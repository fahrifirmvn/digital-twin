// Dampak sebuah simulasi dibanding run dasar (KPI dari Engine). Murni, tanpa DOM.
import { toLiters } from './format.js';

/** [label, ambil nilai dari KPI, lebih tinggi lebih baik?, satuan]. */
const ROWS = [
    ['Rata-rata tunggu truk', (k) => k.truck_wait_min?.mean, false, 'mnt'],
    ['Tunggu truk P90', (k) => k.truck_wait_min?.p90, false, 'mnt'],
    ['CIP darurat', (k) => k.unscheduled_cip, false, 'kali'],
    ['Truk ditahan G1', (k) => k.held_g1, false, 'truk'],
    ['Truk selesai', (k) => k.completed, true, 'truk'],
    ['Susu jadi', (k) => (typeof k.fg_ton === 'number' ? toLiters(k.fg_ton) : null), true, 'L'],
    ['Kepatuhan jadwal', (k) => k.schedule_adherence_pct, true, '%'],
    ['Selesai hari ini', (k) => k.makespan_min, false, 'mnt'],
];

const round = (n) => Math.round(n * 10) / 10;

/** Baris perbandingan; baris yang tidak ada di salah satu KPI dilewati. tone: good | bad | same. */
export function impactRows(kpi, base) {
    if (!kpi || !base) return [];
    const out = [];
    for (const [label, get, higherBetter, unit] of ROWS) {
        const now = get(kpi);
        const was = get(base);
        if (typeof now !== 'number' || typeof was !== 'number') continue;
        const delta = round(now - was);
        const tone = delta === 0 ? 'same' : (delta > 0) === higherBetter ? 'good' : 'bad';
        out.push({ label, unit, base: round(was), now: round(now), delta, tone });
    }
    return out;
}

/** +12,5 / -3 / 0, dengan tanda yang jelas untuk pembaca layar. */
export function deltaText(delta) {
    if (delta === 0) return '0';
    return `${delta > 0 ? '+' : '-'}${String(Math.abs(delta)).replace('.', ',')}`;
}
