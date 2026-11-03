// Kanvas Maps: jalur pendekatan, geofence, gerbang, dan truk menuju gerbang. Menggambar saja; data dari geo.js.
import { FACTORY, GATE, GEOFENCE_R, MAP, ROUTES, inboundList, recentArrivals } from './geo.js';

const VARS = ['bg', 'card', 'ink', 'mute', 'line', 'line-strong', 'brand', 'brand-soft', 'ok', 'warn'];
const HIT_R = 22;

export class MapCanvas {
    /** mini = pratinjau Dashboard: tanpa teks, penanda lebih besar. */
    constructor(canvas, { mini = false } = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.mini = mini;
        this.hits = [];
        this.palette = null;
        this.themeKey = null;
        if (mini) canvas.style.aspectRatio = `${MAP.w} / ${MAP.h}`;
    }

    #colors() {
        const key = this.canvas.closest('[data-theme]')?.dataset.theme ?? '';
        if (key !== this.themeKey || !this.palette) {
            const cs = getComputedStyle(this.canvas);
            this.palette = Object.fromEntries(VARS.map((v) => [v, cs.getPropertyValue(`--${v}`).trim() || '#888']));
            this.themeKey = key;
        }
        return this.palette;
    }

    /** Skala dan offset (isi diletakkan di tengah, proporsi tetap) dari koordinat peta ke px layar. */
    #fit() {
        const cw = this.canvas.clientWidth;
        const ch = this.canvas.clientHeight;
        if (!cw || !ch) return null;
        const s = Math.min(cw / MAP.w, ch / MAP.h);
        return { s, ox: (cw - MAP.w * s) / 2, oy: (ch - MAP.h * s) / 2, cw, ch };
    }

    /** Kode truk di titik layar (client px), atau null. */
    pick(clientX, clientY) {
        const f = this.#fit();
        if (!f) return null;
        const r = this.canvas.getBoundingClientRect();
        const x = (clientX - r.left - f.ox) / f.s;
        const y = (clientY - r.top - f.oy) / f.s;
        const hit = this.hits.map((h) => ({ ...h, d: Math.hypot(h.x - x, h.y - y) })).filter((h) => h.d <= HIT_R).sort((a, b) => a.d - b.d)[0];
        return hit?.code ?? null;
    }

    draw(state, { selected = null } = {}) {
        const f = this.#fit();
        if (!f) return;
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(f.cw * dpr);
        const h = Math.round(f.ch * dpr);
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
        }
        const c = this.ctx;
        const p = this.#colors();
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.fillStyle = p.bg;
        c.fillRect(0, 0, w, h);
        c.setTransform(f.s * dpr, 0, 0, f.s * dpr, f.ox * dpr, f.oy * dpr);
        c.textBaseline = 'middle';

        this.roads(c, p);
        this.factory(c, p);
        const arrivals = recentArrivals(state, 10).slice(0, 3);
        this.gate(c, p, arrivals);
        this.trucks(c, p, inboundList(state), selected);
    }

    text(c, p, str, x, y, { size = 13, weight = 600, color = p.ink, align = 'left' } = {}) {
        c.font = `${weight} ${size}px system-ui, sans-serif`;
        c.textAlign = align;
        c.lineWidth = 4;
        c.strokeStyle = p.bg;
        c.lineJoin = 'round';
        c.strokeText(str, x, y);
        c.fillStyle = color;
        c.fillText(str, x, y);
    }

    roads(c, p) {
        c.lineCap = 'round';
        c.lineJoin = 'round';
        const trace = (r) => {
            c.beginPath();
            r.pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
        };
        c.strokeStyle = p.line;
        c.lineWidth = 20;
        for (const r of ROUTES) { trace(r); c.stroke(); }
        c.strokeStyle = p['line-strong'];
        c.lineWidth = 1.5;
        c.setLineDash([8, 10]);
        for (const r of ROUTES) { trace(r); c.stroke(); }
        c.setLineDash([]);
        if (this.mini) return;
        const [[nx, ny], [wx, wy], [sx, sy]] = ROUTES.map((r) => r.pts[0]);
        const o = { size: 15, color: p.mute, weight: 600 };
        this.text(c, p, 'Jalur utara · 45 mnt dari gerbang', nx + 16, ny + 18, o);
        this.text(c, p, 'Jalur barat · 45 mnt dari gerbang', wx + 10, wy + 22, o);
        this.text(c, p, 'Jalur selatan · 45 mnt dari gerbang', sx + 16, sy - 16, o);
        this.text(c, p, 'Skema jalur pendekatan, bukan peta geografis. Plat nomor sintetis.', 14, MAP.h - 14, { size: 14, color: p.mute, weight: 500 });
    }

    factory(c, p) {
        const { x, y, w, h } = FACTORY;
        c.beginPath();
        c.roundRect(x, y, w, h, 16);
        c.fillStyle = p.card;
        c.fill();
        c.strokeStyle = p['line-strong'];
        c.lineWidth = 2;
        c.stroke();
        c.fillStyle = p['line-strong'];
        for (let i = 0; i < 3; i++) {
            c.beginPath();
            c.arc(x + 140 + i * 66, y + 80, 22, 0, Math.PI * 2);
            c.globalAlpha = 0.35;
            c.fill();
            c.globalAlpha = 1;
        }
        if (!this.mini) this.text(c, p, 'PABRIK', x + 22, y + 34, { size: 18, weight: 800 });
    }

    gate(c, p, arrivals) {
        c.beginPath();
        c.arc(GATE.x, GATE.y, GEOFENCE_R, 0, Math.PI * 2);
        c.fillStyle = p['brand-soft'];
        c.globalAlpha = 0.45;
        c.fill();
        c.globalAlpha = 1;
        c.strokeStyle = p.brand;
        c.lineWidth = 2;
        c.setLineDash([7, 6]);
        c.stroke();
        c.setLineDash([]);

        c.beginPath();
        c.roundRect(GATE.x - 6, GATE.y - 20, 12, 40, 4);
        c.fillStyle = p.ink;
        c.fill();

        if (this.mini) return;
        this.text(c, p, 'Gerbang masuk', GATE.x + 16, GATE.y + 4, { size: 16, weight: 700 });
        this.text(c, p, 'Geofence gerbang', GATE.x + 16, GATE.y + GEOFENCE_R + 16, { size: 15, color: p.mute });
        arrivals.forEach((t, i) => {
            const fade = 1 - t.ago / 12;
            c.globalAlpha = Math.max(0.35, fade);
            this.text(c, p, `\u2713 ${t.plate ?? t.code} tiba`, GATE.x + 16, GATE.y - 30 - i * 20, { size: 15, color: p.ok, weight: 700 });
            c.globalAlpha = 1;
        });
    }

    trucks(c, p, list, selected) {
        const k = this.mini ? 1.7 : 1;
        const crowded = list.length > 10;
        this.hits = [];
        for (const [i, t] of list.entries()) {
            const { x, y, angle } = t.pos;
            this.hits.push({ code: t.code, x, y });
            c.save();
            c.translate(x, y);
            c.rotate(angle);
            c.scale(k, k);
            c.beginPath();
            c.roundRect(-12, -7, 24, 14, 4);
            c.fillStyle = t.inGeofence ? p.ok : p.brand;
            c.fill();
            c.lineWidth = 2;
            c.strokeStyle = p.card;
            c.stroke();
            c.fillStyle = p.card;
            c.fillRect(6, -5, 4, 10);
            c.restore();
            if (t.code === selected) {
                c.beginPath();
                c.arc(x, y, 20 * k, 0, Math.PI * 2);
                c.strokeStyle = p.ink;
                c.lineWidth = 3;
                c.stroke();
            }
            if (!this.mini && (!crowded || t.code === selected || t.progress > 0.5)) {
                // Label bergantian di atas dan di bawah agar truk yang berdekatan tidak saling menimpa.
                // Truk dekat gerbang: label ke kiri supaya tidak menimpa tulisan "Gerbang masuk".
                const left = x > 500;
                this.text(c, p, `${t.plate ?? t.code}`, left ? x - 16 : x + 16, y + (i % 2 ? 28 : -16), { size: 15, weight: 700, align: left ? 'right' : 'left' });
            }
        }
    }
}
