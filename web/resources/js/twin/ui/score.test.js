import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildModel } from '../state.js';
import { interventionScore } from './score.js';

const ev = (seq, t, p) => ({ seq, t, p });
const cmd = (id, kind, over = {}) => ({ type: 'command.applied', command_id: id, kind, actor: 'PPIC: Dewi', reason: 'uji', truck: 'RT-002', ...over });
const kpi = (mean) => ({ truck_wait_min: { mean } });
const model = (...cmds) => buildModel(cmds.map((c, i) => ev(i, `2026-01-01T0${7 + i}:00:00Z`, c)));

test('interventionScore: tidak ada keputusan PPIC atau KPI belum ada -> null', () => {
    assert.equal(interventionScore(model(), kpi(10), kpi(12)), null);
    assert.equal(interventionScore(model({ type: 'command.applied', command_id: 1, kind: 'ster_down', actor: 'x', reason: 'y' }), kpi(10), kpi(12)), null);
    assert.equal(interventionScore(model(cmd(1, 'plan_approve')), null, kpi(12)), null);
    assert.equal(interventionScore(model(cmd(1, 'plan_approve')), kpi(10), {}), null);
});

test('interventionScore: lulus bila tunggu tidak lebih buruk dari jadwal sistem', () => {
    const better = interventionScore(model(cmd(1, 'plan_change', { bay: 'BAY-2' })), kpi(18.24), kpi(20.5));
    assert.deepEqual([better.verdict, better.delta, better.mean, better.base, better.decisions, better.violations], ['lulus', -2.3, 18.2, 20.5, 1, 0]);
    assert.match(better.gap, /2,3 mnt lebih cepat/);
    assert.equal(interventionScore(model(cmd(1, 'plan_approve')), kpi(20), kpi(20)).verdict, 'lulus');
    assert.match(interventionScore(model(cmd(1, 'plan_approve')), kpi(20), kpi(20)).gap, /sama dengan/);
});

test('interventionScore: belum lebih baik bila tunggu lebih lama', () => {
    const s = interventionScore(model(cmd(1, 'plan_reject')), kpi(25), kpi(20));
    assert.deepEqual([s.verdict, s.delta], ['belum', 5]);
    assert.match(s.gap, /5 mnt lebih lama/);
});

test('interventionScore: upaya menembus gate = gagal walau tunggu membaik; blokir tanpa gate bukan pelanggaran', () => {
    const s = interventionScore(
        model(cmd(1, 'truck_release', { truck: 'RT-008', blocked: 'ditahan G1', gate: 'G1' }), cmd(2, 'truck_hold', { truck: 'RT-004', blocked: 'sudah melewati gerbang' })),
        kpi(5), kpi(20),
    );
    assert.deepEqual([s.verdict, s.violations, s.blocked.length, s.decisions], ['gagal', 1, 2, 2]);
    assert.equal(s.blocked[0].gate, 'G1');
    assert.match(s.blocked[0].text, /DIBLOKIR \(G1\)/);

    const soft = interventionScore(model(cmd(1, 'truck_hold', { blocked: 'sudah melewati gerbang' })), kpi(5), kpi(20));
    assert.deepEqual([soft.verdict, soft.violations], ['lulus', 0]);
});
