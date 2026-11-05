# Paket Bukti Proposal & Evaluasi Teknis LactaTwin

> **Label**: `DATA SINTETIS`  
> **Mitra**: `[Nama Pabrik]` (pabrik pengolahan susu; yoghurt dan keju di luar cakupan)  
> **Klaim Kematangan**: **TRL 2–3** (*proof-of-concept* tervalidasi pada simulator *discrete-event* dengan data sintetis)  
> **Prinsip Desain**: AI memprediksi & menjelaskan $\rightarrow$ *optimizer* CP-SAT memutuskan jadwal $\rightarrow$ manusia menyetujui $\rightarrow$ setiap keputusan terekam dalam *audit log* berantai SHA-256 $\rightarrow$ *gate* SOP keras (`G1`–`G6`) tidak pernah dapat dilewati.

---

## 1. Perintah Reproduksibilitas Satu Langkah (*One-Command Reproducibility*)

Seluruh angka di dokumen ini dapat direproduksi kapan saja menggunakan target `make evidence` pada [`Makefile`](file:///home/fahri/Project/digital-twin/Makefile#L1-L16):

```bash
make evidence
```

Atau secara terpisah:
1. **Ablasi 6 Skenario $\times$ 4 Konfigurasi (`A`–`D`) + Waktu Solver & Stabilitas Replan:**
   ```bash
   cd engine && uv run python -u -m scripts.ablation --volume 320 --seeds 3 --scenario all --time-limit 1.5
   ```
2. **Analisis Sensitivitas Parameter Placeholder `"X"` (`cip_minutes`, `holding_max_min`, `n_bays`):**
   ```bash
   cd engine && uv run python -u -m scripts.sensitivity
   ```
3. **Suite Pengujian Deterministik & Validasi Independen:**
   ```bash
   make test && make lint
   ```

---

## 2. Tabel KPI: Baseline (FIFO) vs Hasil Terukur (CP-SAT) vs Target & Metode Pengukuran

Tabel berikut memetakan keempat masalah utama `[Nama Pabrik]` ke indikator kinerja utama (KPI), nilai *baseline* FIFO (`Config A`), nilai terukur `Config C` (CP-SAT P80) dan `Config D` (CP-SAT P80 + *Rolling Replan*), target operasional, serta lokasi perhitungan eksak di kode sumber ([`engine/app/kpi.py`](file:///home/fahri/Project/digital-twin/engine/app/kpi.py#L1-L115), [`engine/app/balance.py`](file:///home/fahri/Project/digital-twin/engine/app/balance.py#L1-L40), [`web/app/Services/TraceService.php`](file:///home/fahri/Project/digital-twin/web/app/Services/TraceService.php#L1-L295)).

| Masalah Mitra `[Nama Pabrik]` | Metrik KPI | Baseline FIFO (`Config A`) | Terukur CP-SAT P80 (`Config C`) | Terukur CP-SAT + Replan (`Config D`) | Target Operasional | Metode Pengukuran & Bukti Kode (`file:line`) |
|---|---|---:|---:|---:|---|---|
| **(1) Kedatangan Tanker & Antrean Penerimaan** | `truck_wait_mean` (skenario `normal`, 320 t) | `71,1 mnt` | `71,2 mnt` | `71,2 mnt` | $\le$ Baseline FIFO tanpa pelanggaran *gate* | Selisih `unload_start - arrived` untuk truk yang dibongkar ([`engine/app/kpi.py:55-61`](file:///home/fahri/Project/digital-twin/engine/app/kpi.py#L55-L61)). |
| **(1) Lonjakan Kedatangan Truk (`truck_surge`)** | `truck_wait_mean` (skenario `truck_surge`) | `99,5 mnt` | `98,9 mnt` | **`97,4 mnt`** (`3/3` seed lebih cepat dari FIFO) | Pangkas antrean saat *surge* | Prioritas `TankPool.reserve(key=unl_key)` & `bays.get()` mengikuti urutan jadwal CP-SAT ([`engine/app/sim.py:249-290,1036-1039`](file:///home/fahri/Project/digital-twin/engine/app/sim.py#L249-L290)). |
| **(2) Rencana Produksi Dinamis & Ketepatan Jadwal** | `schedule_adherence_pct` (`normal` / `sterilizer_down`) | `-` (tanpa rencana) | `30,6%` – `33,3%` | `27,7%` – `35,0%` (hingga `62,6%` pada *budget* 4 dtk) | Pantau deviasi $\le 15\text{ mnt}$ dari rencana | Persentase truk selesai bongkar dengan $\|t_{\text{aktual}} - t_{\text{rencana}}\| \le 15\text{ mnt}$ ([`engine/app/kpi.py:30-42`](file:///home/fahri/Project/digital-twin/engine/app/kpi.py#L30-L42)); kelayakan order 100% FC / 90% Flavour dievaluasi di [`engine/app/orders.py:16-55`](file:///home/fahri/Project/digital-twin/engine/app/orders.py#L16-L55). |
| **(3) Konfigurasi Mesin, Rute Pipa & Urutan SKU** | `changeover_min` (`normal` 320 t) | `113,3 mnt` | **`20,0 mnt` (-82,3%)** | **`0,0 mnt` (-100%)** (`3/3` seed unggul) | Minimalkan kehilangan waktu lini pengisian | Total menit *changeover* ukuran/varian pada `LINE-1..N` ([`engine/app/sim.py:1208-1236`](file:///home/fahri/Project/digital-twin/engine/app/sim.py#L1208-L1236)) dan biaya urutan sirkuit CP-SAT `AddCircuit` ([`engine/app/scheduler.py:252-279`](file:///home/fahri/Project/digital-twin/engine/app/scheduler.py#L252-L279)). |
| **(3) Urutan SKU pada Lonjakan & Beban Puncak** | `changeover_min` (`truck_surge` / `peak_450`) | `446,7 mnt` / `273,3 mnt` | `350,0 mnt` / `193,3 mnt` | **`53,3 mnt` (-88,1%)** / **`30,0 mnt` (-89,0%)** | Hemat $>3\text{ jam/hari}$ kapasitas *filling* | Pengelompokan kampanye SKU oleh *rolling horizon replanner* ([`engine/app/rolling.py:72-125`](file:///home/fahri/Project/digital-twin/engine/app/rolling.py#L72-L125)). |
| **(3) Batas Holding Time (Gate `G4` $\le 240\text{ mnt}$)** | `holding_violations` & `tank_dwell_mean` | `0,0` (`33,6 mnt`) | `0,0` (`33,6 mnt`) | `0,0` (`33,6 mnt`) | **`0` pelanggaran** di semua skenario | Batas keras CP-SAT `ster_start - unload_end <= holding_max_min - 20` ([`engine/app/scheduler.py:216-220`](file:///home/fahri/Project/digital-twin/engine/app/scheduler.py#L216-L220)) dan evaluasi `G4` ([`engine/app/gates.py:67-76`](file:///home/fahri/Project/digital-twin/engine/app/gates.py#L67-L76)). |
| **(3) Keamanan Mutu SOP (`G1`–`G6`)** | `false_accept` | `0` | `0` | `0` | **`0` kompromi mutu** | Truk di luar batas suhu (`G1`) atau hasil lab (`G2`) tidak pernah menghasilkan lot `FG` `released` ([`engine/app/kpi.py:85-92`](file:///home/fahri/Project/digital-twin/engine/app/kpi.py#L85-L92)). |
| **(4) Traceability & Silsilah Mixing/Splitting** | `trace_coverage_pct` | `100,0%` | `100,0%` | `100,0%` | **`100%`** lot FG terlacak ke tanker & peternakan | Penelusuran rekursif *backward* (`FG -> INT -> RAW -> Tanker`) & *forward* (`Tanker -> seluruh FG commingled`) ([`web/app/Services/TraceService.php:37-198`](file:///home/fahri/Project/digital-twin/web/app/Services/TraceService.php#L37-L198)). |
| **(4) Neraca Volume Harian (`06:00–06:00`)** | Residual `start + in - out - end` | `0,00 ton` | `0,00 ton` | `0,00 ton` | **Residual $= 0,00\text{ L}$** ($\rho = 1\text{ kg/L}$) | `start_ton + raw_in_ton == fg_out_ton + qa_hold_ton + loss_ton + end_ton` ([`engine/app/balance.py:11-39`](file:///home/fahri/Project/digital-twin/engine/app/balance.py#L11-L39), [`web/app/Support/Volume.php:10-25`](file:///home/fahri/Project/digital-twin/web/app/Support/Volume.php#L10-L25)). |

---

## 3. Bukti Kecepatan Solver, Skalabilitas 40 Truk, & Stabilitas Replanning

1. **Waktu Penyelesaian CP-SAT (*Wall-Clock Solve Time*):**
   - Pada evaluasi ablasi penuh hulu-ke-hilir ([`docs/ablation-fase4.md`](file:///home/fahri/Project/digital-twin/docs/ablation-fase4.md#L7-L90)), total waktu solver satu hari penuh adalah **`5,1–6,0 detik`** untuk jadwal statis (`Config B`/`C`) dan **`3,1–4,0 detik`** untuk keseluruhan siklus *rolling-horizon replanning* (`Config D`).
   - Pada *benchmark* skala penuh **40 truk, 15 tangki penyimpanan (`ST-01..ST-15`), dan 3 *unloading bay*** (`peak_450`, `423,5 ton` FG), solver CP-SAT selalu menghasilkan jadwal **100% `OPTIMAL` atau `FEASIBLE` (`0` *infeasible*)** dengan `holding_violations = 0,0`.
2. **Stabilitas *Rolling-Horizon Replanning* (`replan_changes`):**
   - Fungsi [`count_assignment_changes(prev, new)`](file:///home/fahri/Project/digital-twin/engine/app/rolling.py#L36-L49) menghitung berapa penugasan aset (`bay`, `sterilizer`, `line`) yang berubah antar-versi jadwal ketika terjadi pemicu dinamis (`unannounced_arrival`, `asset_down`, `qa_hold`, `ster_cip`).
   - Rata-rata perubahan penugasan kumulatif sepanjang hari adalah **`21,7–23,3` perubahan** pada hari normal/`cip_delay` ($\approx 2\text{ perubahan per replan}$), **`33,0` perubahan** saat `sterilizer_down`, dan **`40,0–64,0` perubahan** saat `peak_450` / `truck_surge`. Metrik ini juga ditampilkan secara transparan pada kolom **`Perubahan rute`** di tabel jadwal aplikasi web ([`web/resources/views/runs/_schedule.blade.php:117-146`](file:///home/fahri/Project/digital-twin/web/resources/views/runs/_schedule.blade.php#L117-L146)).

---

## 4. Ringkasan Sensitivitas Parameter Placeholder (`"X"`)

Karena beberapa parameter pabrik mitra bersifat *placeholder* pada brief kompetisi, kami menguji sensitivitas KPI terhadap tiga parameter kunci ([`engine/scripts/sensitivity.py`](file:///home/fahri/Project/digital-twin/engine/scripts/sensitivity.py#L1-L82)):

1. **Jumlah *Unloading Bay* (`n_bays = 1, 2, 3`):**
   - Mengurangi *bay* dari `2` ke `1` meningkatkan waktu tunggu rata-rata truk dari **`71,1 mnt` menjadi `83,1 mnt` (+12,0 mnt / +16,9%)** dan waktu tunggu P90 dari **`112,0 mnt` menjadi `124,0 mnt`**.
   - Menambah *bay* dari `2` ke `3` tidak lagi menurunkan `truck_wait_mean` (`71,1 mnt`), tetapi menurunkan waktu *changeover* pada `Config C` dari **`33,3 mnt` menjadi `20,0 mnt` (-40%)** karena fleksibilitas urutan pelepasan batch ke hilir. Ini membuktikan bahwa pada volume `320 ton/hari`, *bottleneck* penerimaan hulu berada pada transisi `1 -> 2 bay` dan kapasitas analis laboratorium.
2. **Batas *Holding Time* Gate `G4` (`holding_max_min = 120, 240, 360 mnt`):**
   - Baik pada batas ketat `120 mnt` (-50%) maupun `240 mnt` (*baseline*), model CP-SAT berhasil menjaga **`holding_violations = 0,0`** dengan waktu tinggal rata-rata di tangki `33,6 mnt`.
   - Saat batas dilonggarkan menjadi `360 mnt` (+50%), `holding_violations` tetap `0,0`, namun *changeover* `Config C` sedikit naik (`20,0 -> 33,3 mnt`) karena longgarnya jendela waktu membuat solver menerima variasi urutan yang lebih lebar.
3. **Durasi CIP (`45–60 mnt`, `60–90 mnt`, `90–120 mnt`):**
   - Pada beban `320 ton/hari`, peningkatan durasi CIP hingga `90–120 mnt` (+33%) berhasil diserap oleh 10 tangki `TK-STO` dan 5 sterilizer tanpa menimbulkan `holding_violations` (`0,0`) maupun kehilangan output `fg_ton` (`295,4 ton`).

---

## 5. Catatan Kualitas Data Sintetis & Kejujuran Model Prediksi ML

Sesuai aturan kejujuran ilmiah (Rule R6), kami melaporkan karakteristik model *machine learning* ([`engine/models/registry/`](file:///home/fahri/Project/digital-twin/engine/models/registry)) secara apa adanya tanpa klaim berlebihan:

1. **Pencegahan Kebocoran Masa Depan (*Zero Data Leakage*):**
   - Seluruh model dilatih menggunakan pembagian waktu kronologis (`split_method = chronological_70_15_15`: 70% latih, 15% validasi, 15% uji) dan hanya memakai fitur yang tersedia pada saat keputusan dibuat (`availability_at_prediction_time` di [`engine/app/ml/features.py`](file:///home/fahri/Project/digital-twin/engine/app/ml/features.py#L1-L120)).
2. **Perbandingan Jujur terhadap Baseline Naif (`significantly_better`):**
   - Untuk prediksi titik (*point prediction* P50), model LightGBM memiliki MAE yang **setara atau sedikit di atas rata-rata bergerak historis** karena proses pembangkitan data sintetis bersifat stasioner dengan derau acak murni:
     - **ETA Arrival Delay ([`eta_arrival.meta.json`](file:///home/fahri/Project/digital-twin/engine/models/registry/eta_arrival.meta.json#L1-L65)):** `MAE P50 = 7,52 mnt` vs *Moving Average Baseline* `7,23 mnt` (`significantly_better: false`).
     - **Durasi Uji Lab ([`lab_turnaround.meta.json`](file:///home/fahri/Project/digital-twin/engine/models/registry/lab_turnaround.meta.json#L1-L65)):** `MAE P50 = 5,50 mnt` vs *Moving Average Baseline* `5,54 mnt` (`improvement = +0,62%`, `significantly_better: false`).
     - **Durasi CIP ([`cip_duration.meta.json`](file:///home/fahri/Project/digital-twin/engine/models/registry/cip_duration.meta.json#L1-L65)):** `MAE P50 = 6,62 mnt` vs *Moving Average Baseline* `6,38 mnt` (`significantly_better: false`).
3. **Nilai Tambah Utama ML Terletak pada Kalibrasi Kuantil P80/P90, Bukan Prediksi Titik:**
   - Dalam penjadwalan pabrik susu, menjadwalkan dengan nilai rata-rata (`Mean`/`P50`) menyebabkan tabrakan *bay* setiap kali terjadi keterlambatan ekor kanan (*right-tail delay*).
   - Model regresi kuantil LightGBM kami terkalibrasi secara akurat pada kuantil atas:
     - **`eta_arrival`:** Cakupan aktual **`P80 = 80,6%`** (target `80%`), **`P90 = 90,8%`** (target `90%`).
     - **`lab_turnaround`:** Cakupan aktual **`P80 = 83,8%`**, **`P90 = 92,0%`**.
     - **`cip_duration`:** Cakupan aktual **`P80 = 83,3%`**, **`P90 = 92,8%`**.
   - Penggunaan kuantil P80 inilah yang memungkinkan `Config C` dan `Config D` menjaga kepatuhan jadwal dan memangkas *changeover* lini pengisian hingga **82%–100%** tanpa melanggar batas *holding time* `G4`.
4. **Ketahanan terhadap Pergeseran Distribusi (*Traffic Storm Drift* `+25%`):**
   - Pada pengujian *drift* cuaca buruk (`traffic_storm_plus_25pct` di [`eta_arrival.meta.json`](file:///home/fahri/Project/digital-twin/engine/models/registry/eta_arrival.meta.json#L32-L42)), ketika durasi perjalanan melonjak `+25%` tanpa pelatihan ulang, MAE bergeser ke `12,18 mnt` dan cakupan `P80` turun ke `54,0%`. Oleh karena itu, LactaTwin melengkapi prediksi statis dengan **Rolling-Horizon Replanning (`Config D`)** dan deteksi *Isolation Forest* (`anomaly_iforest`) agar jadwal langsung beradaptasi ketika truk terlambat di dunia nyata.

---

## 6. Batasan Sistem Saat Ini (*Honest Limitations*) & Peta Jalan TRL 2–3 $\rightarrow$ TRL 5–6

| Aspek | Status Saat Ini di LactaTwin (TRL 2–3) | Langkah Menuju Pilot Pabrik Nyata (TRL 5–6) |
|---|---|---|
| **Sumber Data** | 100% `DATA SINTETIS` dari simulator SimPy; belum terhubung ke sensor PLC/SCADA atau ERP `[Nama Pabrik]`. | Integrasi konektor baca-saja (*read-only*) ke histori timbangan jembatan, LIMS laboratorium, dan *flowmeter* pasteurizer/sterilizer. |
| **Topologi Tangki** | Memodelkan `5 TK-RAW` (`ST-01..ST-05`, 30.000 L) + `10 TK-STO` (`ST-06..ST-15`, 60.000 L) = **15 tangki penyimpanan** beserta `ASEP-1..5` (`AT-01..AT-05`). | Kalibrasi matriks katup pipa (*valve manifold matrix*) sesuai P&ID aktual `[Nama Pabrik]`. |
| **Aturan Changeover & CIP** | Mendukung matriks *changeover* ukuran (`30 mnt`) & varian (`40 mnt`), CIP wajib *flavour* $\rightarrow$ *Full Cream*, CIP akhir produksi/tangki kosong, dan CIP otomatis batas *fouling* sterilizer (`480 mnt`). | Kalibrasi kurva *fouling* UHT berbasis sensor tekanan diferensial ($\Delta P$) dan suhu uap nyata. |
| **Kontrol & Keamanan** | **Tanpa aktuasi ke peralatan pabrik.** Asisten AI hanya memiliki alat baca, simulasi *what-if*, dan pembuatan draf usulan (`create_proposal`) yang wajib disetujui manusia (PPIC/QA). | Mempertahankan arsitektur *human-in-the-loop* dan tanda tangan audit SHA-256 sesuai standar keamanan pangan dan UU PDP. |
