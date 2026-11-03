import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assetVisual } from './scene3d-model.js';

test('warna dan tinggi cairan mengikuti status serta kapasitas tangki', () => {
    assert.equal(assetVisual('STE-1', undefined).status, 'idle');
    assert.equal(assetVisual('STE-1', { status: 'cip', level: null }).color, '#f59e0b');
    assert.equal(assetVisual('STE-1', { status: 'cip', level: null }).fill, null);
    assert.equal(assetVisual('TK-RAW-1', { status: 'filling', level: 15 }).fill, 0.5);
    assert.equal(assetVisual('TK-STO-1', { status: 'filling', level: 999 }).fill, 1);
    assert.equal(assetVisual('TK-RAW-1', { status: 'idle', level: -3 }).fill, 0);
});
