<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;

// Traceability dua arah (PRD fase 2): dari kode batch ke asal (truk, peternakan)
// dan ke turunannya (FG). Memakai recursive CTE di batch_lineage; berjalan di
// PostgreSQL dan SQLite. UNION (bukan UNION ALL) menjaga graf dengan merge/split
// tidak menghasilkan baris ganda.
class TraceService
{
    /** @return array<string, mixed>|null null bila kode batch atau truk tidak ada di run itu */
    public function trace(int $runId, string $code): ?array
    {
        $resolvedFromTanker = null;
        $start = DB::table('batches')->where('run_id', $runId)->where('code', $code)->first(['id']);
        if ($start === null) {
            $start = DB::table('batches')->where('run_id', $runId)->where('code', 'RAW-'.$code)->first(['id']);
            if ($start !== null) {
                $resolvedFromTanker = $code;
            } else {
                $tankerId = DB::table('tankers')->where('run_id', $runId)->where('code', $code)->value('id');
                if ($tankerId !== null) {
                    $start = DB::table('batches')
                        ->where('run_id', $runId)
                        ->where('tanker_id', $tankerId)
                        ->orderBy('id')
                        ->first(['id']);
                    if ($start !== null) {
                        $resolvedFromTanker = $code;
                    }
                }
            }
        }
        if ($start === null) {
            return null;
        }

        $upstream = $this->walk($start->id, 'up');
        $downstream = $this->walk($start->id, 'down');
        $ids = array_unique([$start->id, ...array_keys($upstream), ...array_keys($downstream)]);

        $batches = DB::table('batches')
            ->leftJoin('skus', 'skus.id', '=', 'batches.sku_id')
            ->whereIn('batches.id', $ids)
            ->get(['batches.id', 'batches.code', 'batches.type', 'batches.status', 'batches.volume_ton',
                'batches.tanker_id', 'skus.code as sku_code'])
            ->keyBy('id');

        $transfers = DB::table('transfer_events')
            ->join('batches', 'batches.id', '=', 'transfer_events.batch_id')
            ->whereIn('transfer_events.batch_id', $ids)
            ->orderBy('transfer_events.occurred_at')->orderBy('transfer_events.id')
            ->get(['batches.code as batch_code', 'transfer_events.from_asset', 'transfer_events.to_asset',
                'transfer_events.volume_ton', 'transfer_events.occurred_at']);

        $simStartStr = DB::table('sim_runs')->where('id', $runId)->value('sim_start');
        $simStartTs = $simStartStr ? strtotime((string) $simStartStr) : null;
        if (! $simStartTs && $transfers->isNotEmpty()) {
            $firstDate = substr((string) $transfers->first()->occurred_at, 0, 10);
            $simStartTs = strtotime($firstDate.' 06:00:00 UTC') ?: null;
        }

        $batchTanks = [];
        $batchLines = [];
        $batchAssets = [];
        $tankFillAt = [];
        $tankFillByAsset = [];
        $isTank = fn (string $a) => str_starts_with($a, 'TK-RAW-') || str_starts_with($a, 'TK-STO-') || str_starts_with($a, 'ASEP-');

        foreach ($transfers as $t) {
            $occTs = strtotime((string) $t->occurred_at);
            $simMin = ($simStartTs && $occTs) ? max(0, (int) round(($occTs - $simStartTs) / 60)) : 0;
            $totMin = 360 + $simMin;
            $dayOff = intdiv($totMin, 1440);
            $hm = $totMin % 1440;
            $t->sim_minute = $simMin;
            $t->clock_wib = sprintf('%02d:%02d WIB%s', intdiv($hm, 60), $hm % 60, $dayOff > 0 ? ' (+1h)' : '');
            $t->dwell_min = null;
            $t->dwell_ok = null;

            foreach ([$t->from_asset, $t->to_asset] as $asset) {
                if ($isTank($asset)) {
                    $batchTanks[$t->batch_code][] = $asset;
                }
                if (str_starts_with($asset, 'LINE-')) {
                    $batchLines[$t->batch_code] = $asset;
                }
                if (! in_array($asset, ['PACK-OUT', 'QA-HOLD'], true)) {
                    $batchAssets[$t->batch_code][] = $asset;
                }
            }

            if ($isTank($t->to_asset)) {
                $tankFillAt[$t->batch_code.':'.$t->to_asset] = $simMin;
                $tankFillByAsset[$t->to_asset] = $simMin;
            }
            if ($isTank($t->from_asset)) {
                $inMin = $tankFillAt[$t->batch_code.':'.$t->from_asset] ?? $tankFillByAsset[$t->from_asset] ?? null;
                if ($inMin !== null && $simMin >= $inMin) {
                    $t->dwell_min = $simMin - $inMin;
                    $t->dwell_ok = $t->dwell_min <= 240;
                }
            }
        }

        $node = fn (int $id, int $depth) => [
            'code' => $batches[$id]->code,
            'type' => $batches[$id]->type,
            'status' => $batches[$id]->status,
            'volume_ton' => (float) $batches[$id]->volume_ton,
            'sku_code' => $batches[$id]->sku_code,
            'depth' => $depth,
            'tanks' => array_values(array_unique($batchTanks[$batches[$id]->code] ?? [])),
            'filling_line' => $batchLines[$batches[$id]->code] ?? null,
            'assets' => array_values(array_unique($batchAssets[$batches[$id]->code] ?? [])),
        ];

        $lineageRows = DB::table('batch_lineage')
            ->whereIn('parent_batch_id', $ids)
            ->whereIn('child_batch_id', $ids)
            ->orderBy('parent_batch_id')->orderBy('child_batch_id')
            ->get(['parent_batch_id', 'child_batch_id', 'volume_ton']);

        $edges = [];
        foreach ($lineageRows as $row) {
            $pBatch = $batches[$row->parent_batch_id] ?? null;
            $cBatch = $batches[$row->child_batch_id] ?? null;
            if ($pBatch && $cBatch) {
                $edgeTon = (float) $row->volume_ton;
                $childTon = (float) $cBatch->volume_ton;
                $edges[] = [
                    'parent_code' => $pBatch->code,
                    'parent_type' => $pBatch->type,
                    'child_code' => $cBatch->code,
                    'child_type' => $cBatch->type,
                    'volume_ton' => $edgeTon,
                    'share_pct' => $childTon > 0 ? round(100.0 * min($edgeTon, $childTon) / $childTon, 1) : 100.0,
                ];
            }
        }

        $tankerIds = $batches->pluck('tanker_id')->filter()->unique()->values();
        $tankers = DB::table('tankers')
            ->join('farms', 'farms.id', '=', 'tankers.farm_id')
            ->whereIn('tankers.id', $tankerIds)
            ->orderBy('tankers.code')
            ->get(['tankers.code', 'tankers.volume_ton', 'tankers.initial_temp_c', 'tankers.status',
                'farms.code as farm_code', 'farms.name as farm_name']);

        $objectIds = $batches->pluck('code')->merge($tankers->pluck('code'))->all();
        $gates = DB::table('gate_decisions')
            ->where('run_id', $runId)
            ->whereIn('object_id', $objectIds)
            ->orderBy('decided_at')->orderBy('id')
            ->get(['gate', 'object_type', 'object_id', 'decision', 'reason', 'decided_by', 'decided_at']);

        $rawSum = round((float) $batches->where('type', 'raw')->sum('volume_ton'), 2);
        $intSum = round((float) $batches->where('type', 'intermediate')->sum('volume_ton'), 2);
        $fgSum = round((float) $batches->where('type', 'fg')->sum('volume_ton'), 2);

        return [
            'resolved_from_tanker' => $resolvedFromTanker,
            'batch' => $node($start->id, 0),
            'upstream' => collect($upstream)->map(fn ($d, $id) => $node($id, $d))->sortBy('depth')->values()->all(),
            'downstream' => collect($downstream)->map(fn ($d, $id) => $node($id, $d))->sortBy('depth')->values()->all(),
            'edges' => $edges,
            'mass_summary' => [
                'raw_ton' => $rawSum,
                'intermediate_ton' => $intSum,
                'fg_ton' => $fgSum,
            ],
            'tankers' => $tankers->all(),
            'transfers' => $transfers->all(),
            'gates' => $gates->all(),
        ];
    }

    /**
     * @return array<int, int> batch_id => jarak terpendek dari titik awal (titik awal tidak ikut)
     */
    private function walk(int $startId, string $dir): array
    {
        [$from, $to] = $dir === 'up'
            ? ['child_batch_id', 'parent_batch_id']
            : ['parent_batch_id', 'child_batch_id'];

        $rows = DB::select(
            "WITH RECURSIVE walk(id, depth) AS (
                SELECT CAST(? AS bigint), 0
                UNION
                SELECT l.{$to}, walk.depth + 1 FROM batch_lineage l JOIN walk ON l.{$from} = walk.id
            )
            SELECT id, MIN(depth) AS depth FROM walk WHERE id <> CAST(? AS bigint) GROUP BY id",
            [$startId, $startId],
        );

        $out = [];
        foreach ($rows as $r) {
            $out[(int) $r->id] = (int) $r->depth;
        }

        return $out;
    }
}
