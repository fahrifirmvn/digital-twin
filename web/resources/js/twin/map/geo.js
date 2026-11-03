// Geometri Maps: skema jalur truk menuju gerbang (bukan peta geografis) dan turunan murni dari state replay.
import { approachProgress } from '../state.js';

export const MAP = { w: 1000, h: 620 };
export const GATE = { x: 600, y: 320 };
export const GEOFENCE_R = 96;
export const FACTORY = { x: 600, y: 170, w: 340, h: 300 };

// Tiga jalur (indeks = route pada event truck.dispatched) yang menyatu di ruas terakhir menuju gerbang.
export const ROUTES = [
    { name: 'Utara', pts: [[470, 0], [470, 110], [540, 190], [540, 320], [600, 320]] },
    { name: 'Barat', pts: [[0, 380], [190, 380], [290, 320], [540, 320], [600, 320]] },
    { name: 'Selatan', pts: [[470, 620], [470, 530], [540, 450], [540, 320], [600, 320]] },
];

const FARMS = {
    'FRM-01': 'Pasuruan', 'FRM-02': 'Malang', 'FRM-03': 'Probolinggo', 'FRM-04': 'Batu',
    'FRM-05': 'Lumajang', 'FRM-06': 'Jember', 'FRM-07': 'Blitar', 'FRM-08': 'Kediri',
};

export const farmName = (code) => FARMS[code] ?? code;

function measure(pts) {
    let total = 0;
    const segs = pts.slice(1).map(([x1, y1], i) => {
        const [x0, y0] = pts[i];
        const len = Math.hypot(x1 - x0, y1 - y0);
        const seg = { x0, y0, x1, y1, len, at: total };
        total += len;
        return seg;
    });
    return { segs, total };
}

const PATHS = ROUTES.map((r) => measure(r.pts));

export const routeOf = (route) => ROUTES[((route % ROUTES.length) + ROUTES.length) % ROUTES.length];

/** Titik dan arah di jalur: progress 0 = awal jalur, 1 = gerbang. */
export function routePoint(route, progress) {
    const path = PATHS[ROUTES.indexOf(routeOf(route))];
    const d = Math.max(0, Math.min(1, progress)) * path.total;
    const seg = path.segs.find((s) => d <= s.at + s.len) ?? path.segs[path.segs.length - 1];
    const f = seg.len ? (d - seg.at) / seg.len : 1;
    return {
        x: seg.x0 + (seg.x1 - seg.x0) * f,
        y: seg.y0 + (seg.y1 - seg.y0) * f,
        angle: Math.atan2(seg.y1 - seg.y0, seg.x1 - seg.x0),
    };
}

export const inGeofence = (p) => Math.hypot(p.x - GATE.x, p.y - GATE.y) <= GEOFENCE_R;

/** Truk yang sedang menuju gerbang, ETA terdekat dulu. `geometry` menggantikan skema (mis. peta geografis). */
export function inboundList(state, geometry = { routePoint, inGeofence }) {
    return Object.values(state.inbound)
        .map((t) => {
            const progress = approachProgress(t, state.m);
            const pos = geometry.routePoint(t.route, progress);
            return {
                code: t.code, plate: t.plate, farm: t.farm, farmName: farmName(t.farm), route: t.route, routeName: routeOf(t.route).name,
                etaM: t.etaM, minsLeft: Math.max(0, Math.ceil(t.etaM - state.m)), progress, pos, inGeofence: geometry.inGeofence(pos),
            };
        })
        .sort((a, b) => a.etaM - b.etaM || a.code.localeCompare(b.code));
}

/** Truk yang baru melewati gerbang (serah-terima dari Maps ke Twin), terbaru dulu. */
export function recentArrivals(state, windowMin = 10) {
    return Object.values(state.tankers)
        .filter((t) => state.m - t.arrivedAt <= windowMin)
        .sort((a, b) => b.arrivedAt - a.arrivedAt || a.code.localeCompare(b.code))
        .map((t) => ({ code: t.code, plate: t.plate, farm: t.farm, farmName: farmName(t.farm), arrivedAt: t.arrivedAt, ago: Math.max(0, Math.round(state.m - t.arrivedAt)) }));
}

export function mapStats(state, total = 0, geometry) {
    const list = inboundList(state, geometry);
    return {
        inbound: list.length,
        inGeofence: list.filter((t) => t.inGeofence).length,
        nextEtaM: list[0]?.etaM ?? null,
        arrived: state.counters.arrived,
        total,
    };
}
