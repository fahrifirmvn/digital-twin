// Penempatan truk dan aliran: fungsi murni state -> posisi dunia. Tanpa three.js agar dapat diuji di Node.
// Posisi hanya tujuan; gerak halus di antara dua keadaan ditangani lapisan mover (F2).
import { hallGeom, roadRect } from '../layout/layout.js';

export const QUEUE_PITCH = 74;
const GATE_CLEAR = 62;
const REAR_MARGIN = 30;
const LOT_PITCH = 74;
const PAD_PITCH = 60;
const BAY_APRON_OFFSET = 32;
const BAY_LANE = 75;
const PAD_LANE = 44;
const ENTRANCE = 'ENTRANCE';

const slotCache = new WeakMap();

/** Slot parkir tiap tahap perjalanan truk: antre di jalan, lab, area tunggu, depan bay. */
export function truckSlots(layout) {
    if (layout.slots) return layout.slots;
    const cached = slotCache.get(layout);
    if (cached) return cached;

    const gate = layout.gates[0];
    const lane = layout.roads.map(roadRect).find((R) => R.axis === 'a' && Math.abs(gate.at[1] - (R.b0 + R.b1) / 2) < 1e-6 && gate.at[0] > R.a0 && gate.at[0] < R.a1);
    const laneB = (lane.b0 + lane.b1) / 2;
    const queue = [];
    for (let a = gate.at[0] - GATE_CLEAR; a >= lane.a0 + REAR_MARGIN; a -= QUEUE_PITCH) queue.push({ a, b: laneB, facing: 'a' });

    // Terjauh dulu agar truk baru tidak melintasi slot yang terisi (lot lab dimasuki sepanjang barisnya).
    const lab = [];
    for (const l of layout.labs) {
        for (let i = l.lot.slots - 1; i >= 0; i--) lab.push({ a: l.lot.from[0] + i * LOT_PITCH, b: l.lot.from[1], facing: 'a' });
    }

    const pad = [];
    for (const p of layout.pads) {
        for (let i = 0; i < p.slots; i++) {
            const a = p.at[0] - ((p.slots - 1) * PAD_PITCH) / 2 + i * PAD_PITCH;
            pad.push({ a, b: p.at[1], facing: 'b', via: [a, p.at[1] - PAD_LANE] });
        }
    }

    const bay = new Map();
    for (const h of layout.halls) {
        const g = hallGeom(h);
        for (const d of g.doors) bay.set(d.code, { a: d.a, b: g.zf + BAY_APRON_OFFSET, facing: 'b', via: [d.a, g.zf + BAY_LANE] });
    }

    const slots = { queue, lab, pad, bay, capacity: queue.length + lab.length + pad.length + bay.size };
    slotCache.set(layout, slots);
    return slots;
}

const byArrival = (x, y) => (x.arrivedAt ?? 0) - (y.arrivedAt ?? 0);

/** Truk yang terlihat: antre di jalan, uji di lab, tunggu di pad, bongkar di depan bay-nya. */
export function placeTrucks(state, layout) {
    const slots = truckSlots(layout);
    const groups = { queue: [], lab: [], pad: [] };
    const trucks = [];
    for (const t of Object.values(state.tankers)) {
        if (t.status === 'unloading' && t.bay && slots.bay.has(t.bay)) {
            trucks.push({ code: t.code, status: t.status, ...slots.bay.get(t.bay) });
        } else if (t.held) {
            continue;
        } else if (t.status === 'queued') {
            groups.queue.push(t);
        } else if (t.status === 'sampling' || t.status === 'lab_test') {
            groups.lab.push(t);
        } else if (t.status === 'released') {
            groups.pad.push(t);
        }
    }
    let overflow = 0;
    for (const key of Object.keys(groups)) {
        const sorted = groups[key].sort(byArrival);
        sorted.slice(0, slots[key].length).forEach((t, i) => trucks.push({ code: t.code, status: t.status, ...slots[key][i] }));
        overflow += Math.max(0, sorted.length - slots[key].length);
    }
    return { trucks, overflow };
}

/** Aliran yang masih terlihat dengan kode aset asal dan tujuan; holdSec = detik nyata aliran tampil pada kecepatan `speed`. */
export function activeFlowLinks(state, speed, holdSec = 0.9) {
    const ttl = Math.max(12, (speed || 60) * holdSec);
    const out = [];
    for (const f of state.flows) {
        const age = state.m - f.m;
        if (age > ttl || age < 0) continue;
        const from = f.from.startsWith('RT-') ? ENTRANCE : f.from;
        if (from === f.to) continue;
        out.push({ from, to: f.to, progress: age / ttl, alpha: 1 - age / ttl, held: f.to === 'QA-HOLD' });
    }
    return out;
}

export const ENTRANCE_CODE = ENTRANCE;
