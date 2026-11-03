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

/** Isi POST /agent/turn. Riwayat hanya user/assistant dan dipotong sesuai batas server. */
export function buildTurn({ message, conversationId, runId, campaignId, history }) {
    const body = {
        message: String(message).trim().slice(0, MAX_MESSAGE),
        history: history.slice(-MAX_HISTORY).map((m) => ({ role: m.role, content: String(m.content).slice(0, MAX_HISTORY_CONTENT) })),
    };
    if (conversationId) body.conversation_id = conversationId;
    if (runId) body.run_id = Number(runId);
    if (campaignId) body.campaign_id = Number(campaignId);
    return body;
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
        return {
            key,
            label,
            text: `${c.baseline} -> ${c.candidate}${unit ? ` ${unit}` : ''} (${sign}${c.change})`,
            tone: c.better ? 'better' : 'worse',
            verdict: c.better ? 'lebih baik' : 'lebih buruk',
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

/** Galat HTTP -> pesan ramah; 422 memakai pesan validasi pertama. */
export function httpError(status, body) {
    if (status === 429) return 'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.';
    if (status === 403) return 'Peran Anda tidak diizinkan melakukan ini.';
    if (status === 401 || status === 419) return 'Sesi berakhir. Muat ulang halaman dan masuk kembali.';
    if (body?.errors) return Object.values(body.errors).flat()[0] ?? `Gagal (HTTP ${status}).`;
    return body?.message || `Gagal (HTTP ${status}).`;
}
