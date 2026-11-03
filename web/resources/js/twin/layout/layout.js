// Denah dunia 3D sebagai data murni (tanpa three.js agar dapat diuji di Node).
// Sumbu: a = x dunia, b = z dunia. Jalan hanya sejajar sumbu (grid), satuan sama dengan scene V6.

export const LIMITS = { bays: [1, 8], silos: [0, 21], lotSlots: [0, 6], padSlots: [1, 6], units: { DEG: [0, 8], THM: [0, 8], SEP: [0, 8], STE: [0, 8], LINE: [0, 16] } };
/** Jejak [lebar, dalam] modul proses hilir (kodenya `KIND-n`, sama dengan kode aset engine). */
export const UNIT_SIZE = { DEG: [44, 44], THM: [44, 44], SEP: [44, 44], STE: [56, 44], LINE: [34, 34] };
export const unitKind = (code) => /^(DEG|THM|SEP|STE|LINE)-\d+$/.test(code) ? code.split('-')[0] : null;
export const BAY_PITCH = 66;
export const SILO_PITCH = 50;
export const SILO_RADIUS = 23;
export const PLACEHOLDER_SIZE = [46, 30];
export const PLACEHOLDER_GAP = 36;
/** Bangunan produksi tunggal: tinggi dinding, tebal dinding, jarak isi ke dinding, dan celah utara blok proses. */
export const BUILDING = { height: 118, wall: 3, margin: 14, north: 28 };
const CURB = 6;
const OVERLAP_TOLERANCE = 4;

export const hallWidth = (bays) => BAY_PITCH * bays + 42;
export const padWidth = (slots) => (slots - 1) * 60 + 64;

/** Ukuran hall: pintu bay di left+54, jarak 66; apron di depan pintu. */
export function hallGeom(hall) {
    const n = hall.bays.length;
    const W = hallWidth(n);
    const [cx, cz] = hall.at;
    const left = cx - W / 2;
    const right = cx + W / 2;
    const zf = cz + 54;
    return {
        n, W, cx, cz, left, right, zf,
        doors: hall.bays.map((code, i) => ({ code, a: left + 54 + BAY_PITCH * i })),
        apron: { a0: left - 77, a1: right + 18, b0: zf, b1: zf + 102 },
    };
}

export const roadAxis = (r) => {
    if (r.from[1] === r.to[1]) return 'a';
    if (r.from[0] === r.to[0]) return 'b';
    return null;
};

/** Persegi aspal; ujung sepanjang sumbu persis from..to, lebar menyamping width. */
export function roadRect(r) {
    const axis = roadAxis(r);
    const h = r.width / 2;
    if (axis === 'a') {
        return { axis, a0: Math.min(r.from[0], r.to[0]), a1: Math.max(r.from[0], r.to[0]), b0: r.from[1] - h, b1: r.from[1] + h };
    }
    return { axis, a0: r.from[0] - h, a1: r.from[0] + h, b0: Math.min(r.from[1], r.to[1]), b1: Math.max(r.from[1], r.to[1]) };
}

const strictOverlap = (lo1, hi1, lo2, hi2) => lo1 < hi2 && hi1 > lo2;

/** Kurangi satu interval [lo, hi] dengan daftar potongan; hasilnya interval tersisa. */
export function subtractIntervals([lo, hi], cuts) {
    let parts = [[lo, hi]];
    for (const [c0, c1] of cuts) {
        parts = parts.flatMap(([p0, p1]) => {
            if (c1 <= p0 || c0 >= p1) return [[p0, p1]];
            const out = [];
            if (c0 > p0) out.push([p0, c0]);
            if (c1 < p1) out.push([c1, p1]);
            return out;
        });
    }
    return parts.filter(([p0, p1]) => p1 - p0 > 0.5);
}

const sideSign = (axis, side) => {
    const table = axis === 'b' ? { east: 1, west: -1 } : { south: 1, north: -1 };
    return table[side] ?? 0;
};

/** Trotoar di kedua sisi tiap jalan, dipotong di persimpangan dan bukaan (mis. pintu masuk apron). */
export function curbRects(roads) {
    const rects = roads.map(roadRect);
    const out = [];
    roads.forEach((r, i) => {
        const R = rects[i];
        const center = R.axis === 'a' ? (R.b0 + R.b1) / 2 : (R.a0 + R.a1) / 2;
        const [alongLo, alongHi] = R.axis === 'a' ? [R.a0, R.a1] : [R.b0, R.b1];
        for (const s of [-1, 1]) {
            const c0 = center + s * (r.width / 2);
            const c1 = center + s * (r.width / 2 + CURB);
            const lo = Math.min(c0, c1);
            const hi = Math.max(c0, c1);
            const cuts = [];
            rects.forEach((O, j) => {
                if (j === i) return;
                const [oc0, oc1] = R.axis === 'a' ? [O.b0, O.b1] : [O.a0, O.a1];
                if (!strictOverlap(lo, hi, oc0, oc1)) return;
                const [oa0, oa1] = R.axis === 'a' ? [O.a0, O.a1] : [O.b0, O.b1];
                cuts.push([oa0 - CURB, oa1 + CURB]);
            });
            for (const op of r.openings ?? []) if (sideSign(R.axis, op.side) === s) cuts.push([op.from, op.to]);
            for (const [x0, x1] of subtractIntervals([alongLo, alongHi], cuts)) {
                out.push(R.axis === 'a' ? { a0: x0, a1: x1, b0: lo, b1: hi } : { a0: lo, a1: hi, b0: x0, b1: x1 });
            }
        }
    });
    return out;
}

/** Titik tengah garis putus-putus marka jalan (panjang 12, jeda 12), tidak melewati persimpangan. */
export function dashSegments(roads) {
    const rects = roads.map(roadRect);
    const out = [];
    roads.forEach((_, i) => {
        const R = rects[i];
        const center = R.axis === 'a' ? (R.b0 + R.b1) / 2 : (R.a0 + R.a1) / 2;
        const [lo, hi] = R.axis === 'a' ? [R.a0, R.a1] : [R.b0, R.b1];
        const cuts = [];
        rects.forEach((O, j) => {
            if (j === i) return;
            const [oc0, oc1] = R.axis === 'a' ? [O.b0, O.b1] : [O.a0, O.a1];
            if (center > oc0 && center < oc1) cuts.push(R.axis === 'a' ? [O.a0, O.a1] : [O.b0, O.b1]);
        });
        for (const [f0, f1] of subtractIntervals([lo, hi], cuts)) {
            for (let s = f0 + 12; s + 12 <= f1; s += 24) {
                out.push(R.axis === 'a' ? { a: s + 6, b: center, axis: 'a' } : { a: center, b: s + 6, axis: 'b' });
            }
        }
    });
    return out;
}

const unitRect = (u) => {
    const [w, d] = UNIT_SIZE[unitKind(u.code)] ?? [44, 44];
    return { a0: u.at[0] - w / 2, a1: u.at[0] + w / 2, b0: u.at[1] - d / 2, b1: u.at[1] + d / 2 };
};

/**
 * Persegi bangunan produksi tunggal, dihitung dari isinya: sayap (bay + tangki) dan blok proses di utaranya
 * (modul hilir + node placeholder). Kedua persegi bersinggungan di b sayap-utara; kosong bila tanpa hall.
 */
export function buildingParts(layout) {
    const [hall] = layout.halls;
    if (!hall) return [];
    const g = hallGeom(hall);
    const east = Math.max(g.right + 2, ...layout.silos.map((s) => s.at[0] + SILO_RADIUS + BUILDING.margin));
    const wing = { id: 'wing', a0: g.left - 2, a1: east, b0: g.cz - 56, b1: g.zf };
    const rects = (layout.units ?? []).map(unitRect);
    if (!rects.length) return [wing];
    const block = {
        id: 'block',
        a0: Math.min(...rects.map((r) => r.a0)) - PLACEHOLDER_GAP - PLACEHOLDER_SIZE[0] - BUILDING.margin,
        a1: Math.max(...rects.map((r) => r.a1)) + BUILDING.margin,
        b0: Math.min(...rects.map((r) => r.b0)) - BUILDING.north,
        b1: wing.b0,
    };
    return [wing, block];
}

/** Dinding luar gabungan persegi: tiap sisi dipotong di bagian yang menempel persegi lain (tidak ada dinding di dalam). */
export function buildingWalls(parts, t = BUILDING.wall) {
    const out = [];
    parts.forEach((p, i) => {
        const others = parts.filter((_, j) => j !== i);
        for (const [b, dir] of [[p.b0, -1], [p.b1, 1]]) {
            const cuts = others.filter((q) => (dir < 0 ? q.b1 : q.b0) === b).map((q) => [q.a0, q.a1]);
            for (const [a0, a1] of subtractIntervals([p.a0, p.a1], cuts)) out.push({ a0, a1, b0: dir < 0 ? b : b - t, b1: dir < 0 ? b + t : b });
        }
        for (const [a, dir] of [[p.a0, -1], [p.a1, 1]]) {
            const cuts = others.filter((q) => (dir < 0 ? q.a1 : q.a0) === a).map((q) => [q.b0, q.b1]);
            for (const [b0, b1] of subtractIntervals([p.b0, p.b1], cuts)) out.push({ a0: dir < 0 ? a : a - t, a1: dir < 0 ? a + t : a, b0, b1 });
        }
    });
    return out;
}

/** Jejak tiap modul (untuk deteksi tumpang tindih dan batas dunia). */
export function moduleRects(layout) {
    const rects = [];
    for (const s of layout.silos) {
        rects.push({ id: s.code, group: s.code, kind: 'silo', a0: s.at[0] - 27, a1: s.at[0] + 27, b0: s.at[1] - 27, b1: s.at[1] + 27 });
    }
    for (const h of layout.halls) {
        const g = hallGeom(h);
        rects.push({ id: h.id, group: h.id, kind: 'hall', a0: g.left - 2, a1: g.right + 2, b0: g.cz - 56, b1: g.cz + 56 });
        rects.push({ id: `${h.id}/apron`, group: h.id, kind: 'apron', ...g.apron });
    }
    for (const p of layout.pads) {
        const w = padWidth(p.slots) / 2;
        rects.push({ id: p.id, group: p.id, kind: 'pad', a0: p.at[0] - w, a1: p.at[0] + w, b0: p.at[1] - 40, b1: p.at[1] + 40 });
    }
    for (const l of layout.labs) {
        rects.push({ id: l.id, group: l.id, kind: 'lab', a0: l.at[0] - 58, a1: l.at[0] + 58, b0: l.at[1] - 40, b1: l.at[1] + 40 });
    }
    for (const u of layout.units ?? []) rects.push({ id: u.code, group: u.code, kind: 'unit', ...unitRect(u) });
    return rects;
}

/** Jejak seluruh isi dunia (jalan, modul, gerbang, dekor). */
export function layoutFootprints(layout) {
    return [
        ...layout.roads.map(roadRect),
        ...moduleRects(layout),
        ...layout.gates.map((g) => ({ a0: g.at[0] - 12, a1: g.at[0] + 28, b0: g.at[1] - 76, b1: g.at[1] + 52 })),
        ...(layout.decor ?? []).map((d) => ({ a0: d.at[0] - 10, a1: d.at[0] + 10, b0: d.at[1] - 10, b1: d.at[1] + 10 })),
    ];
}

/** Kotak pembatas seluruh dunia untuk bayangan dan titik bidik kamera. */
export function layoutBounds(layout) {
    const all = [...layoutFootprints(layout), ...buildingParts(layout)];
    return {
        a0: Math.min(...all.map((r) => r.a0)),
        a1: Math.max(...all.map((r) => r.a1)),
        b0: Math.min(...all.map((r) => r.b0)),
        b1: Math.max(...all.map((r) => r.b1)),
    };
}

const CODE_PATTERNS = { silo: /^TK-(RAW|STO)-\d+$/, bay: /^BAY-\d+$/ };
const finite = (p) => Array.isArray(p) && p.length === 2 && p.every((n) => Number.isFinite(n) && Math.abs(n) <= 5000);

/** Daftar pesan kesalahan; kosong bila denah valid. Batas yang sama diterapkan lagi di engine. */
export function validateLayout(layout) {
    const errors = [];
    if (!layout || layout.version !== 1) return ['Versi denah harus 1.'];
    for (const key of ['roads', 'gates', 'silos', 'halls', 'pads', 'labs']) {
        if (!Array.isArray(layout[key])) errors.push(`Daftar ${key} wajib ada.`);
    }
    if (errors.length) return errors;

    const codes = new Set();
    const addCode = (code) => {
        if (codes.has(code)) errors.push(`Kode ganda: ${code}.`);
        codes.add(code);
    };

    for (const r of layout.roads) {
        if (!finite(r.from) || !finite(r.to) || !roadAxis(r)) errors.push(`Jalan ${r.id}: harus lurus sejajar sumbu.`);
        else if (!(r.width >= 20 && r.width <= 120)) errors.push(`Jalan ${r.id}: lebar 20-120.`);
    }
    for (const s of layout.silos) {
        if (!CODE_PATTERNS.silo.test(s.code)) errors.push(`Kode tangki tidak dikenal: ${s.code}.`);
        if (!finite(s.at)) errors.push(`Posisi ${s.code} tidak valid.`);
        addCode(s.code);
    }
    if (layout.silos.length < LIMITS.silos[0] || layout.silos.length > LIMITS.silos[1]) errors.push(`Jumlah tangki harus ${LIMITS.silos[0]}-${LIMITS.silos[1]}.`);

    let bays = 0;
    for (const h of layout.halls) {
        if (!finite(h.at)) errors.push(`Posisi ${h.id} tidak valid.`);
        for (const code of h.bays) {
            if (!CODE_PATTERNS.bay.test(code)) errors.push(`Kode bay tidak dikenal: ${code}.`);
            addCode(code);
            bays++;
        }
    }
    if (bays < LIMITS.bays[0] || bays > LIMITS.bays[1]) errors.push(`Jumlah bay harus ${LIMITS.bays[0]}-${LIMITS.bays[1]}.`);

    if (layout.units !== undefined && !Array.isArray(layout.units)) errors.push('Daftar units harus berupa larik.');
    const perKind = {};
    for (const u of Array.isArray(layout.units) ? layout.units : []) {
        const kind = unitKind(u.code);
        if (!kind) errors.push(`Kode unit tidak dikenal: ${u.code}.`);
        else perKind[kind] = (perKind[kind] ?? 0) + 1;
        if (!finite(u.at)) errors.push(`Posisi ${u.code} tidak valid.`);
        addCode(u.code);
    }
    for (const [kind, [lo, hi]] of Object.entries(LIMITS.units)) {
        const n = perKind[kind] ?? 0;
        if (n < lo || n > hi) errors.push(`Jumlah ${kind} harus ${lo}-${hi}.`);
    }

    for (const p of layout.pads) {
        if (!finite(p.at) || !(p.slots >= LIMITS.padSlots[0] && p.slots <= LIMITS.padSlots[1])) errors.push(`Area tunggu ${p.id} tidak valid.`);
    }
    for (const l of layout.labs) {
        const lot = l.lot;
        if (!finite(l.at) || !lot || !finite(lot.from) || !(lot.slots >= LIMITS.lotSlots[0] && lot.slots <= LIMITS.lotSlots[1])) errors.push(`Lab ${l.id} tidak valid.`);
    }
    if (layout.gates.length < 1) errors.push('Minimal satu gerbang.');
    const rects = layout.roads.map(roadRect);
    for (const g of layout.gates) {
        const onRoad = rects.some((R) => R.axis === 'a' && Math.abs(g.at[1] - (R.b0 + R.b1) / 2) < 1e-6 && g.at[0] > R.a0 && g.at[0] < R.a1);
        if (!onRoad) errors.push(`Gerbang ${g.id} harus berada di jalan sejajar sumbu a.`);
    }

    const mods = moduleRects(layout);
    const t = OVERLAP_TOLERANCE;
    const hit = (x, y) => strictOverlap(x.a0 + t, x.a1 - t, y.a0, y.a1) && strictOverlap(x.b0 + t, x.b1 - t, y.b0, y.b1);
    for (let i = 0; i < mods.length; i++) {
        for (let j = i + 1; j < mods.length; j++) {
            if (mods[i].group !== mods[j].group && hit(mods[i], mods[j])) errors.push(`${mods[i].id} bertumpukan dengan ${mods[j].id}.`);
        }
        for (const R of rects) if (hit(mods[i], R)) errors.push(`${mods[i].id} bertumpukan dengan jalan.`);
    }
    for (const P of buildingParts(layout)) {
        if (rects.some((R) => strictOverlap(P.a0, P.a1, R.a0, R.a1) && strictOverlap(P.b0, P.b1, R.b0, R.b1))) errors.push('Bangunan produksi bertumpukan dengan jalan.');
        for (const m of mods) {
            if (['pad', 'lab', 'apron'].includes(m.kind) && strictOverlap(P.a0, P.a1, m.a0, m.a1) && strictOverlap(P.b0, P.b1, m.b0, m.b1)) errors.push(`Bangunan produksi bertumpukan dengan ${m.id}.`);
        }
    }
    return errors;
}
