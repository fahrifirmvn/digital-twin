# Asumsi: Asisten Operator dan Kampanye Harian

Semua data adalah DATA SINTETIS. Diganti saat data nyata tersedia.

## Ruang lingkup dan lokasi kode

| Spek | Keputusan |
|---|---|
| `src/opt`, `src/predict`, `src/sim`, `configs/master.yaml`, ST-01..ST-15 | Berada di `decision_core_package/` (paket terpisah). Aplikasi memakai `engine/app` dengan ID `TK-RAW-n` dan `TK-STO-n`. Asisten Operator bekerja di atas `engine/app`. |
| Optimizer | CP-SAT (`engine/app/scheduler.py`) hanya menjadwalkan penerimaan truk. Alokasi dan maintenance tangki diputuskan lewat what-if fork simulasi, lalu diperiksa `gates.py`. Ini yang dimaksud "optimizer / what-if engine" pada P1. |
| Batas parameter (`configs/master.yaml`) | Memakai batas di `engine/app/plant.py` dan `web/config/twin.php`. |
| Provider LLM | Gemini (bawaan, `ENGINE_LLM_PROVIDER=gemini`, model bawaan `gemini-3.8-flash`, suhu 0.2), openai, anthropic, dan local (format OpenAI). Adapter Gemini mengikuti format REST `generateContent` v1beta dan baru diuji dengan transport tiruan; belum diuji ke API sungguhan. Mode Vertex AI (Agent Platform): set `ENGINE_LLM_BASE_URL=https://aiplatform.googleapis.com` (path `/v1/publishers/google/models/...`, header `x-goog-api-key`), opsional `ENGINE_LLM_VERTEX_PROJECT` dan `ENGINE_LLM_VERTEX_LOCATION` (bawaan `global`) untuk path berskop project. Vertex terikat project tidak menerima API key: kosongkan `ENGINE_LLM_API_KEY` dan engine memakai Application Default Credentials (`gcloud auth application-default login`, token Bearer). Terverifikasi ke `gemini-3.8-flash` di Vertex lewat ADC. |
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

## Operator Agent: usulan dan persetujuan (Fase 3)

- Ruang lingkup usulan: hanya maintenance tangki (`tank_maintenance`) pada hari kampanye yang sedang disusun. Usulan alokasi atau alur truk ditunda; Engine tidak punya jalur apply untuk itu.
- Pembagian tugas: Engine hanya membuat draf (alat `campaign_state`, `run_whatif`, `create_proposal`); Laravel menyimpan, memeriksa ulang aturan keras dari database, dan menerapkan. Tidak ada alat yang menerapkan, menyetujui, atau mengajukan.
- What-if: simulasi satu hari kampanye (seed hari, konfigurasi, volume, dan pabrik yang sama) dengan dan tanpa jendela maintenance. Konfigurasi D disimulasikan sebagai C karena D ~25 detik; `config_requested` dan `config_used` dicatat di bukti. Baseline di-cache per keadaan hari. Maksimal 4 what-if per giliran. Selisih dan arah (lebih baik/buruk) dihitung kode, bukan LLM.
- Pagar keras (P3), diperiksa di Engine sebelum what-if, di Laravel saat draf disimpan, saat diajukan, dan saat disetujui: hari harus masih bisa diubah, tangki harus ada, jendela dan durasi dalam batas, tangki belum dijadwalkan, batas jumlah maintenance, dan tidak boleh semua tangki sejenis mati bersamaan (tidak ada tangki tujuan siap). Hasil what-if yang melanggar holding time atau false-accept menandai usulan sebagai temuan. Usulan yang melanggar tidak dibuat; yang menjadi tidak valid sebelum keputusan ditandai `expired`. Aturan dokumen/segel, CIP, dan status released milik gate SOP di Engine dan tidak dapat dilewati karena usulan hanya berupa jendela maintenance yang dijalankan simulator.
- Bukti: snapshot what-if (baseline, kandidat, selisih, temuan, hash hasil, id what-if) disimpan bersama usulan beserta hash-nya. What-if sendiri hanya hidup di memori Engine (LRU 100); usulan membawa snapshot-nya sehingga tetap dapat diperiksa setelah Engine dimulai ulang.
- Status: `draft` → `pending` (diajukan) → `approved` | `rejected` | `expired` | `superseded`. Isi usulan immutable (payload, alasan, bukti, model, pembuat); revisi adalah baris baru dengan versi lebih tinggi dan menandai versi lama `superseded`. Immutability dijaga model dan alur status, tanpa trigger DB (PostgreSQL tidak tersedia di test).
- Persetujuan: hanya PPIC dan Admin (`approve-proposal`), alasan wajib 5–500 karakter, usulan harus `pending`. Penerapan = jadwal maintenance biasa lewat `CampaignService::planMaintenance` dengan pelaku persetujuan, sehingga jejaknya sama dengan jadwal manual. Pembuat usulan boleh menyetujui usulannya sendiri bila perannya PPIC/Admin. QA diperlakukan seperti pengamat: dapat melihat dan membuat draf, tetapi tidak memutuskan.
- Mode: usulan hanya dibuat dalam SIMULASI; permintaan dengan kampanye selalu dipaksa SIMULASI. Usulan bermode LIVE tidak pernah diterapkan.
- Audit: `agent.proposal_created`, `_submitted`, `_approved`, `_rejected`, `_expired`, `_discarded`, selain `agent.tool_call` yang memuat `proposal_id` hanya untuk usulan yang benar-benar tersimpan.

## Operator Agent: antarmuka (Fase 4)

- Satu drawer "Asisten AI" dipakai di dashboard, Twin, Maps, halaman run, dan halaman kampanye. Logika DOM di `ui/assistant.js`; logika murni (isi permintaan, label, aturan tombol) di `ui/assistant-model.js` dan diuji dengan `node:test`. Halaman kampanye (tanpa shell Twin) memuat entri Vite terpisah `assistant.js`.
- Semua teks dari server atau LLM dipasang lewat `textContent`; tidak ada `innerHTML` untuk isi percakapan atau usulan.
- Kartu usulan menampilkan jendela, status, alasan, dan selisih what-if dengan kata "lebih baik/lebih buruk" (tidak hanya warna). Tombol Ajukan/Setujui/Tolak mengikuti peran hanya sebagai kemudahan tampilan; keputusan izin tetap di server (`approve-proposal`). Alasan wajib 5-500 karakter dicek di klien dan di server.
- Label "DATA SINTETIS | mode X" tampil di drawer dan diganti dengan label dari server setiap balasan. Badge DEMO diganti "DATA SINTETIS" di semua halaman, termasuk layar sempit.
- Halaman kampanye memuat ulang otomatis 4 detik saat hari berjalan, sehingga percakapan di drawer hilang pada saat itu. Setelah persetujuan, halaman dimuat ulang agar jadwal tampil.
- Nama produk: LactaTwin (judul halaman, topbar, login, manifest PWA, judul API Engine). Nama pabrik asli tidak dipakai.

## Operator Agent: percakapan (Fase 4b-4e)

- **Pengetikan setelah validasi, bukan streaming token.** Jawaban baru ditampilkan setelah lolos validator grounding (setiap angka harus ada di hasil alat). Streaming token akan menampilkan teks yang belum divalidasi, melanggar P4. Karena itu antarmuka mengetik balasan bertahap SETELAH jawaban final diterima (batas 70 tik, klik melewati animasi, nonaktif pada `prefers-reduced-motion`, `aria-busy` selama animasi).
- **Usulan terbuka (`open_proposals`).** Konteks kampanye membawa draf/usulan menunggu milik PENGGUNA YANG SEDANG BERCAKAP pada hari berjalan (maks. 10), diisi Laravel dari database, bukan dari klien. Isinya hanya jendela dan metrik what-if; nama metrik dibatasi `[a-z0-9_]` agar tidak bisa disisipi teks bebas. `open_proposals` tidak ikut kunci cache what-if. `create_proposal` dengan `supersedes` menolak id yang tidak ada di daftar ini; keputusan tetap di PPIC dan versi lama hanya menjadi "Digantikan versi baru" lewat alur yang sama seperti sebelumnya.
- **Gaya bicara.** Aturan prompt 7-10: boleh obrolan ringan tanpa alat, tanya balik bila permintaan ambigu, dan revisi usulan terbuka dibuat sebagai versi baru. Jawaban teks kosong dari model kini menjadi galat `empty_reply`, bukan jawaban kosong berstatus ok.
- **Gemini.** `thinkingBudget` dikirim bila diatur (`ENGINE_LLM_THINKING_BUDGET`); bawaan 0 untuk model "flash" agar token keluaran tidak habis oleh berpikir. `llm_max_tokens` 2048. Adaptor belum diverifikasi ke API sungguhan di repo ini: jalankan `uv run python -m scripts.smoke_llm` dari `engine/` dengan kunci di `engine/.env` (tidak pernah dicetak).
- **Penyimpanan percakapan.** Hanya `sessionStorage` per pengguna dan konteks (kampanye/run), teks polos maks. 40 pesan, dipulihkan dengan validasi (data rusak diabaikan). Tidak ada percakapan di server selain audit append-only.
- **Revisi lewat kartu.** Tombol "Tanya atau revisi lewat chat" mengisi awalan pesan; kartu versi lama dimuat ulang setelah versi baru dibuat.

## Operator Agent: uji red-team (Fase 5)

- **Cakupan.** `engine/tests/test_redteam.py` dan `web/tests/Feature/RedTeamTest.php` memodelkan tiga penyerang: pengguna yang berniat jahat, LLM yang sudah dibajak lewat injeksi prompt (LLM tiruan yang "menurut"), dan Engine yang mengirim draf berbahaya. `assistant-safety.test.js` menjaga agar teks server/LLM tidak pernah dipasang sebagai HTML. Injeksi diuji pada lapisan kode, bukan dengan berharap model menolak.
- **Temuan yang diperbaiki.** Validator angka hanya memeriksa jawaban akhir, sedangkan alasan usulan (`rationale`) ikut tampil di kartu PPIC tanpa pemeriksaan. Kini `create_proposal` menolak alasan yang memuat angka di luar hasil alat dan pesan pengguna, dan LLM bisa mengulang dengan alasan yang tepat.
- **Yang terbukti tidak bisa dilakukan LLM yang dibajak:** memanggil alat penerapan/persetujuan/ambang/rilis (tidak ada), menyelipkan `role`/`user_id`/`mode`/`status` ke argumen (argumen ekstra ditolak), memakai id what-if karangan atau milik keadaan hari lain, menembus rentang menit/durasi/kode tangki (NaN, inf, `TK-RAW-01`, kode berakhiran baris baru), dan memakai alat kampanye pada mode LIVE.
- **Yang terbukti tidak bisa dilakukan klien:** memalsukan peran, pengguna, mode, atau konteks kampanye di `/agent/turn` (semuanya dari sesi dan database), menyisipkan peran `system`/`tool` pada riwayat, melewati batas laju, memutuskan usulan tanpa izin PPIC/Admin, mengubah isi yang diterapkan lewat badan permintaan, atau menyetujui tanpa alasan nyata.
- **Yang terbukti tidak bisa dilakukan Engine yang dibajak:** draf dengan payload di luar batas, jenis lain, alasan di luar 10-400 karakter dibuang; status, pemilik, mode, dan kolom payload tambahan diabaikan; draf tidak bisa menggantikan atau menimpa usulan pengguna lain; satu giliran paling banyak 4 draf.
- **Batas yang diakui (risiko sisa).**
  - Validator angka hanya mencocokkan digit. Angka yang ditulis dengan kata atau digit yang dipecah dapat lolos. Ia adalah sabuk pengaman terhadap kekeliruan model, bukan batas keamanan. Batas keamanan sebenarnya ada di P1/P2: LLM tidak dapat menerapkan apa pun, angka pada kartu berasal dari what-if Engine, dan PPIC memutuskan dengan alasan.
  - Riwayat dari klien diperlakukan sebagai ucapan pengguna sendiri (angka di dalamnya sah sebagai sumber), sama seperti pesan terbaru.
  - Siapa pun yang boleh membuka Twin (termasuk Observer, QA, Operator) dapat membuat dan mengajukan draf; hanya PPIC/Admin yang menyetujui, dan PPIC boleh menyetujui usulannya sendiri (keputusan Fase 3).
  - What-if disimpan di memori Engine tanpa kepemilikan pengguna. Id acak 48 bit dan harus cocok dengan kunci keadaan hari, sehingga tidak bisa ditebak dan tidak bisa dipakai pada hari lain.
  - Belum ada uji red-team terhadap model sungguhan; semua serangan memakai LLM tiruan. Ulangi dengan Gemini setelah kunci baru terpasang.
