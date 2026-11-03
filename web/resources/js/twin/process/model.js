// Fungsi murni Zona Proses: persen, status, umur isi, aliran, matriks SKU, penempatan kartu.
import { ASSETS, BAYS, FILLERS, NOW_MIN, PIPES, SKUS } from './dummy.js';

export const fmtInt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
export const fmtDec = (n, d = 1) => n.toFixed(d).replace('.', ',');
export const fmtLph = (n, unit = 'L/jam') => `${fmtInt(n)} ${unit}`;

/** Menit sejak 00:00 -> "HH:MM" jam 24. */
export function hhmm(min) {
    const t = ((Math.round(min) % 1440) + 1440) % 1440;
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

const toMin = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

/** Persen selalu = isi / kapasitas. */
export const pctOf = (a) => Math.max(0, Math.min(100, Math.round((a.levelL / a.capL) * 100)));

/** Umur isi melewati 80% batas holding time. */
export const isAged = (a) => a.levelL > 0 && a.ageH > 0.8 * a.holdMaxH;

/** Lencana persen: amber bila >= 90% atau di bawah minimum; ikon jam bila umur isi mendekati batas. */
export function badgeOf(a) {
    const pct = pctOf(a);
    const high = pct >= 90;
    const low = a.minPct != null && pct < a.minPct;
    return { pct, text: `${pct}%`, warn: high || low, icon: high ? 'arrow-up' : low ? 'arrow-down' : null, aged: isAged(a) };
}

const CHIP = {
    holding: { tone: 'brand', icon: 'droplets', label: 'Menahan' },
    filling: { tone: 'ok', icon: 'arrow-down', label: 'Mengisi' },
    running: { tone: 'ok', icon: 'check', label: 'Berjalan' },
    cip: { tone: 'brand', icon: 'clock', label: 'CIP' },
    maintenance: { tone: 'mute', icon: 'alert', label: 'Maintenance' },
};

/** Status = ikon + teks + warna (tidak pernah warna saja). */
export const chipOf = (a) => CHIP[a.status] ?? CHIP.running;

/** Teks status ringkas di bawah mesin/tangki: titik + teks. dot: ok | cyan | slate. */
export function statusLine(a) {
    if (a.status === 'cip') return { dot: 'cyan', text: `CIP ${a.cip.done}/${a.cip.total} mnt` };
    if (a.status === 'maintenance') return { dot: 'slate', text: `Maintenance ${a.maintenanceAt}` };
    return { dot: 'ok', text: fmtLph(a.rate ?? a.outLph, a.unit) };
}

export const emptyAtMin = (a, now = NOW_MIN) => (a.outLph > 0 && a.levelL > 0 ? now + (a.levelL / a.outLph) * 60 : null);
export const fullAtMin = (a, now = NOW_MIN) => (a.inLph > a.outLph ? now + ((a.capL - a.levelL) / (a.inLph - a.outLph)) * 60 : null);

export function nextStatus(a, now = NOW_MIN) {
    if (a.status === 'cip') return `CIP selesai sekitar ${hhmm(now + a.cip.total - a.cip.done)}`;
    if (a.status === 'maintenance') return `Maintenance dijadwalkan ${a.maintenanceAt}; tangki kosong`;
    const empty = emptyAtMin(a, now);
    if (empty != null) return `Kosong sekitar ${hhmm(empty)}, lalu CIP ${a.cipMin} mnt`;
    const full = fullAtMin(a, now);
    if (full != null) return `Penuh sekitar ${hhmm(full)}`;
    return 'Menahan; belum ada jadwal keluar';
}

export const fillerLph = (f) => (f.rate * f.packMl) / 1000;

/** Total flow FL (liter/jam, dari kecepatan x ukuran kemasan) dibanding output AT. */
export function flowCheck(at, fillers = FILLERS) {
    const total = fillers.reduce((s, f) => s + fillerLph(f), 0);
    return { total, max: at.maxOutLph, ok: total <= at.maxOutLph };
}

const byId = (id) => ASSETS.find((a) => a.id === id);
export const assetById = byId;

/** Hubungan hulu/hilir untuk strip aliran kartu. Tiap baris: {dir, label, lph}. */
export function linksOf(a) {
    const row = (dir, label, lph) => ({ dir, label, lph });
    const rows = {
        'UBAY-01': [row('from', 'Receiving', a.rate), row('to', 'Storage tank', a.rate)],
        'THM-01': [row('from', 'Storage tank', a.inLph), row('to', 'SFP storage', a.outLph)],
        'SFP-01': [row('from', 'Thermizer', a.inLph), row('to', 'Sterilizer', a.outLph)],
        'STE-01': [row('from', 'SFP storage', a.inLph), row('to', 'AT-01', a.outLph)],
        'AT-01': [row('from', 'Sterilizer', a.inLph), row('to', 'FL-01 + FL-02', a.outLph)],
        'FL-01': [row('from', 'AT-01 (Dedicated pipe)', fillerLph(a))],
        'FL-02': [row('from', 'AT-01 (Dedicated pipe)', fillerLph(a))],
    }[a.id];
    if (rows) return rows;
    if (a.group === 'storage') return [row('from', `Bay ${a.fromBay}`, a.inLph), row('to', 'Thermizer', a.outLph)];
    return [];
}

/** Id pipa yang tersambung ke aset (untuk menyalakan pipa saat hover). */
export function pipesOf(id) {
    const key = assetById(id)?.group === 'storage' ? 'STORAGE' : id;
    return PIPES.filter((p) => p.from === key || p.to === key).map((p) => p.id);
}

/** Laju yang ditampilkan pada chip pipa: untuk rak tangki, laju milik tangki yang di-hover. */
export function pipeFlow(pipe, hovered) {
    if (hovered?.group === 'storage') {
        if (pipe.to === 'STORAGE') return hovered.inLph;
        if (pipe.from === 'STORAGE') return hovered.outLph;
    }
    return pipe.lph;
}

export const eligible = (sku, flId) => sku.lines.includes(flId);
export const skuMatrix = () => SKUS.map((s) => ({ name: s.name, FL: FILLERS.map((f) => ({ id: f.id, ok: eligible(s, f.id) })) }));

/** Posisi kartu 12 px dari aset di sisi yang lebih lega; membalik di tepi; tak pernah menutup aset. */
export function placeCard(rect, size, bounds, gap = 12) {
    const room = {
        right: bounds.w - (rect.x + rect.w) - gap,
        left: rect.x - gap,
        below: bounds.h - (rect.y + rect.h) - gap,
        above: rect.y - gap,
    };
    const fits = { right: room.right >= size.w, left: room.left >= size.w, below: room.below >= size.h, above: room.above >= size.h };
    const order = ['right', 'left', 'below', 'above'].sort((p, q) => room[q] - room[p]);
    const side = order.find((k) => fits[k]) ?? order[0];
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
    let x;
    let y;
    if (side === 'right') [x, y] = [rect.x + rect.w + gap, rect.y + rect.h / 2 - size.h / 2];
    else if (side === 'left') [x, y] = [rect.x - gap - size.w, rect.y + rect.h / 2 - size.h / 2];
    else if (side === 'below') [x, y] = [rect.x + rect.w / 2 - size.w / 2, rect.y + rect.h + gap];
    else [x, y] = [rect.x + rect.w / 2 - size.w / 2, rect.y - gap - size.h];
    return { side, x: clamp(x, 0, bounds.w - size.w), y: clamp(y, 0, bounds.h - size.h) };
}

/** KPI ringkas: bongkar, filling, jumlah aset perlu perhatian. */
export function kpis() {
    const bongkar = BAYS.reduce((s, b) => s + b.lph, 0);
    const filling = FILLERS.reduce((s, f) => s + fillerLph(f), 0);
    const attention = ASSETS.filter((a) => a.kind === 'tank' && (badgeOf(a).warn || isAged(a))).length;
    return { bongkar, filling, attention };
}

/** Pita jadwal 06:00 -> 06:00 (menit mutlak 360..1800): isi, kosong, CIP, maintenance. */
export function scheduleOf(a, now = NOW_MIN) {
    const DAY0 = 360;
    const DAY1 = 1800;
    const seg = (type, from, to) => ({ type, from, to });
    const empty = emptyAtMin(a, now);
    if (a.kind !== 'tank') return [seg('isi', DAY0, DAY1)];
    if (a.status === 'maintenance') {
        const m = toMin(a.maintenanceAt);
        return [seg('kosong', DAY0, m), seg('maintenance', m, m + 120), seg('kosong', m + 120, DAY1)];
    }
    if (a.status === 'cip') {
        const end = now + a.cip.total - a.cip.done;
        return [seg('cip', DAY0, end), seg('isi', end, DAY1)];
    }
    if (empty != null) {
        const cipEnd = empty + a.cipMin;
        return [seg('isi', DAY0, empty), seg('cip', empty, cipEnd), seg('isi', cipEnd, DAY1)];
    }
    return [seg('isi', DAY0, DAY1)];
}

/** Lima kejadian terakhir (contoh): jam, pelaku, alasan. */
export function historyOf(a, now = NOW_MIN) {
    const t = (back) => hhmm(now - back);
    if (a.kind === 'tank') {
        return [
            { at: t(6), actor: 'Sistem', reason: `Level ${pctOf(a)}% tercatat` },
            { at: t(41), actor: 'PPIC', reason: 'Jadwal CIP disetujui' },
            { at: t(95), actor: 'Sistem', reason: a.inLph > 0 ? `Pengisian dari Bay ${a.fromBay} dimulai` : 'Pengisian selesai, status menahan' },
            { at: t(180), actor: 'Sistem', reason: 'Pergantian batch tercatat' },
            { at: t(300), actor: 'PPIC', reason: 'Catatan shift pagi dibaca' },
        ];
    }
    return [
        { at: t(4), actor: 'Sistem', reason: `Laju ${fmtLph(a.rate ?? 0, a.unit)} tercatat` },
        { at: t(52), actor: 'Sistem', reason: 'Status berjalan' },
        { at: t(110), actor: 'PPIC', reason: 'Rencana produksi dikonfirmasi' },
        { at: t(210), actor: 'Sistem', reason: 'Pemeriksaan awal shift selesai' },
        { at: t(330), actor: 'PPIC', reason: 'Catatan shift pagi dibaca' },
    ];
}

/** ST-n pada layar ini hanya contoh; padanan simulasi hanya untuk tangki susu mentah TK-RAW-n. */
export const simTarget = (a) => (a.group === 'storage' ? `TK-RAW-${Number(a.id.slice(3))}` : null);

export function simPrompt(a) {
    const target = simTarget(a);
    if (!target) return null;
    return `Simulasikan maintenance ${target} selama 45 menit mulai 14:00. Tunjukkan dampaknya ke antrean truk dan level tangki lain. Angka pada layar Zona Proses hanya contoh.`;
}

export const askPrompt = (a) => `Jelaskan kondisi ${a.id} (${a.name}) pada layar Zona Proses dan hal yang perlu saya perhatikan. Angka layar ini masih contoh, menunggu master/SOP.`;
