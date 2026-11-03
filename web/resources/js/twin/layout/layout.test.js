import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_LAYOUT } from './default.js';
import { buildingParts, buildingWalls, curbRects, dashSegments, hallGeom, layoutBounds, roadRect, subtractIntervals, validateLayout } from './layout.js';

const clone = () => structuredClone(DEFAULT_LAYOUT);

test('denah bawaan valid', () => {
    assert.deepEqual(validateLayout(DEFAULT_LAYOUT), []);
});

test('hall 3 bay sama dengan V6: pintu 614/680/746 dan apron 483..818', () => {
    const g = hallGeom({ id: 'H', at: [680, 254], bays: ['BAY-1', 'BAY-2', 'BAY-3'] });
    assert.equal(g.W, 240);
    assert.deepEqual(g.doors.map((d) => d.a), [614, 680, 746]);
    assert.equal(g.zf, 308);
    assert.equal(g.apron.a0, 483);
    assert.equal(g.apron.a1, 818);
});

test('hall 3 bay bawaan menjaga tepi kiri di a=560', () => {
    const g = hallGeom(DEFAULT_LAYOUT.halls[0]);
    assert.equal(g.left, 560);
    assert.equal(g.doors.length, 3);
});

test('trotoar mengikuti V6: dipotong di persimpangan dan bukaan apron', () => {
    const curbs = curbRects(DEFAULT_LAYOUT.roads);
    const east = curbs.filter((c) => c.a0 === 483 && c.a1 === 489).map((c) => [c.b0, c.b1]).sort((x, y) => x[0] - y[0]);
    assert.deepEqual(east, [[-28, 34], [124, 308], [410, 640]]);
    const west = curbs.filter((c) => c.a0 === 421 && c.a1 === 427);
    assert.deepEqual(west.map((c) => [c.b0, c.b1]), [[34, 640]]);
});

test('trotoar tidak menembus aspal jalan lain', () => {
    const rects = DEFAULT_LAYOUT.roads.map(roadRect);
    for (const c of curbRects(DEFAULT_LAYOUT.roads)) {
        for (const R of rects) {
            const inside = c.a0 < R.a1 - 0.01 && c.a1 > R.a0 + 0.01 && c.b0 < R.b1 - 0.01 && c.b1 > R.b0 + 0.01;
            // Trotoar milik jalan itu sendiri menempel di tepi, bukan menembus.
            assert.equal(inside, false, JSON.stringify([c, R]));
        }
    }
});

test('marka jalan dimulai 12 dari ujung dan tidak melewati persimpangan', () => {
    const dashes = dashSegments(DEFAULT_LAYOUT.roads);
    const main = dashes.filter((d) => d.axis === 'a');
    assert.equal(main[0].a, -308 + 6);
    assert.ok(main.every((d) => d.a + 6 <= 427));
    const spur = dashes.filter((d) => d.axis === 'b');
    assert.equal(spur[0].b, 40 + 6);
});

test('subtractIntervals memotong dan menyisakan bagian', () => {
    assert.deepEqual(subtractIntervals([0, 100], [[20, 30], [60, 70]]), [[0, 20], [30, 60], [70, 100]]);
    assert.deepEqual(subtractIntervals([0, 10], [[-5, 20]]), []);
});

test('batas dunia mencakup semua modul', () => {
    const b = layoutBounds(DEFAULT_LAYOUT);
    assert.ok(b.a0 <= -320 && b.a1 >= 1296 && b.b0 <= -135 && b.b1 >= 698);
});

test('validasi menolak denah salah', () => {
    const noGate = clone();
    noGate.gates[0].at = [400, 100];
    assert.match(validateLayout(noGate).join(), /Gerbang/);

    const dup = clone();
    dup.silos[1].code = 'TK-RAW-1';
    assert.match(validateLayout(dup).join(), /Kode ganda/);

    const tooMany = clone();
    tooMany.halls[0].bays = Array.from({ length: 9 }, (_, i) => `BAY-${i + 1}`);
    assert.match(validateLayout(tooMany).join(), /Jumlah bay/);

    const overlap = clone();
    overlap.silos[0].at = [680, 254];
    assert.match(validateLayout(overlap).join(), /bertumpukan/);

    const diagonal = clone();
    diagonal.roads[0].to = [483, 50];
    assert.match(validateLayout(diagonal).join(), /sejajar sumbu/);

    assert.deepEqual(validateLayout({ version: 2 }), ['Versi denah harus 1.']);

    const badUnit = clone();
    badUnit.units[0].code = 'XYZ-1';
    assert.match(validateLayout(badUnit).join(), /Kode unit tidak dikenal/);

    const unitOnRoad = clone();
    unitOnRoad.units[0].at = [-100, 0];
    assert.match(validateLayout(unitOnRoad).join(), /bertumpukan dengan jalan/);

    const noSep = clone();
    noSep.units = noSep.units.filter((u) => !u.code.startsWith('SEP'));
    assert.deepEqual(validateLayout(noSep), []);
});

test('denah tanpa units (data lama) tetap valid', () => {
    const old = clone();
    delete old.units;
    assert.deepEqual(validateLayout(old), []);
});

test('bangunan tunggal: sayap (bay + tangki) dan blok proses menyatu, tidak menimpa jalan, area tunggu, lab, atau apron', () => {
    const [wing, block] = buildingParts(DEFAULT_LAYOUT);
    const g = hallGeom(DEFAULT_LAYOUT.halls[0]);
    assert.equal(wing.b1, g.zf);
    assert.ok(wing.a0 < g.left && wing.a1 > Math.max(...DEFAULT_LAYOUT.silos.map((s) => s.at[0])));
    assert.equal(block.b1, wing.b0);
    for (const u of DEFAULT_LAYOUT.units) assert.ok(u.at[0] > block.a0 && u.at[0] < block.a1 && u.at[1] > block.b0 && u.at[1] < block.b1, u.code);
    for (const s of DEFAULT_LAYOUT.silos) assert.ok(s.at[0] > wing.a0 && s.at[0] < wing.a1 && s.at[1] > wing.b0 && s.at[1] < wing.b1, s.code);
    assert.deepEqual(buildingParts({ ...clone(), halls: [] }), []);
});

test('dinding bangunan hanya di sisi luar: tidak ada dinding di sambungan sayap dan blok', () => {
    const parts = buildingParts(DEFAULT_LAYOUT);
    const walls = buildingWalls(parts);
    const [wing, block] = parts;
    const joint = walls.filter((w) => w.b0 >= wing.b0 && w.b1 <= wing.b0 + 3 && w.a0 >= block.a0 && w.a1 <= block.a1);
    assert.deepEqual(joint, []);
    assert.ok(walls.some((w) => w.a0 === wing.a0 && w.a1 === block.a0), 'dinding utara sayap di sisi barat takik');
    assert.equal(buildingWalls([{ a0: 0, a1: 10, b0: 0, b1: 10 }]).length, 4);
});

test('validasi menolak bangunan yang menimpa area tunggu', () => {
    const bad = clone();
    bad.pads[0].slots = 6;
    assert.match(validateLayout(bad).join(), /Bangunan produksi bertumpukan dengan WP1/);
});
