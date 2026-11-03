// Jaringan pipa susu pabrik realistis dan rute aliran antar aset. Murni data (tanpa three.js); koordinat = meter glTF (plant.json `pipes`).
import { plantNodeOf } from './approach.js';

const ON_PIPE = 0.05; // ujung pipa yang menempel di badan pipa lain (cabang pada header)
const END_GAP = 0.7; // celah antar dua ujung pipa (pompa/sambungan kecil) yang dijembatani
const TAP_ON_PIPE = 0.3;
const SAME = 1e-3;

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function closestOnSegment(p, a, b) {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / len2)) : 0;
    return { t, point: [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t] };
}

/**
 * Graf pipa: tiap titik pipa jadi simpul, ujung pipa disambung ke titik terdekat pipa lain (T-junction memecah segmen).
 * `taps` = titik tambahan {kunci: [x,y,z]} yang ditempelkan ke pipa terdekat (mis. sambungan selang truk).
 */
export function buildPipeGraph(pipes, taps = {}) {
    const nodes = [];
    const lines = new Map();
    const byId = new Map();
    for (const p of pipes) {
        byId.set(p.id, p);
        lines.set(p.id, p.pts.map((pt) => nodes.push(pt) - 1));
    }
    const bridges = [];

    // Cari titik sambung pada pipa lain: tepat di pipa (<= onTol, segmen dipecah di titik itu), atau ke ujung pipa lain yang dekat (<= endTol, dijembatani).
    const attach = (point, skip, onTol = ON_PIPE, endTol = END_GAP) => {
        let best = null;
        let gap = null;
        for (const [id, line] of lines) {
            if (id === skip) continue;
            for (let k = 0; k < line.length - 1; k++) {
                const c = closestOnSegment(point, nodes[line[k]], nodes[line[k + 1]]);
                const d = dist(point, c.point);
                if (!best || d < best.d) best = { d, id, k, ...c };
            }
            for (const n of [line[0], line[line.length - 1]]) {
                const d = dist(point, nodes[n]);
                if (!gap || d < gap.d) gap = { d, n };
            }
        }
        if (best && best.d <= onTol) {
            const line = lines.get(best.id);
            for (const n of [line[best.k], line[best.k + 1]]) if (dist(nodes[n], best.point) < SAME) return n;
            const node = nodes.push(best.point) - 1;
            line.splice(best.k + 1, 0, node);
            return node;
        }
        return gap && gap.d <= endTol ? gap.n : -1;
    };
    const join = (a, b) => {
        if (a >= 0 && a !== b) bridges.push([a, b, dist(nodes[a], nodes[b])]);
    };

    for (const [id, line] of [...lines]) {
        for (const end of [line[0], line[line.length - 1]]) join(attach(nodes[end], id), end);
    }
    const tapNode = new Map();
    for (const [key, point] of Object.entries(taps)) {
        const n = attach(point, null, TAP_ON_PIPE, 0);
        if (n >= 0) tapNode.set(key, n);
    }

    const adj = nodes.map(() => []);
    const link = (a, b, w, pipe) => {
        adj[a].push({ to: b, w, pipe });
        adj[b].push({ to: a, w, pipe });
    };
    for (const [id, line] of lines) for (let k = 0; k < line.length - 1; k++) link(line[k], line[k + 1], dist(nodes[line[k]], nodes[line[k + 1]]), id);
    for (const [a, b, w] of bridges) link(a, b, w, null);

    return { nodes, adj, lines, pipes: byId, tapNode };
}

/** Rute terpendek antar simpul: titik jalur, id pipa yang dilewati (berurutan, tanpa duplikat), dan pipa tiap segmen (null = jembatan); null bila tidak tersambung. */
export function shortestRoute(graph, from, to) {
    const { nodes, adj } = graph;
    const d = new Array(nodes.length).fill(Infinity);
    const prev = new Array(nodes.length).fill(-1);
    const via = new Array(nodes.length).fill(null);
    const done = new Array(nodes.length).fill(false);
    d[from] = 0;
    for (;;) {
        let u = -1;
        for (let i = 0; i < d.length; i++) if (!done[i] && d[i] < Infinity && (u < 0 || d[i] < d[u])) u = i;
        if (u < 0 || u === to) break;
        done[u] = true;
        for (const e of adj[u]) {
            if (d[u] + e.w < d[e.to]) {
                d[e.to] = d[u] + e.w;
                prev[e.to] = u;
                via[e.to] = e.pipe;
            }
        }
    }
    if (d[to] === Infinity) return null;
    const path = [to];
    const ids = [];
    const segs = [];
    for (let n = to; prev[n] >= 0; n = prev[n]) {
        path.push(prev[n]);
        segs.push(via[n]);
        if (via[n] && ids[ids.length - 1] !== via[n]) ids.push(via[n]);
    }
    path.reverse();
    segs.reverse();
    ids.reverse();
    return { pts: path.map((n) => nodes[n]), ids, segs, length: d[to] };
}

const pipeNamed = (graph, name) => [...graph.pipes.values()].find((p) => p.name === name);
const firstNode = (graph, name) => {
    const p = pipeNamed(graph, name);
    return p ? graph.lines.get(p.id)[0] : -1;
};
const lastNode = (graph, name) => {
    const p = pipeNamed(graph, name);
    if (!p) return -1;
    const line = graph.lines.get(p.id);
    return line[line.length - 1];
};
/** Ujung bebas pipa cabang (ujung yang tidak menyambung ke pipa lain, yaitu sisi tangki/mesin). */
const freeEnd = (graph, name) => {
    const a = firstNode(graph, name);
    const b = lastNode(graph, name);
    if (a < 0) return -1;
    return graph.adj[a].length <= graph.adj[b].length ? a : b;
};

const kindOf = (code) => code.replace(/-\d+$/, '');
const ST = (c) => plantNodeOf(c);

/**
 * Simpul awal dan akhir pipa untuk satu aliran engine (asal -> tujuan); null bila aliran itu tidak lewat pipa
 * (RT -> BAY, LINE -> PACK-OUT, ke QA-HOLD) atau modelnya tidak ada.
 */
export function flowEnds(graph, from, to) {
    const f = kindOf(from);
    const t = kindOf(to);
    const ends = {
        'BAY>DEG': () => [graph.tapNode.get(from) ?? -1, lastNode(graph, 'Unloading Manifold')],
        'DEG>TK-RAW': () => [firstNode(graph, 'Unloading to Storage Header'), freeEnd(graph, `STORAGE TANK ${ST(to)} Feed Branch`)],
        'TK-RAW>THM': () => [freeEnd(graph, `STORAGE TANK ${ST(from)} Outlet Branch`), firstNode(graph, 'Farm to Filtration')],
        'THM>SEP': () => [firstNode(graph, 'Farm to Filtration'), lastNode(graph, 'Filtration Inlet Pipe')],
        'SEP>TK-STO': () => [firstNode(graph, 'Filtration Outlet Pipe'), freeEnd(graph, `SFP STORAGE ${ST(to)} Feed Branch`)],
        'TK-STO>STE': () => [freeEnd(graph, `SFP STORAGE ${ST(from)} Outlet Branch`), lastNode(graph, 'SFP to Sterilizer')],
        'STE>ASEP': () => [firstNode(graph, 'Sterilization Process Line'), freeEnd(graph, `ASEPTIC TANK ${ST(to)} Feed Branch`)],
        'ASEP>LINE': () => [freeEnd(graph, `ASEPTIC TANK ${ST(from)} Outlet Line`), freeEnd(graph, `${ST(to)} Product Inlet Pipe`)],
    }[`${f}>${t}`];
    if (!ends) return null;
    const pair = ends();
    return pair.every((n) => n >= 0) ? pair : null;
}

/** Rute pipa untuk satu aliran (di-cache pemanggil per pasangan kode). */
export function flowRoute(graph, from, to) {
    const ends = flowEnds(graph, from, to);
    return ends ? shortestRoute(graph, ends[0], ends[1]) : null;
}

/** Titik sambungan selang truk tiap bay: {'BAY-1': [x,y,z]} dari plant.json `bays` (urut sama dengan kode bay). */
export function bayTaps(meta, bayCodes) {
    const taps = {};
    bayCodes.forEach((code, i) => {
        const join = meta.bays?.[i]?.join;
        if (join) taps[code] = join;
    });
    return taps;
}
