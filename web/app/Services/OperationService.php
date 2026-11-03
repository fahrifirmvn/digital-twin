<?php

namespace App\Services;

use App\Models\Campaign;
use App\Models\CampaignDay;
use App\Models\SimRun;
use App\Models\User;
use Illuminate\Validation\ValidationException;

// Operasi pabrik: satu kampanye tunggal yang berjalan hari demi hari. Hari yang sudah lewat tersimpan (checkpoint + hash)
// dan dapat diputar ulang kapan saja; hari berikutnya disiapkan satu langkah di depan hari yang sedang ditonton.
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

    /** Run hari yang sedang ditonton, bila sudah selesai dihitung. */
    public function watchRun(): ?SimRun
    {
        $c = $this->current();
        if (! $c || ! $c->watch_day) {
            return null;
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
        $target = ($c->watch_day ?? 0) + 1;
        $day = $c->days()->where('day_no', $target)->first();

        if ($day?->status === 'closed') {
            $c->update(['watch_day' => $target]);
            $this->prepareNext($c->refresh(), $user);
        } elseif (in_array($day?->status, ['planned', 'failed'], true)) {
            $this->campaigns->startDay($c, $user);
        }

        return $this->state($c->refresh());
    }

    private function prepareNext(Campaign $c, User $user): void
    {
        $next = $c->days()->where('day_no', $c->current_day)->first();
        if ($next && $next->status === 'planned' && $c->current_day === ($c->watch_day ?? 0) + 1) {
            try {
                $this->campaigns->startDay($c, $user);
            } catch (ValidationException) {
                // Disiapkan ulang saat pengguna maju; kegagalan engine tidak boleh menggagalkan pergantian hari.
            }
        }
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

        return [
            'exists' => true,
            'watch_day' => $watch,
            'target_day' => $watch + 1,
            'target_status' => $target?->status,
            'target_error' => $target?->status === 'failed' ? $target->error : null,
            'days' => $this->history($c),
            'integrity' => $this->campaigns->verify($c),
        ];
    }

    /** @return list<array{day:int, date:string, run_id:int|null, hash:string, summary:array<string,mixed>|null}> */
    private function history(Campaign $c): array
    {
        return $c->days()->where('status', 'closed')->get()->map(fn (CampaignDay $d) => [
            'day' => $d->day_no,
            'date' => $c->dateOf($d->day_no),
            'run_id' => $d->run_id,
            'hash' => substr((string) $d->hash, 0, 12),
            'summary' => $d->snapshot()['summary'] ?? null,
        ])->all();
    }
}
