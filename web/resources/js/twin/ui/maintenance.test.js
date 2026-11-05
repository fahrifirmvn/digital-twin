import assert from 'node:assert/strict';
import test from 'node:test';
import { maintenanceAcknowledgement, maintenancePayload, maintenanceView, minuteOfClock } from './maintenance.js';

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
        limits: { minute: [0, 1439], duration_min: [15, 720], day: [1, 10] },
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

test('jadwal lama tetap ditampilkan terpisah dari satu formulir maintenance operasi', () => {
    const v = maintenanceView(op(), 'TK-STO-1', { runId: 11, canManage: true });
    assert.equal(v.form, true);
    assert.equal(v.meter.tone, 'warn');
    assert.deepEqual([v.planned.start, v.planned.end, v.planned.index], ['08:00', '09:30', 0]);
});

test('run aktif yang belum masuk riwayat tetap menampilkan panel dan formulir pengelola', () => {
    const state = op({ live: { run_id: 99, day: 3, status: 'running' }, days: [] });
    state.maintenance.open = false;
    state.maintenance.schedules = [{ id: 'm1', asset: 'TK-RAW-1', day_no: 4, start_min: 60, duration_min: 120, status: 'scheduled' }];
    const v = maintenanceView(state, 'TK-RAW-1', { runId: 99, canManage: true });
    assert.equal(v.form, true);
    assert.equal(v.minDay, 3);
    assert.equal(v.active, true);
    assert.equal(v.schedules[0].id, 'm1');
    assert.equal(maintenanceView(state, 'TK-RAW-1', { runId: 99, canManage: false }).form, false);
});

const fields = { requestId: '4a665a0f-f8be-4c25-b166-c5b0bfd8c734', runId: 99, asset: 'TK-RAW-1', mode: 'scheduled', day: 3, time: '08:00', duration: 120, reason: 'Servis berkala' };
const liveOp = () => op({ live: { run_id: 99, day: 3, status: 'running' }, target_day: 4 });

test('ack relay lifecycle juga sukses, pending/uncertain tetap tidak pasti', () => {
    const labels = {
        accepted: /diterima; menunggu pelaksanaan/,
        scheduled: /dijadwalkan/,
        waiting_safe: /Aliran masuk baru diblokir; menunggu/,
        maintenance: /sedang berlangsung/,
        completed: /selesai/,
    };
    for (const [status, label] of Object.entries(labels)) {
        const message = maintenanceAcknowledgement({ id: 'm1', status, day_no: 3 });
        assert.match(message, label);
        assert.match(message, /Hari 3/);
    }
    assert.doesNotMatch(maintenanceAcknowledgement({ id: 'm1', status: 'accepted' }), /dimulai|berlangsung|started/);
    for (const status of ['pending', 'uncertain', undefined]) {
        assert.throws(() => maintenanceAcknowledgement({ id: 'm1', status }), /request_id yang sama/);
    }
    assert.throws(() => maintenanceAcknowledgement({ status: 'error', message: 'Ditolak' }), /Ditolak/);
});

test('transisi hari baru tidak menggunakan menit hari lama untuk validasi jadwal hari aktif baru', () => {
    const state = liveOp();
    state.live = { run_id: 100, day: 4, status: 'running' };
    state.maintenance.open = false;
    state.days = [{ day: 3, run_id: 99 }];
    const v = maintenanceView(state, fields.asset, { runId: 99, canManage: true });
    assert.equal(v.form, true);
    assert.equal(v.minDay, 4);
    assert.equal(v.active, false);
    assert.throws(() => maintenancePayload({ ...fields, mode: 'now' }, state), /Buka Hari 4.*riwayat/);
    assert.equal(maintenancePayload({ ...fields, day: 4, time: '06:01' }, state, 1439).start_min, 1);
    assert.throws(() => maintenancePayload({ ...fields, day: 3 }, state, 1439), /Hari jadwal/);
    state.live = null;
    state.target_day = 4;
    assert.equal(maintenanceView(state, fields.asset, { runId: 99, canManage: true }).form, false);
    assert.throws(() => maintenancePayload({ ...fields, mode: 'now' }, state), /Tidak ada hari/);
});

test('maintenance langsung tidak mengirim waktu browser atau hari jadwal', () => {
    const payload = maintenancePayload({ ...fields, mode: 'now', day: '', time: '' }, liveOp(), 200);
    assert.deepEqual(payload, { request_id: fields.requestId, run_id: 99, asset: fields.asset, mode: 'now', duration_min: 120, reason: fields.reason });
    assert.throws(() => maintenancePayload({ ...fields, mode: 'now' }, op()), /Tidak ada hari/);
});

test('jadwal hari ini harus di masa depan berdasarkan menit Engine yang diketahui', () => {
    assert.equal(maintenancePayload(fields, liveOp(), 119).start_min, 120);
    for (const minute of [120, 121]) assert.throws(() => maintenancePayload(fields, liveOp(), minute), /setelah jam Engine/);
    // Menonton riwayat tidak menyediakan jam live: backend tetap memvalidasi waktu hari ini.
    assert.equal(maintenancePayload(fields, liveOp()).start_min, 120);
});

test('jadwal mendatang menerima jam lebih awal, dibatasi hari operasi dan max_days server', () => {
    assert.equal(maintenancePayload({ ...fields, day: 4, time: '06:00' }, liveOp(), 500).start_min, 0);
    for (const day of [2, 11, 3.5]) assert.throws(() => maintenancePayload({ ...fields, day }, liveOp(), 0), /Hari jadwal/);
    assert.throws(() => maintenancePayload({ ...fields, day: 1 }, op()), /Hari jadwal/);
    assert.equal(maintenancePayload({ ...fields, day: 2 }, op()).day, 2);
    assert.throws(() => maintenancePayload({ ...fields, time: '24:00' }, liveOp()), /Jam mulai/);
    assert.throws(() => maintenancePayload({ ...fields, duration: 721 }, liveOp()), /Durasi/);
    assert.throws(() => maintenancePayload({ ...fields, reason: 'bad' }, liveOp()), /Alasan/);
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
