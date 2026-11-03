import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_PLANT, layoutFromPlant, unitsFromPlant } from './plant.js';
import { UNIT_SIZE, buildingParts, unitKind } from './layout.js';
import { PIPE, PLACEHOLDERS, feedPipes, pipeRoute, pipesFromUnits, placeholdersFromUnits, zoneRects } from './zones.js';

const units = unitsFromPlant(DEFAULT_PLANT);
const inside = (r, area) => r.a0 >= area.a0 && r.a1 <= area.a1 && r.b0 >= area.b0 && r.b1 <= area.b1;
const hull = (rects) => ({ a0: Math.min(...rects.map((r) => r.a0)), a1: Math.max(...rects.map((r) => r.a1)), b0: Math.min(...rects.map((r) => r.b0)), b1: Math.max(...rects.map((r) => r.b1)) });
const overlap = (x, y) => x.a0 < y.a1 && x.a1 > y.a0 && x.b0 < y.b1 && x.b1 > y.b0;

test('pipeRoute: tiga ruas, ujung pada tepi modul, tebal sesuai pipa', () => {
    const [v1, h, v2] = pipeRoute([0, -70, 44], [56, -130, 44], 0);
    assert.equal(v1.b0, -100);
    assert.equal(v1.b1, -92);
    assert.equal(v2.b0, -108);
    assert.equal(v2.b1, -100);
    assert.equal(h.a0, -PIPE.w / 2);
    assert.equal(h.a1, 56 + PIPE.w / 2);
    assert.equal(pipeRoute([5, -70, 44], [5, -130, 44]).length, 2);
});

test('pipa: setiap modul hilir menerima sumber dan tidak ada pipa di dalam modul', () => {
    const pipes = pipesFromUnits(units);
    assert.ok(pipes.length >= units.length);
    const rects = units.map((u) => {
        const [w, d] = UNIT_SIZE[unitKind(u.code)];
        return { a0: u.at[0] - w / 2, a1: u.at[0] + w / 2, b0: u.at[1] - d / 2, b1: u.at[1] + d / 2 };
    });
    for (const p of pipes) assert.ok(rects.every((r) => !overlap(p, r)), JSON.stringify(p));
    assert.deepEqual(pipesFromUnits([]), []);
});

test('pipa: jumlah modul tidak seimbang tetap tersambung tanpa error', () => {
    const odd = unitsFromPlant({ ...DEFAULT_PLANT, n_degassing: 1, n_thermal: 3, n_separators: 2, n_sterilizers: 2 });
    assert.ok(pipesFromUnits(odd).every((r) => r.a1 > r.a0 && r.b1 > r.b0));
});

test('placeholder: tiga node di barat zona, sejajar baris terdekat, tidak menimpa modul', () => {
    const ph = placeholdersFromUnits(units);
    assert.deepEqual(ph.map((p) => p.id), PLACEHOLDERS.map((p) => p.id));
    const west = Math.min(...units.map((u) => u.at[0] - UNIT_SIZE[unitKind(u.code)][0] / 2));
    for (const p of ph) assert.ok(p.rect.a1 < west);
    assert.deepEqual(placeholdersFromUnits([]), []);
});

test('zona: Proses = seluruh bangunan, Penerimaan tanpa modul dalam bangunan, Semua memuat semuanya', () => {
    const layout = layoutFromPlant(DEFAULT_PLANT);
    const z = zoneRects(layout);
    assert.deepEqual(z.process, buildingParts(layout));
    const proc = hull(z.process);
    for (const u of units) assert.ok(inside({ a0: u.at[0], a1: u.at[0], b0: u.at[1], b1: u.at[1] }, proc));
    for (const s of layout.silos) assert.ok(inside({ a0: s.at[0], a1: s.at[0], b0: s.at[1], b1: s.at[1] }, proc));
    assert.ok(z.intake.length > 0 && z.intake.length < z.all.length);
    assert.ok(z.intake.every((r) => !units.some((u) => u.at[0] > r.a0 && u.at[0] < r.a1 && u.at[1] > r.b0 && u.at[1] < r.b1)));
    for (const r of z.process) assert.ok(z.all.includes(r));
});

test('pipa masuk: bay -> tangki -> degassing, seluruhnya di dalam bangunan dan tidak menembus tangki atau modul', () => {
    const layout = layoutFromPlant(DEFAULT_PLANT);
    const pipes = feedPipes(layout);
    const parts = buildingParts(layout);
    assert.ok(pipes.length > layout.silos.length);
    for (const p of pipes) {
        assert.ok(p.a1 > p.a0 && p.b1 > p.b0, JSON.stringify(p));
        assert.ok(inside(p, hull(parts)), JSON.stringify(p));
    }
    const solids = [
        ...layout.units.map((u) => { const [w, d] = UNIT_SIZE[unitKind(u.code)]; return { a0: u.at[0] - w / 2, a1: u.at[0] + w / 2, b0: u.at[1] - d / 2, b1: u.at[1] + d / 2 }; }),
        ...layout.silos.map((s) => ({ a0: s.at[0] - 22, a1: s.at[0] + 22, b0: s.at[1] - 22, b1: s.at[1] + 22 })),
    ];
    for (const p of pipes) assert.ok(solids.every((r) => !overlap(p, r)), JSON.stringify(p));
    assert.deepEqual(feedPipes({ ...layout, halls: [] }), []);
    assert.ok(feedPipes({ ...layout, units: [] }).length > 0);
});
