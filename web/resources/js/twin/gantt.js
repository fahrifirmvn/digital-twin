// Gantt: interval status aset dan truk, dengan playhead yang dapat diseret.
import { STATUS_COLORS } from './canvas.js';
import { DAY_START_MIN } from './ui/format.js';

const LABEL_W = 78;
const ROW_H = 11;
const TOP = 22;

export class Gantt {
    constructor(canvas, rows, endMin, onSeek) {
        this.canvas = canvas;
        this.rows = rows;
        this.endMin = Math.max(endMin, 1);
        this.onSeek = onSeek;
        this.height = TOP + rows.length * ROW_H + 6;
        this.dpr = window.devicePixelRatio || 1;
        this.retheme();
        canvas.height = this.height * this.dpr;
        canvas.style.height = `${this.height}px`;
        canvas.style.width = '100%';
        this.resize();
        new ResizeObserver(() => this.resize()).observe(canvas.parentElement);

        const seek = (e) => {
            const r = canvas.getBoundingClientRect();
            const x = ((e.clientX - r.left) / r.width) * this.width - LABEL_W;
            onSeek(Math.max(0, Math.min(this.endMin, (x / (this.width - LABEL_W)) * this.endMin)));
        };
        let dragging = false;
        canvas.addEventListener('pointerdown', (e) => { dragging = true; canvas.setPointerCapture(e.pointerId); seek(e); });
        canvas.addEventListener('pointermove', (e) => dragging && seek(e));
        canvas.addEventListener('pointerup', () => { dragging = false; });
    }

    /** Baca warna teks dan garis dari token CSS tema aktif; panggil lagi saat tema berganti. */
    retheme() {
        const cs = getComputedStyle(this.canvas);
        const get = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
        this.ink = get('--ink', '#334155');
        this.mute = get('--mute', '#64748b');
        this.line = get('--line', '#e3e8ee');
        this.lineStrong = get('--line-strong', '#94a3b8');
        if (this.lastMinute != null) this.draw(this.lastMinute);
    }

    resize() {
        this.width = Math.max(600, this.canvas.parentElement.clientWidth);
        this.canvas.width = this.width * this.dpr;
        this.ctx = this.canvas.getContext('2d');
        this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        if (this.lastMinute != null) this.draw(this.lastMinute);
    }

    draw(minute) {
        this.lastMinute = minute;
        const c = this.ctx;
        const span = this.width - LABEL_W;
        const x = (m) => LABEL_W + (m / this.endMin) * span;
        c.clearRect(0, 0, this.width, this.height);
        c.font = '9px system-ui, sans-serif';
        c.textBaseline = 'middle';

        c.fillStyle = this.mute;
        c.strokeStyle = this.line;
        for (let h = 0; h * 60 <= this.endMin; h += 2) {
            c.beginPath();
            c.moveTo(x(h * 60), TOP - 4);
            c.lineTo(x(h * 60), this.height);
            c.stroke();
            c.fillText(`${String((h + DAY_START_MIN / 60) % 24).padStart(2, '0')}:00`, x(h * 60) - 12, 10);
        }

        let prevGroup = null;
        this.rows.forEach((r, i) => {
            const y = TOP + i * ROW_H;
            if (prevGroup && r.group !== prevGroup) {
                c.strokeStyle = this.lineStrong;
                c.beginPath();
                c.moveTo(0, y);
                c.lineTo(this.width, y);
                c.stroke();
            }
            prevGroup = r.group;
            c.fillStyle = this.ink;
            c.fillText(r.key, 4, y + ROW_H / 2);
            for (const s of r.segs) {
                c.fillStyle = STATUS_COLORS[s.status] ?? '#94a3b8';
                c.fillRect(x(s.from), y + 1, Math.max(1, x(s.to) - x(s.from)), ROW_H - 2);
            }
        });

        c.strokeStyle = '#dc2626';
        c.lineWidth = 1.5;
        c.beginPath();
        c.moveTo(x(minute), TOP - 4);
        c.lineTo(x(minute), this.height);
        c.stroke();
        c.lineWidth = 1;
    }
}
