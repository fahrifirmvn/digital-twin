// Logika murni tampilan Twin: status -> nada/ikon/label, daftar pin, dan isi sheet detail. Tanpa DOM dan tanpa three.js.
import { capacityOf } from '../state.js';
import { clock, fmtL } from './format.js';

export const MAX_PINS = 16;
const TONE_RANK = { bad: 0, warn: 1, lab: 2, brand: 3, ok: 4, mute: 5 };

const ASSET = {
    idle: ['mute', 'Siaga'],
    in_use: ['brand', 'Aktif'],
    filling: ['ok', 'Mengisi'],
    holding: ['lab', 'Menahan'],
    cip: ['warn', 'CIP'],
    unavailable: ['bad', 'Tidak tersedia'],
};
const UNIT_LABEL = { DEG: 'Degassing', THM: 'Termisasi', SEP: 'Separator', STE: 'Sterilizer UHT', ASEP: 'Aseptic tank', LINE: 'Filling line' };
const TRUCK = {
    queued: ['mute', 'Antre'],
    sampling: ['lab', 'Sampling'],
    lab_test: ['lab', 'Uji lab'],
    released: ['ok', 'Rilis'],
    unloading: ['brand', 'Bongkar'],
    rejected: ['bad', 'Ditolak'],
    stored: ['ok', 'Selesai'],
};

// Warna tidak berdiri sendiri: tiap nada selalu berpasangan dengan ikon dan teks.
function iconOf(tone, kind) {
    if (tone === 'bad' || tone === 'warn') return 'alert';
    if (tone === 'ok') return 'check';
    if (tone === 'lab') return 'flask';
    if (tone === 'mute') return 'clock';
    return kind === 'truck' ? 'truck' : 'droplets';
}

export function assetStatus(status = 'idle') {
    const [tone, label] = ASSET[status] ?? ['mute', status];
    return { tone, label, icon: iconOf(tone, 'asset') };
}

/** Umur isi aseptic tank dan sisa holding (menit); null bila tangki kosong. */
export function asepAge(a, m) {
    if (!a || a.sinceM == null || !a.holdMax) return null;
    const age = Math.max(0, m - a.sinceM);
    return { age, left: a.holdMax - age, over: age > a.holdMax };
}

/** Status aset untuk chip dan pin; aseptic tank bisa hampir habis atau melewati holding time. */
export function assetChip(a, m, code = '') {
    // Tangki yang tidak tersedia berarti sedang maintenance (perintah PPIC), bukan rusak.
    if (a?.status === 'unavailable' && code.startsWith('TK-')) return { tone: 'warn', label: 'Maintenance', icon: 'alert' };
    const base = assetStatus(a?.status);
    if (!a || a.cap == null || (code && !code.startsWith('ASEP-'))) return base; // holding time hanya untuk aseptic tank
    if (asepAge(a, m)?.over) return { tone: 'bad', label: 'Melewati holding', icon: 'alert' };
    if (a.low) return { tone: 'warn', label: 'Hampir habis', icon: 'alert' };
    return a.level > 0 ? base : { tone: 'mute', label: 'Kosong', icon: 'clock' };
}

export function truckStatus(t) {
    if (t.held && t.status !== 'rejected') return { tone: 'bad', label: `Ditahan ${t.held}`, icon: 'alert' };
    const [tone, label] = TRUCK[t.status] ?? ['mute', t.status];
    return { tone, label, icon: iconOf(tone, 'truck') };
}

const ATTENTION = new Set(['bad', 'warn']);

const GATES = [['G1', 'Kedatangan'], ['G2', 'Hasil lab'], ['G3', 'Bongkar ke tangki']];

/** Status gate mutu per truk; gate yang belum diputuskan tampil Menunggu. */
export function gateChips(t) {
    return GATES.map(([gate, name]) => {
        const g = t.gates?.[gate];
        if (!g) return { gate, name, tone: 'mute', icon: 'clock', label: 'Menunggu', reason: null };
        if (g.decision === 'pass') return { gate, name, tone: 'ok', icon: 'check', label: 'Lolos', reason: null };
        return { gate, name, tone: 'bad', icon: 'alert', label: 'Tahan', reason: g.reason };
    });
}

/** Pin hanya untuk yang perlu perhatian (aset CIP/tidak tersedia, truk ditahan/ditolak); status biasa terbaca dari warna aset. */
export function pinsOf(state, hasAnchor) {
    const pins = [];
    for (const [code, a] of Object.entries(state.assets)) {
        if (!hasAnchor(code)) continue;
        const s = assetChip(a, state.m, code);
        if (!ATTENTION.has(s.tone)) continue;
        const level = a.level != null && (a.cap ?? capacityOf(code)) ? ` · ${fmtL(a.level)}` : '';
        pins.push({ key: code, kind: 'asset', code, ...s, text: `${code} · ${s.label}${level}` });
    }
    for (const t of Object.values(state.tankers)) {
        const s = truckStatus(t);
        if (s.tone !== 'bad') continue;
        pins.push({ key: t.code, kind: 'truck', code: t.code, ...s, text: `${t.code}${t.plate ? ` (${t.plate})` : ''} · ${s.label}` });
    }
    pins.sort((x, y) => TONE_RANK[x.tone] - TONE_RANK[y.tone] || x.key.localeCompare(y.key));
    return pins.slice(0, MAX_PINS);
}

const STATUS_UNITS = /^(STE|LINE|DEG|THM|SEP)-/;
const NEAR_FULL = 90;

// Anomali AI bersifat satu angka untuk seluruh pabrik; tiap flag ditandai di aset yang paling relevan.
const ANOMALY_AT = {
    FLOW_RATE_ANOMALY: ['DEG-1', 'Laju alir menyimpang'],
    HOLDING_TIME_EXCEEDED: ['TK-RAW-1', 'Holding time terlampaui'],
    MASS_BALANCE_RESIDUAL_HIGH: ['SEP-1', 'Residual neraca tinggi'],
};

/** Peta kode aset -> daftar label anomali; kosong bila model tidak menandai anomali. */
export function anomalyMarks(anomaly) {
    const marks = new Map();
    if (!anomaly?.is_anomaly) return marks;
    for (const flag of anomaly.flags ?? []) {
        const [code, label] = ANOMALY_AT[flag] ?? [];
        if (code) marks.set(code, [...(marks.get(code) ?? []), label]);
    }
    return marks;
}

/**
 * Lencana di atas aset: persen isi untuk semua tangki (TK-RAW, TK-STO, ASEP; kosong = 0%) dan status singkat untuk unit proses yang sedang aktif.
 * Nada mengikuti isi (hampir penuh = warn) atau chip perhatian aseptic tank; teks selalu menyertakan angka/label, bukan warna saja.
 */
export function levelBadges(state, hasAnchor, marks = new Map()) {
    const out = [];
    for (const [code, a] of Object.entries(state.assets)) {
        if (!hasAnchor(code)) continue;
        const cap = a.cap ?? capacityOf(code);
        if (cap && a.level != null) {
            const pct = Math.max(0, Math.min(100, Math.round((a.level / cap) * 100)));
            const chip = assetChip(a, state.m, code);
            const tone = ATTENTION.has(chip.tone) ? chip.tone : pct >= NEAR_FULL ? 'warn' : pct <= 0 ? 'mute' : 'brand';
            const note = ATTENTION.has(chip.tone) ? ` · ${chip.label}` : '';
            out.push({ key: code, code, kind: 'level', pct, tone, text: pct <= 0 && ATTENTION.has(chip.tone) ? chip.label : `${pct}%`, title: `${code} · ${fmtL(a.level)} / ${fmtL(cap)} (${pct}%)${note}` });
        } else if (STATUS_UNITS.test(code) && a.status && a.status !== 'idle') {
            const s = assetStatus(a.status);
            out.push({ key: code, code, kind: 'status', pct: null, tone: s.tone, text: s.label, title: `${code} · ${UNIT_LABEL[code.split('-')[0]]} · ${s.label}` });
        }
    }
    for (const [code, labels] of marks) {
        if (!hasAnchor(code)) continue;
        const note = `Anomali AI: ${labels.join(', ')}`;
        const b = out.find((x) => x.key === code);
        if (b) Object.assign(b, { tone: 'bad', text: `! ${b.text}`, title: `${b.title} · ${note}` });
        else out.push({ key: code, code, kind: 'anomaly', pct: null, tone: 'bad', text: '! Anomali', title: `${code} · ${note}` });
    }
    return out.sort((x, y) => x.key.localeCompare(y.key, 'en', { numeric: true }));
}

export const DETECT_WINDOW_MIN = 20;
export const MAX_BOXES = 6;

/** Kotak deteksi di gerbang: truk yang baru tiba (plat terbaca) beserta hasil G1; terbaru dulu. */
export function detections(state) {
    return Object.values(state.tankers)
        .filter((t) => state.m - t.arrivedAt <= DETECT_WINDOW_MIN)
        .sort((a, b) => b.arrivedAt - a.arrivedAt || a.code.localeCompare(b.code))
        .slice(0, MAX_BOXES)
        .map((t) => {
            const g = t.gates?.G1;
            const [tone, label] = !g ? ['warn', 'Memeriksa G1'] : g.decision === 'pass' ? ['ok', 'G1 lolos'] : ['bad', 'G1 tahan'];
            return { key: t.code, code: t.code, plate: t.plate ?? t.code, tone, label };
        });
}

function asepRows(a, m) {
    if (!(a.level > 0)) return [['Lot', 'tidak ada isi']];
    const t = asepAge(a, m);
    const rows = [['Lot tertua', a.lot ?? '-'], ['Mulai masuk', clock(a.sinceM)]];
    if (a.fillM != null) rows.push(['Mulai isi', clock(a.fillM)]);
    if (t) {
        rows.push(['Umur isi', `${Math.round(t.age)} mnt`]);
        rows.push(['Sisa holding', t.over ? `lewat ${Math.round(-t.left)} mnt` : `${Math.round(t.left)} mnt dari ${a.holdMax}`]);
    }
    return rows;
}

const skuName = (c) => c.replace(/^UHT-/, '');

/** Rute STE -> ASEP -> LINE dan izin SKU (event plant.routes); kosong bila kode tidak ikut rute. */
export function routeRows(routes, code) {
    if (!routes) return [];
    const list = routes.routes;
    if (code.startsWith('LINE-')) {
        const r = list.find((x) => x.line === code);
        if (!r) return [];
        const rows = [['Sumber', `${r.aseptic} (${r.sterilizer})`]];
        if (!r.usable) return [...rows, ['Rute diblokir', r.reason]];
        rows.push(['SKU diizinkan', r.allowed.map(skuName).join(', ') || '-']);
        for (const b of r.blocked) rows.push(['SKU ditolak', b.reason]);
        return rows;
    }
    const k = code.match(/^(?:STE|ASEP)-(\d+)$/)?.[1];
    const mine = k ? list.filter((x) => x.sterilizer === `STE-${k}`) : [];
    if (!mine.length) return [];
    return [
        ['Rute', `STE-${k} > ASEP-${k} > ${mine.map((x) => x.line).join(', ')}`],
        ...mine.map((r) => [r.line, !r.usable ? 'diblokir (batas aliran)' : r.blocked.length ? `${r.allowed.map(skuName).join(', ')}; ditolak ${r.blocked.map((b) => skuName(b.sku)).join(', ')}` : 'semua SKU']),
    ];
}

/** Isi sheet detail untuk truk atau aset; null bila kode tidak dikenal. */
export function detailOf(state, code) {
    const t = state.tankers[code];
    if (t) {
        const s = truckStatus(t);
        const rows = [
            ['Asal', t.farm],
            ...(t.plate ? [['Plat', t.plate]] : []),
            ['Volume', fmtL(t.volume)],
            ['Suhu', `${t.temp} °C`],
            ['Tiba', clock(t.arrivedAt)],
        ];
        if (t.bay) rows.push(['Bay', t.bay]);
        if (!['rejected', 'stored'].includes(t.status)) rows.push(['Di pabrik', `${Math.max(0, Math.round(state.m - t.arrivedAt))} mnt`]);
        return { kind: 'truck', code, title: code, chip: s, rows, gates: gateChips(t) };
    }
    const known = code in state.assets || /^(BAY|TK|DEG|THM|SEP|STE|ASEP|LINE)-/.test(code);
    if (!known) return null;
    const a = state.assets[code] ?? { status: 'idle', level: null };
    const rows = [];
    const kind = UNIT_LABEL[code.split('-')[0]];
    if (kind) rows.push(['Jenis', kind]);
    const cap = a.cap ?? capacityOf(code);
    if (a.level != null && cap) rows.push(['Isi', `${fmtL(a.level)} (${Math.round((a.level / cap) * 100)}%)`]);
    if (cap) rows.push(['Kapasitas', fmtL(cap)]);
    if (code.startsWith('ASEP-')) rows.push(...asepRows(a, state.m));
    rows.push(...routeRows(state.routes, code));
    if (a.changeover && a.changeover.until > state.m) rows.push(['Changeover', `ke ${a.changeover.to} sampai ${clock(a.changeover.until)}`]);
    const unloading = Object.values(state.tankers).find((x) => x.status === 'unloading' && x.bay === code);
    if (unloading) rows.push(['Truk', unloading.code]);
    return { kind: 'asset', code, title: code, chip: assetChip(a, state.m, code), rows };
}
