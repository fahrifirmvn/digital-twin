/** Hari operasi dimulai 06:00 (menit 0 run = 06:00). */
export const DAY_START_MIN = 360;

/** Menit sejak awal run -> "H+1 03:24" / "03:24" (jam dinding, hari bertambah tiap tengah malam). */
export function clock(m) {
    const t = m + DAY_START_MIN;
    const day = Math.floor(t / 1440);
    const hh = String(Math.floor((t % 1440) / 60)).padStart(2, '0');
    const mm = String(Math.floor(t % 60)).padStart(2, '0');
    return `${day ? `H+${day} ` : ''}${hh}:${mm}`;
}

/** Menit sejak awal run -> "HH:MM" saja, tanpa penanda hari (untuk input <input type="time">). */
export function clockOfDay(m) {
    return clock(m).slice(-5);
}

/** Jam dinding "HH:MM" yang jatuh pada hari yang sama dengan menit acuan `near` -> menit run. */
export function runMinuteOf(near, hh, mm) {
    const dayBase = Math.floor((near + DAY_START_MIN) / 1440) * 1440 - DAY_START_MIN;
    return dayBase + hh * 60 + mm;
}

/** Massa jenis susu 1,03 kg/L: 1 ton = 1000/1,03 L. Engine tetap bekerja dalam ton; layar menampilkan liter. */
export const L_PER_TON = 1000 / 1.03;

export const toLiters = (ton) => Math.round(ton * L_PER_TON);

/** 22.5 (ton) -> "21.845 L" (pemisah ribuan lokal Indonesia). */
export function fmtL(ton) {
    return `${toLiters(ton).toLocaleString('id-ID')} L`;
}
