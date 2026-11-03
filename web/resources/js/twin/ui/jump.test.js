import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildModel } from '../state.js';
import { nextNotable, notableLabel } from './jump.js';

const ev = (seq, min, p) => ({ seq, t: new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString(), p });
const model = buildModel([
    ev(0, 0, { type: 'sim.clock' }),
    ev(1, 10, { type: 'tanker.status_changed' }),
    ev(2, 20, { type: 'truck.arrived', tanker_code: 'RT-001' }),
    ev(3, 30, { type: 'gate.decided', decision: 'pass', gate: 'G1', object_id: 'RT-001' }),
    ev(4, 40, { type: 'gate.decided', decision: 'hold', gate: 'G1', object_id: 'RT-002' }),
    ev(5, 50, { type: 'asset.status_changed', status: 'idle', asset_code: 'STE-1' }),
    ev(6, 60, { type: 'asset.status_changed', status: 'unavailable', asset_code: 'STE-1' }),
    ev(7, 70, { type: 'cip.started', is_scheduled: true, asset_code: 'STE-2' }),
    ev(8, 80, { type: 'cip.started', is_scheduled: false, asset_code: 'STE-3' }),
    ev(9, 90, { type: 'schedule.replanned', version: 2 }),
    ev(10, 100, { type: 'command.applied', kind: 'truck_surge', count: 4 }),
]);

test('nextNotable melewati event biasa dan yang tidak penting', () => {
    assert.deepEqual(nextNotable(model, 0), { m: 20, label: 'RT-001 tiba' });
    assert.deepEqual(nextNotable(model, 20), { m: 40, label: 'G1 tahan RT-002' });
    assert.deepEqual(nextNotable(model, 40), { m: 60, label: 'STE-1 tidak tersedia' });
    assert.deepEqual(nextNotable(model, 60), { m: 80, label: 'CIP darurat STE-3' });
    assert.deepEqual(nextNotable(model, 80), { m: 90, label: 'Replan v2' });
    assert.deepEqual(nextNotable(model, 90), { m: 100, label: 'Perintah: 4 truk dadakan' });
});

test('nextNotable: tepat di akhir atau lewat -> null; menit pecahan tidak mengulang event yang sama', () => {
    assert.equal(nextNotable(model, 100), null);
    assert.equal(nextNotable(model, 500), null);
    assert.equal(nextNotable(model, 19.5).m, 20);
    assert.equal(nextNotable(model, 20.0000001).m, 40);
    assert.equal(nextNotable({ events: [] }, 0), null);
});

test('notableLabel: CIP terjadwal dan gate lolos tidak dihitung', () => {
    assert.equal(notableLabel({ type: 'cip.started', is_scheduled: true, asset_code: 'X' }), null);
    assert.equal(notableLabel({ type: 'gate.decided', decision: 'pass' }), null);
    assert.equal(notableLabel({ type: 'unload.finished' }), null);
});
