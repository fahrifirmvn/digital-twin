<?php

namespace App\Services;

use App\Models\Campaign;
use App\Models\OperationMaintenance;
use App\Models\SimCommand;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use RuntimeException;

class LiveMaintenanceService
{
    public function __construct(private EngineClient $engine, private OperationService $operations, private CampaignService $campaigns, private AuditLogger $audit) {}

    public function apply(User $user, array $data): OperationMaintenance
    {
        $c = $this->operations->current();
        if (! $c) {
            throw ValidationException::withMessages(['day' => 'Mulai hari operasi terlebih dahulu.']);
        }
        $entry = DB::transaction(function () use ($c, $user, $data) {
            $c = Campaign::whereKey($c->id)->lockForUpdate()->firstOrFail();
            $existing = OperationMaintenance::find($data['request_id']);
            if ($existing) {
                if ($existing->campaign_id !== $c->id || $existing->actor_id !== $user->id || $existing->request != $data) {
                    throw ValidationException::withMessages(['request_id' => 'ID permintaan sudah digunakan dengan isi berbeda.']);
                }

                if ($existing->status === 'rejected') {
                    throw ValidationException::withMessages(['engine' => $existing->error]);
                }

                return $existing;
            }
            $active = $c->days()->where('status', 'running')->first();
            $dayNo = $data['mode'] === 'now' ? $active?->day_no : $data['day'];
            if (! $dayNo || $dayNo < $c->current_day || $dayNo > config('twin.campaign.max_days')) {
                throw ValidationException::withMessages(['day' => 'Pilih hari aktif atau hari mendatang, bukan hari yang sudah selesai.']);
            }
            if ($data['mode'] === 'now' || $dayNo === $active?->day_no) {
                if (! $active || $active->run_id !== $data['run_id']) {
                    throw ValidationException::withMessages(['run_id' => 'Buka hari operasi aktif untuk mengirim maintenance hari ini.']);
                }
            }
            $limits = $this->campaigns->tankLimits($c);
            $prefix = substr($data['asset'], 0, 6);
            $number = (int) substr($data['asset'], 7);
            if (! isset($limits[$prefix]) || $number < 1 || $number > $limits[$prefix]) {
                throw ValidationException::withMessages(['asset' => 'Tangki tidak ada pada pabrik ini.']);
            }
            $day = $c->days()->where('day_no', $dayNo)->first();
            if ($day && ! in_array($day->status, ['planned', 'failed', 'running'], true)) {
                throw ValidationException::withMessages(['day' => 'Hari yang sudah ditutup tidak dapat diubah.']);
            }
            $taken = OperationMaintenance::where('campaign_id', $c->id)->where('day_no', $dayNo)->where('status', '!=', 'rejected')->get();
            if ($taken->count() + count($day?->plan ?? []) >= config('twin.campaign.max_planned')) {
                throw ValidationException::withMessages(['day' => 'Jumlah maintenance hari ini mencapai batas.']);
            }
            if ($taken->contains('asset', $data['asset']) || in_array($data['asset'], array_column([...($day?->plan ?? []), ...($day?->carry_in ?? [])], 'asset'), true)) {
                throw ValidationException::withMessages(['asset' => 'Tangki sudah memiliki maintenance pada hari ini.']);
            }

            return OperationMaintenance::create([
                'id' => $data['request_id'], 'campaign_id' => $c->id, 'day_no' => $dayNo,
                'run_id' => $active?->day_no === $dayNo ? $active->run_id : null,
                'asset' => $data['asset'], 'mode' => $data['mode'],
                'start_min' => $data['mode'] === 'now' ? null : $data['start_min'],
                'duration_min' => $data['duration_min'], 'reason' => trim($data['reason']),
                'actor_id' => $user->id, 'actor_label' => Str::limit($user->role->label().': '.$user->name, 80, ''),
                'status' => $active?->day_no === $dayNo ? 'pending' : 'scheduled', 'request' => $data,
            ]);
        });

        if (in_array($entry->status, ['pending', 'uncertain'], true)) {
            try {
                $receipt = $this->engine->liveCommand($entry->run_id, 'maintenance', [
                    'request_id' => $entry->id, 'asset' => $entry->asset, 'start_min' => $entry->mode === 'now' ? null : $entry->start_min,
                    'duration_min' => $entry->duration_min, 'actor' => $entry->actor_label, 'reason' => $entry->reason,
                ]);
            } catch (RuntimeException $e) {
                OperationMaintenance::whereKey($entry->id)->whereIn('status', ['pending', 'uncertain'])->update([
                    'status' => in_array($e->getCode(), [400, 404, 409, 422], true) ? 'rejected' : 'uncertain',
                    'error' => $e->getMessage(),
                ]);
                $this->audit->record('user', (string) $user->id, 'operation.maintenance_unconfirmed', ['id' => $entry->id, 'error' => $e->getMessage()]);
                throw ValidationException::withMessages(['engine' => $e->getMessage()]);
            }
            DB::transaction(function () use ($entry, $receipt) {
                $entry = OperationMaintenance::whereKey($entry->id)->lockForUpdate()->firstOrFail();
                $entry->update(['start_min' => $receipt['start_min'], 'error' => null]
                    + (in_array($entry->status, ['pending', 'uncertain'], true) ? ['status' => 'accepted'] : []));
                SimCommand::firstOrCreate(['run_id' => $entry->run_id, 'seq' => $receipt['command_id']], [
                    'minute' => $receipt['start_min'], 'kind' => 'tank_down',
                    'args' => ['asset' => $entry->asset, 'duration_min' => $entry->duration_min, 'request_id' => $entry->id],
                    'actor_id' => $entry->actor_id, 'actor_label' => $entry->actor_label, 'reason' => $entry->reason,
                ]);
            });
            $entry->refresh();
        }
        $this->audit->record('user', (string) $user->id, 'operation.maintenance_saved', [
            'id' => $entry->id, 'run_id' => $entry->run_id, 'day' => $entry->day_no, 'asset' => $entry->asset, 'status' => $entry->status,
        ]);

        return $entry;
    }
}
