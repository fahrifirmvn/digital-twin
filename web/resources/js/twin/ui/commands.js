// Perintah mode Simulasi: label, ringkasan argumen, dan log dari event `command.applied`. Murni, tanpa DOM.
import { clock } from './format.js';

export const KIND_LABEL = {
    ster_down: 'Sterilizer mati',
    tank_down: 'Tangki maintenance',
    cip_delay: 'CIP lebih lama',
    truck_surge: 'Truk dadakan',
    plan_approve: 'Setujui usulan',
    plan_change: 'Ubah usulan',
    plan_reject: 'Tolak usulan',
    truck_hold: 'Tahan truk',
    truck_release: 'Lepas truk',
};

/** Keputusan PPIC atas usulan sistem atau truk (bukan gangguan). */
export const INTERVENTION_KINDS = new Set(['plan_approve', 'plan_change', 'plan_reject', 'truck_hold', 'truck_release']);
export const isIntervention = (kind) => INTERVENTION_KINDS.has(kind);

export const kindLabel = (kind) => KIND_LABEL[kind] ?? kind;

/** 240 -> "4 jam", 90 -> "1 j 30 mnt", 45 -> "45 mnt". */
export function durationText(min) {
    const m = Math.round(min);
    if (m < 60) return `${m} mnt`;
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${h} j ${r} mnt` : `${h} jam`;
}

/** Argumen yang berlaku untuk satu perintah, dalam kalimat singkat. */
export function commandSummary(p) {
    switch (p.kind) {
        case 'ster_down':
            return `${p.count ?? 1} sterilizer mati ${durationText(p.duration_min ?? 0)}`;
        case 'tank_down':
            return `${p.asset ?? 'Tangki'} maintenance ${durationText(p.duration_min ?? 0)}`;
        case 'cip_delay':
            return `CIP ${p.factor ?? 2}x lebih lama selama ${durationText(p.duration_min ?? 0)}`;
        case 'truck_surge':
            return `${p.count ?? 0} truk dadakan`;
        case 'plan_approve':
        case 'plan_reject':
        case 'truck_release':
            return `${kindLabel(p.kind)} ${p.truck}`;
        case 'plan_change': {
            const parts = [p.bay, p.start_min != null ? `bongkar ${clock(p.start_min)}` : null].filter(Boolean);
            return `Ubah usulan ${p.truck}: ${parts.join(', ')}`;
        }
        case 'truck_hold':
            return `Tahan ${p.truck} di gerbang ${durationText(p.duration_min ?? 0)}`;
        default:
            return kindLabel(p.kind);
    }
}

/** Ringkasan plus alasan bila perintah tidak bisa berlaku; bagian gate menandai upaya menembus SOP. */
export function appliedText(p) {
    const base = commandSummary(p);
    if (!p.blocked) return base;
    return `${base} - DIBLOKIR${p.gate ? ` (${p.gate})` : ''}: ${p.blocked}`;
}

/** Baris log perintah dari seluruh event, berurutan menurut waktu berlaku. */
export function commandLog(model) {
    return model.events
        .filter((e) => e.p.type === 'command.applied')
        .map((e) => ({
            id: e.p.command_id, m: e.m, at: clock(e.m), kind: e.p.kind, label: kindLabel(e.p.kind),
            summary: commandSummary(e.p), actor: e.p.actor, reason: e.p.reason,
            blocked: e.p.blocked ?? null, gate: e.p.gate ?? null, truck: e.p.truck ?? null,
        }));
}
