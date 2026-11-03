<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;

// Traceability dua arah (PRD fase 2): dari kode batch ke asal (truk, peternakan)
// dan ke turunannya (FG). Memakai recursive CTE di batch_lineage; berjalan di
// PostgreSQL dan SQLite. UNION (bukan UNION ALL) menjaga graf dengan merge/split
// tidak menghasilkan baris ganda.
class TraceService
{
    /** @return array<string, mixed>|null null bila kode batch tidak ada di run itu */
    public function trace(int $runId, string $code): ?array
    {
        $start = DB::table('batches')->where('run_id', $runId)->where('code', $code)->first(['id']);
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

        $node = fn (int $id, int $depth) => [
            'code' => $batches[$id]->code,
            'type' => $batches[$id]->type,
            'status' => $batches[$id]->status,
            'volume_ton' => (float) $batches[$id]->volume_ton,
            'sku_code' => $batches[$id]->sku_code,
            'depth' => $depth,
        ];

        $tankerIds = $batches->pluck('tanker_id')->filter()->unique()->values();
        $tankers = DB::table('tankers')
            ->join('farms', 'farms.id', '=', 'tankers.farm_id')
            ->whereIn('tankers.id', $tankerIds)
            ->orderBy('tankers.code')
            ->get(['tankers.code', 'tankers.volume_ton', 'tankers.initial_temp_c', 'tankers.status',
                'farms.code as farm_code', 'farms.name as farm_name']);

        $transfers = DB::table('transfer_events')
            ->join('batches', 'batches.id', '=', 'transfer_events.batch_id')
            ->whereIn('transfer_events.batch_id', $ids)
            ->orderBy('transfer_events.occurred_at')->orderBy('transfer_events.id')
            ->get(['batches.code as batch_code', 'transfer_events.from_asset', 'transfer_events.to_asset',
                'transfer_events.volume_ton', 'transfer_events.occurred_at']);

        $objectIds = $batches->pluck('code')->merge($tankers->pluck('code'))->all();
        $gates = DB::table('gate_decisions')
            ->where('run_id', $runId)
            ->whereIn('object_id', $objectIds)
            ->orderBy('decided_at')->orderBy('id')
            ->get(['gate', 'object_type', 'object_id', 'decision', 'reason', 'decided_by', 'decided_at']);

        return [
            'batch' => $node($start->id, 0),
            'upstream' => collect($upstream)->map(fn ($d, $id) => $node($id, $d))->sortBy('depth')->values()->all(),
            'downstream' => collect($downstream)->map(fn ($d, $id) => $node($id, $d))->sortBy('depth')->values()->all(),
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
