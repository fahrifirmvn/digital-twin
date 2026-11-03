// Usulan sistem untuk PPIC pada menit tertentu. Murni, tanpa DOM.
// Usulan = truk yang menunggu analis (sampling) atau bay (released) dan punya baris di rencana terkini.
import { isIntervention } from './commands.js';

const toM = (iso, startMs) => (Date.parse(iso) - startMs) / 60000;
const WAITING = { sampling: 'Antre lab', released: 'Antre bay' };

/** Rencana berlaku pada menit m: versi 1 lengkap, versi berikutnya menimpa truk yang disusun ulang. */
export function planAt(plans, startMs, m) {
    const out = {};
    for (const v of plans ?? []) {
        if (v.at && toM(v.at, startMs) > m) break;
        for (const t of v.trucks ?? []) {
            out[t.code] = {
                analyst: t.analyst, bay: t.bay, sterilizer: t.sterilizer, line: t.line,
                labM: toM(t.lab_start, startMs), unloadM: toM(t.unload_start, startMs),
            };
        }
    }
    return out;
}

/** Keputusan PPIC yang sudah berlaku pada menit m, per truk: {plan: approve|change|reject, bay, startM, hold}. */
export function decisionsAt(model, m) {
    const out = {};
    for (const e of model.events) {
        if (e.m > m) break;
        const p = e.p;
        if (p.type !== 'command.applied' || !p.truck || p.blocked || !isIntervention(p.kind)) continue;
        const d = (out[p.truck] ??= { plan: null, bay: null, startM: null, hold: false });
        if (p.kind === 'truck_hold') d.hold = true;
        else if (p.kind === 'truck_release') d.hold = false;
        else if (p.kind === 'plan_approve') d.plan = 'approve';
        else if (p.kind === 'plan_reject') d.plan = 'reject';
        else {
            d.plan = 'change';
            d.bay = p.bay ?? d.bay;
            d.startM = p.start_min ?? d.startM;
        }
    }
    return out;
}

const byTime = (a, b) => a.sinceM - b.sinceM || a.code.localeCompare(b.code);

/**
 * Baris panel intervensi: waiting (bisa disetujui/diubah/ditolak), gate (ditahan PPIC), g1 (ditahan SOP, tidak
 * bisa dilepas), inbound (bisa ditahan). Tiap daftar dipotong ke `max`.
 */
export function proposalRows(state, plan, decisions, max = 6) {
    const waiting = [];
    const gate = [];
    const g1 = [];
    for (const t of Object.values(state.tankers)) {
        const d = decisions[t.code] ?? null;
        const row = { code: t.code, plate: t.plate, farm: t.farm, sinceM: t.since };
        if (t.held === 'G1') g1.push({ ...row, reason: t.gates?.G1?.reason ?? null });
        else if (t.status === 'queued') gate.push({ ...row, hold: Boolean(d?.hold) });
        else if (t.status in WAITING && plan[t.code]) {
            const p = plan[t.code];
            const rejected = d?.plan === 'reject';
            waiting.push({
                ...row, stage: WAITING[t.status], verdict: d?.plan ?? null,
                proposal: rejected ? null : { bay: d?.bay ?? p.bay, unloadM: d?.startM ?? p.unloadM, analyst: p.analyst },
            });
        }
    }
    const inbound = Object.values(state.inbound)
        .map((i) => ({ code: i.code, plate: i.plate, farm: i.farm, etaM: i.etaM, hold: Boolean(decisions[i.code]?.hold) }))
        .sort((a, b) => a.etaM - b.etaM || a.code.localeCompare(b.code));
    return {
        waiting: waiting.sort(byTime).slice(0, max),
        gate: gate.sort(byTime).slice(0, max),
        g1: g1.sort(byTime).slice(0, 3),
        inbound: inbound.slice(0, max),
    };
}
