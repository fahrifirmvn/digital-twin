<?php

// Daftar konfigurasi dan skenario yang diterima Engine (kunci harus sama dengan engine/app/scenarios.py).
return [
    'configs' => [
        'A' => 'A: FIFO (baseline)',
        'B' => 'B: CP-SAT, durasi rata-rata',
        'C' => 'C: CP-SAT, durasi P80',
        'D' => 'D: C + Monte Carlo + replan bergulir',
    ],
    'scenarios' => [
        'normal' => 'Normal',
        'truck_surge' => 'Lonjakan truk tak terjadwal',
        'sterilizer_down' => '4 dari 5 sterilizer mati 4 jam',
        'cip_delay' => 'CIP 2x lebih lama',
        'out_of_spec' => 'Truk di luar batas mutu',
        'peak_450' => 'Puncak 450 t',
    ],
    // Operator Agent: batas giliran. Engine membatasi langkah dan waktu per langkah; ini batas total HTTP.
    'agent' => ['timeout' => 120, 'per_minute' => 20],
    // Kampanye harian: pabrik yang berjalan hari demi hari dengan checkpoint tiap akhir hari.
    'campaign' => [
        'max_days' => 365,
        'max_planned' => 10, // maintenance yang diputuskan manusia per hari (engine memuat maks 20 perintah)
        'maintenance_minutes' => [15, 720], // sama dengan batas CommandIn.duration_min di engine
        'speeds' => ['' => 'Secepat mungkin', '5' => '5 menit/detik', '10' => '10 menit/detik', '30' => '30 menit/detik', '60' => '60 menit/detik'],
    ],
    // Perintah mode Simulasi (jenis dan batas harus sama dengan engine/app/commands.py dan CommandIn di api.py).
    'commands' => [
        'max' => 20,
        'kinds' => [
            'ster_down' => 'Sterilizer mati',
            'tank_down' => 'Tangki maintenance',
            'cip_delay' => 'CIP lebih lama',
            'truck_surge' => 'Truk dadakan',
        ],
        // Argumen yang berlaku per jenis beserta nilai bawaannya.
        'defaults' => [
            'ster_down' => ['count' => 1, 'duration_min' => 240],
            'tank_down' => ['asset' => 'TK-RAW-1', 'duration_min' => 240],
            'cip_delay' => ['duration_min' => 120, 'factor' => 2],
            'truck_surge' => ['count' => 4],
        ],
        // Jumlah tangki pabrik bawaan (sama dengan PlantConfig di engine).
        'tanks' => ['TK-RAW' => 15, 'TK-STO' => 6],
        'limits' => ['count' => [1, 12], 'duration_min' => [15, 720], 'factor' => [1.2, 5], 'start_min' => [0, 2880]],
        // Intervensi PPIC (jenis harus sama dengan INTERVENTION_KINDS di engine/app/commands.py). Wajib menyebut truk.
        'interventions' => [
            'plan_approve' => 'Setujui usulan',
            'plan_change' => 'Ubah usulan',
            'plan_reject' => 'Tolak usulan',
            'truck_hold' => 'Tahan truk di gerbang',
            'truck_release' => 'Lepas truk',
        ],
        'hold_default' => 60,
    ],
    // Jumlah modul yang boleh diubah (kunci dan batas harus sama dengan engine/app/plant.py).
    // Batas [min, maks] per jenis mengikuti model 3D pabrik (3 bay, 15 tangki mentah, 6 SFP, 5 aseptic/sterilizer).
    'plant' => [
        'limits' => [
            'n_bays' => [1, 3],
            'n_analysts' => [1, 8],
            'n_raw_tanks' => [1, 15],
            'n_degassing' => [1, 8],
            'n_thermal' => [1, 8],
            'n_separators' => [1, 8],
            'n_storage_tanks' => [1, 6],
            'n_sterilizers' => [1, 5],
        ],
    ],
    // Parameter operasional per run (P9/Q1). Kunci dan batas harus sama dengan PARAM_LIMITS di engine/app/plant.py.
    // Semua nilai DEMO, bukan SOP pabrik; mitra dapat mengoreksinya.
    'params' => [
        'fields' => [
            'bay_flow_tph' => ['label' => 'Aliran bongkar per bay', 'unit' => 't/jam', 'min' => 10, 'max' => 80, 'step' => 1, 'default' => 40, 'group' => 'Aliran'],
            'degassing_tph' => ['label' => 'Aliran degassing', 'unit' => 't/jam', 'min' => 20, 'max' => 120, 'step' => 1, 'default' => 60, 'group' => 'Aliran'],
            'thermal_tph' => ['label' => 'Aliran thermalisasi', 'unit' => 't/jam', 'min' => 10, 'max' => 80, 'step' => 1, 'default' => 40, 'group' => 'Aliran'],
            'separator_tph' => ['label' => 'Aliran separator', 'unit' => 't/jam', 'min' => 10, 'max' => 80, 'step' => 1, 'default' => 40, 'group' => 'Aliran'],
            'sterilizer_tph' => ['label' => 'Aliran sterilizer', 'unit' => 't/jam', 'min' => 5, 'max' => 40, 'step' => 1, 'default' => 20, 'group' => 'Aliran'],
            'filling_tph' => ['label' => 'Aliran filling per line', 'unit' => 't/jam', 'min' => 4, 'max' => 20, 'step' => 1, 'default' => 10, 'group' => 'Aliran'],
            'cip_min_minutes' => ['label' => 'Durasi CIP minimum', 'unit' => 'menit', 'min' => 30, 'max' => 120, 'step' => 5, 'default' => 60, 'group' => 'Waktu proses'],
            'cip_max_minutes' => ['label' => 'Durasi CIP maksimum', 'unit' => 'menit', 'min' => 30, 'max' => 180, 'step' => 5, 'default' => 90, 'group' => 'Waktu proses'],
            'holding_max_min' => ['label' => 'Holding time maksimum', 'unit' => 'menit', 'min' => 60, 'max' => 480, 'step' => 10, 'default' => 240, 'group' => 'Waktu proses'],
            'changeover_size_min' => ['label' => 'Changeover beda ukuran', 'unit' => 'menit', 'min' => 0, 'max' => 120, 'step' => 5, 'default' => 40, 'group' => 'Waktu proses'],
            'changeover_flavor_min' => ['label' => 'Changeover beda rasa', 'unit' => 'menit', 'min' => 0, 'max' => 120, 'step' => 5, 'default' => 30, 'group' => 'Waktu proses'],
            'slot_tolerance_min' => ['label' => 'Toleransi slot jadwal', 'unit' => 'menit', 'min' => 5, 'max' => 120, 'step' => 5, 'default' => 30, 'group' => 'Waktu proses'],
            'milk_use_full_pct' => ['label' => 'Susu per ton produk full cream', 'unit' => '%', 'min' => 50, 'max' => 100, 'step' => 1, 'default' => 100, 'group' => 'Order'],
            'opening_stock_ton' => ['label' => 'Stok awal tangki', 'unit' => 'ton', 'min' => 0, 'max' => 500, 'step' => 5, 'default' => 0, 'group' => 'Order'],
            'milk_use_flavour_pct' => ['label' => 'Susu per ton produk rasa', 'unit' => '%', 'min' => 50, 'max' => 100, 'step' => 1, 'default' => 90, 'group' => 'Order'],
            'fouling_max_min' => ['label' => 'Batas sterilisasi sejak CIP terakhir', 'unit' => 'menit', 'min' => 60, 'max' => 720, 'step' => 10, 'default' => 300, 'group' => 'Fouling dan umur simpan'],
            'shelf_life_days' => ['label' => 'Umur simpan produk', 'unit' => 'hari', 'min' => 30, 'max' => 365, 'step' => 1, 'default' => 180, 'group' => 'Fouling dan umur simpan'],
            'dispatch_lead_days' => ['label' => 'Pengisian sampai tiba di pelanggan', 'unit' => 'hari', 'min' => 0, 'max' => 90, 'step' => 1, 'default' => 30, 'group' => 'Fouling dan umur simpan'],
        ],
        // Order produksi manual (P9/Q4): SKU harus sama dengan SKUS di engine/app/plant.py. Kosong = order otomatis dari susu terjadwal.
        'orders' => [
            'max' => 6,
            'min_ton' => 1,
            'max_ton' => 500,
            'skus' => [
                'UHT-FULL-1000' => 'UHT Full cream 1000 ml',
                'UHT-LOW-1000' => 'UHT Low fat 1000 ml',
                'UHT-FULL-200' => 'UHT Full cream 200 ml',
                'UHT-CHOC-200' => 'UHT Cokelat 200 ml',
            ],
        ],
        // Izin SKU per line (P9/Q3); kunci harus sama dengan SKU_POLICIES di engine/app/routing.py. Bawaan: free.
        'sku_policy' => [
            'default' => 'free',
            'options' => [
                'free' => 'Bebas: semua SKU di semua line',
                'dedicated' => 'Dedikasi demo: line ke-2 tiap aseptic hanya kemasan 1000 ml',
            ],
        ],
        // Maintenance terjadwal: saat ini hanya sterilizer (satu-satunya aset yang dipahami penjadwal sebagai tidak tersedia).
        'maintenance' => ['max' => 6, 'min_duration' => 15, 'max_duration' => 480, 'prefix' => 'STE-'],
    ],
];
