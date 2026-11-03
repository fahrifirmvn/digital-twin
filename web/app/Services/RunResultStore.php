<?php

namespace App\Services;

use App\Models\SimRun;
use Illuminate\Support\Facades\DB;

// Menyimpan hasil run dari Engine secara atomik: seluruhnya masuk atau tidak sama sekali.
class RunResultStore
{
    public function __construct(private AuditLogger $audit) {}

    private const CONFIG_LABELS = [
        'A' => 'A FIFO',
        'B' => 'B CP-SAT rata-rata',
        'C' => 'C CP-SAT P80',
        'D' => 'D CP-SAT P80 + Monte Carlo',
    ];

    /** @param array<string, mixed> $r hasil tervalidasi (kontrak run-result.schema.json) */
    public function storeFinished(SimRun $run, array $r): void
    {
        DB::transaction(function () use ($run, $r) {
            $farms = DB::table('farms')->pluck('id', 'code');
            $skus = DB::table('skus')->pluck('id', 'code');
            $now = now();

            $scenarioId = DB::table('scenarios')->insertGetId([
                'name' => sprintf('%s | %s | seed %d | %s t', self::CONFIG_LABELS[$r['config']] ?? $r['config'], config('twin.scenarios')[$r['scenario']] ?? $r['scenario'], $r['seed'], $r['params']['volume_ton'] ?? '?'),
                'params' => json_encode($r['params']),
                'seed' => $r['seed'],
                'kpi_result' => json_encode($r['kpi']),
                'created_at' => $now,
                'updated_at' => $now,
            ]);

            $tankerIds = [];
            foreach ($r['tankers'] as $t) {
                $id = DB::table('tankers')->insertGetId([
                    'run_id' => $run->id,
                    'code' => $t['code'],
                    'farm_id' => $farms[$t['farm_code']],
                    'volume_ton' => $t['volume_ton'],
                    'initial_temp_c' => $t['temp_c'],
                    'status' => $t['status'],
                    'outcome' => $t['outcome'],
                    'eta_p50' => $t['eta_p50'] ?? null,
                    'eta_p80' => $t['eta_p80'] ?? null,
                    'eta_p90' => $t['eta_p90'] ?? null,
                    'created_at' => $now,
                    'updated_at' => $now,
                ]);
                $tankerIds[$t['code']] = $id;

                if ($t['lab_start'] !== null) {
                    DB::table('lab_tests')->insert([
                        'tanker_id' => $id,
                        'test_type' => 'raw_milk_panel',
                        'started_at' => $t['lab_start'],
                        'finished_at' => $t['lab_end'],
                        'results' => json_encode(collect($t['lab_results'])
                            ->map(fn ($v, $k) => ['parameter' => $k, 'value' => $v])->values()),
                        'analyst' => $t['analyst'],
                        'created_at' => $now,
                        'updated_at' => $now,
                    ]);
                }
            }

            if (($r['plan'] ?? null) !== null) {
                $scheduleId = DB::table('schedules')->insertGetId([
                    'run_id' => $run->id,
                    'name' => 'Jadwal '.(self::CONFIG_LABELS[$r['config']] ?? $r['config']),
                    'created_at' => $now,
                    'updated_at' => $now,
                ]);
                DB::table('schedule_versions')->insert($this->versionRows($scheduleId, $r, $now));
            }

            $batchIds = [];
            foreach ($r['batches'] as $b) {
                $batchIds[$b['code']] = DB::table('batches')->insertGetId([
                    'run_id' => $run->id,
                    'code' => $b['code'],
                    'type' => $b['type'],
                    'tanker_id' => $tankerIds[$b['tanker_code']] ?? null,
                    'sku_id' => $b['sku_code'] !== null ? $skus[$b['sku_code']] : null,
                    'volume_ton' => $b['volume_ton'],
                    'status' => $b['status'],
                    'created_at' => $now,
                    'updated_at' => $now,
                ]);
            }
            foreach ($r['batches'] as $b) {
                foreach ($b['parents'] as $parent) {
                    DB::table('batch_lineage')->insert([
                        'parent_batch_id' => $batchIds[$parent],
                        'child_batch_id' => $batchIds[$b['code']],
                        'volume_ton' => $b['volume_ton'],
                    ]);
                }
            }

            $this->insertChunks('transfer_events', array_map(fn ($t) => [
                'run_id' => $run->id,
                'from_asset' => $t['from_asset'],
                'to_asset' => $t['to_asset'],
                'batch_id' => $batchIds[$t['batch_code']],
                'volume_ton' => $t['volume_ton'],
                'occurred_at' => $t['occurred_at'],
            ], $r['transfers']));

            $this->insertChunks('gate_decisions', array_map(fn ($g) => [
                'run_id' => $run->id,
                'gate' => $g['gate'],
                'object_type' => $g['object_type'],
                'object_id' => $g['object_id'],
                'decision' => $g['decision'],
                'reason' => $g['reason'],
                'decided_by' => 'gate_engine',
                'decided_at' => $g['decided_at'],
            ], $r['gates']));

            $this->insertChunks('cip_events', array_map(fn ($c) => [
                'run_id' => $run->id,
                'asset_code' => $c['asset_code'],
                'type' => $c['is_scheduled'] ? 'scheduled' : 'emergency',
                'started_at' => $c['started_at'],
                'finished_at' => $c['finished_at'],
                'is_scheduled' => $c['is_scheduled'],
            ], $r['cips']));

            $this->insertChunks('sim_events', array_map(fn ($e) => [
                'run_id' => $run->id,
                'seq' => $e['seq'],
                'sim_time' => $e['sim_time'],
                'type' => $e['payload']['type'],
                'payload' => json_encode($e['payload']),
            ], $r['events']));

            DB::table('sim_runs')->where('id', $run->id)->update([
                'scenario_id' => $scenarioId,
                'status' => 'finished',
                'ai_result' => isset($r['ai']) ? json_encode($r['ai']) : null,
                'sim_start' => $r['sim_start'],
                'sim_end' => $r['sim_end'],
                'config_snapshot' => json_encode([
                    'config' => $r['config'],
                    'scenario' => $r['scenario'],
                    // Parameter yang diminta pengguna (Engine melaporkan nilai efektif setelah skenario).
                    'params' => $run->config_snapshot['params'] ?? $r['params'],
                ]),
                'updated_at' => $now,
            ]);
        });

        $this->audit->record('system', 'engine', 'run.finished', [
            'run_id' => $run->id,
            'false_accept' => $r['kpi']['false_accept'],
            'events' => count($r['events']),
        ]);
    }

    /**
     * Versi 1 = rencana awal; tiap replan yang berhasil menambah versi. Hanya versi terakhir yang `proposed`,
     * sisanya `superseded`. Replan gagal tidak membuat versi (rencana lama tetap berlaku; tercatat di event).
     *
     * @param  array<string, mixed>  $r
     * @return list<array<string, mixed>>
     */
    private function versionRows(int $scheduleId, array $r, mixed $now): array
    {
        $mc = $r['monte_carlo'];
        $rows = [[
            'version' => 1,
            'config' => $r['config'],
            'created_by' => 'optimizer',
            'plan' => $r['plan'],
            'kpi_predicted' => $mc,
        ]];
        foreach ($r['replans'] as $p) {
            if ($p['plan'] === null || $p['status'] === 'failed') {
                continue;
            }
            $rows[] = [
                'version' => $p['version'],
                'config' => $r['config'],
                'created_by' => 'rolling:'.$p['trigger'],
                'plan' => $p['plan'],
                'kpi_predicted' => null,
            ];
        }

        $last = count($rows) - 1;

        return array_map(fn ($v, $i) => [
            'schedule_id' => $scheduleId,
            'version' => $v['version'],
            'status' => $i === $last ? 'proposed' : 'superseded',
            'config' => $v['config'],
            'created_by' => $v['created_by'],
            'plan' => json_encode($v['plan']),
            'kpi_predicted' => $v['kpi_predicted'] === null ? null : json_encode($v['kpi_predicted']),
            'created_at' => $now,
            'updated_at' => $now,
        ], $rows, array_keys($rows));
    }

    public function storeFailed(SimRun $run, string $error): void
    {
        DB::table('sim_runs')->where('id', $run->id)->update([
            'status' => 'failed',
            'error' => mb_substr($error, 0, 1000),
            'updated_at' => now(),
        ]);
        $this->audit->record('system', 'engine', 'run.failed', ['run_id' => $run->id]);
    }

    /** @param list<array<string, mixed>> $rows */
    private function insertChunks(string $table, array $rows): void
    {
        foreach (array_chunk($rows, 200) as $chunk) {
            DB::table($table)->insert($chunk);
        }
    }
}
