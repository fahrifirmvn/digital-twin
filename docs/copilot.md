# Copilot (Fase 5)

LLM memilih alat, Engine memvalidasi dan menjalankannya, jawaban akhir diperiksa validator sumber (PRD 10.6).

## Memilih provider (hanya di `.env` Engine)

| `ENGINE_LLM_PROVIDER` | Keterangan | Wajib diisi |
|---|---|---|
| `mock` (bawaan) | Tanpa jaringan; menggemakan pesan. Untuk demo dan test | - |
| `openai` | OpenAI Chat Completions (base bawaan `https://api.openai.com/v1`) | `API_KEY`, `MODEL` |
| `anthropic` | Claude Messages API (base bawaan `https://api.anthropic.com`) | `API_KEY`, `MODEL` |
| `local` | Server/router berformat OpenAI: Ollama `http://localhost:11434/v1`, LM Studio, vLLM, LiteLLM, OpenRouter | `BASE_URL`, `MODEL` (`API_KEY` opsional) |

Opsional: `ENGINE_LLM_TIMEOUT` (60), `ENGINE_LLM_MAX_TOKENS` (1024), `ENGINE_LLM_TEMPERATURE` (tidak dikirim bila kosong), `ENGINE_LLM_RETRIES` (2; hanya 429/5xx/jaringan).
Konfigurasi tidak lengkap menonaktifkan Copilot (log peringatan), Engine tetap hidup, UI menampilkan fallback ke Panel Skenario.
Router yang meniru Claude (mis. `.../v1`) dapat dipakai dengan `anthropic` + `BASE_URL`.

## Alat dan peran

| Alat | Peran | Efek |
|---|---|---|
| `get_state`, `compare_schedules`, `explain`, `trace_batch`, `predict_truck`, `anomaly_status` | PPIC, QA, Operator, Admin, Observer | baca saja |
| `run_scenario` | PPIC, Admin | usulan run (belum jalan) |
| `solve_schedule`, `propose_plan` | PPIC | usulan; aktivasi via Approval Modal |

Sopir tidak punya Copilot. Tidak ada alat untuk ambang mutu, SOP, holding time, atau keputusan rilis QA.

## Pagar

1. Angka dalam jawaban harus ada di keluaran alat atau pesan pengguna (`app/copilot/guard.py`); satu kali koreksi, lalu jawaban ditolak.
2. LLM hanya mengusulkan; PPIC menyetujui dengan alasan (`schedule.approved` di audit log); run usulan dijalankan lewat rute `POST /runs` biasa (Gate `run-scenario`).
3-4. Hard constraint dan QA release tidak punya alat.
5. Setiap chat dan panggilan alat dicatat ke audit log (`copilot.chat`).
6. Peran diambil Laravel dari sesi; argumen divalidasi Pydantic (`extra=forbid`); alat di luar peran ditolak walau dipanggil LLM.
7. LLM gagal: pesan fallback, Panel Skenario tetap berfungsi.

## Batasan yang diketahui

- Alat membaca hasil run yang selesai di memori proses Engine; setelah Engine restart, run lama tidak dapat ditanyakan (data tetap ada di Laravel).
- Hanya Engine yang menjalankan LLM dan keluaran model nyata belum diuji dengan kunci sungguhan; terjemahan permintaan/jawaban tiap provider diuji dengan transport tiruan.
- Validator angka tidak menangkap klaim non-numerik yang salah.
