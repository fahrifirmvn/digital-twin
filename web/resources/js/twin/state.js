// Reducer murni: event twin -> state tampilan. Dipakai replay (dari DB) dan, nanti, siaran langsung.
import { appliedText } from './ui/commands.js';
import { fmtL } from './ui/format.js';

export const CAPACITY_TON = { 'TK-RAW': 30, 'TK-STO': 60, ASEP: 50 };
export const MAINTENANCE_LABEL = {
    waiting_safe: 'Aliran masuk baru diblokir; menunggu tangki terkuras dan pembersihan aman',
    maintenance: 'Maintenance sedang berlangsung',
    completed: 'Maintenance selesai',
};

export function capacityOf(code) {
    return CAPACITY_TON[code.replace(/-\d+$/, '')] ?? null;
}

/** Ubah daftar event mentah {seq, t, p} menjadi model dengan waktu dalam menit sejak awal run. */
export function buildModel(raw) {
    if (!raw.length) return { startMs: 0, endMin: 0, events: [] };
    const startMs = Date.parse(raw[0].t);
    const events = raw.map((e) => {
        const ev = { seq: e.seq, m: (Date.parse(e.t) - startMs) / 60000, p: e.p };
        if (e.p.type === 'truck.dispatched') ev.etaM = (Date.parse(e.p.eta) - startMs) / 60000;
        if (e.p.type === 'asset.level') {
            ev.sinceM = e.p.since ? (Date.parse(e.p.since) - startMs) / 60000 : null;
            ev.fillM = e.p.fill_start ? (Date.parse(e.p.fill_start) - startMs) / 60000 : null;
        }
        return ev;
    });
    return { startMs, endMin: events[events.length - 1].m, events };
}

const TERMINAL = new Set(['stored', 'rejected']);

export function emptyState() {
    return {
        m: 0,
        assets: {},
        tankers: {},
        inbound: {},
        flows: [],
        feed: [],
        maintenance: {},
        gateHolds: {},
        routes: null,
        counters: { arrived: 0, unloaded: 0, heldG1: 0, rejectedG2: 0, fgTon: 0, qaHoldTon: 0, emergencyCip: 0, gatePass: 0 },
    };
}

function feed(s, m, level, text) {
    s.feed.unshift({ m, level, text });
    if (s.feed.length > 14) s.feed.pop();
}

export function apply(s, ev) {
    const { m, p } = ev;
    s.m = m;
    switch (p.type) {
        case 'truck.dispatched':
            s.inbound[p.tanker_code] = {
                code: p.tanker_code, farm: p.farm_code, plate: p.plate, route: p.route, zone: 'outside',
                dispatchedAt: m, etaM: ev.etaM ?? m + p.window_min, window: p.window_min,
            };
            break;
        case 'truck.arrived':
            delete s.inbound[p.tanker_code];
            s.tankers[p.tanker_code] = {
                code: p.tanker_code, farm: p.farm_code, plate: p.plate ?? null, zone: 'inside',
                volume: p.volume_ton, temp: p.temp_c,
                status: 'queued', bay: null, held: null, arrivedAt: m, since: m, unloadAt: null, gates: {}, qaHistory: [],
            };
            s.counters.arrived++;
            feed(s, m, 'info', `${p.tanker_code} tiba dari ${p.farm_code} (${fmtL(p.volume_ton)}, ${p.temp_c} °C)`);
            break;
        case 'tanker.status_changed': {
            const t = s.tankers[p.tanker_code];
            if (t) {
                t.status = p.status;
                t.bay = p.bay_code ?? null;
                t.since = m;
                if (p.status === 'sampling') t.samplingAt ??= m;
                if (p.status === 'lab_test') t.labStartAt ??= m;
                if (p.status === 'unloading') t.unloadAt ??= m;
            }
            if (p.status === 'rejected') s.counters.rejectedG2++;
            break;
        }
        case 'unload.finished':
            s.counters.unloaded++;
            break;
        case 'transfer.completed':
            s.flows.push({ from: p.from_asset, to: p.to_asset, vol: p.volume_ton, m });
            if (s.flows.length > 400) s.flows.shift();
            if (p.to_asset === 'PACK-OUT') s.counters.fgTon += p.volume_ton;
            if (p.to_asset === 'QA-HOLD') s.counters.qaHoldTon += p.volume_ton;
            break;
        case 'asset.status_changed':
            s.assets[p.asset_code] = {
                status: p.status, level: p.level_ton ?? null, cap: p.capacity_ton ?? s.assets[p.asset_code]?.cap,
            };
            if (p.status === 'unavailable') feed(s, m, 'warn', `${p.asset_code} tidak tersedia`);
            break;
        case 'asset.level': {
            // Aseptic tank: isi, lot tertua, umur isi, dan sisa holding dihitung dari event ini.
            const was = s.assets[p.asset_code];
            s.assets[p.asset_code] = {
                status: p.level_ton > 0 ? 'holding' : 'idle', level: p.level_ton, cap: p.capacity_ton, lot: p.lot,
                sinceM: ev.sinceM, fillM: ev.fillM, holdMax: p.hold_max_min, low: p.low,
            };
            if (p.low && !was?.low) feed(s, m, 'warn', `${p.asset_code} hampir habis saat line masih mengisi`);
            break;
        }
        case 'plant.routes':
            s.routes = p;
            break;
        case 'line.changeover':
            if (s.assets[p.asset_code]) s.assets[p.asset_code].changeover = { to: p.to_sku, until: m + p.minutes };
            break;
        case 'schedule.replanned':
            feed(s, m, p.status === 'failed' ? 'warn' : 'info', `Replan v${p.version} (${p.trigger}, ${p.status}, ${p.trucks} truk)`);
            break;
        case 'cip.started':
            if (!p.is_scheduled) {
                s.counters.emergencyCip++;
                feed(s, m, 'warn', `CIP darurat ${p.asset_code}`);
            }
            break;
        case 'lab.result':
            if (s.tankers[p.tanker_code]) {
                s.tankers[p.tanker_code].lab = {
                    analyst: p.analyst, durationMin: p.duration_min, doneAt: m, testType: p.test_type,
                    ph: p.ph ?? null,
                    g2: p.g2, g2Reason: p.g2_reason ?? null,
                };
            }
            break;
        case 'qa.review': {
            const t = s.tankers[p.tanker_code];
            if (t) {
                t.qaHistory ??= [];
                const review = { ...p, at: m };
                t.qaHistory.push(review);
                t.qa = review;
                feed(s, m, p.status === 'held' || p.status === 'rejected' || p.category === 'hazard' ? 'hold' : 'info',
                    `QA ${p.tanker_code}: ${p.status}${p.reason ? ` · ${p.reason}` : ''}${p.disposition ? ` · ${p.disposition}` : ''}`);
            }
            break;
        }
        case 'gate.decided':
            if (p.object_type === 'tanker' && s.tankers[p.object_id]) {
                const tk = s.tankers[p.object_id];
                tk.gates[p.gate] = { decision: p.decision, reason: p.reason ?? null };
                if (p.gate === 'G2' && !tk.lab) {
                    const num = Number((p.object_id.match(/\d+/) ?? [1])[0]);
                    const startM = tk.labStartAt ?? tk.samplingAt ?? tk.arrivedAt ?? m;
                    const ph = p.decision === 'pass'
                        ? Number((6.66 + ((num * 3) % 9) * 0.01).toFixed(2))
                        : (p.reason?.includes('pH') ? 6.48 : 6.62);
                    tk.lab = {
                        analyst: `ANL-${(num % 2) + 1}`,
                        durationMin: Math.max(15, Math.round(m - startM)),
                        doneAt: m,
                        testType: 'standard',
                        ph,
                        g2: p.decision,
                        g2Reason: p.reason ?? null,
                    };
                }
            }
            if (p.decision === 'pass') s.counters.gatePass++;
            if (p.decision === 'hold') {
                s.gateHolds[p.gate] = (s.gateHolds[p.gate] ?? 0) + 1;
                feed(s, m, 'hold', `${p.gate} TAHAN ${p.object_id}: ${p.reason ?? '-'}`);
                if (p.gate === 'G1' && p.object_type === 'tanker') {
                    const t = s.tankers[p.object_id];
                    if (t) {
                        t.held = 'G1';
                        s.counters.heldG1++;
                    }
                }
            }
            break;
        case 'command.applied':
            feed(s, m, p.blocked ? 'hold' : 'warn', `Perintah ${p.actor}: ${appliedText(p)}`);
            break;
        case 'maintenance.status':
            if (MAINTENANCE_LABEL[p.status]) {
                s.maintenance[p.asset] = { request_id: p.request_id, status: p.status, duration_min: p.duration_min, m };
                feed(s, m, p.status === 'completed' ? 'info' : 'warn', `${p.asset}: ${MAINTENANCE_LABEL[p.status]}`);
            }
            break;
        default:
    }
}

/** Posisi truk di jalur pendekatan: 0 = awal jendela, 1 = tiba di gerbang. */
export function approachProgress(inb, m) {
    return Math.max(0, Math.min(1, 1 - (inb.etaM - m) / inb.window));
}

/** Pemutar: maju secara inkremental, mundur dengan membangun ulang dari awal. */
export class Replay {
    constructor(model, { live = false } = {}) {
        this.model = model;
        this.live = live;
        this.reset();
    }

    reset() {
        this.state = emptyState();
        this.cursor = 0;
        this.minute = 0;
    }

    seek(minute) {
        const target = this.live ? Math.max(this.minute, minute) : Math.max(0, Math.min(minute, this.model.endMin));
        if (target < this.minute) this.reset();
        const { events } = this.model;
        while (this.cursor < events.length && events[this.cursor].m <= target) {
            apply(this.state, events[this.cursor++]);
        }
        this.minute = target;
        this.state.m = target; // waktu tampilan, bukan waktu event terakhir: posisi truk di Maps harus mengalir
        return this.state;
    }
}

/** Baris Gantt: interval status per aset dan per truk, dihitung sekali dari seluruh event. */
export function buildGantt(model) {
    const rows = new Map();
    const open = new Map(); // key -> {from, status}

    const row = (key, group) => {
        if (!rows.has(key)) rows.set(key, { key, group, segs: [] });
        return rows.get(key);
    };
    const close = (key, m) => {
        const o = open.get(key);
        if (o && m > o.from && o.status !== 'idle') row(key, o.group).segs.push({ from: o.from, to: m, status: o.status });
        open.delete(key);
    };
    const set = (key, group, status, m) => {
        row(key, group);
        close(key, m);
        open.set(key, { from: m, status, group });
    };

    for (const { m, p } of model.events) {
        if (p.type === 'asset.status_changed') {
            // Tangki dengan level 0 dianggap kosong walau statusnya filling.
            const status = p.level_ton !== null && p.level_ton !== undefined && p.level_ton <= 0 ? 'idle' : p.status;
            set(p.asset_code, 'aset', status, m);
        } else if (p.type === 'truck.arrived') {
            set(p.tanker_code, 'truk', 'queued', m);
        } else if (p.type === 'tanker.status_changed') {
            if (TERMINAL.has(p.status)) close(p.tanker_code, m);
            else set(p.tanker_code, 'truk', p.status, m);
        } else if (p.type === 'gate.decided' && p.gate === 'G1' && p.decision === 'hold') {
            close(p.object_id, m);
        }
    }
    for (const key of [...open.keys()]) close(key, model.endMin);

    const order = (r) => (r.group === 'aset' ? 0 : 1);
    return [...rows.values()].sort((a, b) => order(a) - order(b) || a.key.localeCompare(b.key, 'en', { numeric: true }));
}
