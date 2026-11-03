<?php

namespace App\Services;

use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/** Jadwal kedatangan satu run, disusun dari event: kapan truk diperkirakan tiba, kapan tiba, dan bay yang dipakai. */
class DaySchedule
{
    private const STATUS = [
        'queued' => 'Antre', 'sampling' => 'Sampling', 'lab_test' => 'Uji lab', 'released' => 'Rilis',
        'unloading' => 'Bongkar', 'rejected' => 'Ditolak', 'stored' => 'Selesai',
    ];

    /** @return list<array{code:string, plate:?string, farm:string, eta:?string, arrived:?string, volume:?float, bay:?string, status:?string, status_key:?string}> */
    public function forRun(int $runId): array
    {
        $rows = [];
        $events = DB::table('sim_events')->where('run_id', $runId)
            ->whereIn('type', ['truck.dispatched', 'truck.arrived', 'tanker.status_changed'])
            ->orderBy('seq')->get(['type', 'sim_time', 'payload']);

        foreach ($events as $e) {
            $p = json_decode($e->payload, true) ?: [];
            $code = $p['tanker_code'] ?? null;
            if ($code === null) {
                continue;
            }
            $rows[$code] ??= ['code' => $code, 'plate' => null, 'farm' => '', 'eta' => null, 'arrived' => null, 'volume' => null, 'bay' => null, 'status' => null, 'status_key' => null, 'sort' => 0];
            $r = &$rows[$code];

            if ($e->type === 'truck.dispatched') {
                $r['plate'] = $p['plate'] ?? null;
                $r['farm'] = $p['farm_code'] ?? '';
                $r['eta'] = $this->clock($p['eta'] ?? null);
                $r['sort'] = Carbon::parse($p['eta'])->getTimestamp();
            } elseif ($e->type === 'truck.arrived') {
                $r['plate'] ??= $p['plate'] ?? null;
                $r['farm'] = $r['farm'] ?: ($p['farm_code'] ?? '');
                $r['arrived'] = $this->clock($e->sim_time);
                $r['volume'] = $p['volume_ton'] ?? null;
                $r['sort'] = $r['sort'] ?: Carbon::parse($e->sim_time)->getTimestamp();
            } else {
                $r['bay'] = $p['bay_code'] ?? $r['bay'];
                $r['status_key'] = $p['status'] ?? null;
                $r['status'] = self::STATUS[$r['status_key']] ?? $r['status_key'];
            }
            unset($r);
        }

        uasort($rows, fn ($a, $b) => [$a['sort'], $a['code']] <=> [$b['sort'], $b['code']]);

        return array_values(array_map(function ($r) {
            unset($r['sort']);

            return $r;
        }, $rows));
    }

    private function clock(?string $iso): ?string
    {
        return $iso ? Carbon::parse($iso)->utc()->format('H:i') : null;
    }
}
