// Tier kualitas grafis Twin 3D: pilihan awal dari spesifikasi perangkat dan penyesuaian saat berjalan. Murni, tanpa three.js.

/** pixelRatio = batas rasio piksel, detail = pengali segmen geometri, shadow = ukuran peta bayangan, antialias hanya berlaku saat renderer dibuat. */
export const TIERS = {
    low: { label: 'Rendah', pixelRatio: 1, detail: 0.35, shadow: 1024, antialias: false },
    medium: { label: 'Sedang', pixelRatio: 1.5, detail: 0.65, shadow: 2048, antialias: true },
    high: { label: 'Tinggi', pixelRatio: 2, detail: 1, shadow: 4096, antialias: true },
};
export const ORDER = ['low', 'medium', 'high'];

/** Tier awal dari sinyal perangkat; sinyal yang tidak tersedia (mis. deviceMemory di Firefox/Safari) diabaikan. */
export function detectTier({ cores, memory, coarse = false, narrow = false, saveData = false } = {}) {
    if (saveData || memory <= 2 || cores <= 2) return 'low';
    if (coarse && narrow && memory <= 4) return 'low';
    if (coarse || cores <= 4 || memory <= 4) return 'medium';
    return 'high';
}

export function deviceSignals() {
    const nav = globalThis.navigator ?? {};
    const mq = (q) => globalThis.matchMedia?.(q).matches ?? false;
    return {
        cores: nav.hardwareConcurrency,
        memory: nav.deviceMemory,
        coarse: mq('(pointer: coarse)'),
        narrow: mq('(max-width: 820px)'),
        saveData: Boolean(nav.connection?.saveData),
    };
}

const WARMUP = 45;
const WINDOW = 90;
const SLOW_MS = 24;
const FAST_MS = 18;
const CALM_WINDOWS = 8;
const RETRY_WINDOWS = 12;

/**
 * Menurunkan tier bila rata-rata interval frame lambat dan menaikkannya kembali dengan hati-hati setelah lama stabil.
 * Naik yang langsung disusul turun menetapkan batas atas, supaya tidak berosilasi.
 */
export class QualityGovernor {
    constructor(tier, onChange) {
        this.tier = tier;
        this.ceiling = 'high';
        this.onChange = onChange;
        this.#reset();
        this.upAgo = Infinity;
    }

    #reset() {
        this.skip = WARMUP;
        this.n = 0;
        this.sum = 0;
        this.calm = 0;
    }

    /** Ganti tier dari luar (pilihan pengguna); pemantauan dimulai ulang. */
    set(tier) {
        this.tier = tier;
        this.ceiling = 'high';
        this.upAgo = Infinity;
        this.#reset();
    }

    /** Catat satu interval frame (ms) selama pemutaran berlanjut. Interval besar (jeda, tab tersembunyi) mengulang jendela. */
    sample(ms) {
        if (ms > 250) return this.#reset();
        if (this.skip > 0) {
            this.skip--;
            return;
        }
        this.sum += ms;
        if (++this.n < WINDOW) return;
        const mean = this.sum / this.n;
        this.n = 0;
        this.sum = 0;
        this.upAgo++;

        const i = ORDER.indexOf(this.tier);
        if (mean > SLOW_MS && i > 0) {
            if (this.upAgo <= RETRY_WINDOWS) this.ceiling = ORDER[i - 1];
            this.#change(ORDER[i - 1]);
        } else if (mean <= FAST_MS) {
            if (++this.calm >= CALM_WINDOWS && i < ORDER.indexOf(this.ceiling)) {
                this.upAgo = 0;
                this.#change(ORDER[i + 1]);
            }
        } else {
            this.calm = 0;
        }
    }

    #change(tier) {
        this.tier = tier;
        this.#reset();
        this.onChange(tier);
    }
}
