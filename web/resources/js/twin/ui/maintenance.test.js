import assert from 'node:assert/strict';
import test from 'node:test';
import { maintenanceView, minuteOfClock } from './maintenance.js';

const op = (over = {}) => ({
    exists: true,
    campaign_id: 7,
    days: [{ day: 1, run_id: 11 }],
    maintenance: {
        day: 2, date: '2026-11-04', status: 'closed', open: true,
        tanks: [
            { asset: 'TK-RAW-1', cycles: 2, limit: 10, state: 'ok', planned: false },
            { asset: 'TK-RAW-2', cycles: 12, limit: 10, state: 'due', planned: false },
            { asset: 'TK-STO-1', cycles: 8, limit: 10, state: 'near', planned: true },
        ],
        planned: [{ asset: 'TK-STO-1', minute: 120, duration_min: 90 }],
        limits: { minute: [0, 1439], duration_min: [15, 720] },
    },
    ...over,
});

test('jam dinding diubah ke menit sejak 06:00', () => {
    assert.equal(minuteOfClock('06:00'), 0);
    assert.equal(minuteOfClock('08:30'), 150);
    assert.equal(minuteOfClock('00:00'), 1080);
    assert.equal(minuteOfClock('05:59'), 1439);
    assert.equal(minuteOfClock('24:00'), null);
    assert.equal(minuteOfClock('abc'), null);
});

test('meter servis: persen dibatasi 100 dan nada mengikuti keadaan', () => {
    const due = maintenanceView(op(), 'TK-RAW-2', { runId: 11, canManage: true });
    assert.equal(due.meter.pct, 100);
    assert.equal(due.meter.tone, 'bad');
    assert.equal(due.form, true);
    assert.equal(maintenanceView(op(), 'TK-RAW-1', { runId: 11, canManage: true }).meter.tone, 'ok');
});

test('tangki yang sudah dijadwalkan menampilkan jadwal, bukan formulir', () => {
    const v = maintenanceView(op(), 'TK-STO-1', { runId: 11, canManage: true });
    assert.equal(v.form, false);
    assert.equal(v.meter.tone, 'warn');
    assert.deepEqual([v.planned.start, v.planned.end, v.planned.index], ['08:00', '09:30', 0]);
});

test('formulir hanya untuk pengelola dan saat hari target terbuka', () => {
    assert.equal(maintenanceView(op(), 'TK-RAW-1', { runId: 11, canManage: false }).form, false);
    const closed = op();
    closed.maintenance.open = false;
    assert.equal(maintenanceView(closed, 'TK-RAW-1', { runId: 11, canManage: true }).form, false);
});

test('bukan run operasi, bukan tangki, atau operasi belum ada tidak menampilkan apa pun', () => {
    assert.equal(maintenanceView(op(), 'TK-RAW-1', { runId: 99, canManage: true }), null);
    assert.equal(maintenanceView(op(), 'STER-1', { runId: 11, canManage: true }), null);
    assert.equal(maintenanceView({ exists: false }, 'TK-RAW-1', { runId: 11 }), null);
    assert.equal(maintenanceView(null, 'TK-RAW-1', { runId: 11 }), null);
});
