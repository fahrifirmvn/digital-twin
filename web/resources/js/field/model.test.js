import test from 'node:test';
import assert from 'node:assert/strict';
import { busyAssets, createQueue, flush, taskPhase, uuid4 } from './model.js';

const mem = () => {
    const m = new Map();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
};
const item = (n, over = {}) => ({ uuid: `u${n}`, run_id: 1, kind: 'check_in', subject: `RT-00${n}`, client_at: 't', ...over });

test('taskPhase: upcoming, active, done; tanpa end = aktif seterusnya', () => {
    const t = { start: '2026-10-28T02:00:00Z', end: '2026-10-28T03:00:00Z' };
    assert.equal(taskPhase(t, Date.parse('2026-10-28T01:59:00Z')), 'upcoming');
    assert.equal(taskPhase(t, Date.parse('2026-10-28T02:00:00Z')), 'active');
    assert.equal(taskPhase(t, Date.parse('2026-10-28T03:00:00Z')), 'done');
    assert.equal(taskPhase({ start: t.start, end: null }, Date.parse('2026-10-29T00:00:00Z')), 'active');
});

test('busyAssets hanya memuat tugas aktif', () => {
    const tasks = [
        { asset: 'BAY-1', truck: 'RT-001', start: '2026-10-28T02:00:00Z', end: '2026-10-28T03:00:00Z' },
        { asset: 'BAY-2', truck: 'RT-002', start: '2026-10-28T04:00:00Z', end: '2026-10-28T05:00:00Z' },
    ];
    assert.deepEqual(busyAssets(tasks, Date.parse('2026-10-28T02:30:00Z')), { 'BAY-1': 'RT-001' });
});

test('uuid4 berformat v4', () => {
    assert.match(uuid4((a) => a.fill(7)), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('antrian menolak konfirmasi ganda untuk subjek yang sama', () => {
    const q = createQueue(mem(), 'k');
    assert.equal(q.add(item(1)), true);
    assert.equal(q.add(item(1, { uuid: 'lain' })), false);
    assert.equal(q.pending().length, 1);
});

test('flush: offline menyimpan antrian utuh', async () => {
    const q = createQueue(mem(), 'k');
    q.add(item(1));
    const r = await flush(q, async () => { throw new Error('net'); });
    assert.equal(r.error, 'offline');
    assert.equal(q.pending().length, 1);
});

test('flush: 419 dan 500 menyimpan antrian, galat dibedakan', async () => {
    const q = createQueue(mem(), 'k');
    q.add(item(1));
    assert.equal((await flush(q, async () => ({ ok: false, status: 419 }))).error, 'auth');
    assert.equal((await flush(q, async () => ({ ok: false, status: 500 }))).error, 'server');
    assert.equal(q.pending().length, 1);
});

test('flush: recorded/duplicate/rejected keluar dari antrian, hanya yang ada di hasil', async () => {
    const q = createQueue(mem(), 'k');
    [1, 2, 3, 4].forEach((n) => q.add(item(n)));
    const r = await flush(q, async () => ({
        ok: true, status: 200, json: { results: { u1: 'recorded', u2: 'duplicate', u3: 'rejected' } },
    }));
    assert.deepEqual(r, { sent: 2, dropped: 1, error: null });
    assert.deepEqual(q.pending().map((i) => i.uuid), ['u4']);
});
