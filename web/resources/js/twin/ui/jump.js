// Lompat ke kejadian penting berikutnya, supaya penonton tidak menunggu jam-jam yang sepi.
import { commandSummary } from './commands.js';

const EPS = 1e-6;

/** Label bila event ini layak dilompati, selain itu null. */
export function notableLabel(p) {
    switch (p.type) {
        case 'truck.arrived':
            return `${p.tanker_code} tiba`;
        case 'gate.decided':
            return p.decision === 'hold' ? `${p.gate} tahan ${p.object_id}` : null;
        case 'asset.status_changed':
            return p.status === 'unavailable' ? `${p.asset_code} tidak tersedia` : null;
        case 'cip.started':
            return p.is_scheduled ? null : `CIP darurat ${p.asset_code}`;
        case 'schedule.replanned':
            return `Replan v${p.version}`;
        case 'command.applied':
            return `Perintah: ${commandSummary(p)}`;
        default:
            return null;
    }
}

/** Kejadian penting pertama setelah `minute`: {m, label}, atau null bila sudah tidak ada. */
export function nextNotable(model, minute) {
    for (const e of model.events) {
        if (e.m <= minute + EPS) continue;
        const label = notableLabel(e.p);
        if (label) return { m: e.m, label };
    }
    return null;
}
