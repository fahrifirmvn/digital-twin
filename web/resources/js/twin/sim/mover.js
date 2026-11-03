// Gerak truk: mengikuti rute jalan menuju slot tujuan. Murni (tanpa three.js); pemanggil memberi dt nyata.
import { drivePath, facingAngle, headingOf } from './routes.js';

const BASE_SPEED = 260;
const LAG_SEC = 2.5;
const TURN_RATE = 7;
const SETTLED = 0.01;

const wrap = (x) => ((((x + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
const sameSpot = (p, q) => Math.abs(p.a - q.a) < 0.5 && Math.abs(p.b - q.b) < 0.5;

export class TruckMover {
    /** maxEntries membatasi truk tampil (termasuk yang sedang keluar) agar muat di pool mesh. */
    constructor(layout, { maxEntries = 64, speed = BASE_SPEED, lagSec = LAG_SEC, turnRate = TURN_RATE } = {}) {
        this.layout = layout;
        this.maxEntries = maxEntries;
        this.speed = speed;
        this.lagSec = lagSec;
        this.turnRate = turnRate;
        const [a, b] = layout.roads[0].from;
        this.entrance = { a, b };
        this.entries = new Map();
    }

    #from(e) {
        return { a: e.a, b: e.b, ...(!e.path.length && e.goal?.via ? { via: e.goal.via } : {}) };
    }

    // Kecepatan dikunci per rute: rute panjang dipercepat agar selesai dalam lagSec, bukan menurun eksponensial.
    #drive(e, path) {
        e.path = path;
        e.v = Math.max(this.speed, this.#remaining(e) / this.lagSec);
    }

    #place(e, spot) {
        e.a = spot.a;
        e.b = spot.b;
        e.rot = facingAngle(spot.facing);
        e.path = [];
        e.goal = spot;
    }

    #headingTo(e, p) {
        return p.h ?? headingOf(p.a - e.a, p.b - e.b);
    }

    /** Samakan daftar truk tujuan (keluaran placeTrucks); snap = lompat langsung ke tujuan tanpa menyetir. */
    sync(trucks, { snap = false } = {}) {
        const seen = new Set();
        for (const t of trucks) {
            seen.add(t.code);
            const goal = { a: t.a, b: t.b, facing: t.facing, via: t.via };
            let e = this.entries.get(t.code);
            if (!e) {
                e = { code: t.code, status: t.status, a: 0, b: 0, rot: 0, path: [], goal, leaving: false };
                this.entries.set(t.code, e);
                if (snap) this.#place(e, goal);
                else {
                    Object.assign(e, this.entrance);
                    this.#drive(e, drivePath(this.layout, this.entrance, goal));
                    e.rot = e.path.length ? this.#headingTo(e, e.path[0]) : facingAngle(goal.facing);
                }
                continue;
            }
            e.status = t.status;
            if (snap) {
                e.leaving = false;
                this.#place(e, goal);
            } else if (e.leaving || !e.goal || !sameSpot(e.goal, goal)) {
                this.#drive(e, drivePath(this.layout, this.#from(e), goal));
                e.goal = goal;
                e.leaving = false;
            }
        }
        for (const [code, e] of this.entries) {
            if (seen.has(code)) continue;
            if (snap) this.entries.delete(code);
            else if (!e.leaving) {
                this.#drive(e, drivePath(this.layout, this.#from(e), this.entrance, { lane: true }));
                e.goal = null;
                e.leaving = true;
            }
        }
        for (const [code, e] of this.entries) {
            if (this.entries.size <= this.maxEntries) break;
            if (e.leaving) this.entries.delete(code);
        }
    }

    #remaining(e) {
        let a = e.a;
        let b = e.b;
        let len = 0;
        for (const p of e.path) {
            len += Math.hypot(p.a - a, p.b - b);
            a = p.a;
            b = p.b;
        }
        return len;
    }

    /** Majukan semua truk dt detik; true selama masih ada yang bergerak atau berputar. */
    step(dt) {
        let moving = false;
        for (const [code, e] of this.entries) {
            let budget = e.v * dt;
            while (budget > 0 && e.path.length) {
                const p = e.path[0];
                const d = Math.hypot(p.a - e.a, p.b - e.b);
                if (d <= budget) {
                    budget -= d;
                    e.a = p.a;
                    e.b = p.b;
                    e.path.shift();
                } else {
                    e.a += ((p.a - e.a) / d) * budget;
                    e.b += ((p.b - e.b) / d) * budget;
                    budget = 0;
                }
            }
            if (e.leaving && !e.path.length) {
                this.entries.delete(code);
                continue;
            }
            const want = e.path.length ? this.#headingTo(e, e.path[0]) : e.goal ? facingAngle(e.goal.facing) : e.rot;
            const diff = wrap(want - e.rot);
            const turn = this.turnRate * dt;
            e.rot = Math.abs(diff) <= turn ? want : e.rot + Math.sign(diff) * turn;
            if (e.path.length || Math.abs(diff) > SETTLED) moving = true;
        }
        return moving;
    }

    get moving() {
        for (const e of this.entries.values()) if (e.path.length || (e.goal && Math.abs(wrap(facingAngle(e.goal.facing) - e.rot)) > SETTLED)) return true;
        return false;
    }

    poses() {
        return [...this.entries.values()].map((e) => ({ code: e.code, status: e.status, a: e.a, b: e.b, rot: e.rot, leaving: e.leaving }));
    }
}
