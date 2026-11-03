// Visual aset Twin 3D: fungsi murni status -> warna dan tinggi cairan. Tanpa three.js agar dapat diuji di Node.
import { STATUS_COLORS } from './canvas.js';
import { capacityOf } from './state.js';

const BODY_IDLE = '#cbd5e1';

/** Warna badan dan tinggi cairan (0..1, null untuk aset tanpa kapasitas) satu aset. */
export function assetVisual(code, asset) {
    const status = asset?.status ?? 'idle';
    const cap = asset?.cap ?? capacityOf(code);
    return {
        status,
        color: asset?.low ? STATUS_COLORS.cip : status === 'idle' ? BODY_IDLE : (STATUS_COLORS[status] ?? BODY_IDLE),
        fill: cap ? Math.max(0, Math.min(1, (asset?.level ?? 0) / cap)) : null,
        level: asset?.level ?? null,
    };
}
