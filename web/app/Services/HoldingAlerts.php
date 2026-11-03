<?php

namespace App\Services;

use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/** Peringatan holding time aseptic tank: lot yang usianya di tangki mendekati atau melewati batas, dari event asset.level. */
class HoldingAlerts
{
    /** Bagian dari batas holding yang sudah dipakai sebelum lot dianggap mendekati batas. */
    private const NEAR = 0.75;

    /**
     * Satu baris per (tangki, lot) dengan usia tertinggi yang teramati, diurut dari yang paling mendesak.
     *
     * @return list<array{asset:string, lot:string, age_min:int, limit_min:int, state:'over'|'near', at:string}>
     */
    public function forRun(int $runId, int $max = 8): array
    {
        $worst = [];
        $events = DB::table('sim_events')->where('run_id', $runId)->where('type', 'asset.level')
            ->orderBy('seq')->get(['sim_time', 'payload']);

        foreach ($events as $e) {
            $p = json_decode($e->payload, true) ?: [];
            if (($p['lot'] ?? null) === null || ($p['since'] ?? null) === null) {
                continue;
            }
            $now = Carbon::parse($e->sim_time);
            $age = (int) round(Carbon::parse($p['since'])->diffInSeconds($now, false) / 60);
            $limit = (int) round($p['hold_max_min'] ?? 0);
            $key = $p['asset_code'].'|'.$p['lot'];
            if ($limit > 0 && $age >= $limit * self::NEAR && $age > ($worst[$key]['age_min'] ?? -1)) {
                $worst[$key] = [
                    'asset' => $p['asset_code'], 'lot' => $p['lot'], 'age_min' => $age, 'limit_min' => $limit,
                    'state' => $age > $limit ? 'over' : 'near', 'at' => $now->utc()->format('H:i'),
                ];
            }
        }

        $rows = array_values($worst);
        usort($rows, fn ($a, $b) => [$a['state'] === 'over' ? 0 : 1, $a['limit_min'] - $a['age_min']] <=> [$b['state'] === 'over' ? 0 : 1, $b['limit_min'] - $b['age_min']]);

        return array_slice($rows, 0, $max);
    }
}
