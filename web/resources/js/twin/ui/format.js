/** Hari operasi dimulai 06:00 (menit 0 run = 06:00). */
export const DAY_START_MIN = 360;

export function dayProgress(minute) {
    const elapsed = Math.max(0, Math.floor(minute));
    return {
        percent: Math.min(100, Math.floor(elapsed / 1440 * 100)),
        elapsed: `${Math.floor(elapsed / 60)}j ${String(elapsed % 60).padStart(2, '0')}m berlalu`,
        overtime: elapsed > 1440,
    };
}

/** Jam operasi lokal WIB; menit run sudah dihitung sejak pukul 06:00 WIB. */
export function clock(m) {
    return `${clockOfDay(m)} WIB`;
}

/** Jam lokal tanpa zona untuk input <input type="time">. */
export function clockOfDay(m) {
    const t = ((m + DAY_START_MIN) % 1440 + 1440) % 1440;
    const hh = String(Math.floor((t % 1440) / 60)).padStart(2, '0');
    const mm = String(Math.floor(t % 60)).padStart(2, '0');
    return `${hh}:${mm}`;
}

/** Jam dinding "HH:MM" yang jatuh pada hari yang sama dengan menit acuan `near` -> menit run. */
export function runMinuteOf(near, hh, mm) {
    const dayBase = Math.floor((near + DAY_START_MIN) / 1440) * 1440 - DAY_START_MIN;
    return dayBase + hh * 60 + mm;
}

/** Massa jenis susu standar brief 1,0 kg/L: 1 ton = 1.000 L. Engine tetap bekerja dalam ton; layar menampilkan liter. */
export const L_PER_TON = 1000;

export const toLiters = (ton) => Math.round(ton * L_PER_TON);

/** 22.5 (ton) -> "22.500 L" (pemisah ribuan lokal Indonesia). */
export function fmtL(ton) {
    return `${toLiters(ton).toLocaleString('id-ID')} L`;
}

const BRIEF_PREFIX = {
    BAY: 'UB',
    'TK-RAW': 'ST',
    'TK-STO': 'SFP',
    THM: 'TH',
    STE: 'ST-STER',
    ASEP: 'AT',
    LINE: 'FL',
};

/** Pemetaan kode internal Engine ke kode standar brief mitra (mis. TK-RAW-1 -> ST-01). */
export function assetAlias(code) {
    const m = String(code ?? '').match(/^(BAY|TK-RAW|TK-STO|THM|STE|ASEP|LINE)-(\d+)$/);
    if (!m) return null;
    const prefix = BRIEF_PREFIX[m[1]];
    return prefix ? `${prefix}-${String(Number(m[2])).padStart(2, '0')}` : null;
}

/** Label ganda brief + internal untuk judul aset (mis. "ST-01 (TK-RAW-1)"). */
export function assetDualLabel(code) {
    const alias = assetAlias(code);
    return alias ? `${alias} (${code})` : String(code ?? '');
}

