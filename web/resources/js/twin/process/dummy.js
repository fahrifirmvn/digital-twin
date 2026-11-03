// Data contoh Zona Proses: satu-satunya sumber angka layar ini. Bukan hasil run; menunggu master/SOP final.
export const SAMPLE_CHIP = 'Nilai contoh · menunggu master/SOP';
export const PLANT_NAME = '[Nama Pabrik]';
/** Jam contoh 09:21 (menit sejak 00:00), jam 24. */
export const NOW_MIN = 9 * 60 + 21;
export const TANK_CAP_L = 60000;

const LEVELS = [70, 90, 40, 70, 55, 82, 62, 0, 35, 78, 0, 48, 91, 66, 24];
const AGE_H = [2.4, 5.2, 1.1, 3.0, 0.8, 4.0, 3.2, 0, 1.5, 0.5, 0, 2.0, 4.9, 3.6, 1.2];
const bayOf = (n) => (n <= 5 ? 1 : n <= 9 ? 2 : 3);

const storageTank = (n) => ({
    id: `ST-${String(n).padStart(2, '0')}`,
    kind: 'tank',
    group: 'storage',
    name: 'Storage tank',
    capL: TANK_CAP_L,
    levelL: (LEVELS[n - 1] * TANK_CAP_L) / 100,
    status: 'holding',
    inLph: 0,
    outLph: 0,
    maxInLph: 22000,
    maxOutLph: 22000,
    ageH: AGE_H[n - 1],
    holdMaxH: 6,
    cipMin: 45,
    fromBay: bayOf(n),
    batches: LEVELS[n - 1] > 0 ? [{ label: 'Batch A', pct: 100 }] : [],
});

const OVERRIDES = {
    'ST-05': { status: 'filling', inLph: 12000 },
    'ST-07': { outLph: 18000, batches: [{ label: 'Batch A', pct: 60 }, { label: 'Batch B', pct: 40 }] },
    'ST-08': { status: 'cip', cip: { done: 18, total: 45 } },
    'ST-10': { status: 'filling', inLph: 12000 },
    'ST-11': { status: 'maintenance', maintenanceAt: '14:00' },
};

export const STORAGE_TANKS = Array.from({ length: 15 }, (_, i) => {
    const t = storageTank(i + 1);
    return { ...t, ...OVERRIDES[t.id] };
});

const sumLph = (rows) => rows.reduce((a, r) => a + r.lph, 0);

export const BAYS = [
    { n: 1, active: true, lph: 12000, to: 'ST-05' },
    { n: 2, active: false, lph: 0, to: null },
    { n: 3, active: true, lph: 12000, to: 'ST-10' },
];

const fillerLph = (f) => (f.rate * f.packMl) / 1000;

const filler = (id, rate, packMl, maxRate) => ({
    id, kind: 'filler', name: 'Filling line', unit: 'pack/jam', rate, maxRate, packMl, status: 'running',
    sizeChangeMin: 40, paperChangeMin: 25, variantChangeMin: 30,
});
export const FILLERS = [filler('FL-01', 8000, 1000, 10000), filler('FL-02', 20000, 250, 24000)];

const storageOut = STORAGE_TANKS.reduce((a, t) => a + t.outLph, 0);
const fillersLph = FILLERS.reduce((a, f) => a + fillerLph(f), 0);

export const MACHINES = [
    { id: 'UBAY-01', kind: 'machine', name: 'Unloading bay', unit: 'L/jam', rate: sumLph(BAYS), maxRate: 30000, status: 'running', inLph: sumLph(BAYS), outLph: sumLph(BAYS) },
    { id: 'THM-01', kind: 'machine', name: 'Thermizer', unit: 'L/jam', rate: storageOut, maxRate: 22000, status: 'running', inLph: storageOut, outLph: storageOut },
    { id: 'STE-01', kind: 'machine', name: 'Sterilizer', unit: 'L/jam', rate: 16000, maxRate: 20000, status: 'running', inLph: 16000, outLph: 16000 },
    ...FILLERS.map((f) => ({ ...f, inLph: fillerLph(f), outLph: fillerLph(f) })),
];

export const SFP = {
    id: 'SFP-01', kind: 'tank', group: 'sfp', name: 'SFP storage', capL: TANK_CAP_L, levelL: 0.58 * TANK_CAP_L,
    status: 'holding', inLph: storageOut, outLph: 16000, maxInLph: 22000, maxOutLph: 22000, ageH: 1.8, holdMaxH: 8, cipMin: 45,
    batches: [{ label: 'Batch A', pct: 100 }],
};

export const AT = {
    id: 'AT-01', kind: 'tank', group: 'at', name: 'Aseptic tank', capL: TANK_CAP_L, levelL: 0.44 * TANK_CAP_L,
    status: 'holding', inLph: 16000, outLph: fillersLph, maxInLph: 20000, maxOutLph: 18000, minPct: 20, ageH: 2.1, holdMaxH: 8,
    cipMin: 45, batches: [{ label: 'Batch A', pct: 100 }],
};

export const RECEIVING = { id: 'RCV-01', kind: 'node', name: 'Receiving' };

export const ASSETS = [RECEIVING, ...MACHINES.filter((m) => m.id === 'UBAY-01'), ...STORAGE_TANKS,
    MACHINES.find((m) => m.id === 'THM-01'), SFP, MACHINES.find((m) => m.id === 'STE-01'), AT, ...FILLERS.map((f) => MACHINES.find((m) => m.id === f.id))];

export const SKUS = [
    { name: 'Full Cream 1000 mL', lines: ['FL-01'] },
    { name: 'Full Cream 250 mL', lines: ['FL-02'] },
    { name: 'Low Fat 1000 mL', lines: ['FL-01'] },
    { name: 'Coklat 200 mL', lines: ['FL-02'] },
];

/** Pipa: `from`/`to` = id aset atau 'STORAGE' (rak 15 tangki). `lph` dihitung dari aset agar konsisten. */
export const PIPES = [
    { id: 'rcv-bay', from: 'RCV-01', to: 'UBAY-01', lph: sumLph(BAYS) },
    { id: 'bay-st', from: 'UBAY-01', to: 'STORAGE', lph: sumLph(BAYS) },
    { id: 'st-thm', from: 'STORAGE', to: 'THM-01', lph: storageOut },
    { id: 'thm-sfp', from: 'THM-01', to: 'SFP-01', lph: storageOut },
    { id: 'sfp-ste', from: 'SFP-01', to: 'STE-01', lph: 16000 },
    { id: 'ste-at', from: 'STE-01', to: 'AT-01', lph: 16000 },
    { id: 'at-fl1', from: 'AT-01', to: 'FL-01', lph: fillerLph(FILLERS[0]), label: 'Dedicated pipe' },
    { id: 'at-fl2', from: 'AT-01', to: 'FL-02', lph: fillerLph(FILLERS[1]), label: 'Dedicated pipe' },
];
