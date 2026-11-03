// Akses truk di sekitar model pabrik realistis (plant.glb): jalan, gerbang, lab, area tunggu, dan slot bay.
// Murni data (tanpa three.js). Satuan dunia = meter model x PLANT_SCALE; sumbu a = x, b = z.
import { padWidth, roadRect } from './layout.js';

export const PLANT_SCALE = 10;
const ROAD_W = 56;
const ROAD_X = -420;
const LANE_Z = -460;
const GATE_X = -500;
const QUEUE_X0 = -760;
const LOT_PITCH = 74;
const PAD_PITCH = 60;
const LAB_ROAD_Z = -300;
const PAD_ROAD_Z = -150;
const SIDE_ROAD_X0 = -700;
const ROAD_END_Z = -80;
const BAY_HALF = 19;
const GATE_RECT = [-12, 28, -76, 52];

const rect = (a0, a1, b0, b1) => ({ a0, a1, b0, b1 });

/** Slot bay mengikuti posisi truk di model: badan sejajar sumbu x, kabin ke barat, masuk mundur dari jalan barat. */
function baySlots(bays, codes) {
    const out = new Map();
    codes.forEach((code, i) => {
        const bay = bays[i];
        if (!bay) return;
        const a = bay.at[0] * PLANT_SCALE;
        const b = bay.at[2] * PLANT_SCALE;
        out.set(code, { a, b, facing: Math.atan2(-bay.dir[1], bay.dir[0]), via: [ROAD_X, b] });
    });
    return out;
}

/**
 * Denah gerak truk untuk model pabrik: bentuknya sama dengan denah biasa (roads, gates, pads, labs) supaya modul jalan,
 * gerbang, lab, dan pad dipakai ulang; `slots` menggantikan slot hasil hitungan hall.
 */
export function plantApproach(meta, bayCodes) {
    // R1 berakhir di sumbu R2 dan R2 mulai di tepi luar R1 supaya tikungan penuh; R3/R4 jalan servis lab dan pad cuci.
    const roads = [
        { id: 'R1', from: [QUEUE_X0, LANE_Z], to: [ROAD_X, LANE_Z], width: ROAD_W },
        { id: 'R2', from: [ROAD_X, LANE_Z - ROAD_W / 2], to: [ROAD_X, ROAD_END_Z], width: ROAD_W },
        { id: 'R3', from: [SIDE_ROAD_X0, LAB_ROAD_Z], to: [ROAD_X, LAB_ROAD_Z], width: ROAD_W },
        { id: 'R4', from: [SIDE_ROAD_X0, PAD_ROAD_Z], to: [ROAD_X, PAD_ROAD_Z], width: ROAD_W },
    ];
    const gates = [{ id: 'G1', at: [GATE_X, LANE_Z] }];
    const pads = [{ id: 'WP1', at: [-560, -80], slots: 3 }];
    const labs = [{ id: 'LAB1', at: [-570, -370], lot: { from: [-640, LAB_ROAD_Z], slots: 3 } }];

    const queue = [];
    for (let a = GATE_X - 62; a >= QUEUE_X0 + 30; a -= 74) queue.push({ a, b: LANE_Z, facing: 'a' });
    // Terjauh dari jalan dulu agar truk baru tidak melintasi slot yang terisi.
    const lab = Array.from({ length: labs[0].lot.slots }, (_, i) => ({ a: labs[0].lot.from[0] + i * LOT_PITCH, b: labs[0].lot.from[1], facing: 'a' }));
    const pad = Array.from({ length: pads[0].slots }, (_, i) => {
        const a = pads[0].at[0] - ((pads[0].slots - 1) * PAD_PITCH) / 2 + i * PAD_PITCH;
        return { a, b: pads[0].at[1], facing: 'b', via: [a, PAD_ROAD_Z] };
    });
    const bay = baySlots(meta.bays, bayCodes);
    const slots = { queue, lab, pad, bay, capacity: queue.length + lab.length + pad.length + bay.size };

    const plantRect = rect(meta.bounds.min[0] * PLANT_SCALE, meta.bounds.max[0] * PLANT_SCALE, meta.bounds.min[2] * PLANT_SCALE, meta.bounds.max[2] * PLANT_SCALE);
    const [ga0, ga1, gb0, gb1] = GATE_RECT;
    const near = [
        ...roads.map(roadRect),
        rect(GATE_X + ga0, GATE_X + ga1, LANE_Z + gb0, LANE_Z + gb1),
        rect(pads[0].at[0] - padWidth(pads[0].slots) / 2, pads[0].at[0] + padWidth(pads[0].slots) / 2, pads[0].at[1] - 40, pads[0].at[1] + 40),
        rect(labs[0].at[0] - 58, labs[0].at[0] + 58, labs[0].at[1] - 40, labs[0].at[1] + 40),
    ];
    const bayB = [...bay.values()].map((s) => s.b);
    // Aspal depan bay: dari tepi jalan barat sampai pelat pabrik, selebar tiga bay.
    const apron = bay.size ? rect(ROAD_X + ROAD_W / 2, plantRect.a0, Math.min(...bayB) - BAY_HALF, Math.max(...bayB) + BAY_HALF) : null;

    return {
        layout: { version: 1, roads, gates, silos: [], halls: [], pads, labs, units: [], decor: [], slots },
        entrance: { a: QUEUE_X0, b: LANE_Z },
        plantRect,
        apron,
        bayLines: apron ? [apron.b0, ...bayB.slice(1).map((b, i) => (b + bayB[i]) / 2), apron.b1] : [],
        zones: { all: [plantRect, ...near], intake: [...near, ...(apron ? [apron] : [])], process: [plantRect] },
    };
}

const two = (n) => String(n).padStart(2, '0');

/** Node model untuk kode aset engine, atau null bila tidak dimodelkan (tangki RAW -> ST, STO -> SFP, ASEP -> AT, LINE -> FL). */
export function plantNodeOf(code) {
    const [, kind, n] = /^(TK-RAW|TK-STO|ASEP|LINE)-(\d+)$/.exec(code) ?? [];
    const i = Number(n);
    if (!kind || i < 1) return null;
    if (kind === 'TK-RAW') return `ST-${two(i)}`;
    if (kind === 'TK-STO') return `SFP-${two(i)}`;
    if (kind === 'ASEP') return `AT-${two(i)}`;
    return `FL-${Math.ceil(i / 2)}${i % 2 ? 'A' : 'B'}`;
}
