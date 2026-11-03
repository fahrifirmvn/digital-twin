import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_LAYOUT as L } from '../layout/default.js';
import { truckSlots } from './intent.js';
import { TruckMover } from './mover.js';
import { LANE_OFFSET, drivePath } from './routes.js';

const ENTRANCE = { a: -320, b: 0 };
const pts = (path) => path.map((p) => [p.a, p.b]);
const slots = truckSlots(L);

test('rute ke antrean lurus di jalan utama', () => {
    const q = slots.queue[0];
    assert.deepEqual(pts(drivePath(L, ENTRANCE, q)), [[q.a, q.b]]);
});

test('rute ke bay: jalan utama, spur, jalur apron, lalu mundur ke slot', () => {
    const bay = slots.bay.get('BAY-3');
    const path = drivePath(L, ENTRANCE, bay);
    assert.deepEqual(pts(path), [[455, 0], [455, 383], [746, 383], [746, 340]]);
    assert.equal(path.at(-1).h, -Math.PI / 2);
    assert.equal(path[2].h, undefined);
});

test('rute ke area tunggu lewat bukaan trotoar di b=40', () => {
    const pad = slots.pad[2];
    assert.deepEqual(pts(drivePath(L, ENTRANCE, pad)), [[455, 0], [455, 40], [640, 40], [640, 84]]);
});

test('rute ke lab lewat ujung spur lalu sepanjang barisnya', () => {
    const lab = slots.lab[0];
    assert.deepEqual(pts(drivePath(L, ENTRANCE, lab)), [[455, 0], [455, 640], [668, 640]]);
});

test('rute keluar memakai lajur kanan, tidak melewati garis tengah antrean', () => {
    const bay = slots.bay.get('BAY-1');
    const out = drivePath(L, { ...bay }, ENTRANCE, { lane: true });
    assert.deepEqual(pts(out), [[614, 383], [455 + LANE_OFFSET, 383], [455 + LANE_OFFSET, LANE_OFFSET], [-320, LANE_OFFSET]]);
});

test('mover: truk baru menyetir dari pintu masuk lalu berhenti di slot', () => {
    const m = new TruckMover(L);
    const q = slots.queue[0];
    m.sync([{ code: 'T-1', status: 'queued', ...q }]);
    assert.equal(m.moving, true);
    assert.deepEqual([m.poses()[0].a, m.poses()[0].b], [-320, 0]);
    for (let i = 0; i < 400 && m.step(0.016); i++);
    const p = m.poses()[0];
    assert.ok(Math.abs(p.a - q.a) < 1e-6 && Math.abs(p.b - q.b) < 1e-6);
    assert.equal(m.moving, false);
});

test('mover: snap langsung di tujuan tanpa bergerak', () => {
    const m = new TruckMover(L);
    const bay = slots.bay.get('BAY-2');
    m.sync([{ code: 'T-1', status: 'unloading', ...bay }], { snap: true });
    assert.equal(m.moving, false);
    assert.deepEqual([m.poses()[0].a, m.poses()[0].b, m.poses()[0].rot], [bay.a, bay.b, -Math.PI / 2]);
});

test('mover: truk yang hilang keluar lewat lajur kanan lalu dihapus; snap menghapus seketika', () => {
    const m = new TruckMover(L);
    const bay = slots.bay.get('BAY-2');
    m.sync([{ code: 'T-1', status: 'unloading', ...bay }], { snap: true });
    m.sync([]);
    assert.equal(m.poses()[0].leaving, true);
    for (let i = 0; i < 1000 && m.entries.size; i++) m.step(0.016);
    assert.equal(m.entries.size, 0);

    m.sync([{ code: 'T-1', status: 'unloading', ...bay }], { snap: true });
    m.sync([], { snap: true });
    assert.equal(m.entries.size, 0);
});

test('mover: pindah slot menyetir dari posisi sekarang dan tertinggal paling lama lagSec', () => {
    const m = new TruckMover(L, { speed: 10, lagSec: 2 });
    const [q0, q1] = slots.queue;
    m.sync([{ code: 'T-1', status: 'queued', ...q1 }], { snap: true });
    m.sync([{ code: 'T-1', status: 'queued', ...q0 }]);
    let t = 0;
    while (m.step(0.05) && t < 20) t += 0.05;
    assert.ok(t <= 2.3, `selesai ${t}s`);
    assert.equal(m.poses()[0].a, q0.a);
});

test('mover: batas entri membuang truk keluar terlama', () => {
    const m = new TruckMover(L, { maxEntries: 2 });
    const [a, b, c] = slots.queue;
    m.sync([{ code: 'A', status: 'queued', ...a }, { code: 'B', status: 'queued', ...b }], { snap: true });
    m.sync([{ code: 'B', status: 'queued', ...b }]);
    m.sync([{ code: 'B', status: 'queued', ...b }, { code: 'C', status: 'queued', ...c }]);
    assert.deepEqual([...m.entries.keys()].sort(), ['B', 'C']);
});
