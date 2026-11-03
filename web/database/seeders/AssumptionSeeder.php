<?php

namespace Database\Seeders;

use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;

// Parameter asumsi PRD 9.2. Semuanya DEMO dan harus dikonfirmasi mitra.
class AssumptionSeeder extends Seeder
{
    public function run(): void
    {
        $rows = [
            ['plant.daily_volume_ton', 320, 'ton', 'Dari bootcamp'],
            ['plant.peak_volume_ton', 450, 'ton', 'Dari bootcamp'],
            ['truck.volume_ton_range', [20, 25], 'ton', 'Asumsi'],
            ['truck.per_day_range', [14, 20], 'truck', 'Turunan dari volume'],
            ['bay.count', 4, 'bay', 'Asumsi dari slide constraint'],
            ['lab.duration_minutes_range', [30, 90], 'menit', 'Asumsi, ekor panjang'],
            ['tank.holding_time_max_hours', 4, 'jam', 'Asumsi, harus dikonfirmasi QA'],
            ['cip.tank_duration_minutes_range', [60, 90], 'menit', 'Asumsi'],
            ['sku.changeover', 'per_transition', null, 'Berbeda per transisi (kertas, ukuran, rasa)'],
        ];

        foreach ($rows as [$key, $value, $unit, $note]) {
            DB::table('assumptions')->updateOrInsert(
                ['key' => $key],
                ['value' => json_encode($value), 'unit' => $unit, 'note' => $note, 'is_demo' => true,
                    'created_at' => now(), 'updated_at' => now()],
            );
        }
    }
}
