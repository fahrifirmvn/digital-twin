<?php

namespace App\Services;

use App\Models\SimCommand;
use App\Models\SimRun;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;
use RuntimeException;

// Membuat cabang simulasi (fork) dari run selesai: seed sama, perintah lama disalin, perintah baru ditambahkan, lalu Engine dijalankan.
class ForkService
{
    public function __construct(private EngineClient $engine) {}

    /**
     * @param  list<array{minute:float, kind:string, args:array<string,mixed>, reason:string}>  $new
     * @param  string  $actor  Label pelaku yang tercatat di log perintah (maks 80 huruf)
     */
    public function create(SimRun $run, array $new, ?User $user, string $actor): SimRun
    {
        $previous = $run->commands()->get();
        $snap = $run->config_snapshot ?? [];
        $minute = round((float) end($new)['minute'], 1);

        $fork = DB::transaction(function () use ($run, $previous, $new, $user, $actor, $minute, $snap) {
            $fork = SimRun::create([
                'kind' => 'simulation',
                'seed' => $run->seed,
                'status' => 'pending',
                'requested_by' => $user?->id,
                'parent_run_id' => $run->id,
                'fork_minute' => $minute,
                'config_snapshot' => ['config' => $snap['config'] ?? 'A', 'scenario' => $snap['scenario'] ?? 'normal', 'params' => $snap['params'] ?? []],
            ]);
            foreach ($previous as $i => $c) {
                SimCommand::create(['run_id' => $fork->id, 'seq' => $i + 1] + $c->only(['minute', 'kind', 'args', 'actor_id', 'actor_label', 'reason']));
            }
            foreach ($new as $j => $c) {
                SimCommand::create([
                    'run_id' => $fork->id, 'seq' => $previous->count() + $j + 1, 'minute' => round((float) $c['minute'], 1), 'kind' => $c['kind'], 'args' => $c['args'],
                    'actor_id' => $user?->id, 'actor_label' => $actor, 'reason' => trim($c['reason']),
                ]);
            }

            return $fork;
        });

        try {
            $this->engine->startRun($fork->id, ($snap['params'] ?? []) + ['seed' => $run->seed] + [
                'config' => $snap['config'] ?? 'A',
                'scenario' => $snap['scenario'] ?? 'normal',
                'commands' => $fork->commands()->get()->map->toEngine()->all(),
            ]);
            // Engine bisa selesai sebelum respons ini kembali, jadi jangan menimpa status akhir.
            DB::table('sim_runs')->where('id', $fork->id)->where('status', 'pending')->update(['status' => 'running']);
        } catch (RuntimeException $e) {
            $fork->update(['status' => 'failed', 'error' => $e->getMessage()]);
            throw ValidationException::withMessages(['engine' => $e->getMessage()]);
        }

        return $fork;
    }
}
