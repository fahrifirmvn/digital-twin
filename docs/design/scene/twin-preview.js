// Harness: memuat TwinScene3D produksi dengan state buatan tangan (replika himpunan truk V6).
import { TwinScene3D } from '/web/resources/js/twin/scene3d.js';

const q = new URLSearchParams(location.search);
const t = (code, status, arrivedAt, extra = {}) => [code, { code, status, arrivedAt, bay: null, held: null, ...extra }];
const state = {
    m: 100,
    assets: {
        'TK-RAW-1': { status: 'filling', level: 70 },
        'TK-RAW-2': { status: 'idle', level: 20 },
        'TK-STO-1': { status: 'holding', level: 45 },
        'TK-STO-2': { status: 'in_use', level: 30 },
        'BAY-1': { status: 'in_use' },
        'BAY-3': { status: 'in_use' },
        'BAY-4': { status: 'cip' },
    },
    tankers: Object.fromEntries([
        t('T-107', 'queued', 1), t('T-109', 'queued', 2), t('T-110', 'queued', 3), t('T-111', 'queued', 4), t('T-112', 'queued', 5),
        t('T-105', 'released', 6), t('T-106', 'released', 7), t('T-108', 'released', 8),
        t('T-101', 'unloading', 0, { bay: 'BAY-1' }), t('T-103', 'unloading', 0, { bay: 'BAY-3' }),
        t('T-104', 'lab_test', 9),
    ]),
    flows: [{ from: 'RT-1', to: 'TK-RAW-1', m: 95 }, { from: 'BAY-1', to: 'TK-RAW-1', m: 92 }],
};

const scene = new TwinScene3D(document.getElementById('c'), { theme: q.get('theme') || 'light' });
window.__scene = scene;
if (q.has('anim')) {
    // Awali dari dunia kosong; truk datang lalu menyetir ke slot (state.m dekat, tanpa snap).
    scene.draw({ ...state, m: 0, tankers: {}, flows: [] }, 60);
    window.__go = () => scene.draw({ ...state, m: 10 }, 60);
} else {
    scene.draw(state, 60);
}
document.title = 'ready';
