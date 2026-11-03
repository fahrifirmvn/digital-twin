// Skor latihan PPIC: tunggu rata-rata truk pada cabang simulasi dibanding jadwal sistem (run dasar).
// Gagal bila ada upaya menembus gate SOP, apa pun hasil tunggunya. Murni, tanpa DOM.
import { clock } from './format.js';
import { appliedText, isIntervention } from './commands.js';

const round = (n) => Math.round(n * 10) / 10;
const fmt = (n) => String(n).replace('.', ',');

/** null bila belum ada keputusan PPIC atau KPI belum tersedia. */
export function interventionScore(model, kpi, baseKpi) {
    const mine = model.events.filter((e) => e.p.type === 'command.applied' && isIntervention(e.p.kind));
    const mean = kpi?.truck_wait_min?.mean;
    const base = baseKpi?.truck_wait_min?.mean;
    if (!mine.length || typeof mean !== 'number' || typeof base !== 'number') return null;

    const blocked = mine.filter((e) => e.p.blocked).map((e) => ({ at: clock(e.m), m: e.m, gate: e.p.gate ?? null, text: appliedText(e.p) }));
    const violations = blocked.filter((b) => b.gate).length;
    const delta = round(mean - base);
    const verdict = violations ? 'gagal' : delta <= 0 ? 'lulus' : 'belum';
    const gap = delta === 0 ? 'sama dengan jadwal sistem' : `${fmt(Math.abs(delta))} mnt ${delta < 0 ? 'lebih cepat' : 'lebih lama'} daripada jadwal sistem`;
    const headline = {
        gagal: `Gagal: ${violations} upaya melewati gate SOP (diblokir)`,
        lulus: 'Lulus: tunggu rata-rata tidak lebih buruk dari jadwal sistem',
        belum: 'Belum lebih baik dari jadwal sistem',
    }[verdict];
    return { verdict, headline, mean: round(mean), base: round(base), delta, gap, decisions: mine.length, blocked, violations };
}
