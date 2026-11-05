import test from 'node:test';
import assert from 'node:assert/strict';
import { assetAlias, assetDualLabel, clock, clockOfDay, fmtL, runMinuteOf, toLiters } from './format.js';

test('hari operasi 06:00-06:00: clockOfDay dan runMinuteOf bolak-balik', () => {
    assert.equal(clockOfDay(0), '06:00');
    assert.equal(clockOfDay(1100), '00:20');
    assert.equal(runMinuteOf(500, 14, 20), 500); // 14:20 pada hari yang sama dengan menit 500
    assert.equal(runMinuteOf(1100, 0, 20), 1100); // setelah tengah malam (H+1)
    assert.equal(clock(runMinuteOf(1100, 0, 20)), '00:20 WIB');
});

test('fmtL: ton dikonversi ke liter dengan massa jenis 1,0 kg/L (1 t = 1.000 L)', () => {
    assert.equal(toLiters(1), 1000);
    assert.equal(fmtL(15), '15.000 L');
    assert.equal(fmtL(0), '0 L');
});

test('assetAlias dan assetDualLabel memetakan kode aset internal ke standar brief', () => {
    assert.equal(assetAlias('TK-RAW-1'), 'ST-01');
    assert.equal(assetAlias('TK-RAW-15'), 'ST-15');
    assert.equal(assetAlias('TK-STO-3'), 'SFP-03');
    assert.equal(assetAlias('BAY-2'), 'UB-02');
    assert.equal(assetAlias('ASEP-1'), 'AT-01');
    assert.equal(assetAlias('LINE-4'), 'FL-04');
    assert.equal(assetAlias('DEG-1'), null);
    assert.equal(assetDualLabel('TK-RAW-1'), 'ST-01 (TK-RAW-1)');
    assert.equal(assetDualLabel('DEG-1'), 'DEG-1');
});

