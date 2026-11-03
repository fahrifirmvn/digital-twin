import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deltaText, impactRows } from './impact.js';

const base = { truck_wait_min: { mean: 30, p90: 50 }, unscheduled_cip: 0, held_g1: 1, completed: 30, fg_ton: 300, schedule_adherence_pct: 80, makespan_min: 1400 };

test('impactRows: nada mengikuti arah yang baik per KPI', () => {
    const rows = impactRows({ ...base, truck_wait_min: { mean: 42.6, p90: 50 }, completed: 31, makespan_min: 1380 }, base);
    const by = Object.fromEntries(rows.map((r) => [r.label, r]));
    assert.deepEqual([by['Rata-rata tunggu truk'].delta, by['Rata-rata tunggu truk'].tone], [12.6, 'bad']);
    assert.equal(by['Tunggu truk P90'].tone, 'same');
    assert.equal(by['Truk selesai'].tone, 'good');
    assert.equal(by['Selesai hari ini'].tone, 'good');
    assert.equal(rows.length, 8);
});

test('impactRows: tanpa KPI atau KPI sebagian -> baris yang ada saja', () => {
    assert.deepEqual(impactRows(null, base), []);
    assert.deepEqual(impactRows(base, null), []);
    assert.deepEqual(impactRows({ completed: 3 }, { completed: 5 }).map((r) => [r.label, r.delta, r.tone]), [['Truk selesai', -2, 'bad']]);
});

test('deltaText: tanda eksplisit dan koma desimal', () => {
    assert.equal(deltaText(12.5), '+12,5');
    assert.equal(deltaText(-3), '-3');
    assert.equal(deltaText(0), '0');
});
