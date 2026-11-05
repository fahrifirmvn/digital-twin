// Model Zona Proses: fungsi murni dari state replay (reducer yang sama dengan Twin 3D) dan jumlah modul pabrik.
// Tidak ada angka contoh: bagian yang belum punya sumber data tidak ditampilkan.
import { normalizePlant } from '../layout/plant.js';
import { capacityOf } from '../state.js';
import { fmtL } from '../ui/format.js';
import { asepAge, assetChip } from '../ui/status.js';

const range = (n) => Array.from({ length: n }, (_, i) => i + 1);
const LINES_PER_STE = 2;
export const RATE_WINDOW_MIN = 60;

export const fmtTph = (tph) => `${tph.toFixed(1).replace('.', ',')} t/jam`;
export const pct = (level, cap) => (cap > 0 ? Math.max(0, Math.min(100, Math.round((level / cap) * 100))) : 0);

/** Laju (ton/jam) perpindahan yang cocok dengan `test` selama jendela terakhir; jendela memendek di awal hari. */
export function rateTph(flows, m, test, window = RATE_WINDOW_MIN) {
    const w = Math.max(10, Math.min(window, m));
    const vol = flows.filter((f) => f.m > m - w && f.m <= m && test(f)).reduce((a, f) => a + f.vol, 0);
    return (vol * 60) / w;
}

const starts = (key, prefix) => (f) => (f[key] ?? '').startsWith(prefix);
const LINKS = {
    recvRaw: starts('to', 'TK-RAW'),
    rawPre: starts('from', 'TK-RAW'),
    preSto: starts('to', 'TK-STO'),
    stoSte: starts('from', 'TK-STO'),
    steAsep: starts('to', 'ASEP-'),
    asepLine: (f) => f.from.startsWith('ASEP-') && f.to.startsWith('LINE-'),
    lineOut: (f) => f.to === 'PACK-OUT',
};

/** Pasangan sterilizer -> aseptic -> line; mengikuti rute engine bila sudah ada, selain itu pola bawaan. */
export function routesOf(plant, state) {
    const p = normalizePlant(plant);
    const usable = new Set((state.routes?.routes ?? []).filter((r) => r.usable).map((r) => r.line));
    return range(p.n_sterilizers).map((k) => {
        const lines = range(LINES_PER_STE).map((i) => `LINE-${(k - 1) * LINES_PER_STE + i}`);
        return { k, ste: `STE-${k}`, asep: `ASEP-${k}`, lines: state.routes ? lines.filter((l) => usable.has(l)) : lines };
    });
}

const LABEL = { BAY: 'Bay bongkar', 'TK-RAW': 'Tangki susu mentah', DEG: 'Degassing', THM: 'Termisasi', SEP: 'Separator', 'TK-STO': 'Tangki penyimpanan', STE: 'Sterilizer UHT', ASEP: 'Aseptic tank', LINE: 'Filling line' };
export const kindOf = (code) => (code.startsWith('TK-') ? code.slice(0, 6) : code.replace(/-\d+$/, ''));
export const labelOf = (code) => LABEL[kindOf(code)] ?? code;
const isTank = (code) => /^(TK-RAW|TK-STO|ASEP)/.test(code);

/** Satu aset pada papan: chip status, isi (tangki), dan satu baris keterangan. */
function itemOf(code, state) {
    const a = state.assets[code];
    const chip = assetChip(a ?? { status: 'idle' }, state.m, code);
    const out = { code, label: labelOf(code), chip, pct: null, level: null, cap: null, note: '', warn: chip.tone === 'bad' || chip.tone === 'warn' };
    if (isTank(code)) {
        const cap = a?.cap ?? capacityOf(code);
        const level = a?.level ?? 0;
        Object.assign(out, { level, cap, pct: pct(level, cap) });
        out.note = cap ? `${fmtL(level)} / ${fmtL(cap)}` : '-';
        const age = code.startsWith('ASEP-') ? asepAge(a, state.m) : null;
        if (age) out.note += ` · umur ${Math.round(age.age)} mnt`;
        if (out.pct >= 90) out.warn = true;
    } else if (code.startsWith('BAY-')) {
        const t = Object.values(state.tankers).find((x) => x.status === 'unloading' && x.bay === code);
        if (t) out.note = `${t.code} · ${fmtL(t.volume)}`;
    } else if (a?.changeover && a.changeover.until > state.m) {
        out.note = `Ganti SKU ${a.changeover.to}`;
    }
    return out;
}

const group = (title, codes, state) => ({ title, items: codes.map((c) => itemOf(c, state)) });

/** Papan proses: enam tahap berurutan dengan laju antar tahap (dari perpindahan nyata) dan ringkasan KPI. */
export function processModel(plant, state) {
    const p = normalizePlant(plant);
    const routes = routesOf(p, state);
    const rate = (key) => {
        const tph = rateTph(state.flows, state.m, LINKS[key]);
        return { tph, active: tph > 0 };
    };
    const codes = (prefix, n) => range(n).map((i) => `${prefix}-${i}`);
    const lineCodes = routes.flatMap((r) => r.lines);
    const stages = [
        { key: 'recv', title: 'Penerimaan', groups: [group('Bay bongkar', codes('BAY', p.n_bays), state)], rate: rate('recvRaw') },
        { key: 'raw', title: 'Tangki susu mentah', groups: [group('Tangki mentah', codes('TK-RAW', p.n_raw_tanks), state)], rate: rate('rawPre') },
        {
            key: 'pre',
            title: 'Pra-proses',
            groups: [
                group('Degassing', codes('DEG', p.n_degassing), state),
                group('Termisasi', codes('THM', p.n_thermal), state),
                group('Separator', codes('SEP', p.n_separators), state),
            ],
            rate: rate('preSto'),
        },
        { key: 'sto', title: 'Penyimpanan', groups: [group('Tangki penyimpanan', codes('TK-STO', p.n_storage_tanks), state)], rate: rate('stoSte') },
        {
            key: 'ste',
            title: 'Sterilisasi dan aseptic',
            groups: [group('Sterilizer UHT', routes.map((r) => r.ste), state), group('Aseptic tank', routes.map((r) => r.asep), state)],
            rate: rate('steAsep'),
        },
        { key: 'fill', title: 'Filling dan produk jadi', groups: [group('Filling line', lineCodes, state)], rate: rate('lineOut') },
    ];
    const sum = (prefix) => Object.entries(state.assets).filter(([c]) => c.startsWith(prefix)).reduce((a, [, x]) => a + (x.level ?? 0), 0);
    const items = stages.flatMap((s) => s.groups.flatMap((g) => g.items));
    return {
        m: state.m,
        stages,
        kpis: {
            unloaded: state.counters.unloaded,
            rawTon: sum('TK-RAW'),
            stoTon: sum('TK-STO'),
            asepTon: sum('ASEP-'),
            fgTon: state.counters.fgTon,
            qaHoldTon: state.counters.qaHoldTon,
            attention: items.filter((i) => i.warn).length,
        },
        codes: items.map((i) => i.code),
    };
}

/** Laju masuk dan keluar satu aset dari perpindahan terakhir. */
export function flowsOf(code, state) {
    return {
        into: rateTph(state.flows, state.m, (f) => f.to === code),
        out: rateTph(state.flows, state.m, (f) => f.from === code),
    };
}

/** Perpindahan terakhir yang melibatkan aset (terbaru dulu), untuk bagian riwayat. */
export function historyOf(code, state, limit = 6) {
    return state.flows.filter((f) => f.from === code || f.to === code).slice(-limit).reverse()
        .map((f) => ({ m: f.m, text: f.from === code ? `Keluar ${fmtL(f.vol)} ke ${f.to}` : `Masuk ${fmtL(f.vol)} dari ${f.from}` }));
}

/** Isi panel detail satu aset; hanya baris yang punya sumber data. */
export function detailOf(code, state) {
    const item = itemOf(code, state);
    const a = state.assets[code];
    const { into, out } = flowsOf(code, state);
    const rows = [['Status', item.chip.label]];
    if (item.cap) {
        rows.push(['Isi', `${fmtL(item.level)} (${item.pct}%)`], ['Kapasitas', fmtL(item.cap)]);
        if (item.pct >= 90) rows.push(['Peringatan', 'Hampir penuh']);
    }
    const age = code.startsWith('ASEP-') ? asepAge(a, state.m) : null;
    if (age) {
        rows.push(['Umur isi', `${Math.round(age.age)} mnt`], [age.over ? 'Melewati holding' : 'Sisa holding', `${Math.round(Math.abs(age.left))} mnt`]);
    }
    if (a?.lot) rows.push(['Lot tertua', a.lot]);
    if (a?.low) rows.push(['Peringatan', 'Hampir habis saat line masih mengisi']);
    const truck = code.startsWith('BAY-') ? Object.values(state.tankers).find((x) => x.status === 'unloading' && x.bay === code) : null;
    if (truck) rows.push(['Truk', `${truck.code} · ${truck.farm}`], ['Volume truk', fmtL(truck.volume)], ['Suhu tiba', `${String(truck.temp).replace('.', ',')} °C`]);
    if (a?.changeover && a.changeover.until > state.m) rows.push(['Ganti SKU', `${a.changeover.to}, ${Math.round(a.changeover.until - state.m)} mnt lagi`]);
    rows.push(['Aliran masuk', fmtTph(into)], ['Aliran keluar', fmtTph(out)]);
    return { ...item, rows, history: historyOf(code, state) };
}

export const askPrompt = (code) => `Jelaskan kondisi ${code} (${labelOf(code)}) pada hari operasi ini dan hal yang perlu saya perhatikan.`;
export const simPrompt = (code) => (/^TK-(RAW|STO)-\d+$/.test(code)
    ? `Simulasikan maintenance ${code} selama 45 menit mulai 14:00. Tunjukkan dampaknya ke antrean truk dan level tangki lain.`
    : null);
