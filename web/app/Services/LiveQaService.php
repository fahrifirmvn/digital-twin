<?php

namespace App\Services;

use App\Models\OperationQaDecision;
use App\Models\SimRun;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use RuntimeException;

class LiveQaService
{
    public function __construct(private EngineClient $engine, private OperationService $operations, private AuditLogger $audit) {}

    public function apply(User $user, array $data): OperationQaDecision
    {
        $entry = DB::transaction(function () use ($user, $data) {
            $run = SimRun::whereKey($data['run_id'])->lockForUpdate()->first();
            if (! $run) {
                throw ValidationException::withMessages(['run_id' => 'Run tidak ditemukan.']);
            }
            $entry = OperationQaDecision::find($data['request_id']);
            if ($entry) {
                if ($entry->actor_id !== $user->id || $entry->request != $data) {
                    throw ValidationException::withMessages(['request_id' => 'ID permintaan sudah digunakan dengan isi berbeda.']);
                }
                if ($entry->status === 'rejected') {
                    throw ValidationException::withMessages(['engine' => $entry->error]);
                }

                return $entry;
            }
            $active = $this->operations->current()?->days()->where('status', 'running')->first();
            if (! $active || $active->run_id !== $run->id || $run->status !== 'running' || ! ($run->config_snapshot['live'] ?? false)) {
                throw ValidationException::withMessages(['run_id' => 'Keputusan QA hanya dapat diterapkan pada hari operasi live yang aktif.']);
            }

            return OperationQaDecision::create([
                'id' => $data['request_id'], 'run_id' => $run->id, 'actor_id' => $user->id,
                'actor_label' => Str::limit($user->role->label().': '.$user->name, 80, ''),
                'truck' => $data['truck'], 'action' => $data['action'], 'reason' => trim($data['reason']),
                'status' => 'pending', 'request' => $data,
            ]);
        });
        if ($entry->status === 'accepted') {
            return $entry;
        }
        try {
            $payload = collect($entry->request)->except(['run_id'])->all();
            $payload['actor'] = $entry->actor_label;
            $receipt = $this->engine->liveCommand($entry->run_id, 'qa', $payload);
            if (($receipt['request_id'] ?? null) !== $entry->id || ($receipt['status'] ?? null) !== 'accepted') {
                throw new RuntimeException('Engine belum mengonfirmasi keputusan QA. Coba kembali dengan ID yang sama.');
            }
        } catch (RuntimeException $e) {
            OperationQaDecision::whereKey($entry->id)->whereIn('status', ['pending', 'uncertain'])->update([
                'status' => in_array($e->getCode(), [400, 404, 409, 422], true) ? 'rejected' : 'uncertain',
                'error' => $e->getMessage(),
            ]);
            $this->audit->record('user', (string) $user->id, 'operation.qa_unconfirmed', ['id' => $entry->id, 'error' => $e->getMessage()]);
            throw ValidationException::withMessages(['engine' => $e->getMessage()]);
        }
        $entry->update(['status' => 'accepted', 'receipt' => $receipt, 'error' => null]);
        $this->audit->record('user', (string) $user->id, 'operation.qa_accepted', [
            'id' => $entry->id, 'run_id' => $entry->run_id, 'truck' => $entry->truck,
            'action' => $entry->action, 'reason' => $entry->reason, 'disposition' => $entry->request['disposition'] ?? null,
        ]);

        return $entry->refresh();
    }
}
