import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, buildModel, emptyState } from '../state.js';
import { decisionsAt, planAt, proposalRows } from './proposals.js';

const ev = (seq, t, p) => ({ seq, t, p });
const T0 = '2026-01-01T00:00:00Z';
const iso = (min) => new Date(Date.parse(T0) + min * 60000).toISOString();
const tp = (code, bay, unload, analyst = 'AN-1') => ({ code, bay, analyst, sterilizer: 'STE-1', line: 'L1', lab_start: iso(unload - 40), unload_start: iso(unload) });
const cmd = (id, kind, over = {}) => ({ type: 'command.applied', command_id: id, kind, actor: 'PPIC', reason: 'uji', truck: 'RT-002', ...over });

test('planAt: versi 1 lengkap, versi berikutnya menimpa truk yang disusun ulang', () => {
    const startMs = Date.parse(T0);
    const plans = [
        { version: 1, at: null, trucks: [tp('RT-001', 'BAY-1', 100), tp('RT-002', 'BAY-2', 200)] },
        { version: 2, at: iso(300), trucks: [tp('RT-002', 'BAY-1', 400)] },
    ];
    assert.equal(planAt(plans, startMs, 250)['RT-002'].unloadM, 200);
    assert.equal(planAt(plans, startMs, 250)['RT-002'].labM, 160);
    const late = planAt(plans, startMs, 300);
    assert.deepEqual([late['RT-001'].bay, late['RT-002'].bay, late['RT-002'].unloadM], ['BAY-1', 'BAY-1', 400]);
    assert.deepEqual(planAt([], startMs, 10), {});
});

test('decisionsAt: hanya keputusan yang berlaku dan belum diblokir sampai menit itu', () => {
    const model = buildModel([
        ev(0, iso(0), { type: 'sim.clock' }),
        ev(1, iso(100), cmd(1, 'plan_change', { bay: 'BAY-2' })),
        ev(2, iso(110), cmd(2, 'plan_change', { start_min: 500 })),
        ev(3, iso(120), cmd(3, 'truck_hold', { truck: 'RT-004', duration_min: 60 })),
        ev(4, iso(130), cmd(4, 'truck_release', { truck: 'RT-008', blocked: 'ditahan G1', gate: 'G1' })),
        ev(5, iso(140), cmd(5, 'truck_release', { truck: 'RT-004' })),
        ev(6, iso(150), cmd(6, 'plan_reject')),
        ev(7, iso(160), { type: 'command.applied', command_id: 7, kind: 'ster_down', actor: 'x', reason: 'y', count: 1, duration_min: 60 }),
    ]);
    assert.deepEqual(decisionsAt(model, 105), { 'RT-002': { plan: 'change', bay: 'BAY-2', startM: null, hold: false } });
    const d = decisionsAt(model, 200);
    assert.deepEqual(d['RT-002'], { plan: 'reject', bay: 'BAY-2', startM: 500, hold: false });
    assert.equal(d['RT-004'].hold, false);
    assert.equal(d['RT-008'], undefined);
});

function stateAt(events) {
    const s = emptyState();
    for (const e of buildModel(events).events) apply(s, e);
    return s;
}

const arrive = (code) => ({ type: 'truck.arrived', tanker_code: code, farm_code: 'F-1', plate: `B ${code}`, volume_ton: 10, temp_c: 4 });
const status = (code, st) => ({ type: 'tanker.status_changed', tanker_code: code, status: st });

test('proposalRows: antre lab dan bay punya usulan, G1 dan gerbang terpisah, truk menuju gerbang bisa ditahan', () => {
    const s = stateAt([
        ev(0, iso(0), { type: 'truck.dispatched', tanker_code: 'RT-009', farm_code: 'F-2', plate: 'B 9', route: 'r', window_min: 30, eta: iso(90) }),
        ev(1, iso(10), arrive('RT-001')), ev(2, iso(11), status('RT-001', 'sampling')),
        ev(3, iso(12), arrive('RT-002')), ev(4, iso(13), status('RT-002', 'released')),
        ev(5, iso(14), arrive('RT-003')), ev(6, iso(15), status('RT-003', 'lab_test')),
        ev(7, iso(16), arrive('RT-004')),
        ev(8, iso(17), arrive('RT-005')), ev(9, iso(17), { type: 'gate.decided', gate: 'G1', object_type: 'tanker', object_id: 'RT-005', decision: 'hold', reason: 'suhu' }),
    ]);
    const plan = { 'RT-001': { bay: 'BAY-1', unloadM: 60, analyst: 'AN-1' }, 'RT-002': { bay: 'BAY-2', unloadM: 70, analyst: 'AN-2' } };
    const rows = proposalRows(s, plan, { 'RT-002': { plan: 'change', bay: 'BAY-3', startM: 90, hold: false }, 'RT-004': { plan: null, hold: true } });

    assert.deepEqual(rows.waiting.map((r) => [r.code, r.stage, r.verdict, r.proposal.bay, r.proposal.unloadM]), [
        ['RT-001', 'Antre lab', null, 'BAY-1', 60],
        ['RT-002', 'Antre bay', 'change', 'BAY-3', 90],
    ]);
    assert.deepEqual(rows.gate.map((r) => [r.code, r.hold]), [['RT-004', true]]);
    assert.deepEqual(rows.g1.map((r) => [r.code, r.reason]), [['RT-005', 'suhu']]);
    assert.deepEqual(rows.inbound.map((r) => [r.code, r.etaM, r.hold]), [['RT-009', 90, false]]);
});

test('proposalRows: usulan ditolak tidak lagi punya usulan, truk tanpa rencana tidak muncul, daftar dipotong', () => {
    const arrivals = [];
    for (let i = 1; i <= 8; i++) arrivals.push(ev(i * 2, iso(i), arrive(`RT-00${i}`)), ev(i * 2 + 1, iso(i), status(`RT-00${i}`, 'sampling')));
    const s = stateAt(arrivals);
    const plan = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`RT-00${i + 1}`, { bay: 'BAY-1', unloadM: 50, analyst: 'AN-1' }]));
    const rows = proposalRows(s, plan, { 'RT-001': { plan: 'reject', hold: false } }, 5);
    assert.equal(rows.waiting.length, 5);
    assert.equal(rows.waiting[0].proposal, null);
    assert.equal(rows.waiting[0].verdict, 'reject');
    assert.ok(!rows.waiting.some((r) => r.code === 'RT-008'));
});
