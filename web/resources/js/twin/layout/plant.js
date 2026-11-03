// Mode membangun: jumlah modul pabrik (kunci dan batas sama dengan engine/app/plant.py) menjadi denah 3D.
import { DEFAULT_LAYOUT } from './default.js';
import { BUILDING, PLACEHOLDER_GAP, PLACEHOLDER_SIZE, SILO_PITCH, SILO_RADIUS, hallGeom, hallWidth, padWidth } from './layout.js';

/** `drawn`: modul tampil di denah 3D; yang lain hanya memengaruhi simulasi. `min`/`max` sama dengan MODULE_LIMITS engine. */
export const PLANT_FIELDS = [
    { key: 'n_bays', label: 'Bay bongkar', drawn: true, def: 3, min: 1, max: 3 },
    { key: 'n_raw_tanks', label: 'Tangki susu mentah', drawn: true, def: 15, min: 1, max: 15 },
    { key: 'n_storage_tanks', label: 'Tangki penyimpanan', drawn: true, def: 6, min: 1, max: 6 },
    { key: 'n_analysts', label: 'Analis lab', drawn: false, def: 2, min: 1, max: 8 },
    { key: 'n_degassing', label: 'Unit degassing', drawn: true, def: 2, min: 1, max: 8 },
    { key: 'n_separators', label: 'Separator', drawn: true, def: 2, min: 1, max: 8 },
    { key: 'n_thermal', label: 'Unit termisasi', drawn: true, def: 2, min: 1, max: 8 },
    { key: 'n_sterilizers', label: 'Sterilizer UHT', drawn: true, def: 5, min: 1, max: 5 },
];

export const DEFAULT_PLANT = Object.fromEntries(PLANT_FIELDS.map((f) => [f.key, f.def]));

/** Lengkapi kunci yang hilang dengan bawaan dan jepit tiap jumlah ke batas jenisnya. */
export function normalizePlant(input) {
    const src = input && typeof input === 'object' ? input : {};
    return Object.fromEntries(PLANT_FIELDS.map((f) => {
        const n = Math.round(Number(src[f.key] ?? f.def));
        return [f.key, Number.isFinite(n) ? Math.min(f.max, Math.max(f.min, n)) : f.def];
    }));
}

/** Hanya kunci yang berbeda dari pabrik bawaan (yang disimpan di run; bawaan tidak disimpan). */
export function plantChanges(plant) {
    const p = normalizePlant(plant);
    return Object.fromEntries(Object.entries(p).filter(([k, v]) => v !== DEFAULT_PLANT[k]));
}

const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

/**
 * Blok proses di dalam bangunan, utara hall: satu baris per jenis modul, urut sesuai alur ke utara (deret ke timur).
 * Dimulai di timur area tunggu supaya dinding bangunan (termasuk node placeholder di baratnya) tidak menimpanya.
 */
const PAD = DEFAULT_LAYOUT.pads[0];
const YARD_ROW0 = DEFAULT_LAYOUT.halls[0].at[1] - 56 - 48;
const YARD = {
    a0: PAD.at[0] + padWidth(PAD.slots) / 2 + 28 + 28 + PLACEHOLDER_GAP + PLACEHOLDER_SIZE[0] + BUILDING.margin,
    rows: [['DEG', YARD_ROW0, 56], ['THM', YARD_ROW0 - 60, 56], ['SEP', YARD_ROW0 - 120, 56], ['STE', YARD_ROW0 - 180, 64], ['LINE', YARD_ROW0 - 240, 38]],
};
export const LINES_PER_STERILIZER = 2;

/** Modul hilir (degassing, termisasi, separator, sterilizer, filling line) dari jumlah modul. */
export function unitsFromPlant(plant) {
    const p = normalizePlant(plant);
    const counts = { DEG: p.n_degassing, THM: p.n_thermal, SEP: p.n_separators, STE: p.n_sterilizers, LINE: p.n_sterilizers * LINES_PER_STERILIZER };
    return YARD.rows.flatMap(([kind, b, pitch]) => range(counts[kind]).map((n) => ({ code: `${kind}-${n}`, at: [YARD.a0 + pitch * (n - 1), b] })));
}

/** Denah dari jumlah modul: tangki satu baris (RAW dulu, lalu STO) di sayap bangunan sebelah timur bay; bay dalam satu hall dengan tepi kiri tetap. */
export function layoutFromPlant(plant) {
    const p = normalizePlant(plant);
    const layout = structuredClone(DEFAULT_LAYOUT);
    const hall = layout.halls[0];
    const left = hallGeom(DEFAULT_LAYOUT.halls[0]).left;
    hall.bays = range(p.n_bays).map((i) => `BAY-${i}`);
    hall.at = [left + hallWidth(p.n_bays) / 2, hall.at[1]];
    const a0 = left + hallWidth(p.n_bays) + 2 + BUILDING.margin + SILO_RADIUS + 4;
    const codes = [...range(p.n_raw_tanks).map((i) => `TK-RAW-${i}`), ...range(p.n_storage_tanks).map((i) => `TK-STO-${i}`)];
    layout.silos = codes.map((code, i) => ({ code, at: [a0 + SILO_PITCH * i, hall.at[1]] }));
    layout.units = unitsFromPlant(p);
    return layout;
}
