import assert from 'node:assert/strict';
import { test } from 'node:test';
import { drivePath } from '../sim/routes.js';
import { placeTrucks, truckSlots } from '../sim/intent.js';
import { roadRect } from './layout.js';
import { PLANT_SCALE, plantApproach, plantNodeOf } from './approach.js';

const meta = {
    bounds: { min: [-35.7, -0.1, -39.9], max: [35.7, 4.7, 39.9] },
    bays: [-20.185, -16.385, -12.585].map((z, i) => ({ id: `T-${i + 1}`, at: [-28.6275, 0, z], dir: [-1, -0], length: 7.045, width: 1.51 })),
};
const codes = ['BAY-1', 'BAY-2', 'BAY-3'];

test('kode aset dipetakan ke node model', () => {
    assert.equal(plantNodeOf('TK-RAW-1'), 'ST-01');
    assert.equal(plantNodeOf('TK-RAW-15'), 'ST-15');
    assert.equal(plantNodeOf('TK-STO-6'), 'SFP-06');
    assert.equal(plantNodeOf('ASEP-5'), 'AT-05');
    assert.equal(plantNodeOf('LINE-1'), 'FL-1A');
    assert.equal(plantNodeOf('LINE-2'), 'FL-1B');
    assert.equal(plantNodeOf('LINE-9'), 'FL-5A');
    assert.equal(plantNodeOf('LINE-10'), 'FL-5B');
    assert.equal(plantNodeOf('STE-1'), null);
    assert.equal(plantNodeOf('BAY-1'), null);
});

test('slot bay mengikuti posisi truk di model dengan kabin ke barat', () => {
    const { layout } = plantApproach(meta, codes);
    const slot = truckSlots(layout).bay.get('BAY-2');
    assert.ok(Math.abs(slot.a + 28.6275 * PLANT_SCALE) < 1e-9);
    assert.ok(Math.abs(slot.b + 16.385 * PLANT_SCALE) < 1e-9);
    assert.ok(Math.abs(Math.abs(slot.facing) - Math.PI) < 1e-9);
});

test('jumlah bay mengikuti kode yang diminta', () => {
    assert.equal(truckSlots(plantApproach(meta, ['BAY-1']).layout).bay.size, 1);
});

test('truk bongkar diarahkan ke bay lewat jalan barat dan berakhir mundur ke slot', () => {
    const { layout, entrance } = plantApproach(meta, codes);
    const state = { tankers: { 'RT-1': { code: 'RT-1', status: 'unloading', bay: 'BAY-3' } } };
    const [truck] = placeTrucks(state, layout).trucks;
    const path = drivePath(layout, entrance, truck);
    const last = path.at(-1);
    assert.ok(Math.abs(last.a - truck.a) < 1e-9 && Math.abs(last.b - truck.b) < 1e-9);
    assert.ok(Math.abs(Math.abs(last.h) - Math.PI) < 1e-9);
    assert.ok(path.some((p) => Math.abs(p.a + 420) < 1e-9 && Math.abs(p.b - truck.b) < 1e-9));
});

test('zona mencakup pabrik dan akses', () => {
    const { zones, plantRect } = plantApproach(meta, codes);
    assert.deepEqual(zones.process, [plantRect]);
    assert.ok(zones.all.length > zones.process.length);
});

const onAsphalt = (roads, p) => roads.map(roadRect).some((r) => p.a >= r.a0 - 1e-6 && p.a <= r.a1 + 1e-6 && p.b >= r.b0 - 1e-6 && p.b <= r.b1 + 1e-6);

test('tikungan R1-R2 penuh: R2 mulai di tepi luar R1', () => {
    const [r1, r2] = plantApproach(meta, codes).layout.roads.map(roadRect);
    assert.ok(r2.b0 <= r1.b0);
    assert.ok(r1.a1 >= r2.a0 && r1.a1 <= r2.a1);
});

test('slot lab dan pad berada di jalan servis dan rutenya tidak keluar dari aspal', () => {
    const { layout, entrance } = plantApproach(meta, codes);
    const slots = truckSlots(layout);
    for (const slot of [...slots.lab, ...slots.pad]) {
        for (const p of drivePath(layout, entrance, slot)) {
            if (p.h !== undefined && p.b === slot.b && p.a === slot.a) continue;
            assert.ok(onAsphalt(layout.roads, p), `titik ${p.a},${p.b} di luar aspal`);
        }
    }
});

test('apron bay menghubungkan jalan barat ke pelat pabrik dan membagi tiga bay', () => {
    const { apron, bayLines, plantRect } = plantApproach(meta, codes);
    assert.equal(apron.a1, plantRect.a0);
    assert.equal(bayLines.length, 4);
    assert.equal(plantApproach(meta, []).apron, null);
});
