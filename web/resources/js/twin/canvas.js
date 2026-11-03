// Twin Canvas 2D: diagram alir pabrik. Murni menggambar state; tidak menyimpan logika simulasi.
import { capacityOf } from './state.js';
import { fmtL } from './ui/format.js';

const W = 1180;
const H = 600;

const COLORS = {
    idle: '#e2e8f0', in_use: '#2563eb', filling: '#16a34a', holding: '#7c3aed',
    cip: '#f59e0b', unavailable: '#475569',
};
export const STATUS_COLORS = {
    ...COLORS, queued: '#94a3b8', sampling: '#a78bfa', lab_test: '#7c3aed', released: '#14b8a6', unloading: '#2563eb',
};

function column(codes, x, y0, y1, w, h) {
    const step = codes.length > 1 ? (y1 - y0 - h) / (codes.length - 1) : 0;
    return Object.fromEntries(codes.map((c, i) => [c, { x, y: y0 + i * step + (codes.length === 1 ? (y1 - y0 - h) / 2 : 0), w, h }]));
}
const seq = (p, n) => Array.from({ length: n }, (_, i) => `${p}-${i + 1}`);

export const LAYOUT = (() => {
    const L = {
        ...column(seq('BAY', 4), 150, 70, 470, 76, 40),
        ...column(seq('DEG', 2), 262, 150, 390, 76, 40),
        ...column(seq('TK-RAW', 2), 374, 130, 410, 80, 64),
        ...column(seq('THM', 2), 492, 150, 390, 76, 40),
        ...column(seq('SEP', 2), 592, 150, 390, 76, 40),
        ...column(seq('TK-STO', 6), 706, 60, 540, 80, 52),
        ...column(seq('STE', 5), 826, 70, 520, 76, 40),
    };
    for (let k = 1; k <= 5; k++) {
        const s = L[`STE-${k}`];
        L[`LINE-${2 * k - 1}`] = { x: 930, y: s.y - 18, w: 70, h: 28 };
        L[`LINE-${2 * k}`] = { x: 930, y: s.y + 30, w: 70, h: 28 };
    }
    L['PACK-OUT'] = { x: 1060, y: 70, w: 100, h: 450 };
    L['QA-HOLD'] = { x: 706, y: 556, w: 130, h: 34 };
    return L;
})();

const TITLES = [
    [10, 'Truk menunggu'], [150, 'Bay'], [262, 'Degassing'], [374, 'Raw tank'], [492, 'Thermal'],
    [592, 'Separator'], [706, 'Storage'], [826, 'Sterilizer'], [930, 'Filling'], [1060, 'Keluar (FG)'],
];

export const QUEUE_STATES = ['queued', 'sampling', 'lab_test', 'released'];

export function center(code) {
    // Aseptic tank tidak punya node sendiri: alirannya digambar dari sterilizer pasangannya.
    const asep = /^ASEP-(\d+)$/.exec(code);
    const n = LAYOUT[asep ? `STE-${asep[1]}` : code];
    return n ? { x: n.x + n.w / 2, y: n.y + n.h / 2 } : null;
}

export class TwinCanvas {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        canvas.width = W * dpr;
        canvas.height = H * dpr;
        canvas.style.width = '100%';
        canvas.style.aspectRatio = `${W} / ${H}`;
        this.ctx.scale(dpr, dpr);
    }

    /** Skala dan offset canvas (object-fit: contain) dari koordinat diagram ke px layar; null bila tersembunyi. */
    #fit() {
        const cw = this.canvas.clientWidth;
        const ch = this.canvas.clientHeight;
        if (!cw || !ch) return null;
        const s = Math.min(cw / W, ch / H);
        return { s, ox: (cw - W * s) / 2, oy: (ch - H * s) / 2 };
    }

    has(key) {
        return key in LAYOUT;
    }

    /** Tempat pin truk ditolak: pojok kiri bawah, di atas teks "Ditolak". */
    fallbackKey() {
        return 'REJECT';
    }

    /** Titik atas-tengah node (px layar relatif canvas); null bila tidak dikenal atau canvas tersembunyi. */
    project(key) {
        const f = this.#fit();
        const n = LAYOUT[key];
        const p = key === 'REJECT' ? { x: 70, y: H - 30 } : n && { x: n.x + n.w / 2, y: n.y };
        return f && p ? { x: f.ox + p.x * f.s, y: f.oy + p.y * f.s } : null;
    }

    /** Kode aset di titik layar (client px), atau null. */
    pick(clientX, clientY) {
        const f = this.#fit();
        if (!f) return null;
        const r = this.canvas.getBoundingClientRect();
        const x = (clientX - r.left - f.ox) / f.s;
        const y = (clientY - r.top - f.oy) / f.s;
        return Object.entries(LAYOUT).find(([, n]) => x >= n.x && x <= n.x + n.w && y >= n.y && y <= n.y + n.h)?.[0] ?? null;
    }

    draw(state, speed) {
        const c = this.ctx;
        c.clearRect(0, 0, W, H);
        c.font = '11px system-ui, sans-serif';
        c.textBaseline = 'middle';

        c.fillStyle = '#64748b';
        for (const [x, t] of TITLES) c.fillText(t, x, 28);

        for (const [code, n] of Object.entries(LAYOUT)) this.node(code, n, state);
        this.queue(state);
        this.flows(state, speed);
    }

    node(code, n, state) {
        const c = this.ctx;
        const a = state.assets[code];
        const status = a?.status ?? 'idle';
        c.fillStyle = '#fff';
        c.strokeStyle = status === 'idle' ? '#cbd5e1' : COLORS[status];
        c.lineWidth = status === 'idle' ? 1 : 2;
        c.beginPath();
        c.roundRect(n.x, n.y, n.w, n.h, 6);
        c.fill();

        const cap = capacityOf(code);
        if (cap && a?.level > 0) {
            const hh = Math.min(1, a.level / cap) * (n.h - 4);
            c.fillStyle = 'rgba(22,163,74,.35)';
            c.fillRect(n.x + 2, n.y + n.h - 2 - hh, n.w - 4, hh);
        } else if (!cap && status !== 'idle' && code !== 'PACK-OUT' && code !== 'QA-HOLD') {
            c.fillStyle = COLORS[status] + '22';
            c.beginPath();
            c.roundRect(n.x, n.y, n.w, n.h, 6);
            c.fill();
        }
        c.stroke();

        c.fillStyle = '#1d2733';
        c.fillText(code, n.x + 6, n.y + 11);
        if (cap) c.fillText(`${fmtL(a?.level ?? 0)} / ${fmtL(cap)}`, n.x + 6, n.y + n.h - 10);
        else if (status !== 'idle') {
            c.fillStyle = COLORS[status];
            c.fillText(status === 'in_use' ? 'aktif' : status.toUpperCase(), n.x + 6, n.y + n.h - 10);
        }

        if (code === 'PACK-OUT') {
            c.fillStyle = '#16a34a';
            c.font = 'bold 18px system-ui, sans-serif';
            c.fillText(fmtL(state.counters.fgTon), n.x + 10, n.y + 40);
            c.font = '11px system-ui, sans-serif';
        }
        if (code === 'QA-HOLD') {
            c.fillStyle = state.counters.qaHoldTon > 0 ? '#dc2626' : '#64748b';
            c.fillText(`${fmtL(state.counters.qaHoldTon)} ditahan`, n.x + 6, n.y + n.h - 10);
        }

        // Truk yang sedang bongkar ditandai di bay-nya.
        if (code.startsWith('BAY-')) {
            const t = Object.values(state.tankers).find((x) => x.status === 'unloading' && x.bay === code);
            if (t) {
                c.fillStyle = '#2563eb';
                c.fillText(t.code, n.x + 6, n.y + n.h - 10);
            }
        }
    }

    queue(state) {
        const c = this.ctx;
        const waiting = Object.values(state.tankers).filter((t) => QUEUE_STATES.includes(t.status) && !t.held);
        waiting.slice(0, 26).forEach((t, i) => {
            const y = 50 + i * 20;
            c.fillStyle = STATUS_COLORS[t.status];
            c.beginPath();
            c.roundRect(10, y, 120, 17, 4);
            c.fill();
            c.fillStyle = '#fff';
            c.fillText(`${t.code}  ${t.status === 'lab_test' ? 'uji lab' : t.status}`, 16, y + 9);
        });
        if (waiting.length > 26) {
            c.fillStyle = '#64748b';
            c.fillText(`+${waiting.length - 26} lagi`, 10, 50 + 26 * 20 + 8);
        }
        const { heldG1, rejectedG2 } = state.counters;
        if (heldG1 + rejectedG2 > 0) {
            c.fillStyle = '#dc2626';
            c.fillText(`Ditolak: G1 ${heldG1}, G2 ${rejectedG2}`, 10, H - 14);
        }
    }

    flows(state, speed) {
        const c = this.ctx;
        // Garis aliran terlihat sekitar 0,9 detik nyata, apa pun kecepatan putarnya.
        const ttl = Math.max(12, (speed || 60) * 0.9);
        for (const f of state.flows) {
            const age = state.m - f.m;
            if (age > ttl || age < 0) continue;
            const a = f.from.startsWith('RT-') ? { x: 130, y: 60 } : center(f.from);
            const b = center(f.to);
            if (!a || !b || (a.x === b.x && a.y === b.y)) continue;
            const alpha = 1 - age / ttl;
            const held = f.to === 'QA-HOLD';
            c.strokeStyle = held ? `rgba(220,38,38,${alpha})` : `rgba(37,99,235,${alpha * 0.8})`;
            c.lineWidth = 2;
            c.beginPath();
            c.moveTo(a.x, a.y);
            c.lineTo(b.x, b.y);
            c.stroke();
        }
    }
}
