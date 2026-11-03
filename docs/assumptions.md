# Asumsi: Asisten Operator dan Kampanye Harian

Semua data adalah DATA SINTETIS. Diganti saat data nyata tersedia.

## Ruang lingkup dan lokasi kode

| Spek | Keputusan |
|---|---|
| `src/opt`, `src/predict`, `src/sim`, `configs/master.yaml`, ST-01..ST-15 | Berada di `decision_core_package/` (paket terpisah). Aplikasi memakai `engine/app` dengan ID `TK-RAW-n` dan `TK-STO-n`. Asisten Operator bekerja di atas `engine/app`. |
| Optimizer | CP-SAT (`engine/app/scheduler.py`) hanya menjadwalkan penerimaan truk. Alokasi dan maintenance tangki diputuskan lewat what-if fork simulasi, lalu diperiksa `gates.py`. Ini yang dimaksud "optimizer / what-if engine" pada P1. |
| Batas parameter (`configs/master.yaml`) | Memakai batas di `engine/app/plant.py` dan `web/config/twin.php`. |
| Provider LLM | Adapter openai, anthropic, dan local (format OpenAI) sudah ada. Adapter Gemini ditambah di Fase 2 sesuai dokumentasi resmi saat itu. |
| Peran viewer, operator, PPIC, admin | viewer = Observer, operator = Operator, PPIC = PPIC, admin = Admin. QA dan Driver tidak mendapat Asisten Operator. |
| Mode SIMULASI dan LIVE | Hanya SIMULASI yang menulis state (sandbox kampanye). LIVE bersifat baca saja dan tidak ada kode penulisan ke SCADA/PLC. |
| Label | "DEMO" menjadi "DATA SINTETIS" dan nama pabrik hanya "[Nama Pabrik]". |

## Yang sudah dilakukan (Fase 0)

- Copilot (chat) dan Agen Copilot (mandat otomasi 0-3, aksi agen otomatis) dihapus, termasuk tabelnya. Agen otomatis bertentangan dengan P1 dan P2.
- Asisten AI dibangun ulang sebagai Operator Agent; kerangka laci "Asisten AI" di UI dipertahankan.
- Folder paket diganti nama menjadi `decision_core_package`; nilai pengaturan prediktor `greenfields` menjadi `core`. Venv di folder itu perlu dibuat ulang (`uv sync`) karena path berubah.

## Kampanye harian (Fase 1)

- Kampanye = pabrik yang terus hidup: seed, log perintah yang disetujui, dan hari berjalan.
- Hari maju lewat tombol "Hari berikutnya" (manual); mode otomatis berbasis waktu nyata ditunda.
- Backup harian = checkpoint (hari, menit, ringkasan state, KPI hari itu, hash, log perintah sampai hari itu). Pemulihan deterministik dari seed dan log, karena proses SimPy tidak dapat diserialisasi.
- Replay hari D = pulihkan checkpoint D-1 lalu putar ulang event hari D. Fork dari hari D memakai mekanisme fork yang sudah ada.
