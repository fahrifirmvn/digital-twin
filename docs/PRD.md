# PRD: LactOS Digital Twin

Tim Rawon Gank, Politeknik Negeri Jember | Program PLAY IT! PLUS Deeptech Hackathon 2026 | Studi kasus [Nama Pabrik] | Versi 1.0 (draft untuk review tim) | 28 Oktober 2026

## 1. Ringkasan Produk

LactOS Digital Twin adalah aplikasi web yang menampilkan Milk Plant [Nama Pabrik] sebagai twin digital 3D yang hidup, mulai dari truk tangki tiba sampai susu siap dikemas. Twin dijalankan oleh simulator berbasis event, dijadwalkan oleh solver optimasi, diprediksi oleh model machine learning, dan diajak berdiskusi lewat Asisten Operator (LLM). PPIC dapat bertanya, mensimulasikan gangguan, menyusun ulang jadwal, membandingkannya dengan baseline FIFO, lalu menyetujuinya. QA memegang keputusan rilis mutu. Seluruh keputusan tercatat di audit log yang tidak dapat diubah dan dapat ditelusuri mundur maupun maju.

Produk ini menjawab dua isu dari materi bootcamp: (1) Receiving Flow dan Dynamic Plan Visibility, (2) End-to-End Milk Traceability.

### Prinsip desain

1. **Satu sumber kebenaran.** State twin adalah satu-satunya sumber data untuk 3D, Gantt, KPI, dan chat. Tidak ada animasi hardcoded.
2. **Mutu adalah syarat jalan.** Setiap tahap hanya berjalan jika tahap sebelumnya lulus mutu dan aset siap. Gate bersifat deterministik, bukan ML.
3. **AI mengusulkan, manusia memutuskan.** PPIC menyetujui jadwal, QA memutuskan rilis. LLM tidak pernah memutuskan.
4. **Angka hanya dari tool.** Semua angka di jawaban asisten berasal dari output solver, simulator, atau database, dengan tombol sumber.
5. **Kejujuran data.** Seluruh data berlabel DEMO. Hasil KPI adalah hasil simulasi di bawah asumsi terdokumentasi, bukan klaim dampak nyata di pabrik.

## 2. Latar Belakang dan Problem

### 2.1 Fakta dari materi bootcamp

- Kapasitas pengolahan 320 ton susu per hari, maksimal 450 ton. Utilisasi Milk Plant sekitar 95%. Peternakan 18.000 ekor sapi. Kebutuhan susu nasional naik 29,89% YoY.
- Permintaan produksi dan rencana kedatangan susu segar naik dari 2025 sampai Q4 2026.
- Alur kedatangan: Farms, On the way, Sampling, Lab test, Released, Unloading, Stored.
- Konfigurasi proses: Unloading, Degassing, Raw Milk Buffer, Thermal Processing, Separation/Standardization, Storage, Premix, Mixing, Cream, Sterilization, Aseptic Tanks, Filling Machines.
- Departemen yang saling bergantung: Farms, PPIC, Production.

### 2.2 Dua celah kritis

| Isu | Masalah | Dampak |
| --- | --- | --- |
| 01 Receiving Flow dan Dynamic Plan Visibility | Antrean truk, kesiapan bay, ketersediaan aset, dan kondisi CIP belum terhubung dalam satu rencana dinamis | Truk menunggu, susu lulus uji tertahan di tangki, keputusan lambat |
| 02 End-to-End Milk Traceability | Serah terima batch di tengah alur proses belum lengkap (visibility gap antara storage/transfer tank dan processing) | Penelusuran dari peternakan sampai barang jadi sulit, hold dan recall lambat |

### 2.3 Konstrain konfigurasi (dari slide bootcamp)

Flow rate, availability dan maintenance, holding time, downtime/CIP/breakdown, storage capacity, production constraint SOP (changeover kertas, ukuran, rasa), satu aseptic tank melayani dua filling line, aset hilir dipakai bersama, gangguan hilir dapat menunda aliran hulu.

## 3. Sasaran, Metrik, dan Non-Goals

### 3.1 Metrik keberhasilan

Semua target dihitung dari simulasi dengan jumlah run dan seed tetap, dibandingkan dengan baseline FIFO pada skenario yang sama.

| KPI | Definisi | Target di simulasi |
| --- | --- | --- |
| Waktu tunggu truk | Selisih waktu tiba dan mulai bongkar | Turun 20 sampai 30% vs FIFO |
| Waktu tunggu lab | Selisih sampling dan hasil uji dirilis | Turun 20 sampai 30% vs FIFO |
| Waktu susu di tangki | Lama susu lulus uji menunggu diproses | Turun vs FIFO, tanpa melewati holding time |
| CIP tak terjadwal | Jumlah CIP darurat per hari | Turun vs FIFO |
| Utilisasi aset | Persen waktu aset produktif | Naik vs FIFO |
| Reject pengemasan | Persen batch terdampak changeover atau gangguan | Turun vs FIFO |
| Ketepatan jadwal | Persen skenario Monte Carlo selesai sesuai rencana | Lebih tinggi dari FIFO dan CP-SAT rata-rata |
| Waktu penelusuran | Dari input batch sampai graf lengkap | Kurang dari 1 menit, cakupan 100% data DEMO |
| False accept rate | Produk tidak layak yang lolos gate | 0 pada seluruh skenario uji |

### 3.2 Non-goals

- Tidak terhubung ke sensor atau sistem [Nama Pabrik] sungguhan (sensor disimulasikan).
- Tidak menggantikan keputusan PPIC atau QA, dan tidak mengotomasi rilis produk.
- Bukan ERP atau WMS. Cakupan hanya Milk Plant sampai siap dikemas.
- Tidak mengklaim dampak nyata di pabrik. Angka adalah hasil simulasi.
- Yogurt Plant dan Cheese Plant masuk roadmap replikasi, bukan MVP.

## 4. Persona dan Peran

| Persona | Kebutuhan utama | Halaman utama |
| --- | --- | --- |
| PPIC | Melihat rencana dinamis, mensimulasikan gangguan, menyusun ulang, menyetujui jadwal | Twin 3D, Gantt, KPI, Asisten AI, Approval |
| QA/Lab | Memutuskan lulus atau tahan, memantau gate, menelusuri batch | Gate Mutu, Traceability |
| Operator produksi | Tugas aktif, status aset, konfirmasi serah terima | Operator View |
| Sopir tangki | Check-in kedatangan, slot bongkar, bekerja tanpa sinyal | Driver PWA |
| Admin | Konfigurasi aset, ambang mutu, pengguna | Konfigurasi |
| Observer/Juri | Menjalankan demo dan melihat bukti | Mode Demo |

### Matriks izin

| Aksi | PPIC | QA | Operator | Sopir | Admin | Asisten Operator |
| --- | --- | --- | --- | --- | --- | --- |
| Lihat twin dan KPI | Ya | Ya | Ya | Terbatas | Ya | Ya (baca) |
| Jalankan skenario | Ya | Tidak | Tidak | Tidak | Ya | Ya (atas permintaan PPIC) |
| Ajukan jadwal | Ya | Tidak | Tidak | Tidak | Tidak | Ya (hanya mengajukan) |
| Setujui jadwal | Ya | Tidak | Tidak | Tidak | Tidak | Tidak |
| Putuskan lulus atau tahan mutu | Tidak | Ya | Tidak | Tidak | Tidak | Tidak |
| Ubah ambang mutu | Tidak | Usul | Tidak | Tidak | Ya (dengan validasi QA) | Tidak |
| Check-in truk | Tidak | Tidak | Ya | Ya | Tidak | Tidak |
| Lihat audit log | Ya | Ya | Tidak | Tidak | Ya | Ya (baca) |

## 5. Ruang Lingkup dan Prioritas

| Prioritas | Fitur |
| --- | --- |
| **P0 (wajib untuk demo final)** | Simulator twin, generator data DEMO, Twin Canvas (2D lalu 3D), Gantt, KPI Panel, Scheduler CP-SAT + baseline FIFO, Predictor kuantil, Monte Carlo, Gate Engine, Traceability (back dan forward), audit log hash-chain, Asisten Operator dengan tool calling, Approval Modal, skenario preset |
| **P1 (sangat diinginkan)** | Re-optimasi rolling otomatis, Anomaly Detector, Driver PWA offline-first, Operator View, perbandingan ablation otomatis, Scenario Panel manual |
| **P2 (jika waktu ada)** | Partikel aliran susu, animasi truk detail, transisi kamera sinematik, ekspor laporan PDF, mode multi-bahasa |

## 6. Arsitektur Sistem

```
+---------------------------------------------------------------+
|  BROWSER                                                      |
|  Twin 3D (Three.js) | Gantt | KPI | Asisten AI | Approval   |
|  HUD = HTML di atas canvas | Driver PWA (offline-first)       |
+--------------------------+------------------------------------+
                           | HTTPS + WebSocket (Reverb)
+--------------------------v------------------------------------+
|  WEB APP (Laravel)                                            |
|  Auth, role, halaman, relay realtime, antrean job, PWA sopir  |
+--------------------------+------------------------------------+
                           | REST + event (internal)
+--------------------------v------------------------------------+
|  ENGINE SERVICE (Python, FastAPI)                             |
|  Data Generator | Predictor | Scheduler | Twin Simulator      |
|  Gate Engine | Anomaly | LLM Orchestrator | KPI Evaluator     |
+--------------------------+------------------------------------+
                           |
+--------------------------v------------------------------------+
|  POSTGRESQL                                                   |
|  State pabrik, genealogi batch, jadwal, audit log hash-chain  |
+---------------------------------------------------------------+
```

Pembagian tanggung jawab: Laravel mengurus pengguna dan tampilan. Engine mengurus semua perhitungan dan mengembalikan hasil terstruktur. Laravel tidak pernah menghitung jadwal, dan Engine tidak mengurus pengguna.

## 7. Tech Stack

| Lapisan | Teknologi | Alasan |
| --- | --- | --- |
| Web app | Laravel 11, Blade, Vite | Sesuai pembagian tugas proposal |
| Realtime | Laravel Reverb (WebSocket), fallback SSE | Push state twin ke browser |
| 3D | Three.js, kamera ortografis isometrik, aset .glb | Ringan dan dapat dikontrol penuh |
| HUD | HTML, CSS, Alpine.js atau vanilla JS | Murah dan mudah dirawat |
| Engine | Python 3.11, FastAPI, Pydantic | Ekosistem optimasi dan ML |
| Prediksi | LightGBM (objective quantile), scikit-learn | Cepat, cocok data tabular |
| Solver | OR-Tools CP-SAT | Sesuai proposal, mendukung interval dan no-overlap |
| Simulasi | SimPy (discrete-event) | Cocok antrean, resource, dan gangguan |
| Anomali | scikit-learn Isolation Forest + aturan statistik | Ringan |
| LLM | Function calling (provider dapat dikonfigurasi) | Tool calling andal |
| Database | PostgreSQL 16 | Recursive CTE untuk genealogi, JSONB untuk log |
| Deployment demo | Docker Compose di satu laptop, cadangan di VPS | Demo stabil |

## 8. Model Data

### 8.1 Entitas inti

| Entitas | Atribut utama |
| --- | --- |
| Farm | id, nama, jarak\_km, volume\_rata2, label DEMO |
| Tanker (RT) | id, farm\_id, volume\_ton, suhu\_awal, eta\_prediksi (p50, p80, p90), status |
| LabTest | id, tanker\_id, tipe\_uji, mulai, selesai, hasil (parameter, nilai, lulus), analis |
| Bay | id, status (idle, in-use, CIP, unavailable), flow\_rate\_max |
| Tank | id, tipe (raw buffer, storage, cream, aseptic), kapasitas, level, status (empty, filling, holding, CIP, unavailable), produk\_saat\_ini |
| ProcessUnit | id, tipe (degassing, thermal, separator, sterilizer, mixer), kapasitas\_per\_jam, jendela\_maintenance |
| FillingLine | id, aseptic\_tank\_id, SKU\_saat\_ini, kecepatan |
| SKU | id, nama, ukuran, varian rasa, tipe kemasan, aturan changeover |
| CIPEvent | id, aset\_id, tipe, mulai, selesai, terjadwal atau darurat |
| Batch | id, tipe (raw, intermediate, FG), volume, status, label DEMO |
| TransferEvent | id, dari\_aset, ke\_aset, batch\_id, volume, waktu |
| Schedule dan ScheduleVersion | id, versi, status (usulan, aktif, diganti), pembuat, kpi\_prediksi |
| Scenario | id, parameter JSON tervalidasi, hasil\_kpi, seed |
| ConstraintSet | id, aturan keras (SOP, QA), preferensi |
| GateDecision | id, tahap, objek, keputusan (lulus, tahan), alasan, pemutus |
| AuditLog | id, waktu, aktor, aksi, payload, prev\_hash, hash |

### 8.2 Genealogi batch

Genealogi dimodelkan sebagai graf: `Tanker -> RawBatch -> Tank -> IntermediateBatch -> FillingLine -> FGLot`. Trace back dan trace forward adalah query graf (recursive CTE) dengan setiap TransferEvent sebagai sisi. Setiap perpindahan susu antar aset wajib menghasilkan TransferEvent. Inilah yang menutup visibility gap pada Isu 02.

### 8.3 Audit log hash-chain

Setiap baris menyimpan `hash = SHA256(prev_hash + payload + waktu)`. Tabel hanya mengizinkan INSERT (tanpa UPDATE dan DELETE lewat izin database). UI menyediakan tombol Verifikasi Integritas yang menghitung ulang rantai dan menandai baris pertama yang tidak cocok. Yang dicatat: keputusan gate, persetujuan dan override jadwal, perubahan ambang, tool call LLM beserta parameternya, dan percakapan asisten.

## 9. Konfigurasi Twin Pabrik

### 9.1 Topologi (mengikuti slide Milk Processing Configuration)

```
Unloading (bay) -> Degassing (2) -> Raw Milk Buffer (2 tank)
                              \-> Thermal Processing (2)
Thermal -> Separation/Standardization (2) -> Storage (6 tank)
Premix (1) -> Mixing (2) -> Storage / Cream (3 tank)
Storage -> Sterilization (5) -> Aseptic Tank (5) -> Filling (10 line)
```

Satu aseptic tank melayani dua filling line, sehingga lima aseptic tank melayani sepuluh filling line. Aliran dibedakan dengan warna pipa sesuai legenda bootcamp: main milk (biru), cream (oranye), premix (ungu), mixed product (pink), menuju sterilisasi dan aseptic (merah tua).

### 9.2 Parameter asumsi (semua berlabel DEMO, dapat diubah di konfigurasi)

| Parameter | Nilai awal | Catatan |
| --- | --- | --- |
| Volume harian | 320 ton (skenario puncak 450 ton) | Dari bootcamp |
| Volume per truk | 20 sampai 25 ton | Asumsi |
| Jumlah truk per hari | sekitar 14 sampai 20 | Turunan dari volume |
| Bay unloading | 4 | Asumsi dari slide constraint |
| Durasi uji lab | 30 sampai 90 menit, ekor panjang | Asumsi |
| Holding time maksimal susu di tangki | Dikonfigurasi, nilai awal 4 jam | Asumsi, harus dikonfirmasi QA |
| Durasi CIP tangki | 60 sampai 90 menit | Asumsi |
| Changeover SKU | Berbeda per transisi (kertas, ukuran, rasa) | Asumsi |

Semua asumsi ditampilkan di halaman Konfigurasi dan diekspor bersama laporan, supaya juri dan [Nama Pabrik] dapat mengoreksinya.

### 9.3 Aturan gate mutu (deterministik)

| Gate | Syarat lulus | Aksi jika gagal |
| --- | --- | --- |
| G1 Truk tiba | Suhu dan dokumen (surat jalan) sesuai | Truk ditahan di area antre |
| G2 Hasil lab | Seluruh parameter dalam ambang QA | Truk ditolak atau ditahan, bay tidak dialokasikan |
| G3 Unloading ke tangki | Tangki kosong, bersih (CIP selesai), kompatibel | Alihkan ke tangki lain atau tunggu |
| G4 Pra-sterilisasi | Holding time belum terlampaui, produk sesuai rute | Batch ditahan, notifikasi QA |
| G5 Sterilisasi | Parameter suhu dan holding time terpenuhi, tanpa divert valve aktif | Produk dialihkan, batch ditahan |
| G6 Siap kemas | Aseptic tank steril, line tersedia, tanpa penahanan QA | Jadwal filling ditunda |

## 10. Desain AI: Di Mana AI Bekerja dan Apa Buktinya

Ukuran substantif: jika komponen AI dicabut, KPI memburuk dan dapat dibuktikan lewat perbandingan. Loop utamanya adalah **Predict, Optimize, Simulate**, dibungkus **Asisten Operator**.

```
Predictor (kuantil) -> Scheduler (CP-SAT) -> Twin Monte Carlo -> pilih jadwal terbaik
      ^                                                         |
      +-------- event nyata (truk telat, CIP gagal) <-----------+
                         Asisten Operator menjembatani PPIC ke semua tool
```

### 10.1 Predictor (machine learning)

| Model | Target | Fitur | Keluaran |
| --- | --- | --- | --- |
| ETA truk | Waktu tiba | Farm, jarak, jam, hari, riwayat keterlambatan, jadwal | P50, P80, P90 |
| Durasi uji lab | Lama uji | Tipe uji, panjang antrean lab, jam, jumlah analis | P50, P80, P90 |
| Durasi CIP dan changeover | Lama | Tipe, ukuran tangki, SKU sebelum dan sesudah | P50, P80, P90 |

Metode: LightGBM dengan objective quantile. Evaluasi: pinball loss, MAE P50, dan coverage (P90 harus mencakup sekitar 90% kasus). Pembanding: rata-rata historis. Nilai rentang inilah yang membuat jadwal tahan terhadap ketidakpastian.

### 10.2 Scheduler (optimasi, AI klasik)

Disebut jujur sebagai optimasi berbasis constraint programming, bukan machine learning.

- **Variabel:** slot dan bay tiap truk, urutan uji lab, penugasan tangki, penugasan sterilizer, aseptic tank, dan filling line, serta interval CIP dan changeover.
- **Konstrain keras:** no-overlap per bay, per sterilizer, dan per filling line. Kapasitas dan level tangki (cumulative). Tangki harus CIP sebelum dipakai ulang. Durasi bongkar = volume dibagi flow rate. Susu hanya boleh dibongkar setelah status Released. Holding time maksimal. Jendela maintenance. Satu aseptic tank melayani dua line. Changeover bergantung urutan SKU.
- **Fungsi tujuan (berbobot, dapat diatur):** minimalkan waktu tunggu truk, waktu susu di tangki, CIP tak terjadwal, jumlah changeover, dan keterlambatan terhadap target produksi.
- **Robustness:** tahap kritis (aseptic tank bersama dan sterilizer) memakai durasi P80 sebagai buffer.
- **Baseline:** FIFO atau FCFS dengan aturan dispatch sederhana.
- **Re-optimasi rolling:** dipicu event (truk telat, CIP gagal, aset mati). Pekerjaan yang sedang berjalan dibekukan, solver dibatasi 10 sampai 20 detik, memakai warm start dari jadwal sebelumnya, dan penalti perubahan agar jadwal tidak berubah drastis.

### 10.3 Twin Simulator dan Monte Carlo

SimPy mensimulasikan antrean, bay, tangki, sterilizer, dan filling dengan durasi yang disampel dari distribusi hasil Predictor. Setiap jadwal calon dijalankan 200 kali (dapat diatur) dengan gangguan acak (sterilizer mati, lonjakan truk, CIP molor, hasil lab di luar batas). Keluarannya adalah persentase skenario tepat waktu, serta KPI pada P50 dan P90. Jadwal dipilih berdasarkan skor yang memperhitungkan risiko, bukan hanya nilai rata-rata. Seed disimpan agar hasil dapat direproduksi.

### 10.4 Gate Engine (bukan ML)

Aturan deterministik dari konfigurasi QA. Tidak ada model yang boleh meloloskan produk. Ini menjaga false accept rate di angka 0.

### 10.5 Anomaly Detector (pelengkap)

Isolation Forest ditambah aturan statistik multivariat pada suhu, tekanan, flow, holding time, dan divert valve. Hasilnya memicu peringatan dan hold untuk ditinjau QA, bukan keputusan otomatis. Prediksi kelulusan sampel hanya dipakai sebagai **prioritas antrean uji**, sedangkan sampel meragukan tetap diuji penuh.

### 10.6 Asisten Operator (antarmuka percakapan ke seluruh mesin)

LLM tidak menghitung jadwal. Ia memanggil tool yang terdefinisi ketat dan merangkum hasilnya.

| Tool | Fungsi | Izin |
| --- | --- | --- |
| `get_state` | Baca status truk, tangki, CIP, aset, batch | Baca |
| `run_scenario` | Jalankan gangguan di twin | PPIC, Admin |
| `solve_schedule` | Panggil CP-SAT dengan parameter atau konstrain baru | PPIC |
| `compare_schedules` | Bandingkan KPI antar jadwal (FIFO, CP-SAT rata-rata, CP-SAT kuantil) | Baca |
| `explain` | Tarik jejak keputusan solver dan audit log | Baca |
| `trace_batch` | Trace back dan forward | Baca |
| `propose_plan` | Ajukan jadwal ke PPIC (tidak dapat menerapkan) | PPIC |

**Alur percakapan:** pengguna mengetik, LLM memilih tool, parameter divalidasi skema Pydantic, tool dijalankan Engine, hasil terstruktur kembali ke LLM, LLM menyusun jawaban dengan rujukan ID dan tombol Lihat Data, UI memperbarui twin, Gantt, dan KPI.

**Penerjemahan bahasa alami ke konstrain:** permintaan seperti susu dari bay 2 tidak boleh menunggu di tangki lebih dari 90 menit diubah menjadi objek konstrain JSON. UI menampilkan diff konstrain untuk dikonfirmasi PPIC sebelum solver memakainya (didukung referensi \[5\] proposal).

**Guardrail wajib:**

1. Angka hanya dari output tool. Jawaban tanpa sumber ditolak oleh validator.
2. Perubahan dilakukan dua langkah: LLM mengusulkan, PPIC menyetujui dengan alasan.
3. Konstrain keras (SOP, ambang QA, holding time) tidak dapat diubah lewat chat. Permintaan yang melanggar ditolak dengan penjelasan.
4. Keputusan rilis mutu tidak dapat dijangkau LLM.
5. Seluruh percakapan dan tool call masuk audit log.
6. Izin tool mengikuti peran pengguna.
7. Fallback: jika API LLM gagal, form Scenario Panel tetap berfungsi, dan skenario preset tersedia untuk demo.

### 10.7 Bukti: studi ablation

| Konfigurasi | Isi | Menjawab |
| --- | --- | --- |
| A | FIFO | Baseline |
| B | CP-SAT dengan durasi rata-rata | Nilai optimasi |
| C | CP-SAT dengan durasi kuantil P80 | Nilai prediksi |
| D | C + seleksi jadwal via Monte Carlo + re-optimasi | Nilai simulasi dan ketahanan |

Skenario uji: hari normal, lonjakan truk, sterilizer mati, CIP molor, truk di luar batas mutu, volume puncak 450 ton. Setiap konfigurasi dijalankan pada seed yang sama. Hasil ditampilkan di KPI Panel sebagai tabel perbandingan.

### 10.8 Kejujuran tentang data sintetis

Jika kita sendiri membuat pola dan model hanya mempelajarinya, akurasi tinggi tidak membuktikan apa pun tentang pabrik nyata. Karena itu: (1) hasil dibingkai sebagai validasi pipeline dan logika keputusan di bawah asumsi X, (2) angka seperti 20 sampai 30% disebut hasil simulasi, (3) generator memasukkan noise, ekor panjang, dan gangguan yang tidak dipelajari mudah oleh model, dan (4) seluruh asumsi dapat diaudit dan dikoreksi mitra.
