<?php

namespace Database\Seeders;

use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;

// Farm dan SKU DEMO. Kode harus sama dengan generator di Engine.
class MasterDataSeeder extends Seeder
{
    public function run(): void
    {
        $now = now();

        foreach ([
            ['FRM-01', 'Farm Pasuruan', 45.0], ['FRM-02', 'Farm Malang', 95.0],
            ['FRM-03', 'Farm Probolinggo', 70.0], ['FRM-04', 'Farm Batu', 110.0],
            ['FRM-05', 'Farm Lumajang', 130.0], ['FRM-06', 'Farm Jember', 190.0],
            ['FRM-07', 'Farm Blitar', 120.0], ['FRM-08', 'Farm Kediri', 150.0],
        ] as [$code, $name, $km]) {
            DB::table('farms')->upsert(
                ['code' => $code, 'name' => $name, 'distance_km' => $km, 'avg_volume_ton' => 22.5,
                    'is_demo' => true, 'created_at' => $now, 'updated_at' => $now],
                ['code'], ['name', 'distance_km', 'avg_volume_ton', 'updated_at'],
            );
        }

        foreach ([
            ['UHT-FULL-1000', 'UHT Full Cream 1 L', '1000', 'full_cream'],
            ['UHT-LOW-1000', 'UHT Low Fat 1 L', '1000', 'low_fat'],
            ['UHT-FULL-200', 'UHT Full Cream 200 mL', '200', 'full_cream'],
            ['UHT-CHOC-200', 'UHT Chocolate 200 mL', '200', 'chocolate'],
        ] as [$code, $name, $size, $flavor]) {
            DB::table('skus')->upsert(
                ['code' => $code, 'name' => $name, 'size_ml' => $size, 'flavor' => $flavor,
                    'package_type' => 'carton', 'is_demo' => true, 'created_at' => $now, 'updated_at' => $now],
                ['code'], ['name', 'size_ml', 'flavor', 'package_type', 'updated_at'],
            );
        }
    }
}
