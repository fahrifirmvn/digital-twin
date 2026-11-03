// Koordinat skema 2D Zona Proses (viewBox 1440x960, bentuk ular).
export const VIEW = { w: 1440, h: 960 };

export const SILO = { w: 56, h: 72 };
export const SILO_BIG = { w: 72, h: 92 };
export const BADGE_H = 20;
export const MACHINE = { w: 150, h: 96 };

export const FRAME = { x: 496, y: 140, w: 472, h: 380 };
const GRID = { x0: 536, y0: 156, px: 84, py: 120, cols: 5 };

/** ST-01..ST-15 diurut per baris, 5 kolom x 3 baris. */
export function tankCell(index) {
    return { x: GRID.x0 + (index % GRID.cols) * GRID.px, y: GRID.y0 + Math.floor(index / GRID.cols) * GRID.py, ...SILO };
}

/** Kotak aset (untuk pipa dan uji tata letak). Tangki besar memakai silo + lencana di bawahnya. */
export const NODES = {
    'RCV-01': { x: 24, y: 282, w: 120, h: 96, label: 'RECEIVING', icon: 'truck' },
    'UBAY-01': { x: 240, y: 282, ...MACHINE, label: 'UNLOADING BAY', icon: 'truck' },
    STORAGE: { ...FRAME, label: 'STORAGE TANK' },
    'THM-01': { x: 1070, y: 282, ...MACHINE, label: 'THERMIZER', icon: 'flask' },
    'SFP-01': { x: 1109, y: 654, ...SILO_BIG, label: 'SFP STORAGE', big: true },
    'STE-01': { x: 680, y: 652, ...MACHINE, label: 'STERILIZER', icon: 'flask' },
    'AT-01': { x: 392, y: 654, ...SILO_BIG, label: 'ASEPTIC TANK (AT-01)', big: true },
    'FL-01': { x: 24, y: 592, ...MACHINE, label: 'FL-01', icon: 'droplets' },
    'FL-02': { x: 24, y: 782, ...MACHINE, label: 'FL-02', icon: 'droplets' },
};

/** Jalur pipa (titik berurutan) + posisi chip laju dan label pipa. */
export const PIPE_PATHS = {
    'rcv-bay': { pts: [[144, 330], [240, 330]], chip: [192, 330] },
    'bay-st': { pts: [[390, 330], [496, 330]], chip: [443, 330] },
    'st-thm': { pts: [[968, 330], [1070, 330]], chip: [1019, 330] },
    'thm-sfp': { pts: [[1145, 378], [1145, 654]], chip: [1145, 520] },
    'sfp-ste': { pts: [[1109, 700], [830, 700]], chip: [970, 700] },
    'ste-at': { pts: [[680, 700], [464, 700]], chip: [572, 700] },
    'at-fl1': { pts: [[392, 700], [300, 700], [300, 640], [174, 640]], chip: [300, 670], label: [237, 640] },
    'at-fl2': { pts: [[392, 700], [300, 700], [300, 830], [174, 830]], chip: [300, 765], label: [237, 830] },
};
