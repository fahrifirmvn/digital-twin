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
3a. **Satu bangunan produksi.** Bay, TK-RAW, TK-STO, DEG sampai LINE (termasuk aseptic tank) berada di dalam satu bangunan berpipa internal; gerbang, area tunggu truk, dan LAB QA tetap di luar. Dari luar bangunan beratap; klik 2x bangunan (atau tombol "Proses", atau memilih aset di dalamnya dari tabel) untuk masuk: atap dibuka dan dinding menjadi transparan. Esc atau "Semua" untuk keluar; "Terima" memfokuskan gerbang/pad/lab/depan bay. Tiga node abu-abu "belum dimodelkan" (Premix, Cream, Mixing) belum ada di simulasi. Tab "Proses" memuat ASEP-n; panelnya menampilkan isi, lot tertua, umur isi, sisa holding, dan changeover filling line. Run lama (sebelum Q2) tidak punya data isi tangki, buat run baru.
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
8. **Agen.** Atur mandat (admin/PPIC), jalankan agen pada run, lalu setujui, tolak (veto), atau batalkan (undo) usulannya. Mandat level 0 hanya merekomendasikan.
9. **Asisten AI.** Tombol "Tanya Asisten AI" di topbar. Tanyakan KPI run; jawaban hanya berdasar data run.
10. **Traceability (`/trace?run=13&code=FG-0001`).** Telusuri satu lot hingga hulu dan hilir. Login sebagai `qa@demo.test` bila perlu.
11. **Audit (`/audit`).** Login sebagai `admin@demo.test`, tekan verifikasi rantai hash. Hanya tersedia di PostgreSQL.
12. **Lapangan.** Login `driver@demo.test` (`/driver`) untuk check-in truk dan `operator@demo.test` (`/operator`) untuk konfirmasi tugas.

## Catatan yang perlu dijujurkan

- Hari operasi dimulai pukul 06:00 (menit 0 = 06:00); run lama sebelum perubahan ini memakai bingkai 00:00, buat run baru.
- Perawatan terjadwal baru berlaku untuk sterilizer, dan tidak terlihat oleh Monte Carlo/rencana awal.
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
