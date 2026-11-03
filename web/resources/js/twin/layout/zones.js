// Zona Proses di scene 3D yang sama: pipa antar tahap, node "belum dimodelkan", dan jejak tiap zona untuk kamera.
// Murni data (tanpa three.js), dihitung dari layout.units sehingga tidak ikut disimpan di layout.
import { PLACEHOLDER_GAP, PLACEHOLDER_SIZE, SILO_RADIUS, UNIT_SIZE, buildingParts, hallGeom, layoutFootprints, moduleRects, unitKind } from './layout.js';

export { PLACEHOLDER_SIZE };
export const PIPE = { w: 3, h: 3, y: 12 };
export const ASEP_DX = 16; // aseptic tank di samping sterilizer (sama dengan makeUnit)
export const LINE_IN_DX = -8; // badan filling line bergeser dari pusat jejaknya
const FLOW = [['DEG', 'THM'], ['THM', 'SEP'], ['SEP', 'STE']];
const LANES = [-4, 0, 4];

/** Tahap yang belum ada di model simulasi (sim.py): hanya penanda, tanpa pipa dan tanpa status. */
export const PLACEHOLDERS = [
    { id: 'PREMIX', label: 'Premix', near: 'THM' },
    { id: 'CREAM', label: 'Cream', near: 'SEP' },
    { id: 'MIXING', label: 'Mixing', near: 'STE' },
];

const rectOf = (a0, a1, b0, b1) => ({ a0: Math.min(a0, a1), a1: Math.max(a0, a1), b0: Math.min(b0, b1), b1: Math.max(b0, b1) });

/** Tiga ruas pipa (turun, menyamping, turun) dari tepi satu modul ke tepi modul berikutnya. */
export function pipeRoute(from, to, lane = 0) {
    const [aFrom, bFrom, depthFrom] = from;
    const [aTo, bTo, depthTo] = to;
    const dir = Math.sign(bTo - bFrom) || 1;
    const start = bFrom + (dir * depthFrom) / 2;
    const end = bTo - (dir * depthTo) / 2;
    const mid = (start + end) / 2 + lane;
    const t = PIPE.w / 2;
    const segs = [rectOf(aFrom - t, aFrom + t, start, mid)];
    if (aFrom !== aTo) segs.push(rectOf(aFrom - t, aTo + t, mid - t, mid + t));
    segs.push(rectOf(aTo - t, aTo + t, mid, end));
    return segs;
}

const unitsOf = (units, kind) => units.filter((u) => unitKind(u.code) === kind);

/** Semua ruas pipa: DEG->THM->SEP->STE (tiap modul dapat satu sumber) dan tiap STE ke dua line di bawahnya. */
export function pipesFromUnits(units, linesPerSterilizer = 2) {
    const out = [];
    for (const [fromKind, toKind] of FLOW) {
        const src = unitsOf(units, fromKind);
        const dst = unitsOf(units, toKind);
        if (!src.length || !dst.length) continue;
        const n = Math.max(src.length, dst.length);
        for (let i = 0; i < n; i++) {
            const s = src[i % src.length];
            const d = dst[i % dst.length];
            const [, sd] = UNIT_SIZE[fromKind];
            const [, dd] = UNIT_SIZE[toKind];
            out.push(...pipeRoute([s.at[0], s.at[1], sd], [d.at[0], d.at[1], dd], LANES[i % LANES.length]));
        }
    }
    const ste = unitsOf(units, 'STE');
    for (const [j, line] of unitsOf(units, 'LINE').entries()) {
        const s = ste[Math.floor(j / linesPerSterilizer)];
        if (!s) continue;
        out.push(...pipeRoute([s.at[0] + ASEP_DX, s.at[1], UNIT_SIZE.STE[1]], [line.at[0] + LINE_IN_DX, line.at[1], UNIT_SIZE.LINE[1]], LANES[j % LANES.length]));
    }
    return out;
}

/** Node placeholder di barat zona, sejajar dengan baris modul terdekat; kosong bila belum ada modul. */
export function placeholdersFromUnits(units) {
    if (!units.length) return [];
    const [w, d] = PLACEHOLDER_SIZE;
    const west = Math.min(...units.map((u) => u.at[0] - UNIT_SIZE[unitKind(u.code)][0] / 2));
    const a = west - PLACEHOLDER_GAP - w / 2;
    return PLACEHOLDERS.flatMap((p) => {
        const row = unitsOf(units, p.near)[0];
        return row ? [{ ...p, at: [a, row.at[1]], rect: rectOf(a - w / 2, a + w / 2, row.at[1] - d / 2, row.at[1] + d / 2) }] : [];
    });
}

/** Pipa masuk di dalam bangunan: bay -> semua tangki (di belakang pintu), lalu tangki -> baris proses pertama. */
export function feedPipes(layout) {
    const [hall] = layout.halls;
    if (!hall) return [];
    const g = hallGeom(hall);
    const t = PIPE.w / 2;
    const silos = layout.silos;
    const out = [];
    const header = g.zf - 16;
    const valveDx = -10; // katup tiap tangki ada di sisi selatan, bergeser dari pusat
    const lastDoor = g.doors.at(-1).a;
    const reach = silos.length ? Math.max(lastDoor, ...silos.map((s) => s.at[0] + valveDx)) : lastDoor;
    out.push(rectOf(g.doors[0].a - t, reach + t, header - t, header + t));
    for (const s of silos) out.push(rectOf(s.at[0] + valveDx - t, s.at[0] + valveDx + t, s.at[1] + SILO_RADIUS + 3, header));

    const deg = unitsOf(layout.units ?? [], 'DEG')[0];
    if (silos.length && deg) {
        const north = g.cz - SILO_RADIUS - 11;
        const lo = Math.min(deg.at[0], ...silos.map((s) => s.at[0]));
        const hi = Math.max(deg.at[0], ...silos.map((s) => s.at[0]));
        out.push(rectOf(lo - t, hi + t, north - t, north + t));
        for (const s of silos) out.push(rectOf(s.at[0] - t, s.at[0] + t, north, s.at[1] - SILO_RADIUS));
        out.push(rectOf(deg.at[0] - t, deg.at[0] + t, deg.at[1] + UNIT_SIZE.DEG[1] / 2, north));
    }
    return out;
}

/** Jejak per zona untuk kamera: Proses = seluruh bangunan; Penerimaan = semua di luar modul dalam bangunan (gerbang, lab, area tunggu, apron). */
export function zoneRects(layout) {
    const units = layout.units ?? [];
    const key = (r) => `${r.a0}|${r.a1}|${r.b0}|${r.b1}`;
    const inProcess = new Set(moduleRects(layout).filter((r) => r.kind === 'unit' || r.kind === 'silo').map(key));
    const base = layoutFootprints(layout);
    const holders = placeholdersFromUnits(units).map((p) => p.rect);
    const parts = buildingParts(layout);
    return {
        all: [...base, ...holders, ...parts],
        process: parts,
        intake: base.filter((r) => !inProcess.has(key(r))),
    };
}
