import assert from 'node:assert/strict';
import test from 'node:test';
import { dayProgress } from './format.js';

test('progres hari berasal dari menit Engine dengan batas 24 jam', () => {
    assert.deepEqual(dayProgress(0), { percent: 0, elapsed: '0j 00m berlalu', overtime: false });
    assert.deepEqual(dayProgress(103.9), { percent: 7, elapsed: '1j 43m berlalu', overtime: false });
    assert.deepEqual(dayProgress(720), { percent: 50, elapsed: '12j 00m berlalu', overtime: false });
    assert.deepEqual(dayProgress(1440), { percent: 100, elapsed: '24j 00m berlalu', overtime: false });
    assert.deepEqual(dayProgress(1501), { percent: 100, elapsed: '25j 01m berlalu', overtime: true });
});
