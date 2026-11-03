# LactaTwin Assumptions and Placeholder Parameter Registry

> **KLASIFIKASI DATA: DATA SINTETIS**  
> **STUDI KASUS: [Nama Pabrik]**  
> Seluruh metrik, durasi, flow rate, dan jadwal di bawah ini berbasis model sintetis dan asumsi teknik operasional. Tidak ada data rahasia riil yang terekspos.

Dokumen ini mencatat seluruh parameter yang ditandai `placeholder: true` pada `configs/master.yaml`, dasar asumsi teknis, dampaknya pada model CP-SAT dan simulator discrete-event, serta rekomendasi validasi saat data riil pabrik tersedia.

---

## 1. Parameter Placeholder Registry

| No | Modul / Path Konfigurasi | Nilai Default | Satuan | Deskripsi & Rasional Teknik | Dampak pada Optimasi / Simulasi |
|:---|:---|:---|:---|:---|:---|
| 1 | `receiving.bay_flow_lph` | 25,000 | L/jam | Kapasitas discharge pump bay unloading. | Menentukan durasi unloading: $T = V / Q$. |
| 2 | `receiving.bay_cip_min` | 45 | menit | Durasi cleaning manifold bay penerimaan. | Memblokir bay sebelum melayani tanker berikutnya bila diperlukan CIP. |
| 3 | `receiving.slot_tolerance_min` | 30 | menit | Batas toleransi deviasi slot kedatangan truk tangki. | Menentukan batas constraint window kedatangan di CP-SAT. |
| 4 | `receiving.tanker_volume_distribution` | Mean: 10,000, Std: 800, Min: 8,000, Max: 12,000 | Liter | Distribusi volume muatan truk tangki susu segar. | Menggerakkan neraca massa harian dan durasi pembongkaran. |
| 5 | `lab.n_channels` | 2 | unit | Saluran uji paralel lab QC milk reception. | Membatasi throughput uji sampel; antrean uji lab. |
| 6 | `lab.default_duration_min` | 20 | menit | Durasi uji rapid test (alkohol, antibiotik, densitas, fat, protein). | Waktu minimum sebelum status *Released* diberikan (`RECEIVING_GATE`). |
| 7 | `lab.qc_pass_rate_default` | 96% (0.96) | rasio | Rata-rata tingkat kelulusan QC susu segar dari peternakan. | Truk yang gagal uji (4%) langsung ditolak dan tidak masuk bay. |
| 8 | `degassing.process_speed_lph` | 35,000 | L/jam | Throughput alat degassing penghilang busa/udara. | Bukan bottleneck (`DEGASSING` constraint). |
| 9 | `raw_milk_buffer_tanks.capacity_l` | 50,000 | Liter | Kapasitas tampung RMT-01..03 sebelum pasteurisasi/termisasi. | Buffer jika thermizer tertunda atau terjadi lonjakan penerimaan. |
| 10 | `raw_milk_buffer_tanks.holding_max_h` | 24 | jam | Batas maksimum susu mentah dingin sebelum diolah. | Hard constraint holding time agar susu tidak rusak. |
| 11 | `thermizer.speed_lph` | 25,000 | L/jam | Kecepatan unit pasteurisasi awal TH-01 dan TH-02. | Mengatur debit aliran masuk ke tangki SFP. |
| 12 | `thermizer.cip_min` | 90 | menit | Durasi sirkulasi CIP thermal heat exchanger. | Aset thermizer tidak dapat digunakan selama CIP. |
| 13 | `storage_tanks.units[].capacity_l` | 60,000 | Liter | Usable capacity tangki SFP (SFP-01 s/d SFP-15). | Batas atas penyimpanan material susu pasteurisasi. |
| 14 | `storage_tanks.units[].in_out_lph` | 25,000 | L/jam | Laju aliran inlet dan outlet pipa tangki SFP. | Batas laju transfer ke tangki dan ke sterilizer. |
| 15 | `storage_tanks.units[].holding_max_h` | 48 | jam | Umur simpan maksimum susu pasteurisasi dingin di SFP. | Mencegah penuaan lot susu; penalti latensi penyimpanan. |
| 16 | `storage_tanks.units[].cip_min` | 75 | menit | Durasi CIP tangki penyimpanan setelah kosong. | Aturan `CIP_EMPTY`: Tangki kosong wajib CIP sebelum refill. |
| 17 | `sterilizer.units[].speed_lph` | 15,000 | L/jam | Throughput sterilizer UHT / ESL (ST-01..05). | Bottleneck penyuplai ke Aseptic Tank. |
| 18 | `sterilizer.units[].cip_min` | 120 | menit | Durasi pencucian sterilizer suhu tinggi (sterilisasi basah). | Downtime wajib setelah campaign selesai atau ganti varian. |
| 19 | `aseptic_tanks.units[].capacity_l` | 30,000 | Liter | Kapasitas tangki aseptis steril (AT-01..05). | Buffer penyuplai langsung ke Filling Line. |
| 20 | `aseptic_tanks.units[].min_level_l` | 3,000 | Liter | Batas minimum level sebelum line diizinkan filling. | Menjaga tekanan konstan dan mencegah gelembung udara di filling line. |
| 21 | `filling_lines.speeds` | 7,000 - 12,000 | pack/jam | Kecepatan nominal mesin kemas FL-01 s/d FL-10. | Menentukan laju penarikan volume cair: $L/jam = pph \times mL / 1000$. |
| 22 | `changeover.variant_change_min` | 90 | menit | Ganti flavour/formula (misal Strawberry $\rightarrow$ Full Cream). | Mengoverride size change & paper change; independen dari CIP. |
| 23 | `changeover.size_change_min` | 60 | menit | Ganti ukuran kemasan (misal 1000 mL $\rightarrow$ 950 mL). | Mengoverride paper change; mekanik forming die diganti. |
| 24 | `changeover.paper_change_min` | 20 | menit | Ganti gulungan kertas karton (misal Local $\rightarrow$ Export). | Hanya downtime pergantian packaging material di line. |
| 25 | `plant_derating.utilisation_pct` | 0.95 (95%) | rasio | Faktor derating ketersediaan akibat micro-stop & kalibrasi. | Merapatkan kapasitas riil tanpa random breakdown di optimizer. |

---

## 2. Asumsi Model Simulator (Discrete-Event)

1. **Jadwal Hari Bisnis:**  
   Satu hari operasional dihitung mulai pukul **06:00 pagi** sampai **06:00 pagi keesokan harinya** (1440 menit). Seluruh waktu dimodelkan dalam integer menit integer offset dari 06:00.

2. **Kepadatan Susu & Neraca Massa:**  
   Densitas susu diasumsikan standar $1.0\text{ kg/L}$. Neraca massa mengikuti hukum konservasi:
   $$\text{Stok Awal} + \sum \text{Susu Masuk} = \sum \text{Output Kemasan} + \sum \text{Loss Tercatat} + \text{Stok Akhir}$$
   Faktor penggunaan susu: **Full Cream = 100%**, **Flavour (Cokelat/Stroberi) = 90%** (10% sisanya adalah gula, premix, dan perisa).

3. **Logika Gate Penerimaan:**  
   Bongkar muat tanker **TIDAK PERNAH** dapat dimulai sebelum hasil uji lab dirilis (*Released*). Jika hasil uji lab tertunda di simulator, proses unloading otomatis menunggu di antrean gerbang.

4. **Independent Schedule Validator:**  
   Validator jadwal dirancang murni dengan logika Python standar (tanpa library solver `ortools`) untuk memverifikasi non-overlapping bays, batas holding time tangki, aturan sekuens CIP, dan ketersediaan mesin.

---

## 3. Rencana Penggantian ke Data Riil

Ketika sistem dihubungkan ke database SCADA/ERP/LIMS pabrik:
* Mengganti generator sintetis dengan `CsvDataAdapter` atau API data connector.
* Menyesuaikan nilai pada `configs/master.yaml` dan mengubah flag `placeholder: false`.
* Melakukan kalibrasi ulang model regresi kuantil LightGBM dengan observasi aktual.

---

## 4. Distribusi Generator Data Sintetis (Phase 1)

Generator sintetis dijalankan dengan seed tetap (`seed=42`) untuk menjamin determinisme (Rule R5):

1. **Model Estimasi Waktu Tiba (ETA):**
   $$\text{ETA} = \text{departure\_time} + \left( \text{base\_transit\_time} \times \exp(\mathcal{N}(0, 0.12^2)) \times \text{rush\_factor} \right)$$
   * **Departure Delay:** $\mathcal{U}(-10, +20)$ menit terhadap rencana jadwal keberangkatan peternakan.
   * **Base Transit per Farm:**
     - `FARM-01`: $45\text{ menit}$ (jarak dekat, $7\text{ rit/hari}$)
     - `FARM-02`: $75\text{ menit}$ ($6\text{ rit/hari}$)
     - `FARM-03`: $110\text{ menit}$ ($6\text{ rit/hari}$)
     - `FARM-04`: $140\text{ menit}$ ($5\text{ rit/hari}$)
     - `FARM-05`: $180\text{ menit}$ (jarak terjauh, $6\text{ rit/hari}$)
   * **Rush-Hour Multiplier:**
     - Jam sibuk pagi ($07:00 - 09:00$ / menit $60..180$): pengali $1.35\times$.
     - Jam sibuk sore ($16:00 - 18:00$ / menit $600..720$): pengali $1.25\times$.
     - Di luar jam sibuk: $1.0\times$.

2. **Distribusi Durasi Uji Lab:**
   $$\text{Durasi} = \max\left(10, \text{round}\left(\text{Lognormal}(\mu=\ln(20.0), \sigma=0.18)\right) + \text{shift\_delay}\right)$$
   * **Shift Handover Delay:** Ditambahkan $+8\text{ menit}$ antrean jika waktu sampling berada dalam rentang $\pm 20\text{ menit}$ dari pergantian shift ($06:00$, $14:00$, $22:00$).

3. **Tingkat Kegagalan Mutu (QC Fail Rate) per Farm:**
   * `FARM-01`: $2.0\%$ (Kualitas stabil prima)
   * `FARM-02`: $3.0\%$
   * `FARM-03`: $4.0\%$
   * `FARM-04`: $2.5\%$
   * `FARM-05`: $5.0\%$ (Resiko kontaminasi atau asam lebih tinggi akibat jarak jauh)
   * *Penegakan Gate:* Truk dengan QC Gagal langsung berstatus `REJECTED`, dilarang masuk bay unloading, dan muatannya tidak masuk neraca produksi.

4. **Order Mix dan Neraca Massa:**
   * Campuran produk: ESL Full Cream, ESL Cokelat, UHT Full Cream, UHT Cokelat, ESL Stroberi.
   * Setiap hari konsumsi diatur sesuai debit penerimaan susu segar yang lolos uji sehingga:
     $$\text{Opening Stock} + \text{Total Milk In} = \text{Liquid Consumed} + \text{Closing Stock} \quad (\text{Residual} < 0.01\text{ L})$$

5. **Replanning Thresholds & Monte Carlo Simulation (Phase 5):**
   * `eta_shift_min`: $30\text{ menit}$. Jadwal ulang receiving dipicu jika deviasi kedatangan truk melebihi batas ini.
   * `lab_overrun_min`: $20\text{ menit}$. Dipicu jika pengujian lab melebihi estimasi P80.
   * `cip_overrun_min`: $20\text{ menit}$. Dipicu jika siklus pencucian tangki/line melebihi waktu SOP.
   * `frozen_window_min`: $60\text{ menit}$. Tugas yang sedang berjalan atau dijadwalkan dalam $60\text{ menit}$ ke depan dibekukan untuk stabilitas operasional.
   * `monte_carlo_samples`: $N = 200$. Evaluasi risiko antrean truk ($P(\text{waiting} > 30\text{ min})$) dengan sampling durasi dari distribusi prediksi. Gate pelanggaran lab dipastikan 0 karena unloading hanya dimulai pasca status `RELEASED`.

