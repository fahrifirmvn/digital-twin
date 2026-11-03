// Dunia 3D dari model pabrik realistis (public/models/plant.glb): satu bangunan dengan 15 ST, SFP, AT, dan FL dari Blender.
// Mengembalikan bentuk yang sama dengan buildWorld (kit/world.js) sehingga TwinScene3D tidak perlu tahu perbedaannya.
// Konvensi node GLB dan cara membuatnya: web/scripts/export-plant.py.
import * as THREE from 'three';
import { PLANT_SCALE, plantApproach, plantNodeOf } from '../layout/approach.js';
import { bayTaps } from '../layout/pipes.js';
import { createKit } from './ctx.js';
import { createMilk } from './milk.js';
import { makeBuilding, makeGate, makeLab, makePad, makeRoads } from './modules.js';
import { paletteOf } from './palette.js';

const GROUND_Y = -1.2;
const SHOW_MIN = 0.005;
const LAMPS = ['amber', 'green', 'red'];
const LAMP_OF = { in_use: 'green', filling: 'green', cip: 'amber', unavailable: 'red' };
// Unit proses tanpa model 3D memakai titik pipa terdekat agar aliran tetap tergambar.
const UNIT_SPOT = { DEG: 'ANCHOR_FEED_SUPPLY', THM: 'ANCHOR_PROCESS_FLOW', SEP: 'ANCHOR_FLOW_METER' };
const LAMP_RISE = 10;
const WALL_HEIGHT = 65; // 6,5 m: peralatan setinggi 4,7 m
const DOOR_WIDTH = 36;

/** Muat plant.glb dan plant.json; null bila tidak ada atau gagal (pemanggil memakai denah prosedural). */
export async function loadPlant(base = '/models/') {
    try {
        const meta = await fetch(`${base}plant.json`, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null));
        if (!meta?.bounds || !Array.isArray(meta.bays)) return null;
        const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
        const gltf = await new GLTFLoader().loadAsync(`${base}plant.glb`);
        return { scene: gltf.scene, meta };
    } catch (err) {
        console.warn('Model pabrik gagal dimuat:', err?.message ?? err);
        return null;
    }
}

/** Kode aset layout yang ada, per jenis. */
function codesOf(layout) {
    const units = (layout.units ?? []).map((u) => u.code);
    return {
        raw: layout.silos.filter((s) => s.code.startsWith('TK-RAW-')).map((s) => s.code),
        sto: layout.silos.filter((s) => s.code.startsWith('TK-STO-')).map((s) => s.code),
        ste: units.filter((c) => c.startsWith('STE-')),
        line: units.filter((c) => c.startsWith('LINE-')),
        bays: layout.halls.flatMap((h) => h.bays),
    };
}

const topOf = (node) => {
    const box = new THREE.Box3().setFromObject(node);
    return { a: (box.min.x + box.max.x) / 2, b: (box.min.z + box.max.z) / 2, h: box.max.y };
};

export function buildPlantWorld(layout, plant, { theme = 'light', detail = 1 } = {}) {
    const palette = paletteOf(theme);
    const kit = createKit(palette, { detail });
    const root = new THREE.Group();
    const anchors = new Map();
    const assets = new Map();
    const pickables = [];
    const codes = codesOf(layout);
    const approach = plantApproach(plant.meta, codes.bays);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(8000, 8000), kit.unique(palette.ground, 1));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = GROUND_Y;
    ground.receiveShadow = true;
    root.add(ground);
    const [gate] = approach.layout.gates;
    root.add(makeRoads({ ...kit, palette: { ...palette, asphalt: palette.road, curb: palette.roadCurb } }, approach.layout.roads).group, makeGate(kit, gate).group);
    if (approach.apron) {
        const { a0, a1, b0, b1 } = approach.apron;
        kit.rboxAt(root, a1 - a0, 0.8, b1 - b0, palette.road, (a0 + a1) / 2, 0, (b0 + b1) / 2, 0.3, 1);
        for (const b of approach.bayLines) kit.flat(root, a1 - a0 - 6, 2.5, palette.white, (a0 + a1) / 2, 0.95, b);
    }
    for (const p of approach.layout.pads) root.add(makePad(kit, p).group);
    for (const l of approach.layout.labs) {
        root.add(makeLab(kit, l).group);
        anchors.set(`LAB:${l.id}`, { a: l.at[0], b: l.at[1], h: 70 });
    }
    anchors.set('ENTRANCE', { a: approach.entrance.a, b: approach.entrance.b, h: 20 });

    const model = new THREE.Group();
    model.scale.setScalar(PLANT_SCALE);
    model.add(plant.scene.clone(true));
    model.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.receiveShadow = true;
    });
    root.add(model);
    root.updateMatrixWorld(true);

    const named = new Map();
    model.traverse((o) => named.set(o.name, o));
    const wanted = new Set([...codes.raw, ...codes.sto, ...codes.line, ...codes.ste.map((c) => `ASEP-${c.slice(4)}`)].map(plantNodeOf));
    for (const id of [...plant.meta.ST, ...plant.meta.SFP, ...plant.meta.AT, ...plant.meta.FL]) {
        if (!wanted.has(id) && named.get(id)) named.get(id).visible = false;
    }

    // Susu mengalir di dalam pipa model; tanpa data pipa (plant.json lama) aliran jatuh kembali ke garis antar jangkar.
    const milk = plant.meta.pipes?.length ? createMilk({ parent: model, pipes: plant.meta.pipes, taps: bayTaps(plant.meta, codes.bays), nodes: named, kit }) : null;

    const level = (node) => {
        if (!node?.isMesh) return null;
        const full = node.scale.y;
        node.visible = false;
        return (f) => {
            const show = f != null && f > SHOW_MIN;
            node.visible = show;
            if (show) node.scale.y = full * Math.min(1, f);
        };
    };
    const own = (node) => {
        if (!node?.isMesh) return null;
        node.material = kit.own(node.material.clone());
        return node;
    };
    const equipment = (code, pick) => {
        const id = plantNodeOf(code);
        const group = named.get(id);
        if (!group) return;
        const body = named.get(`${id}_body`);
        const ring = own(named.get(`${id}_status`));
        const idle = ring?.material.color.clone();
        const setLevel = level(named.get(`${id}_level`));
        const lamps = LAMPS.map((k) => [k, named.get(`${id}_beacon_${k}`)]).filter(([, n]) => n);
        for (const [, n] of lamps) n.visible = false;
        // Badan multi-material dimuat sebagai Group berisi mesh; raycast pemilih tidak rekursif.
        if (body && pick) {
            body.traverse((o) => {
                if (!o.isMesh) return;
                o.userData = { code, inside: true };
                pickables.push(o);
            });
        }
        anchors.set(code, { ...topOf(group), inside: true });
        assets.set(code, {
            set(color, fill, status) {
                if (ring) ring.material.color.set(color ?? idle);
                setLevel?.(fill);
                for (const [k, n] of lamps) n.visible = LAMP_OF[status] === k;
            },
        });
    };
    for (const c of codes.raw) equipment(c, true);
    for (const c of codes.sto) equipment(c, true);
    for (const c of codes.ste) {
        equipment(`ASEP-${c.slice(4)}`, true);
        const asep = anchors.get(`ASEP-${c.slice(4)}`);
        if (asep) anchors.set(c, asep);
    }
    for (const c of codes.line) equipment(c, true);

    for (const code of codes.bays) {
        const slot = approach.layout.slots.bay.get(code);
        if (slot) anchors.set(code, { a: slot.a, b: slot.b, h: 50 });
    }

    const spot = (name, rise = 0) => {
        const node = named.get(name);
        if (!node) return null;
        const p = node.getWorldPosition(new THREE.Vector3());
        return { a: p.x, b: p.z, h: p.y + rise };
    };
    for (const u of layout.units ?? []) {
        const p = UNIT_SPOT[u.code.split('-')[0]] && spot(UNIT_SPOT[u.code.split('-')[0]], LAMP_RISE);
        if (p) anchors.set(u.code, { ...p, inside: true });
    }
    const out = spot('ANCHOR_PACKAGING_END', LAMP_RISE);
    if (out) {
        anchors.set('PACK-OUT', out);
        anchors.set('QA-HOLD', { ...out, h: out.h + 40 });
    }

    // Bangunan produksi membungkus seluruh pelat pabrik; truk masuk ke bay lewat pintu di dinding barat.
    const hall = approach.plantRect;
    const building = makeBuilding(kit, [hall], {
        height: WALL_HEIGHT,
        doors: plant.meta.bays.map((b) => ({ a: hall.a0, b: b.at[2] * PLANT_SCALE, w: DOOR_WIDTH })),
    });
    root.add(building.group);

    const all = approach.zones.all;
    const bounds = {
        a0: Math.min(...all.map((r) => r.a0)),
        a1: Math.max(...all.map((r) => r.a1)),
        b0: Math.min(...all.map((r) => r.b0)),
        b1: Math.max(...all.map((r) => r.b1)),
    };
    return {
        root, kit, palette, assets, anchors, pickables, milk,
        building,
        bounds,
        footprints: all,
        zones: approach.zones,
        motion: approach.layout,
        dispose: () => kit.dispose(),
    };
}
