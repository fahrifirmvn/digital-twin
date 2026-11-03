<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;

// Tugas operator diturunkan dari rencana jadwal semua versi run (lihat penggabungan di bawah).
class FieldTasks
{
    private const STEPS = [
        'unload' => ['label' => 'Bongkar ke', 'start' => 'unload_start'],
        'ster' => ['label' => 'Serah ke sterilizer', 'start' => 'ster_start'],
        'fill' => ['label' => 'Serah ke filling', 'start' => 'fill_start'],
    ];

    /** @return list<array{key: string, truck: string, step: string, label: string, asset: string, start: string, end: ?string}> */
    public function forRun(int $runId): array
    {
        // Replan bergulir hanya memuat truk yang belum selesai, jadi gabungkan semua versi:
        // versi lebih baru menimpa per truk, dan versi aktif (disetujui) menimpa paling akhir.
        $plans = DB::table('schedules')
            ->join('schedule_versions', 'schedule_versions.schedule_id', '=', 'schedules.id')
            ->where('schedules.run_id', $runId)
            ->orderByRaw("case when schedule_versions.status = 'active' then 1 else 0 end")
            ->orderBy('schedule_versions.version')
            ->pluck('schedule_versions.plan');
        $byTruck = [];
        foreach ($plans as $plan) {
            foreach (json_decode($plan, true)['trucks'] ?? [] as $t) {
                $byTruck[$t['code']] = $t;
            }
        }

        $tasks = [];
        foreach ($byTruck as $t) {
            $assets = [
                'unload' => $t['bay'] ?? null,
                'ster' => isset($t['sterilizer']) ? "STE-{$t['sterilizer']}" : null,
                'fill' => $t['line'] ?? null,
            ];
            // Tahap berakhir saat tahap berikutnya mulai; filling berakhir di fill_end.
            $ends = ['unload' => $t['ster_start'] ?? null, 'ster' => $t['fill_start'] ?? null, 'fill' => $t['fill_end'] ?? null];
            foreach (self::STEPS as $step => $def) {
                $start = $t[$def['start']] ?? null;
                if ($start === null || $assets[$step] === null) {
                    continue;
                }
                $tasks[] = [
                    'key' => "{$t['code']}:{$step}",
                    'truck' => $t['code'],
                    'step' => $step,
                    'label' => "{$def['label']} {$assets[$step]}",
                    'asset' => $assets[$step],
                    'start' => $start,
                    'end' => $ends[$step],
                ];
            }
        }
        usort($tasks, fn ($a, $b) => strcmp($a['start'], $b['start']));

        return $tasks;
    }
}
