# Asumsi: Asisten Operator dan Kampanye Harian

Semua data adalah DATA SINTETIS. Diganti saat data nyata tersedia.

## Ruang lingkup dan lokasi kode

| Spek | Keputusan |
|---|---|
| `src/opt`, `src/predict`, `src/sim`, `configs/master.yaml`, ST-01..ST-15 | Berada di `decision_core_package/` (paket terpisah). Aplikasi memakai `engine/app` dengan ID `TK-RAW-n` dan `TK-STO-n`. Asisten Operator bekerja di atas `engine/app`. |
| Optimizer | CP-SAT (`engine/app/scheduler.py`) hanya menjadwalkan penerimaan truk. Alokasi dan maintenance tangki diputuskan lewat what-if fork simulasi, lalu diperiksa `gates.py`. Ini yang dimaksud "optimizer / what-if engine" pada P1. |
| Batas parameter (`configs/master.yaml`) | Memakai batas di `engine/app/plant.py` dan `web/config/twin.php`. |
| Provider LLM | Gemini (bawaan, `ENGINE_LLM_PROVIDER=gemini`, model bawaan `gemini-2.5-flash`, suhu 0.2), openai, anthropic, dan local (format OpenAI). Adapter Gemini mengikuti format REST `generateContent` v1beta dan baru diuji dengan transport tiruan; belum diuji ke API sungguhan (dokumentasi resmi tidak dapat diambil saat penulisan). |
| Peran viewer, operator, PPIC, admin | viewer = Observer, operator = Operator, PPIC = PPIC, admin = Admin. QA dan Driver tidak mendapat Asisten Operator. |
| Mode SIMULASI dan LIVE | Hanya SIMULASI yang menulis state (sandbox kampanye). LIVE bersifat baca saja dan tidak ada kode penulisan ke SCADA/PLC. |
| Label | "DEMO" menjadi "DATA SINTETIS" dan nama pabrik hanya "[Nama Pabrik]". |

## Yang sudah dilakukan (Fase 0)

- Copilot (chat) dan Agen Copilot (mandat otomasi 0-3, aksi agen otomatis) dihapus, termasuk tabelnya. Agen otomatis bertentangan dengan P1 dan P2.
- Asisten AI dibangun ulang sebagai Operator Agent; kerangka laci "Asisten AI" di UI dipertahankan.
- Folder paket diganti nama menjadi `decision_core_package`; nilai pengaturan prediktor `greenfields` menjadi `core`. Venv di folder itu perlu dibuat ulang (`uv sync`) karena path berubah.

## Kampanye harian (Fase 1)

- Kampanye = pabrik yang terus hidup: seed, log perintah yang disetujui, dan hari berjalan.
- Hari maju lewat tombol "Mulai hari" atau mode jalan otomatis (hari berikutnya mulai sendiri setelah hari berjalan ditutup). Mode berbasis waktu nyata ditunda.
- Satu hari = satu run engine 24 jam dengan seed `(seed kampanye + nomor hari - 1)`. Checkpoint hari = JSON kanonik (hari, tanggal, seed hari, run, konfigurasi, perintah, KPI, sisa maintenance) dengan hash `sha256(hash_kemarin + "\n" + checkpoint)`. Hari yang ditutup tidak bisa diubah atau dihapus.
- State pabrik tidak dibawa utuh antarhari (proses SimPy tidak dapat diserialisasi). Yang dibawa hanya maintenance tangki yang melewati tengah malam; setiap hari mulai dengan pabrik kosong. Ini penyederhanaan yang disengaja.
- Maintenance dibatasi 15-720 menit (batas perintah engine); sisa di luar tengah malam menjadi `carry_in` hari berikutnya.
- Replay hari D memutar event run hari itu. Pemulihan membuat kampanye cabang baru dari checkpoint D; kampanye asal tidak berubah.

## Operator Agent: inti (Fase 2)

- Pembagian tugas: Laravel memegang identitas, peran, batas laju, dan audit log append-only; Engine memegang LLM, orkestrator, registry alat, dan policy engine. Engine tidak pernah menerima peran dari browser, hanya dari Laravel lewat token internal.
- Orkestrator: maksimal 8 langkah (`ENGINE_AGENT_MAX_STEPS`), batas 30 detik per langkah, maksimal 4 panggilan alat per langkah, kegagalan berupa kode terstruktur (`rate_limited`, `step_timeout`, `max_steps`, `grounding_failed`, `llm_unavailable`, ...).
- Alat Fase 2 hanya membaca hasil run yang selesai di proses Engine yang sama (hilang saat Engine dimulai ulang). Tidak ada alat untuk ambang mutu, SOP, holding time, atau rilis QA. Alat yang mengusulkan perubahan datang di Fase 3.
- Argumen alat: pydantic `extra=forbid`; kode tangki divalidasi terhadap pabrik run itu; rentang angka dibatasi; tidak ada teks bebas yang diteruskan ke solver.
- Keluaran alat selalu dibungkus `{"untrusted_data": true}` dan prompt menyuruh mengabaikan instruksi di dalamnya. Pembatasan sebenarnya ada di kode (RBAC, registry), bukan di prompt.
- Grounding: angka di jawaban harus muncul di keluaran alat atau pesan/riwayat pengguna; satu kali koreksi, lalu ditolak. Label "DATA SINTETIS | mode X" dibuat oleh kode, bukan oleh LLM.
- Mode LIVE hanya untuk run yang masih mengalir; run kampanye dan hasil selesai dianggap SIMULASI.
- Audit (P7): satu entri `agent.turn` dan satu `agent.tool_call` per panggilan alat (percakapan, pengguna, peran, mode, nama dan versi model, alat, argumen, hash hasil, waktu, id usulan). Pengguna, peran, dan percakapan diambil dari sesi Laravel, bukan dari balasan Engine. Hash-chain hanya aktif di PostgreSQL.
- Riwayat percakapan dikirim klien (maks 20 giliran) dan hanya berisi peran user/assistant; keabsahannya tidak dipercaya, jadi tidak pernah memberi izin apa pun.
