import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assetRows, decisions, labPrep, layoutCodes, liveStats, trackerSteps, truckRows } from './live.js';

const truck = (code, over = {}) => ({ code, farm: 'FRM-01', volume: 20, temp: 4, status: 'queued', bay: null, held: null, arrivedAt: 10, since: 10, unloadAt: null, gates: {}, ...over });
const state = (tankers, extra = {}) => ({
    m: 100,
    assets: {},
    tankers: Object.fromEntries(tankers.map((t) => [t.code, t])),
    gateHolds: {},
    counters: { arrived: tankers.length, gatePass: 0 },
    ...extra,
});

test('liveStats: antre, rata-rata tunggu hanya dari truk yang sudah mulai bongkar', () => {
    const s = state([
        truck('A', { status: 'unloading', unloadAt: 40 }),
        truck('B', { status: 'stored', arrivedAt: 20, unloadAt: 80 }),
        truck('C', { status: 'sampling' }),
        truck('D', { status: 'lab_test' }),
        truck('Q', { status: 'qa_hold' }),
        truck('E'),
    ]);
    const k = liveStats(s, 9);
    assert.equal(k.avgWaitMin, 45);
    assert.equal(k.waiting, 4);
    assert.equal(k.labQueue, 1);
    assert.equal(k.labTesting, 1);
    assert.equal(k.qaHolds, 1);
    assert.equal(k.inTransit, 3);
});

test('liveStats: tanpa data -> null, kepatuhan gate dari lolos vs tahan', () => {
    assert.equal(liveStats(state([])).avgWaitMin, null);
    assert.equal(liveStats(state([])).gatePassPct, null);
    const s = state([], { gateHolds: { G1: 1 }, counters: { arrived: 0, gatePass: 3 } });
    assert.equal(liveStats(s).gatePassPct, 75);
});

test('decisions: ditahan dan ditolak, terbaru dulu, dengan alasan gate', () => {
    const s = state([
        truck('A', { held: 'G1', since: 30, gates: { G1: { decision: 'hold', reason: 'suhu tinggi' } } }),
        truck('B', { status: 'rejected', since: 60 }),
        truck('Q', { status: 'qa_hold', since: 50, qa: { reason: 'Konfirmasi mutu diperlukan' } }),
        truck('C'),
    ]);
    const d = decisions(s);
    assert.deepEqual(d.map((x) => x.code), ['B', 'Q', 'A']);
    assert.equal(d[1].reason, 'Konfirmasi mutu diperlukan');
    assert.equal(d[1].label, 'Ditahan QA');
    assert.equal(d[0].label, 'Ditolak');
});

test('labPrep mengurutkan yang paling lama menunggu', () => {
    const s = state([truck('A', { status: 'lab_test', since: 50 }), truck('B', { status: 'sampling', since: 20 }), truck('Q', { status: 'qa_hold', since: 30 }), truck('C')]);
    assert.deepEqual(labPrep(s).map((x) => x.code), ['B', 'Q', 'A']);
    assert.equal(labPrep(s)[0].ago, 80);
});

test('truckRows: terbaru tiba dulu, dibatasi limit, waktu tunggu', () => {
    const s = state([truck('A', { arrivedAt: 10, unloadAt: 25 }), truck('B', { arrivedAt: 50 }), truck('C', { arrivedAt: 70, status: 'rejected' })]);
    const rows = truckRows(s, 2);
    assert.deepEqual(rows.map((r) => r.code), ['C', 'B']);
    assert.equal(rows[0].wait, null);
    assert.equal(rows[1].wait, 50);
});

test('trackerSteps menandai langkah, bad saat ditahan atau ditolak', () => {
    const states = (t) => trackerSteps(t).map((s) => s.state);
    assert.deepEqual(states(truck('A', { status: 'released' })), ['done', 'done', 'current', 'todo', 'todo']);
    assert.deepEqual(states(truck('A', { status: 'stored' })), ['done', 'done', 'done', 'done', 'done']);
    assert.deepEqual(states(truck('A', { status: 'rejected' })), ['done', 'bad', 'todo', 'todo', 'todo']);
    assert.deepEqual(states(truck('A', { held: 'G1' })), ['bad', 'todo', 'todo', 'todo', 'todo']);
    assert.deepEqual(states(truck('A', { status: 'qa_hold', qa: { status: 'held' } })), ['done', 'done', 'bad', 'todo', 'todo']);
    assert.deepEqual(states(truck('A', { status: 'qa_hold', qa: { status: 'confirmed' } })), ['done', 'done', 'current', 'todo', 'todo']);
});

test('assetRows: bay dengan truk bongkar, silo dengan isi, lab dari truk uji dan riwayat lab hari itu', () => {
    const layout = { halls: [{ bays: ['BAY-1', 'BAY-2'] }], silos: [{ code: 'TK-STO-1' }] };
    const codes = layoutCodes(layout);
    const s = state([
        truck('A', { status: 'unloading', bay: 'BAY-1', lab: { doneAt: 60, ph: 6.72, g2: 'pass' } }),
        truck('B', { status: 'sampling' }),
        truck('C', { status: 'stored', lab: { doneAt: 90, ph: 6.68, g2: 'pass' } }),
    ], {
        assets: { 'TK-STO-1': { status: 'filling', level: 30 } },
    });
    const bays = assetRows(s, 'bay', codes);
    assert.deepEqual(bays.map((r) => [r.code, r.detail]), [['BAY-1', 'A'], ['BAY-2', '-']]);
    assert.equal(assetRows(s, 'silo', codes)[0].detail, '30.000 L / 60.000 L');
    const labRows = assetRows(s, 'lab', codes);
    assert.deepEqual(labRows.map((r) => r.code), ['B', 'C', 'A']);
    assert.equal(labRows[1].chip.label, 'Lolos G2');
    assert.match(labRows[1].detail, /pH 6,68/);
    assert.equal(assetRows(state([truck('Q', { status: 'qa_hold' })]), 'lab', codes)[0].chip.label, 'Ditahan QA');
});

test('assetRows: tab proses memuat unit hilir dengan status; layout lama tanpa units aman', () => {
    const codes = layoutCodes({ halls: [], silos: [], units: [{ code: 'DEG-1' }, { code: 'STE-1' }] });
    const s = state([], { assets: { 'STE-1': { status: 'cip', level: null } } });
    const rows = assetRows(s, 'proc', codes);
    assert.deepEqual(rows.map((r) => r.code), ['DEG-1', 'STE-1', 'ASEP-1']);
    assert.equal(assetRows(state([], { assets: { 'ASEP-1': { status: 'holding', level: 20 } } }), 'proc', codes)[2].detail, '20.000 L / 50.000 L');
    assert.deepEqual(layoutCodes({ halls: [], silos: [] }).proc, []);
});

test('liveStats: truk menuju gerbang dan terdeteksi (tiba); state lama tanpa inbound aman', () => {
    const s = state([truck('A'), truck('B')], { inbound: { X: {}, Y: {}, Z: {} } });
    const k = liveStats(s, 9);
    assert.equal(k.inbound, 3);
    assert.equal(k.detected, 2);
    assert.equal(liveStats(state([])).inbound, 0);
});
