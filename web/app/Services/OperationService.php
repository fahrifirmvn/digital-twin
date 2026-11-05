<?php

namespace App\Services;

use App\Models\Campaign;
use App\Models\CampaignDay;
use App\Models\OperationMaintenance;
use App\Models\SimRun;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

// Operasi pabrik: satu kampanye tunggal yang berjalan hari demi hari. Hari yang sudah lewat tersimpan (checkpoint + hash)
// dan dapat diputar ulang kapan saja; hari aktif dijalankan live, tidak dihitung terlebih dahulu.
class OperationService
{
    public function __construct(private CampaignService $campaigns) {}

    public function current(): ?Campaign
    {
        return Campaign::where('name', config('twin.operation.name'))->whereNull('parent_campaign_id')->orderBy('id')->first();
    }

    private function ensure(User $user): Campaign
    {
        $o = config('twin.operation');

        return $this->current() ?? $this->campaigns->create($user, [
            'name' => $o['name'], 'seed' => $o['seed'], 'start_date' => $o['start_date'], 'config' => $o['config'], 'scenario' => $o['scenario'],
            'params' => ['volume_ton' => (float) $o['volume_ton'], 'extra_bad' => (int) $o['extra_bad']], 'speed' => null,
        ])->refresh();
    }

    /** Hari aktif diutamakan; bila tidak ada, tampilkan hari terakhir yang ditonton. */
    public function watchRun(): ?SimRun
    {
        $c = $this->current();
        if (! $c) {
            return null;
        }
        $active = $c->days()->where('status', 'running')->first();
        if ($active?->run_id) {
            return SimRun::find($active->run_id);
        }
        $day = $c->days()->where('day_no', $c->watch_day)->where('status', 'closed')->first();

        return $day?->run_id ? SimRun::find($day->run_id) : null;
    }

    /** Hari operasi sebuah run (null bila run itu bukan bagian dari operasi). */
    public function dayOf(SimRun $run): ?CampaignDay
    {
        $day = CampaignDay::where('run_id', $run->id)->with('campaign')->first();

        return $day && $day->campaign_id === $this->current()?->id ? $day : null;
    }

    /**
     * Maju satu hari: mulai operasi bila belum ada, geser hari yang ditonton ke hari berikutnya bila sudah siap,
     * atau minta engine menghitungnya. Idempoten selama hari itu masih berjalan.
     *
     * @return array<string, mixed>
     */
    public function advance(User $user): array
    {
        $c = $this->ensure($user);
        $failure = null;
        DB::transaction(function () use ($c, $user, &$failure) {
            $c = Campaign::whereKey($c->id)->lockForUpdate()->firstOrFail();
            if ($c->days()->where('status', 'running')->exists()) {
                return;
            }
            // Data lama yang sudah dihitung tetap dianggap riwayat; tidak direvisi.
            $target = (int) ($c->watch_day ?? 0) + 1;
            $day = $c->days()->where('day_no', $target)->first();
            if ($day?->status === 'closed') {
                $c->update(['watch_day' => $target]);

                return;
            }
            $day = $this->campaigns->currentDay($c);
            if (in_array($day->status, ['planned', 'failed'], true)) {
                $c->update(['watch_day' => $day->day_no, 'speed' => $c->speed ?? 1, 'autoplay' => false]);
                try {
                    $this->campaigns->startDay($c, $user);
                } catch (ValidationException $e) {
                    $failure = $e;
                }
            }
        });
        if ($failure) {
            throw $failure;
        }

        return $this->state($c->refresh());
    }

    /** @return array<string, mixed> */
    public function state(?Campaign $c = null): array
    {
        $c ??= $this->current();
        if (! $c) {
            return ['exists' => false, 'watch_day' => 0, 'target_day' => 1, 'target_status' => null, 'target_error' => null, 'days' => [], 'integrity' => ['ok' => true, 'broken_day' => null]];
        }
        $watch = (int) ($c->watch_day ?? 0);
        $target = $c->days()->where('day_no', $watch + 1)->first();
        $active = $c->days()->where('status', 'running')->first();
        $target = $active ?? $target ?? $this->campaigns->currentDay($c);

        return [
            'exists' => true,
            'campaign_id' => $c->id,
            'watch_day' => $watch,
            'target_day' => $target->day_no,
            'target_status' => $target?->status,
            'target_error' => $target?->status === 'failed' ? $target->error : null,
            'days' => $this->history($c),
            'live' => $active ? ['run_id' => $active->run_id, 'day' => $active->day_no, 'status' => $active->status] : null,
            'integrity' => $this->campaigns->verify($c),
            'maintenance' => $this->maintenance($c),
        ];
    }

    /**
     * Keadaan maintenance untuk hari yang akan datang: meter servis tangki dan jadwal yang sudah ada.
     *
     * @return array<string, mixed>
     */
    private function maintenance(Campaign $c): array
    {
        $day = $this->campaigns->targetDay($c);
        $busy = in_array($day->status, ['running'], true);

        return [
            'day' => $day->day_no, 'date' => $c->dateOf($day->day_no), 'status' => $day->status,
            'open' => ! $busy && $this->campaigns->canChange($c, $day),
            'tanks' => $this->campaigns->tankService($c),
            'planned' => array_map(fn ($e) => ['asset' => $e['asset'], 'minute' => (float) $e['minute'], 'duration_min' => (float) $e['duration_min']], $day->plan),
            'schedules' => OperationMaintenance::where('campaign_id', $c->id)->where('day_no', '>=', $day->day_no)
                ->orderBy('day_no')->orderBy('start_min')->get(['id', 'asset', 'day_no', 'start_min', 'duration_min', 'status', 'error'])->toArray(),
            'limits' => ['minute' => [0, CampaignService::DAY_MIN - 1], 'duration_min' => config('twin.campaign.maintenance_minutes'), 'day' => [$day->day_no, config('twin.campaign.max_days')]],
        ];
    }

    /** @return list<array{day:int, date:string, run_id:int|null, hash:string, summary:array<string,mixed>|null}> */
    private function history(Campaign $c): array
    {
        // Hari yang sudah dihitung tetapi belum ditonton tidak ikut tampil.
        return $c->days()->where('status', 'closed')->where('day_no', '<=', (int) ($c->watch_day ?? 0))->get()->map(fn (CampaignDay $d) => [
            'day' => $d->day_no,
            'date' => $c->dateOf($d->day_no),
            'run_id' => $d->run_id,
            'hash' => substr((string) $d->hash, 0, 12),
            'summary' => $d->snapshot()['summary'] ?? null,
        ])->all();
    }
}
