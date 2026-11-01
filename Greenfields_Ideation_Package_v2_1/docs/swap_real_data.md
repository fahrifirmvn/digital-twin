# Panduan Integrasi Data Riil Pabrik (Swap Real Data Guide)
**Data Classification**: `DATA SINTETIS` / Panduan Operasional  
**Partner**: `[Nama Pabrik]`  

Dokumen ini adalah panduan teknis bagi tim Engineering dan PPIC `[Nama Pabrik]` untuk menggantikan dataset sintetis (`data/synthetic_90d/`) dengan data riil dari sistem SCADA, LIMS, MES, dan ERP pabrik tanpa mengubah satu baris pun kode inti pengoptimal (*zero code modification*).

---

## 1. Arsitektur Data Adapter

LactaTwin memisahkan logika matematika pengoptimal dari format penyimpanan data menggunakan pola *Adapter*:

```
[ Sistem Pabrik Riil ]
  ├── SCADA / IoT PLC (Level tangki, status CIP, bay sensor)
  ├── LIMS (Hasil uji lab fat, protein, antibiotik, release time)
  ├── MES / ERP SAP (Work orders, jadwal truk tangki, output filling)
             │
             ▼ Export CSV Harian / Streaming
    [ data/real_factory/ ]
             │
             ▼
    [ CsvDataAdapter ]  <-- (src/data/adapter.py)
             │  (Validasi Pydantic Schema Contracts)
             ▼
  [ LactaTwin Decision Core ]
  (Prediksi ML LightGBM + Pengoptimal CP-SAT)
```

---

## 2. Struktur Berkas CSV Riil yang Dibutuhkan

Letakkan berkas CSV di dalam direktori `data/real/` (atau direktori yang Anda tentukan). Format kolom harus sesuai dengan kontrak Pydantic di `src/data/schemas.py`:

### A. `tanker_trips.csv` (Data Perjalanan & Penerimaan Truk Tangki)
| Kolom | Tipe | Deskripsi | Contoh |
| :--- | :--- | :--- | :--- |
| `trip_id` | String | ID Unik perjalanan truk | `TRIP-20261101-01` |
| `farm_id` | String | Kode peternakan / KUD | `FARM-01` |
| `driver_id` | String | ID Driver (Pseudonim) | `DRV-882` |
| `truck_plate` | String | Nomor plat armada | `N-1234-AA` |
| `departure_time_minute` | Int | Menit keberangkatan dari 06:00 | `45` |
| `gate_arrival_time_minute` | Int | Menit tiba di gerbang pabrik | `115` |
| `volume_l` | Float | Volume susu segar (Liter) | `10250.0` |
| `qc_status` | String | Status uji mutu awal | `RELEASED` / `REJECTED` |
| `assigned_bay` | String | Bay pembongkaran yang ditugaskan | `UB-01` |
| `assigned_tank` | String | Tangki penerima awal | `SFP-02` |
| `unload_start_minute` | Int | Waktu mulai pompa unloading | `140` |
| `unload_end_minute` | Int | Waktu selesai pompa unloading | `165` |

### B. `lab_tests.csv` (Hasil Uji Mutu LIMS)
| Kolom | Tipe | Deskripsi | Contoh |
| :--- | :--- | :--- | :--- |
| `test_id` | String | ID Uji laboratorium | `LAB-20261101-01` |
| `trip_id` | String | Referensi ke trip truk tangki | `TRIP-20261101-01` |
| `sampling_time_minute` | Int | Menit pengambilan sampel | `118` |
| `duration_minutes` | Int | Durasi pengujian lab | `22` |
| `test_end_minute` | Int | Waktu hasil rilis resmi | `140` |
| `result_released` | Bool | Lolos uji (`True` / `False`) | `True` |
| `fat_pct` | Float | Kadar lemak (%) | `3.85` |
| `protein_pct` | Float | Kadar protein (%) | `3.22` |
| `acidity_sh` | Float | Tingkat keasaman (°SH) | `6.4` |
| `antibiotic_negative` | Bool | Bebas residu antibiotik | `True` |

### C. `production_orders.csv` (Surat Perintah Kerja Produksi)
| Kolom | Tipe | Deskripsi | Contoh |
| :--- | :--- | :--- | :--- |
| `order_id` | String | Nomor SPK / Batch Order | `WO-9901` |
| `sku_id` | String | ID SKU Cairan (`ESL-FC`, `UHT-CH`) | `ESL-FC` |
| `pack_size_code` | String | Kode ukuran kemasan | `LARGE_A` (1000 mL) |
| `market_variant` | String | Target pasar | `LOCAL` / `EXP` |
| `target_volume_l` | Float | Volume target (Liter) | `15000.0` |
| `earliest_start_minute` | Int | Waktu paling awal boleh mulai | `0` |
| `due_time_minute` | Int | Batas waktu siap kirim (Due Date) | `600` |

### D. `cip_events.csv` (Log Pembersihan CIP Aset)
| Kolom | Tipe | Deskripsi | Contoh |
| :--- | :--- | :--- | :--- |
| `event_id` | String | ID Peristiwa CIP | `CIP-20261101-01` |
| `asset_id` | String | Aset yang dicuci (`SFP-01`, `FL-01`) | `SFP-01` |
| `asset_type` | String | Jenis aset | `StorageTank` |
| `trigger` | String | Pemicu CIP | `FLAVOUR_CHANGE` |
| `start_time_minute` | Int | Menit mulai siklus cuci | `240` |
| `duration_min` | Int | Durasi riil siklus pencucian | `75` |
| `end_time_minute` | Int | Menit selesai verifikasi bersih | `315` |
| `clean_status` | Bool | Verifikasi swab/uji bilas bersih | `True` |

---

## 3. Langkah-Langkah Mengganti Dataset

### Langkah 1: Ekspor & Sanitasi Data
1. Pastikan nama asli perusahaan tidak tercantum dalam dokumen atau data ekspor (tetap gunakan tag anonim `[Nama Pabrik]`).
2. Jangan menyertakan data pribadi operator atau sopir (gunakan ID samaran/pseudonim).
3. Simpan seluruh berkas CSV di folder `data/real/`.

### Langkah 2: Menggunakan `CsvDataAdapter` dalam Python
Muat data riil menggunakan adapter bawaan:

```python
from pathlib import Path
from src.data.adapter import CsvDataAdapter
from src.data.config_loader import load_master_config
from src.opt.validator import ScheduleValidator

# 1. Inisialisasi adapter dengan path data riil
real_data_dir = Path("data/real")
adapter = CsvDataAdapter(real_data_dir)

# 2. Muat seluruh kontrak data yang tervalidasi Pydantic
trips = adapter.load_tanker_trips()
lab_tests = adapter.load_lab_tests()
orders = adapter.load_production_orders()
cip_events = adapter.load_cip_events()

print(f"Berhasil memuat {len(trips)} data perjalanan riil.")
```

### Langkah 3: Uji Integritas & Validasi Mandiri
Jalankan ScheduleValidator (Rule R4) pada data riil untuk memastikan neraca massa dan gerbang QC terpenuhi sebelum menjalankan optimasi:

```python
config = load_master_config()
validator = ScheduleValidator(config)

report = validator.validate_full_execution(
    trips=trips,
    lab_tests=lab_tests,
    opening_stock_l=40000.0,
    closing_stock_l=60000.0,
    filling_outputs=adapter.load_filling_outputs()
)

if report.is_valid:
    print("Data riil valid dan mematuhi seluruh batasan fisik!")
else:
    print(f"Ditemukan {report.total_violations} anomali pada data riil:")
    for v in report.violations:
        print(f" - [{v.rule_id}] {v.message}")
```

### Langkah 4: Melatih Ulang Model Prediksi ML
Setelah data riil termuat, Anda dapat melatih ulang model LightGBM dengan:

```bash
PYTHONPATH=. .venv/bin/python src/predict/train.py --data-dir data/real/
```
Model baru akan otomatis terdaftar di `models/registry/` lengkap dengan git SHA dan timestamp audit.
