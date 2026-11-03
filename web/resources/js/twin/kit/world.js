// Merakit dunia 3D dari denah: modul, jalan, jangkar posisi dan pegangan aset untuk gaya status.
import * as THREE from 'three';
import { buildingParts, layoutBounds, UNIT_SIZE, unitKind } from '../layout/layout.js';
import { PIPE, feedPipes, pipesFromUnits, placeholdersFromUnits, zoneRects } from '../layout/zones.js';
import { createKit } from './ctx.js';
import { mergeStatic } from './merge.js';
import { ASEP_GAUGE, makeBuilding, makeDecor, makeGate, makeHall, makeLab, makePad, makePlaceholder, makeRoads, makeSilo, makeUnit } from './modules.js';
import { paletteOf } from './palette.js';

const SILO_BASE = 1.6;
const SILO_TOP = 111;
const BAY_ANCHOR_HEIGHT = 50;
const FILL_HEIGHT = 74;

function ground(kit) {
    const C = kit.palette;
    const tex = kit.canvasTex(`ground|${C.name}`, 256, 256, (g, w, h) => {
        g.fillStyle = C.ground;
        g.fillRect(0, 0, w, h);
        g.fillStyle = C.seam;
        g.fillRect(0, 0, w, 3);
        g.fillRect(0, 0, 3, h);
    });
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    tex.repeat.set(6400 / 64, 6400 / 64);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(6400, 6400), kit.unique(0xffffff, 1));
    m.material.map = tex;
    m.rotation.x = -Math.PI / 2;
    m.receiveShadow = true;
    return m;
}

export function buildWorld(layout, { theme = 'light', detail = 1 } = {}) {
    const zones = zoneRects(layout);
    const palette = paletteOf(theme);
    const kit = createKit(palette, { detail });
    const root = new THREE.Group();
    const anchors = new Map();
    const assets = new Map();
    const pickables = [];

    root.add(ground(kit), makeRoads(kit, layout.roads).group);
    const parts = buildingParts(layout);
    for (const p of parts) kit.rboxAt(root, p.a1 - p.a0, 1, p.b1 - p.b0, palette.concrete, (p.a0 + p.a1) / 2, 0, (p.b0 + p.b1) / 2, 0.4, 1);

    const rows = new Map();
    for (const s of layout.silos) rows.set(s.at[1], [...(rows.get(s.at[1]) ?? []), s]);
    for (const [b, row] of rows) {
        const a0 = Math.min(...row.map((s) => s.at[0])) - 27;
        const a1 = Math.max(...row.map((s) => s.at[0])) + 27;
        kit.rboxAt(root, a1 - a0, 1.6, 54, palette.concrete, (a0 + a1) / 2, 0, b, 0.8, 1);
    }
    for (const s of layout.silos) {
        const silo = makeSilo(kit);
        silo.group.position.set(s.at[0], SILO_BASE, s.at[1]);
        root.add(silo.group);
        kit.contact(root, s.at[0] + 6, s.at[1] - 4, 54, 54);
        for (const m of silo.picks) {
            m.userData = { code: s.code, inside: true };
            pickables.push(m);
        }
        anchors.set(s.code, { a: s.at[0], b: s.at[1], h: SILO_TOP, inside: true });
        assets.set(s.code, {
            set(color, fill) {
                silo.collar.material.color.set(color ?? palette.paleBlue);
                if (!silo.fill) {
                    silo.setLevel?.(fill);
                    return;
                }
                const show = fill != null && fill > 0.005;
                silo.pivot.visible = show;
                if (show) {
                    const h = FILL_HEIGHT * Math.min(1, fill);
                    silo.fill.scale.y = h;
                    silo.fill.position.y = h / 2;
                    silo.fill.material.color.set(palette.roofLine);
                }
            },
        });
    }

    for (const hall of layout.halls) {
        const built = makeHall(kit, hall);
        root.add(built.group);
        for (const [code, bay] of built.bays) {
            anchors.set(code, { a: bay.a, b: built.geom.zf, h: BAY_ANCHOR_HEIGHT });
            bay.door.userData = { code };
            pickables.push(bay.door);
            assets.set(code, { set: (color) => bay.ring.material.color.set(color ?? palette.rail) });
        }
    }
    const units = layout.units ?? [];
    const unitRows = new Map();
    for (const u of units) unitRows.set(u.at[1], [...(unitRows.get(u.at[1]) ?? []), u]);
    for (const [b, row] of unitRows) {
        const a0 = Math.min(...row.map((u) => u.at[0] - UNIT_SIZE[unitKind(u.code)][0] / 2));
        const a1 = Math.max(...row.map((u) => u.at[0] + UNIT_SIZE[unitKind(u.code)][0] / 2));
        kit.rboxAt(root, a1 - a0, 1.6, Math.max(...row.map((u) => UNIT_SIZE[unitKind(u.code)][1])), palette.concrete, (a0 + a1) / 2, 0, b, 0.8, 1);
    }
    for (const u of units) {
        const kind = unitKind(u.code);
        const unit = makeUnit(kit, kind);
        unit.group.position.set(u.at[0], 1.6, u.at[1]);
        root.add(unit.group);
        for (const m of unit.picks) {
            m.userData = { code: u.code, inside: true };
            pickables.push(m);
        }
        anchors.set(u.code, { a: u.at[0], b: u.at[1], h: unit.h, inside: true });
        if (unit.asep) {
            const code = `ASEP-${u.code.split('-')[1]}`;
            const { body, gauge } = unit.asep;
            anchors.set(code, { a: u.at[0] + unit.asep.dx, b: u.at[1], h: unit.asep.h, inside: true });
            body.userData = { code, inside: true };
            pickables.push(body);
            assets.set(code, {
                set(color, fill) {
                    body.material.color.set(color ?? palette.white);
                    if (!gauge) {
                        unit.asep.setLevel?.(fill);
                        return;
                    }
                    const show = fill != null && fill > 0.005;
                    gauge.pivot.visible = show;
                    if (show) {
                        const h = ASEP_GAUGE * Math.min(1, fill);
                        gauge.fill.scale.y = h;
                        gauge.fill.position.y = h / 2;
                        gauge.fill.material.color.set(palette.roofLine);
                    }
                },
            });
        }
        assets.set(u.code, { set: (color) => unit.band.material.color.set(color ?? palette.paleBlue) });
    }

    // Pipa antar tahap dan node tahap yang belum dimodelkan (zona Proses); hiasan statis, tidak dapat dipilih.
    for (const r of [...feedPipes(layout), ...pipesFromUnits(units)]) {
        kit.rboxAt(root, r.a1 - r.a0, PIPE.h, r.b1 - r.b0, palette.roofLine, (r.a0 + r.a1) / 2, PIPE.y, (r.b0 + r.b1) / 2, 0.8);
    }
    for (const ph of placeholdersFromUnits(units)) root.add(makePlaceholder(kit, ph).group);
    const building = makeBuilding(kit, parts);
    root.add(building.group);

    const [gate] = layout.gates;
    root.add(makeGate(kit, gate).group);
    for (const p of layout.pads) root.add(makePad(kit, p).group);
    for (const l of layout.labs) {
        root.add(makeLab(kit, l).group);
        anchors.set(`LAB:${l.id}`, { a: l.at[0], b: l.at[1], h: 70 });
    }
    for (const d of layout.decor ?? []) root.add(makeDecor(kit, d).group);

    const first = layout.roads[0];
    anchors.set('ENTRANCE', { a: first.from[0], b: first.from[1], h: 20 });

    root.traverse((o) => { if (o.isMesh && o.material?.map) o.material.map.anisotropy = 8; });
    for (const g of mergeStatic(root, kit.staticMaterials())) kit.ownGeometry(g);
    return {
        root, kit, palette, assets, anchors, pickables, building,
        bounds: layoutBounds(layout),
        footprints: zones.all,
        zones,
        dispose: () => kit.dispose(),
    };
}
