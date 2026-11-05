import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchReplay, fetchSnapshot, followLive, isLiveOperation, liveMinute, mergeEvents, nextOperationRun, pollTransition, readOnlyLiveControls, speedPayload } from './load.js';

test('jam live tidak mengarang waktu masa depan dan menolak kemunduran', () => {
    assert.equal(liveMinute(30, { minute: 30, speed: 60 }), 30);
    assert.equal(liveMinute(30, { minute: 31, speed: 1 }), 31);
    assert.throws(() => liveMinute(30, { minute: 29 }), /mundur/);
    for (const live of [null, { minute: NaN }, { minute: -1 }]) assert.throws(() => liveMinute(0, live), /tidak tersedia/);
});

test('event polling dideduplikasi dan diurutkan berdasarkan seq', () => {
    const event = (seq) => ({ seq, t: '2026-11-04T06:00:00Z', p: {} });
    assert.deepEqual(mergeEvents([event(2), event(1)], [event(2), event(3)]).map((e) => e.seq), [1, 2, 3]);
});

test('operasi running langsung tersedia, finished tetap replay, simulasi tidak live', () => {
    assert.equal(isLiveOperation({ run: { status: 'RUNNING', kind: 'campaign' } }), true);
    assert.equal(isLiveOperation({ run: { status: 'finished', kind: 'campaign' }, live: null }), false);
    assert.equal(isLiveOperation({ run: { status: 'running', kind: 'simulation' } }), false);
});

test('initial snapshot menerima live dan polling memakai after, tanpa fallback saat HTTP error', async (t) => {
    const payload = { run: { status: 'running', kind: 'campaign' }, live: { minute: 15, speed: 5 }, events: [{ seq: 1 }] };
    const urls = [];
    t.mock.method(globalThis, 'fetch', async (url) => {
        urls.push(url);
        return { ok: true, json: async () => payload };
    });

    assert.equal(await fetchReplay('http://localhost/runs/99/replay', () => {}, { allowLive: true }), payload);
    await fetchSnapshot('http://localhost/runs/99/replay?view=twin', 7);
    assert.equal(new URL(urls[0]).searchParams.has('after'), false);
    assert.equal(new URL(urls[1]).searchParams.get('after'), '7');
    t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));
    await assert.rejects(fetchSnapshot('http://localhost/runs/99/replay', 7), /HTTP 503/);
});

test('running tanpa jam Engine gagal eksplisit, tidak menunggu finished replay', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ run: { status: 'running', kind: 'campaign' }, live: null }) }));
    await assert.rejects(fetchReplay('http://localhost/runs/99/replay', () => {}, { allowLive: true }), /tidak tersedia/);
});

test('optimizer preparing dipoll sampai snapshot awal memiliki event sebelum inisialisasi Twin', async (t) => {
    const preparing = { run: { status: 'running', kind: 'campaign' }, live: { minute: 0, speed: 1, preparing: true }, events: [] };
    const ready = { ...preparing, live: { minute: 0, speed: 1 }, events: [{ seq: 1, t: '2026-11-04T06:00:00Z', p: { type: 'day.started' } }] };
    const responses = [preparing, ready];
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => responses.shift() }));
    t.mock.method(globalThis, 'setTimeout', (callback) => { callback(); });
    const waiting = [];
    assert.equal(await fetchReplay('http://localhost/runs/99/replay', (status) => waiting.push(status), { allowLive: true }), ready);
    assert.deepEqual(waiting, ['menyiapkan operasi']);
    assert.equal(responses.length, 0);
});

test('konsumen replay lama tidak menjalankan playback atas snapshot operasi aktif', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ run: { status: 'running', kind: 'campaign' }, live: { minute: 5, speed: 1 } }) }));
    await assert.rejects(fetchReplay('http://localhost/runs/99/replay', () => { throw new Error('tetap menunggu hasil selesai'); }), /tetap menunggu/);
});

test('snapshot finished mengembalikan replay dan live null', async (t) => {
    const finished = { run: { status: 'finished', kind: 'campaign' }, live: null, events: [{ seq: 1 }] };
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => finished }));
    assert.equal(await fetchReplay('http://localhost/runs/99/replay'), finished);
});

test('speed payload selalu numeric dan hanya kecepatan maju yang valid', () => {
    assert.deepEqual(speedPayload('99', '20'), { run_id: 99, speed: 20 });
    for (const speed of [0, -1, 2, NaN, 'pause']) assert.throws(() => speedPayload(99, speed), /tidak valid/);
    for (const run of [0, undefined, 'no']) assert.throws(() => speedPayload(run, 1), /tidak valid/);
});

test('hari berikutnya menunjuk run aktif walau belum masuk riwayat; inactive hanya closed replay', () => {
    assert.deepEqual(nextOperationRun({ live: { run_id: 100, day: 4 }, days: [] }, 3), { runId: 100, day: 4, live: true });
    assert.deepEqual(nextOperationRun({ live: { run_id: 101, day: 5 }, days: [] }, 3), { runId: 101, day: 5, live: true });
    assert.equal(nextOperationRun({ live: { run_id: 99, day: 3 }, days: [] }, 3), null);
    assert.equal(nextOperationRun({ live: null, days: [{ day: 4, run_id: 100, status: 'running' }] }, 3), null);
    assert.deepEqual(nextOperationRun({ live: null, days: [{ day: 4, run_id: 100, status: 'closed' }] }, 3), { runId: 100, day: 4, live: false });
    assert.equal(nextOperationRun(null, 3), null);
});

const event = (seq, minute) => ({ seq, t: `2026-11-04T06:${String(minute).padStart(2, '0')}:00Z`, p: { type: 'day.started' } });
const initialLive = () => ({ run: { id: 99, status: 'running', kind: 'campaign' }, live: { minute: 5, speed: 1 }, events: [event(1, 0)] });

test('EOF delta merge conserve events, termine polling et rend replay historique', () => {
    const initial = initialLive();
    const next = { run: { ...initial.run, status: 'finished' }, live: null, events: [event(2, 20)] };
    const transition = pollTransition(initial.events, next, 19, 99);
    assert.equal(transition.active, false);
    assert.equal(transition.minute, 20);
    assert.deepEqual(transition.events.map((e) => e.seq), [1, 2]);
    assert.equal(pollTransition(transition.events, { ...next, events: [] }, 20, 99).minute, 20);
    assert.throws(() => pollTransition(initial.events, { ...initial, run: { ...initial.run, id: 100 } }, 5, 99), /bukan untuk run/);
    assert.throws(() => pollTransition(initial.events, { ...initial, live: { minute: 4 } }, 5, 99), /mundur/);
    assert.throws(() => pollTransition(initial.events, { ...initial, run: { ...initial.run, status: 'failed' } }, 5, 99), /tidak tersedia/);
});

test('followLive retry menjaga clock/cursor, EOF berhenti, pagehide membatalkan callback', async (t) => {
    const timers = new Map();
    let timerId = 0;
    t.mock.method(globalThis, 'setTimeout', (callback, delay) => { assert.equal(delay, 1000); timers.set(++timerId, callback); return timerId; });
    t.mock.method(globalThis, 'clearTimeout', (id) => timers.delete(id));
    const initial = initialLive();
    const responses = [
        { ok: false, status: 503 },
        { ok: true, json: async () => ({ ...initial, live: { minute: 8, speed: 5 }, events: [event(2, 7)] }) },
        { ok: true, json: async () => ({ run: { ...initial.run, status: 'finished' }, live: null, events: [event(3, 10)] }) },
    ];
    const urls = [];
    t.mock.method(globalThis, 'fetch', async (url) => { urls.push(url); return responses.shift(); });
    const snapshots = [];
    const errors = [];
    const stop = followLive('http://localhost/runs/99/replay', initial, (_, snapshot) => snapshots.push(snapshot), (error) => errors.push(error));
    const tick = async () => {
        const [id, callback] = timers.entries().next().value;
        timers.delete(id);
        await callback();
    };
    await tick();
    assert.equal(errors.length, 1);
    assert.equal(snapshots.length, 0);
    await tick();
    assert.equal(snapshots[0].minute, 8);
    await tick();
    assert.deepEqual(snapshots.map((s) => s.active), [true, false]);
    assert.deepEqual(snapshots[1].events.map((e) => e.seq), [1, 2, 3]);
    assert.deepEqual(urls.map((url) => new URL(url).searchParams.get('after')), ['1', '1', '2']);
    assert.equal(timers.size, 0);
    stop();
    const cancel = followLive('http://localhost/runs/99/replay', initial, () => assert.fail('cancelled callback'));
    cancel();
    assert.equal(timers.size, 0);
});

test('Maps/dashboard timeline controls are disabled live, restored only after closure', () => {
    const els = new Map(['play', 'speed', 'scrub'].map((id) => [`#${id}`, {}]));
    const root = { dataset: {}, querySelector: (id) => els.get(id) };
    readOnlyLiveControls(root, true);
    for (const el of els.values()) assert.equal(el.disabled, true);
    assert.equal(els.get('#play').hidden, true);
    assert.equal(els.get('#speed').hidden, true);
    assert.equal(root.dataset.live, '1');
    readOnlyLiveControls(root, false);
    for (const el of els.values()) assert.equal(el.disabled, false);
    assert.equal(els.get('#play').hidden, false);
    assert.equal(root.dataset.live, '0');
});
