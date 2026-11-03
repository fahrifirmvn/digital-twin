import test from 'node:test';
import assert from 'node:assert/strict';
import { clock, clockOfDay, fmtL, runMinuteOf, toLiters } from './format.js';

test('hari operasi 06:00-06:00: clockOfDay dan runMinuteOf bolak-balik', () => {
    assert.equal(clockOfDay(0), '06:00');
    assert.equal(clockOfDay(1100), '00:20');
    assert.equal(runMinuteOf(500, 14, 20), 500); // 14:20 pada hari yang sama dengan menit 500
    assert.equal(runMinuteOf(1100, 0, 20), 1100); // setelah tengah malam (H+1)
    assert.equal(clock(runMinuteOf(1100, 0, 20)), 'H+1 00:20');
});

test('fmtL: ton dikonversi ke liter dengan massa jenis 1,03 (1 t = 970,87 L)', () => {
    assert.equal(toLiters(1), 971);
    assert.equal(fmtL(15), '14.563 L');
    assert.equal(fmtL(0), '0 L');
});
