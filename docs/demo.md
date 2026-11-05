# Skrip Demo LactOS

Semua angka di aplikasi adalah **simulasi** (data sintetis dari mesin SimPy), bukan data pabrik nyata. Sebutkan ini di awal demo.

## Persiapan

```bash
# Engine (terminal 1)
cd engine && ENGINE_INTERNAL_TOKEN=devtoken ENGINE_WEB_URL=http://localhost:8000 \
  uv run uvicorn app.main:app --port 8001

# Web (terminal 2)
cd web && php artisan migrate --seed
ENGINE_INTERNAL_TOKEN=devtoken ENGINE_URL=http://localhost:8001 \
  BROADCAST_CONNECTION=log QUEUE_CONNECTION=sync php artisan serve --port=8000
```

Alternatif: `make up` (docker compose). Untuk halaman Audit, gunakan PostgreSQL (trigger audit tidak ada di sqlite).

Akun demo (kata sandi semuanya `password`): `ppic@demo.test`, `qa@demo.test`, `operator@demo.test`, `driver@demo.test`, `admin@demo.test`, `observer@demo.test`.

Buat satu run terlebih dahulu (halaman Runs, konfigurasi B, skenario normal) dan tunggu statusnya selesai.

## Alur (sekitar 10 menit)

1. **Login sebagai `ppic@demo.test`.** Tunjukkan banner "SIMULASI" dan tombol tema gelap/terang.
2. **Dashboard (`/dashboard`).** Jelaskan KPI (tunggu truk, tunggu lab, CIP darurat, false accept), ubin menuju Digital Twin dan Maps, lalu tombol putar ulang run.
3. **Digital Twin (`/twin`).** Denah 3D pabrik: truk, bay, silo, gate SOP. Putar ulang per menit lewat dock di bawah, arahkan kursor ke aset untuk detail, klik objek untuk panel.
   Kamera 3D dapat diputar 360 derajat dengan seret kiri; klik kanan atau Shift + seret untuk menggeser, gulir untuk zoom. Pada layar sentuh gunakan satu jari untuk memutar dan dua jari untuk geser/pinch. Kemiringan dibatasi di atas tanah agar kamera tidak terbalik. Tombol Pusatkan peta mengembalikan bingkai awal; tombol ? membuka panduan.
   **Hari operasi baru berjalan live:** waktu berasal dari Engine dan hanya maju; PPIC/Admin dapat mengubah kecepatan (1, 5, 20, 60 menit/detik), bukan menarik slider mundur. Hari berikutnya tidak dihitung terlebih dahulu. Hari selesai menjadi riwayat yang boleh diputar ulang tanpa mengubah checkpoint.
   Dock waktu selalu menandai **Hari aktif** atau **Riwayat** (termasuk pada layar kecil). Animasi rekaman bukan tanda operasi masih aktif. Panel aset pada riwayat menonaktifkan maintenance langsung dan menautkan ke hari aktif bila tersedia.
   Panel waktu menampilkan jam operasi, progres hari 24 jam sejak 06:00, waktu berlalu, dan kecepatan. Indikator live berdenyut mengikuti preferensi reduced motion; jika koneksi Engine terputus indikator berubah menjadi peringatan dan jam tetap pada snapshot terakhir. Proses yang melewati 24 jam ditandai lembur, bukan memutar progres kembali ke nol.
   Jam operasi memakai format 24 jam WIB tanpa awalan H+ (13:00 WIB = pukul satu siang, 01:00 WIB = pukul satu dini hari). Setelah tengah malam jam kembali ke 00:00 WIB; durasi berjalan dan nomor hari tetap ditampilkan terpisah.
   **Maintenance tangki:** satu form dengan pilihan Langsung atau Jadwalkan (hari dan jam operasi, 06:00 = menit 0). Langsung diterapkan pada run aktif yang sama, bukan cabang what-if. Tangki tidak menerima pekerjaan baru, menunggu kosong dan bersih, lalu menjalani durasi servis penuh. Status: diterima, menunggu aman, maintenance, selesai. Jadwal hari mendatang disimpan sampai hari itu dimulai. Semua ini mengubah aset digital twin, bukan perangkat PLC/SCADA.
   Sebelum mencoba, jalankan `cd web && php artisan migrate` dan mulai ulang Engine. Run lama yang sudah selesai tetap riwayat; gunakan **Mulai Hari berikutnya** untuk operasi live baru. Jika Engine restart di tengah hari, tampilan/perintah live melaporkan ketidaktersediaan; tidak diam-diam memutar replay atau menjalankan ulang hari. Pemulihan otomatis run aktif belum tersedia. Timeout perintah harus dicoba ulang dengan ID permintaan yang sama agar tidak menggandakan servis.
3a. **Satu bangunan produksi.** Bay, TK-RAW, TK-STO, DEG sampai LINE (termasuk aseptic tank) berada di dalam satu bangunan berpipa internal; gerbang, area tunggu truk, dan LAB QA tetap di luar. Dari luar bangunan beratap; klik 2x bangunan (atau tombol "Proses", atau memilih aset di dalamnya dari tabel) untuk masuk: atap dibuka dan dinding menjadi transparan. Esc atau "Semua" untuk keluar; "Terima" memfokuskan gerbang/pad/lab/depan bay. Tiga node abu-abu "belum dimodelkan" (Premix, Cream, Mixing) belum ada di simulasi. Tab "Proses" memuat ASEP-n; panelnya menampilkan isi, lot tertua, umur isi, sisa holding, dan changeover filling line. Run lama (sebelum Q2) tidak punya data isi tangki, buat run baru.
3a-i. **Lab hanya pH dan truk tidak lolos lab.** Uji penerimaan G2, generator data, tampilan hasil, KPI, dan form konfirmasi hanya memakai **pH** (batas demo 6,55–6,85). Lemak, protein, keasaman, antibiotik, dan adulteran tidak diperiksa atau diwajibkan. pH hilang/tidak valid tetap ditahan. Pada run live baru, truk yang tidak lolos masuk **Tahan QA**, tetap terpisah dari tangki produksi dan tidak boleh bongkar. Panel truk memuat nilai/batas pH, kategori (data belum lengkap atau mutu), pemasok, dan volume yang belum dapat diterima.
   **Notifikasi dibaca:** pin warning truk di peta hilang setelah detail truk dibuka (dari pin, antrean lab, tabel, atau peta). Membuka Lab saja tidak menandai seluruh truk sebagai dibaca. Status dibaca disimpan per run dalam sesi tab browser, termasuk setelah refresh/putar ulang; perubahan status, alasan gate, atau review QA memunculkan warning baru. Bila detail truk sedang terbuka, perubahan yang tampil di detail juga dianggap dibaca. Status tahan/ditolak, antrean, statistik, dan riwayat tetap utuh; membaca bukan persetujuan atau pelepasan QA. Pin maintenance/aset tidak ikut disembunyikan.
   QA/Admin dapat menolak dengan alasan dan disposisi (pengembalian pemasok atau disposisi terkendali). Untuk data belum lengkap/ketidaksesuaian mutu, QA dapat mencatat satu uji konfirmasi pH; uji memakai antrean analis dan durasi lab, bukan perubahan hasil seketika. pH yang memenuhi batas menghasilkan status **Terkonfirmasi**, tetapi tetap menunggu tombol pelepasan QA. Hasil awal dan uji konfirmasi disimpan terpisah dalam event/riwayat; tidak ada paksa lolos atau uji berulang sampai lolos. Kolom kontrak legacy tetap dapat dibaca untuk snapshot lama; keputusan dan audit historis tidak ditulis ulang. Kebijakan pH saja bukan klaim bahwa parameter keamanan pangan lainnya sudah diperiksa.
   Batas tunggu demo adalah akhir hari operasi atau 120 menit sejak hasil awal, mana yang lebih akhir. Tanpa pelepasan sampai batas itu, sistem menutup penerimaan sebagai ditolak dengan disposisi **unresolved_hold**: ini bukan klaim bahwa susu sudah dikembalikan atau dimusnahkan secara fisik. Run non-interaktif mencatat tahan lalu penolakan penerimaan tanpa menunggu manusia; checkpoint lama tidak diubah. PPIC melihat volume tertahan/ditolak untuk menyesuaikan pasokan dan jadwal; pengiriman notifikasi ke pemasok, pemesanan pengganti, dan eksekusi pengembalian fisik tidak otomatis dilakukan.
   Jalankan migrasi `php artisan migrate` dan mulai ulang Engine ketika tidak ada run aktif agar runtime memuat alur QA baru. Endpoint `POST /operasi/qa` hanya untuk QA/Admin, memakai UUID idempoten, mencatat aktor/alasan/disposisi, dan melaporkan timeout sebagai belum pasti agar dicoba ulang dengan ID yang sama. Nilai uji pada digital twin tetap data demo, bukan sertifikasi keamanan pangan atau pengganti SOP QA.
3b. **Peringatan holding time.** Dashboard menampilkan lot aseptic tank yang mendekati (75%) atau melewati batas holding time, dihitung dari event `asset.level`.
3c. **Kelayakan rute.** Rute STE > ASEP > LINE (satu sterilizer, satu aseptic tank, dua filling line) dan izin SKU per line terlihat di panel aset ASEP/STE (matriks line x SKU) dan LINE (sumber, SKU diizinkan, SKU ditolak beserta alasan). Panel "Parameter operasional" punya pilihan "Izin SKU per line": Bebas (bawaan, perilaku lama) atau Dedikasi demo (line ke-2 tiap aseptic hanya kemasan 1000 ml); engine memaksa SKU hanya dipilihkan sterilizer/line yang mengizinkan. Aliran line yang jalan serentak tidak boleh melebihi output aseptic: bila (line x aliran filling) > aliran sterilizer, line kelebihan ditandai "tidak tersedia" dan tidak dipakai. Penjadwal CP-SAT belum tahu izin ini (hanya simulasi yang menegakkannya), jadi kepatuhan jadwal dapat sedikit turun pada kebijakan dedikasi. Run lama tanpa event rute tidak menampilkan matriks; buat run baru.
3d. **Order & kelayakan.** Panel "Parameter operasional" punya "Order produksi" (maks. 6 baris SKU + ton produk jadi) dan pemakaian susu per ton produk jadi (full cream 100%, rasa 90%, nilai demo). Dashboard run selesai memuat kartu "Order & kelayakan": per order jumlah diminta, terpenuhi, kurang, status, dan penyebab kekurangan beserta ton susunya (truk ditahan/ditolak gerbang atau lab, batch ditahan QA, belum selesai diisi, susu terjadwal SKU kurang). Tanpa baris order, engine membuat satu order per SKU dari susu terjadwal. Pemakaian susu hanya memengaruhi evaluasi order, bukan jalannya simulasi. Low fat memakai angka full cream; Premix/Mixing belum dimodelkan, jadi bahan non-susu dianggap selalu ada. Dua order SKU sama memakai susu SKU itu berurutan. Run lama tanpa event `orders.evaluated` menampilkan petunjuk untuk membuat run baru.
3e. **Neraca volume & KPI.** Dashboard run selesai memuat kartu "Neraca volume & KPI": masuk = stok awal tangki + susu diterima; keluar = produk jadi (FG) + susut proses + ditahan QA + sisa di tangki + masih dalam proses; selalu dalam ton, kolom liter hanya konversi tampilan (1 t = 1.000 L) dan neraca ditandai seimbang atau tidak. Susu dari truk yang ditahan atau ditolak di gerbang/lab tidak diterima, jadi dicatat terpisah. "Stok awal tangki" (Parameter operasional, nilai demo) tidak diproses simulasi; ia hanya dibawa sebagai sisa. KPI di kartu: rendemen FG terhadap susu diterima, persen order terpenuhi penuh (dari 3d), dan utilisasi aset per jenis (bay sampai filling line). Run lama tanpa event `volume.balance` menampilkan petunjuk untuk membuat run baru.
3f. **Fouling & umur simpan.** Kartu "Fouling & umur simpan" memuat dua hal, keduanya hanya evaluasi di akhir hari (tidak mengubah jalannya proses). Fouling: menit sterilisasi tiap sterilizer sejak CIP terakhir terhadap batas "Batas sterilisasi sejak CIP terakhir" (bawaan 300 menit, nilai demo); status Aman / Mendekati batas (>= 75%) / Melewati batas, beserta jam batas tercapai (UTC). CIP terjadwal sterilizer belum dimodelkan, jadi hanya CIP darurat (sterilisasi gagal di G5) yang mereset hitungan. Umur simpan: satu angka untuk semua SKU (bawaan 180 hari) dan "Pengisian sampai tiba di pelanggan" (30 hari); tabel per SKU memuat tanggal isi pertama, tanggal kedaluwarsa, dan sisa umur saat tiba, dibandingkan dengan minimum 60% (demo). Run lama tanpa event `fouling.expiry` menampilkan petunjuk untuk membuat run baru.
4. **Maps (`/maps`).** Truk yang menuju gerbang lengkap dengan plat dan ETA. Peta dasar butuh internet.
5. **Runs (`/runs`, `/runs/{id}`).** Tabel run, perbandingan konfigurasi A/B, jadwal, dan versi jadwal. Setujui versi jadwal bila peran mengizinkan.
6. **What-if / Simulasi.** Dari satu run, buat cabang (fork) dengan skenario lain, lalu bandingkan KPI terhadap run induk.
6a. **Panel parameter & Uji ulang.** Di Dashboard atau halaman run (What-if), buka "Parameter proses": laju tiap tahap, CIP, batas holding, changeover, toleransi slot, dan sampai 6 jadwal perawatan sterilizer (jam hari 06:00–06:00). "Uji ulang A dan B" menjalankan dua run dengan skenario sama (A = nilai awal, B = parameter baru) dan menampilkan perbandingannya. Nilai bawaan adalah "nilai demo", bukan data pabrik.
7. **Bangun denah (`/twin/build`).** Ubah jumlah bay dan tangki, simpan layout, jalankan run baru dengan layout itu.
8. **Usulan Operator Agent (`/campaigns`).** Di halaman Kampanye atau laci Asisten AI, minta agen menjalankan simulasi *what-if* untuk jadwal *maintenance* tangki, tinjau kartu usulan (`draft -> pending`) beserta perbandingan KPI terhadap baseline, lalu setujui atau tolak dengan alasan (hanya PPIC/Admin; agen tidak pernah punya akses eksekusi langsung).
9. **Asisten AI.** Tombol "Tanya Asisten AI" di topbar. Tanyakan KPI run; jawaban hanya berdasar data run yang diverifikasi oleh *numeric grounding validator*.
10. **Traceability (`/trace?run=13&code=FG-0001`).** Telusuri satu lot hingga hulu dan hilir. Login sebagai `qa@demo.test` bila perlu.
11. **Audit (`/audit`).** Login sebagai `admin@demo.test`, tekan verifikasi rantai hash. Hanya tersedia di PostgreSQL.
12. **Lapangan.** Login `driver@demo.test` (`/driver`) untuk check-in truk dan `operator@demo.test` (`/operator`) untuk konfirmasi tugas.

## Catatan yang perlu dijujurkan

- Hari operasi dimulai pukul 06:00 (menit 0 = 06:00); run lama sebelum perubahan ini memakai bingkai 00:00, buat run baru.
- Parameter perawatan pada run eksperimen berlaku untuk sterilizer; form maintenance operasi mendukung TK-RAW/TK-STO. Perintah live tidak dihitung sebagai rencana awal Monte Carlo.
- Data simulasi; hasil KPI bergantung pada seed dan parameter skenario.
- Peta dasar di `/maps` memerlukan koneksi internet.
- Tampilan 3D di mesin tanpa GPU berjalan lambat; pilih peramban dengan akselerasi perangkat keras.
- Anggaran performa: `cd web && npm run build && npm run budget`.

## Pemeriksaan sebelum demo

```bash
make lint
make test
cd web && npm run build && npm run budget
```
