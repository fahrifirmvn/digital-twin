// Ringkasan murni untuk Dashboard dan panel Twin: statistik langsung, antrean keputusan, uji mutu, tracker truk, tabel aset.
// Tanpa DOM; semua dihitung dari state hasil reducer pada menit tertentu.
import { capacityOf } from '../state.js';
import { fmtL } from './format.js';
import { assetStatus, truckStatus } from './status.js';

const WAITING = new Set(['queued', 'sampling', 'lab_test', 'released']);
const DONE = new Set(['stored', 'rejected']);

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Angka kartu KPI langsung. total = jumlah truk seluruh hari (untuk "dalam perjalanan"). */
export function liveStats(state, total = 0) {
    const trucks = Object.values(state.tankers);
    const started = trucks.filter((t) => t.unloadAt != null);
    const holds = Object.values(state.gateHolds).reduce((a, b) => a + b, 0);
    const passes = state.counters.gatePass ?? 0;
    return {
        waiting: trucks.filter((t) => WAITING.has(t.status)).length,
        avgWaitMin: mean(started.map((t) => t.unloadAt - t.arrivedAt)),
        inTransit: Math.max(0, total - state.counters.arrived),
        inbound: Object.keys(state.inbound ?? {}).length,
        detected: state.counters.arrived,
        labQueue: trucks.filter((t) => t.status === 'sampling').length,
        labTesting: trucks.filter((t) => t.status === 'lab_test').length,
        unloading: trucks.filter((t) => t.status === 'unloading').length,
        holds,
        gatePassPct: passes + holds ? (passes / (passes + holds)) * 100 : null,
    };
}

const minutesIn = (state, t) => Math.max(0, Math.round(state.m - t.since));

/** Truk yang butuh keputusan manusia: ditahan atau ditolak, terbaru dulu. */
export function decisions(state) {
    return Object.values(state.tankers)
        .filter((t) => t.held || t.status === 'rejected')
        .map((t) => {
            const gate = Object.entries(t.gates ?? {}).find(([, g]) => g.decision === 'hold');
            const label = t.status === 'rejected' ? 'Ditolak' : `Ditahan ${t.held}`;
            return { code: t.code, farm: t.farm, label, reason: gate?.[1].reason ?? null, tone: 'bad', since: t.since, ago: minutesIn(state, t) };
        })
        .sort((a, b) => b.since - a.since);
}

/** Truk dalam tahap uji mutu (sampling/lab), yang paling lama menunggu lebih dulu. */
export function labPrep(state) {
    return Object.values(state.tankers)
        .filter((t) => t.status === 'sampling' || t.status === 'lab_test')
        .sort((a, b) => a.since - b.since)
        .map((t) => ({ code: t.code, farm: t.farm, volume: t.volume, chip: truckStatus(t), ago: minutesIn(state, t) }));
}

/** Seluruh truk (terbaru tiba dulu) untuk tabel; dibatasi limit. */
export function truckRows(state, limit = 40) {
    return Object.values(state.tankers)
        .sort((a, b) => b.arrivedAt - a.arrivedAt || a.code.localeCompare(b.code))
        .slice(0, limit)
        .map((t) => ({
            code: t.code,
            farm: t.farm,
            volume: t.volume,
            chip: truckStatus(t),
            bay: t.bay,
            wait: t.unloadAt != null ? Math.round(t.unloadAt - t.arrivedAt) : DONE.has(t.status) ? null : Math.round(state.m - t.arrivedAt),
        }));
}

const STEPS = ['Antre', 'Uji lab', 'Rilis', 'Bongkar', 'Selesai'];
const STEP_OF = { queued: 0, sampling: 1, lab_test: 1, released: 2, unloading: 3, stored: 4, rejected: 1 };

/** Langkah pelacakan satu truk: done/current/todo, bad bila ditahan atau ditolak di langkah itu. */
export function trackerSteps(t) {
    const at = STEP_OF[t.status] ?? 0;
    const bad = t.status === 'rejected' || (t.held && !DONE.has(t.status));
    return STEPS.map((label, i) => {
        let st = i < at ? 'done' : i === at ? 'current' : 'todo';
        if (t.status === 'stored') st = 'done';
        if (i === at && bad) st = 'bad';
        return { label, state: st };
    });
}

/** Kode aset menurut tab dari layout (bay di hall, silo tangki, proses hilir). */
export function layoutCodes(layout) {
    const units = layout.units ?? [];
    return {
        bay: (layout.halls ?? []).flatMap((h) => h.bays ?? []),
        silo: (layout.silos ?? []).map((s) => s.code),
        // Aseptic tank menempel pada tiap sterilizer (ASEP-n untuk STE-n) dan dapat dipilih lewat tabel.
        proc: [...units.map((u) => u.code), ...units.filter((u) => u.code.startsWith('STE-')).map((u) => `ASEP-${u.code.slice(4)}`)],
    };
}

/** Baris tabel aset untuk tab bay | silo | proc | lab. */
export function assetRows(state, tab, codes) {
    if (tab === 'lab') {
        return labPrep(state).map((r) => ({ code: r.code, detail: `${r.farm} · ${fmtL(r.volume)}`, chip: r.chip, extra: `${r.ago} mnt` }));
    }
    return (codes[tab] ?? []).map((code) => {
        const a = state.assets[code] ?? { status: 'idle', level: null };
        const cap = capacityOf(code);
        const truck = tab === 'bay' ? Object.values(state.tankers).find((t) => t.status === 'unloading' && t.bay === code) : null;
        const fill = a.level != null && cap ? `${fmtL(a.level)} / ${fmtL(cap)}` : null;
        return { code, detail: truck ? truck.code : fill ?? '-', chip: assetStatus(a.status), extra: null };
    });
}
