import { truckStatus } from './status.js';

export function truckWarningKey(t) {
    if (!t || truckStatus(t).tone !== 'bad') return null;
    return JSON.stringify([
        t.code, t.status, t.held ?? null, t.since ?? null,
        ['G1', 'G2', 'G3'].map((gate) => t.gates?.[gate] ?? null),
        t.qa ?? null,
    ]);
}

export function readWarnings(runId, storage) {
    const key = `twin.read-warnings.${runId}`;
    const seen = new Set();
    try {
        const saved = JSON.parse(storage?.getItem(key) ?? '[]');
        if (!Array.isArray(saved) || saved.some((item) => typeof item !== 'string')) throw new Error('Data tidak valid');
        for (const item of saved) seen.add(item);
    } catch (error) {
        console.warn('Riwayat notifikasi dibaca tidak dapat dimuat; peringatan tetap ditampilkan.', error);
    }
    return {
        has(t) {
            const warning = truckWarningKey(t);
            return warning != null && seen.has(warning);
        },
        mark(t) {
            const warning = truckWarningKey(t);
            if (warning == null || seen.has(warning)) return;
            seen.add(warning);
            try {
                storage?.setItem(key, JSON.stringify([...seen]));
            } catch (error) {
                console.warn('Status notifikasi dibaca hanya tersimpan sampai halaman ditutup.', error);
            }
        },
    };
}
