// Rute truk di jaringan jalan denah: graf garis tengah jalan + penghubung ke slot. Murni, tanpa three.js.
import { roadRect } from '../layout/layout.js';

export const LANE_OFFSET = 16;
const EPS = 0.5;

const key = (p) => `${Math.round(p[0] * 10)},${Math.round(p[1] * 10)}`;
const same = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < EPS;
export const facingAngle = (f) => (typeof f === 'number' ? f : f === 'b' ? -Math.PI / 2 : 0);
export const headingOf = (dx, dz) => -Math.atan2(dz, dx);

export function roadLines(layout) {
    return layout.roads.map((r, i) => {
        const R = roadRect(r);
        return R.axis === 'a'
            ? { i, axis: 'a', c: (R.b0 + R.b1) / 2, lo: R.a0, hi: R.a1 }
            : { i, axis: 'b', c: (R.a0 + R.a1) / 2, lo: R.b0, hi: R.b1 };
    });
}

const pointAt = (L, s) => (L.axis === 'a' ? [s, L.c] : [L.c, s]);

/** Jalan terdekat dari p; jalan yang bisa dicapai lurus tegak lurus didahulukan dari yang perlu diklem ke ujungnya. */
function nearestRoad(lines, p) {
    let best = null;
    for (const L of lines) {
        const along = L.axis === 'a' ? p[0] : p[1];
        const across = L.axis === 'a' ? p[1] : p[0];
        const s = Math.min(L.hi, Math.max(L.lo, along));
        const clamped = s !== along;
        const d = Math.hypot(along - s, across - L.c);
        if (!best || clamped < best.clamped || (clamped === best.clamped && d < best.d - 1e-9)) best = { L, s, d, clamped, pt: pointAt(L, s) };
    }
    return best;
}

/** Lintasan terpendek di graf jalan dari titik a ke b (keduanya sudah di garis tengah). */
function roadNodes(lines, a, b) {
    const per = lines.map((L) => new Set([L.lo, L.hi]));
    for (const A of lines.filter((L) => L.axis === 'a')) {
        for (const B of lines.filter((L) => L.axis === 'b')) {
            if (B.c >= A.lo && B.c <= A.hi && A.c >= B.lo && A.c <= B.hi) {
                per[A.i].add(B.c);
                per[B.i].add(A.c);
            }
        }
    }
    for (const p of [a, b]) {
        for (const L of lines) {
            const along = L.axis === 'a' ? p[0] : p[1];
            const across = L.axis === 'a' ? p[1] : p[0];
            if (Math.abs(across - L.c) < EPS && along >= L.lo - EPS && along <= L.hi + EPS) per[L.i].add(along);
        }
    }
    const points = new Map();
    const edges = new Map();
    const link = (p, q) => {
        const w = Math.hypot(p[0] - q[0], p[1] - q[1]);
        for (const [x, y] of [[p, q], [q, p]]) {
            points.set(key(x), x);
            if (!edges.has(key(x))) edges.set(key(x), []);
            edges.get(key(x)).push({ to: key(y), w, p: y });
        }
    };
    lines.forEach((L) => {
        const s = [...per[L.i]].sort((x, y) => x - y);
        for (let k = 1; k < s.length; k++) link(pointAt(L, s[k - 1]), pointAt(L, s[k]));
    });

    const start = key(a);
    const goal = key(b);
    const dist = new Map([[start, 0]]);
    const prev = new Map();
    const todo = new Set([start]);
    while (todo.size) {
        let u = null;
        for (const k of todo) if (u === null || dist.get(k) < dist.get(u)) u = k;
        todo.delete(u);
        if (u === goal) break;
        for (const e of edges.get(u) ?? []) {
            const nd = dist.get(u) + e.w;
            if (nd < (dist.get(e.to) ?? Infinity)) {
                dist.set(e.to, nd);
                prev.set(e.to, u);
                todo.add(e.to);
            }
        }
    }
    if (!dist.has(goal)) return null;
    const out = [];
    for (let k = goal; k !== undefined; k = prev.get(k)) out.unshift(points.get(k));
    return out;
}

const onLine = (L, p) => (L.axis === 'a' ? Math.abs(p[1] - L.c) < EPS && p[0] >= L.lo - EPS && p[0] <= L.hi + EPS : Math.abs(p[0] - L.c) < EPS && p[1] >= L.lo - EPS && p[1] <= L.hi + EPS);

function offsetToLane(lines, p) {
    const q = [...p];
    for (const L of lines) {
        if (!onLine(L, p)) continue;
        if (L.axis === 'a') q[1] += LANE_OFFSET;
        else q[0] += LANE_OFFSET;
    }
    return q;
}

/**
 * Titik jalan dari `from` ke `to` ({a, b, via?, facing?}); via = titik jalur masuk sebelum slot.
 * Segmen terakhir menuju slot membawa `h` (arah badan = facing slot) karena truk parkir mundur/menyamping.
 * `lane` menggeser titik di jalan ke lajur kanan (untuk truk yang keluar).
 */
export function drivePath(layout, from, to, { lane = false } = {}) {
    const lines = roadLines(layout);
    const start = from.via ?? [from.a, from.b];
    const end = to.via ?? [to.a, to.b];
    const sf = nearestRoad(lines, start);
    const st = nearestRoad(lines, end);
    const nodes = roadNodes(lines, sf.pt, st.pt) ?? [sf.pt, st.pt];

    const pts = [{ p: [from.a, from.b] }];
    if (from.via) pts.push({ p: from.via });
    nodes.forEach((p) => pts.push({ p: lane ? offsetToLane(lines, p) : p }));
    const h = to.facing ? facingAngle(to.facing) : undefined;
    if (to.via) pts.push({ p: to.via });
    const dest = lane ? offsetToLane(lines, [to.a, to.b]) : [to.a, to.b];
    pts.push({ p: dest, h: to.via || !same(st.pt, [to.a, to.b]) ? h : undefined });

    const out = [];
    for (const q of pts) {
        const last = out.at(-1);
        if (last && same(last.p, q.p)) {
            if (q.h !== undefined) last.h = q.h;
            continue;
        }
        out.push(q);
    }
    return out.slice(1).map(({ p, h: heading }) => ({ a: p[0], b: p[1], ...(heading === undefined ? {} : { h: heading }) }));
}
