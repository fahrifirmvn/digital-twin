// Logika murni Asisten AI (tanpa DOM): isi permintaan, label, dan aturan tombol. Server tetap menjadi penentu izin.
import { clock } from './format.js';

export const MAX_HISTORY = 20;
export const MAX_MESSAGE = 1000;
const MAX_HISTORY_CONTENT = 2000;
export const REASON_MIN = 5;
export const REASON_MAX = 500;

export const STATUS_LABEL = {
    draft: 'Draf',
    pending: 'Menunggu persetujuan',
    approved: 'Disetujui',
    rejected: 'Ditolak',
    expired: 'Kedaluwarsa',
    superseded: 'Digantikan versi baru',
};

const METRIC = {
    truck_wait_mean_min: ['Tunggu truk rata-rata', 'menit'],
    truck_wait_p90_min: ['Tunggu truk P90', 'menit'],
    lab_wait_mean_min: ['Tunggu lab rata-rata', 'menit'],
    tank_dwell_mean_min: ['Waktu di tangki rata-rata', 'menit'],
    changeover_count: ['Jumlah changeover', ''],
    changeover_min: ['Durasi changeover', 'menit'],
    schedule_adherence_pct: ['Kepatuhan jadwal', '%'],
    unscheduled_cip: ['CIP darurat', ''],
    held_qa: ['Ditahan QA', ''],
    holding_violations: ['Pelanggaran holding time', ''],
    false_accept: ['False accept', ''],
    completed: ['Truk selesai', ''],
    trucks: ['Truk', ''],
    makespan_min: ['Makespan', 'menit'],
};

const SAFE_CODE = /^[A-Za-z0-9:_-]{2,32}$/;

/** Isi POST /agent/turn. Riwayat hanya user/assistant dan dipotong sesuai batas server. */
export function buildTurn({ message, conversationId, runId, campaignId, history, uiContext }) {
    const body = {
        message: String(message).trim().slice(0, MAX_MESSAGE),
        history: history.slice(-MAX_HISTORY).map((m) => ({ role: m.role, content: String(m.content).slice(0, MAX_HISTORY_CONTENT) })),
    };
    if (conversationId) body.conversation_id = conversationId;
    if (runId) body.run_id = Number(runId);
    if (campaignId) body.campaign_id = Number(campaignId);
    if (uiContext && typeof uiContext === 'object') {
        const ctx = {};
        if (typeof uiContext.selected === 'string' && SAFE_CODE.test(uiContext.selected)) ctx.selected_code = uiContext.selected;
        if (Number.isFinite(uiContext.minute) && uiContext.minute >= 0 && uiContext.minute <= 2880) ctx.minute = Math.round(uiContext.minute);
        if (uiContext.view === 'recv' || uiContext.view === 'process') ctx.view = uiContext.view;
        if (Object.keys(ctx).length) body.ui_context = ctx;
    }
    return body;
}

/** Label ringkas konteks panggung yang sedang dipilih pengguna. */
export function describeContext(uiContext) {
    if (!uiContext || typeof uiContext !== 'object' || !uiContext.selected || !SAFE_CODE.test(uiContext.selected)) return '';
    const timePart = Number.isFinite(uiContext.minute) && uiContext.minute >= 0 ? ` · ${clock(uiContext.minute)}` : '';
    return `Fokus: ${uiContext.selected}${timePart}`;
}

/** Tambahkan satu giliran ke riwayat; balasan kosong (galat) tidak masuk riwayat. */
export function pushHistory(history, userText, reply) {
    const next = [...history, { role: 'user', content: userText }];
    if (reply && reply.status === 'ok' && reply.text) next.push({ role: 'assistant', content: reply.text });
    return next.slice(-MAX_HISTORY);
}

export function statusLabel(status) {
    return STATUS_LABEL[status] ?? status;
}

/** "TK-RAW-1, 06:00 - 09:00 (180 menit)". */
export function describeWindow(w) {
    return `${w.asset}, ${clock(w.minute)} - ${clock(w.minute + w.duration_min)} (${Math.round(w.duration_min)} menit)`;
}

/** Selisih what-if dari server -> baris tampilan; kata "lebih baik/lebih buruk" selalu menyertai warna. */
export function changeRows(whatif) {
    return Object.entries(whatif ?? {}).map(([key, c]) => {
        const [label, unit] = METRIC[key] ?? [key, ''];
        const sign = c.change > 0 ? '+' : '';
        const base = Math.max(Math.abs(Number(c.baseline) || 0), Math.abs(Number(c.candidate) || 0), 1);
        const rawPct = Math.round((Math.abs(Number(c.change) || 0) / base) * 100);
        const pct = c.change === 0 ? 0 : Math.min(100, Math.max(10, rawPct));
        return {
            key,
            label,
            text: `${c.baseline} -> ${c.candidate}${unit ? ` ${unit}` : ''} (${sign}${c.change})`,
            tone: c.better ? 'better' : 'worse',
            verdict: c.better ? 'lebih baik' : 'lebih buruk',
            pct,
        };
    });
}

export function canSubmit(p, userId, canApprove) {
    return p.status === 'draft' && (p.created_by === userId || canApprove);
}

export function canDecide(p, canApprove) {
    return p.status === 'pending' && canApprove;
}

/** null bila alasan sah. */
export function reasonError(text) {
    const n = String(text).trim().length;
    if (n < REASON_MIN) return `Alasan wajib diisi, minimal ${REASON_MIN} karakter.`;
    if (n > REASON_MAX) return `Alasan maksimal ${REASON_MAX} karakter.`;
    return null;
}

/** Pesan untuk balasan Engine yang bukan "ok"; kosong bila tidak perlu. */
export function replyNote(reply) {
    if (!reply || reply.status === 'ok') return '';
    return reply.error?.message || reply.text || 'Asisten tidak dapat menjawab saat ini.';
}

/** Label model di bawah label data; mock harus terbaca sebagai mode demo, bukan LLM sungguhan. */
export function modelNote(reply) {
    if (!reply?.provider) return '';
    if (reply.provider === 'mock') return 'model: mode demo (tiruan, bukan LLM sungguhan)';
    return `model: ${reply.model || reply.provider}`;
}

/** Galat HTTP -> pesan ramah; 422 memakai pesan validasi pertama. */
export function httpError(status, body) {
    if (status === 429) return 'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.';
    if (status === 403) return 'Peran Anda tidak diizinkan melakukan ini.';
    if (status === 401 || status === 419) return 'Sesi berakhir. Muat ulang halaman dan masuk kembali.';
    if (body?.errors) return Object.values(body.errors).flat()[0] ?? `Gagal (HTTP ${status}).`;
    return body?.message || `Gagal (HTTP ${status}).`;
}

// --- percakapan: simpan sementara, saran, revisi, pengetikan ---------------------------------

export const MAX_STORED = 40;
const MAX_STORED_TEXT = 2000;

/** Kunci localStorage per pengguna dan konteks, supaya percakapan tidak bocor antar akun/halaman. */
export function storageKey({ userId, campaignId, runId }) {
    const scope = campaignId ? `c${campaignId}` : runId ? `r${runId}` : 'x';
    return `lactatwin.chat.u${userId}.${scope}`;
}

/** Hanya teks polos dan bendera galat; tidak ada HTML, sumber, atau usulan. */
export function serializeChat({ conversationId, history, messages }) {
    return JSON.stringify({
        v: 1,
        conversationId: conversationId || null,
        history: history.slice(-MAX_HISTORY).map((m) => ({ role: m.role, content: String(m.content).slice(0, MAX_STORED_TEXT) })),
        messages: messages.slice(-MAX_STORED).map((m) => ({
            role: m.role === 'user' ? 'user' : 'assistant',
            text: String(m.text).slice(0, MAX_STORED_TEXT),
            meta: m.meta ? String(m.meta).slice(0, 300) : '',
            error: Boolean(m.error),
        })),
    });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pulihkan percakapan; data rusak atau berbeda versi diabaikan (null), bukan dipercaya. */
export function restoreChat(raw) {
    let o;
    try {
        o = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!o || o.v !== 1 || !Array.isArray(o.messages) || !Array.isArray(o.history)) return null;
    const ok = (m, k) => m && (m.role === 'user' || m.role === 'assistant') && typeof m[k] === 'string';
    return {
        conversationId: typeof o.conversationId === 'string' && UUID.test(o.conversationId) ? o.conversationId : null,
        history: o.history.filter((m) => ok(m, 'content')).slice(-MAX_HISTORY).map((m) => ({ role: m.role, content: m.content.slice(0, MAX_STORED_TEXT) })),
        messages: o.messages.filter((m) => ok(m, 'text')).slice(-MAX_STORED).map((m) => ({
            role: m.role,
            text: m.text.slice(0, MAX_STORED_TEXT),
            meta: typeof m.meta === 'string' ? m.meta.slice(0, 300) : '',
            error: m.error === true,
        })),
    };
}

/** Chip pertanyaan awal. Sengaja tanpa angka: semua angka harus datang dari alat, bukan dari kami. */
export function suggestions({ campaignId, runId, canApprove }) {
    const out = [];
    if (campaignId) {
        out.push('Bagaimana kondisi pabrik pada hari ini?');
        out.push('Usulkan jadwal maintenance tangki yang paling aman.');
        if (canApprove) out.push('Apa saja usulan yang menunggu persetujuan saya?');
    } else if (runId) {
        out.push('Ringkas hasil run ini.');
        out.push('Apa penyebab utama truk menunggu?');
    } else {
        out.push('Apa yang bisa kamu bantu?');
    }
    return out;
}

/** Awalan pesan untuk membahas/merevisi satu usulan lewat chat; pengguna melanjutkan mengetik. */
export function revisePrompt(p) {
    return `Usulan ${describeWindow(p.payload)} (versi ${p.version}): `;
}

/**
 * Tangki yang perlu servis menurut state operasi (belum dijadwalkan). Hanya pemberitahuan: usulan baru disusun asisten
 * setelah pengguna menekan tombolnya, dan baru diterapkan setelah pengguna mengizinkan.
 */
export function dueNotice(op) {
    const m = op?.maintenance;
    if (!op?.exists || !m?.open) return null;
    const tanks = m.tanks.filter((t) => t.state !== 'ok' && !t.planned).sort((a, b) => b.cycles - a.cycles);
    if (!tanks.length) return null;
    const label = (t) => `${t.asset} (${t.cycles}/${t.limit} siklus, ${t.state === 'due' ? 'perlu servis' : 'mendekati batas'})`;
    const names = tanks.map((t) => t.asset);
    return {
        tanks,
        text: `Tangki berikut belum dijadwalkan servis: ${tanks.map(label).join('; ')}.`,
        prompt: `Tangki ${names.join(', ')} sudah dekat atau melewati batas servis. Usulkan jadwal maintenance yang aman untuk Hari ${m.day}.`,
    };
}

/** Izin satu klik: alasan bawaan dipakai bila catatan dikosongkan (server tetap mewajibkan alasan). */
export const ALLOW_REASON = 'Disetujui lewat Asisten AI';
export function allowReason(note) {
    const t = String(note ?? '').trim();
    return t.length >= REASON_MIN ? t.slice(0, REASON_MAX) : ALLOW_REASON;
}

/** Banyak karakter per tik agar pengetikan selesai dalam batas tik tetap (balasan panjang tidak lambat). */
export function revealStep(total, maxTicks = 70) {
    return Math.max(2, Math.ceil(total / maxTicks));
}

const TOOL_LABELS = {
    get_state: 'Status Run',
    compare_schedules: 'Perbandingan Jadwal',
    explain: 'Analisis Sebab',
    trace_batch: 'Pelacakan Batch',
    predict_truck: 'Prediksi AI Truk',
    anomaly_status: 'Deteksi Anomali',
    list_assets: 'Daftar Aset',
    asset_activity: 'Aktivitas Aset',
    summarize_report: 'Ringkasan Laporan',
    prepare_report_export: 'Siapkan Ekspor',
    campaign_state: 'Status Kampanye',
    run_whatif: 'Simulasi What-If',
    scan_whatif: 'Pindai Jendela What-If',
    create_proposal: 'Draf Usulan',
};

/** Ringkas daftar panggilan alat menjadi lencana langkah yang ramah pengguna. */
export function toolSummaryBadges(tools) {
    if (!Array.isArray(tools) || !tools.length) return [];
    const grouped = new Map();
    for (const item of tools) {
        if (!item?.tool) continue;
        const prev = grouped.get(item.tool) ?? { count: 0, ok: true, ms: 0 };
        prev.count += 1;
        prev.ok = prev.ok && item.ok !== false;
        if (Number.isFinite(item.ms) && item.ms > 0) prev.ms += Math.round(item.ms);
        grouped.set(item.tool, prev);
    }
    return [...grouped.entries()].map(([name, info]) => {
        const base = TOOL_LABELS[name] ?? name;
        const countStr = info.count > 1 ? ` ×${info.count}` : '';
        const msStr = info.ms > 0 ? ` · ${info.ms} mdtk` : '';
        return { tool: name, label: `${base}${countStr}${msStr}`, ok: info.ok };
    });
}

/** Saran tindak lanjut dinamis sesudah balasan asisten (tanpa angka agar tidak menyalahi aturan grounding). */
export function followUpSuggestions(tools, { campaignId, runId, canApprove, selected } = {}) {
    const names = new Set((tools ?? []).map((t) => t?.tool).filter(Boolean));
    const out = [];
    if (selected && SAFE_CODE.test(selected)) {
        out.push('Bagaimana aktivitas dan status aset terpilih ini?');
    }
    if (names.has('run_whatif') || names.has('scan_whatif')) {
        out.push('Bandingkan dengan jendela waktu mulai yang lebih siang.');
        if (campaignId && !names.has('create_proposal')) out.push('Susun draf usulan dari hasil simulasi terbaik ini.');
    }
    if (names.has('create_proposal')) {
        out.push('Jelaskan alasan utama memilih jendela waktu tersebut.');
        out.push('Bagaimana jika digeser ke tangki kandidat lain?');
    }
    if (names.has('get_state') || names.has('summarize_report')) {
        out.push('Apa penyebab utama truk menunggu atau ditahan di gate?');
        if (runId) out.push('Siapkan unduhan laporan PDF untuk run ini.');
    }
    if (names.has('explain') || names.has('anomaly_status')) {
        out.push('Bagaimana dampak temuan ini terhadap kepatuhan jadwal?');
    }
    if (names.has('campaign_state') && !names.has('run_whatif')) {
        out.push('Pindai jadwal maintenance paling aman untuk tangki yang perlu servis.');
    }
    if (!out.length) {
        if (campaignId) out.push('Usulkan jadwal maintenance tangki yang paling aman.');
        if (runId) out.push('Apa penyebab utama penahanan gate pada hari ini?');
        if (canApprove && campaignId) out.push('Apa saja usulan yang menunggu persetujuan saya?');
    }
    return [...new Set(out)].slice(0, 3);
}

