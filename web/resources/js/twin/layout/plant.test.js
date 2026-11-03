import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_LAYOUT } from './default.js';
import { buildingParts, validateLayout } from './layout.js';
import { DEFAULT_PLANT, PLANT_FIELDS, layoutFromPlant, normalizePlant, plantChanges } from './plant.js';

test('pabrik bawaan menghasilkan denah bawaan persis', () => {
    assert.deepEqual(layoutFromPlant(DEFAULT_PLANT), DEFAULT_LAYOUT);
    assert.deepEqual(layoutFromPlant(null), DEFAULT_LAYOUT);
});

test('normalizePlant melengkapi, membulatkan, dan menjepit ke batas tiap jenis', () => {
    const p = normalizePlant({ n_bays: 99, n_raw_tanks: 0, n_analysts: '3', n_thermal: 'x' });
    assert.equal(p.n_bays, 3);
    assert.equal(p.n_raw_tanks, 1);
    assert.equal(p.n_analysts, 3);
    assert.equal(p.n_thermal, DEFAULT_PLANT.n_thermal);
    assert.equal(Object.keys(p).length, PLANT_FIELDS.length);
});

test('semua kombinasi ekstrem bay dan tangki menghasilkan denah valid', () => {
    for (const bays of [1, 2, 3]) {
        for (const raw of [1, 2, 15]) {
            for (const sto of [1, 3, 6]) {
                const layout = layoutFromPlant({ n_bays: bays, n_raw_tanks: raw, n_storage_tanks: sto });
                assert.deepEqual(validateLayout(layout), [], `${bays}/${raw}/${sto}`);
                assert.equal(layout.halls[0].bays.length, bays);
                assert.equal(layout.silos.length, raw + sto);
            }
        }
    }
});

test('kode aset mengikuti penamaan engine dan tepi kiri hall tetap', () => {
    const layout = layoutFromPlant({ n_bays: 3, n_raw_tanks: 3, n_storage_tanks: 2 });
    assert.deepEqual(layout.silos.map((s) => s.code), ['TK-RAW-1', 'TK-RAW-2', 'TK-RAW-3', 'TK-STO-1', 'TK-STO-2']);
    assert.deepEqual(layout.halls[0].bays, ['BAY-1', 'BAY-2', 'BAY-3']);
    assert.equal(layout.halls[0].at[0] - (66 * 3 + 42) / 2, 560);
});

test('tangki dan modul proses berada di dalam bangunan untuk semua ukuran pabrik', () => {
    for (const n of [1, 4, 8]) {
        const layout = layoutFromPlant({ n_bays: n, n_raw_tanks: n, n_storage_tanks: n, n_degassing: n, n_thermal: n, n_separators: n, n_sterilizers: n });
        const [wing, block] = buildingParts(layout);
        for (const s of layout.silos) assert.ok(s.at[0] - 27 >= wing.a0 && s.at[0] + 27 <= wing.a1 && s.at[1] - 27 >= wing.b0 && s.at[1] + 27 <= wing.b1, `${n} ${s.code}`);
        for (const u of layout.units) assert.ok(u.at[0] >= block.a0 && u.at[0] <= block.a1 && u.at[1] >= block.b0 && u.at[1] <= block.b1, `${n} ${u.code}`);
    }
});

test('modul hilir mengikuti jumlah dan kode engine (2 filling line per sterilizer)', () => {
    const layout = layoutFromPlant({ n_degassing: 3, n_thermal: 1, n_separators: 4, n_sterilizers: 2 });
    const codes = (kind) => layout.units.filter((u) => u.code.startsWith(`${kind}-`)).map((u) => u.code);
    assert.deepEqual(codes('DEG'), ['DEG-1', 'DEG-2', 'DEG-3']);
    assert.deepEqual(codes('THM'), ['THM-1']);
    assert.equal(codes('SEP').length, 4);
    assert.deepEqual(codes('STE'), ['STE-1', 'STE-2']);
    assert.deepEqual(codes('LINE'), ['LINE-1', 'LINE-2', 'LINE-3', 'LINE-4']);
});

test('semua modul pada jumlah maksimum dan minimum tetap valid dan tidak bertumpuk', () => {
    for (const edge of ['min', 'max']) {
        const all = Object.fromEntries(PLANT_FIELDS.map((f) => [f.key, f[edge]]));
        assert.deepEqual(validateLayout(layoutFromPlant(all)), [], `semua ${edge}`);
    }
});

test('layoutFromPlant tidak mengubah denah bawaan', () => {
    const before = structuredClone(DEFAULT_LAYOUT);
    layoutFromPlant({ n_bays: 2 });
    assert.deepEqual(DEFAULT_LAYOUT, before);
});

test('plantChanges hanya memuat yang berbeda dari bawaan', () => {
    assert.deepEqual(plantChanges(DEFAULT_PLANT), {});
    assert.deepEqual(plantChanges({ n_bays: 2, n_raw_tanks: 15 }), { n_bays: 2 });
});
