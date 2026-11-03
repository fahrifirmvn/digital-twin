import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildModel } from '../state.js';
import { appliedText, commandLog, commandSummary, durationText, isIntervention, kindLabel } from './commands.js';

const ev = (seq, t, p) => ({ seq, t, p });
const cmd = (over = {}) => ({ type: 'command.applied', command_id: 1, kind: 'ster_down', actor: 'PPIC: Dewi', reason: 'uji', count: 2, duration_min: 240, ...over });

test('durationText: menit, jam, dan campuran', () => {
    assert.equal(durationText(45), '45 mnt');
    assert.equal(durationText(240), '4 jam');
    assert.equal(durationText(90), '1 j 30 mnt');
});

test('commandSummary: ringkas per jenis perintah', () => {
    assert.equal(commandSummary(cmd()), '2 sterilizer mati 4 jam');
    assert.equal(commandSummary(cmd({ kind: 'cip_delay', factor: 2.5, duration_min: 120 })), 'CIP 2.5x lebih lama selama 2 jam');
    assert.equal(commandSummary(cmd({ kind: 'truck_surge', count: 5 })), '5 truk dadakan');
    assert.equal(commandSummary(cmd({ kind: 'lain' })), 'lain');
    assert.equal(kindLabel('truck_surge'), 'Truk dadakan');
});

test('commandLog: hanya event perintah, dengan jam dan alasan', () => {
    const model = buildModel([
        ev(0, '2026-01-01T00:00:00Z', { type: 'sim.clock' }),
        ev(1, '2026-01-01T07:00:00Z', cmd({ reason: 'sterilizer diuji' })),
        ev(2, '2026-01-01T07:05:00Z', { type: 'truck.arrived' }),
        ev(3, '2026-01-01T10:00:00Z', cmd({ command_id: 2, kind: 'truck_surge', count: 3, actor: 'Observer/Juri: Budi' })),
    ]);
    const log = commandLog(model);
    assert.deepEqual(log.map((l) => [l.id, l.at, l.label, l.actor]), [
        [1, '13:00', 'Sterilizer mati', 'PPIC: Dewi'],
        [2, '16:00', 'Truk dadakan', 'Observer/Juri: Budi'],
    ]);
    assert.equal(log[0].reason, 'sterilizer diuji');
    assert.equal(log[0].m, 420);
});

test('perintah intervensi: ringkasan, penanda, dan teks diblokir', () => {
    const c = (over) => ({ type: 'command.applied', command_id: 1, actor: 'PPIC', reason: 'uji', truck: 'RT-002', ...over });
    assert.equal(commandSummary(c({ kind: 'plan_approve' })), 'Setujui usulan RT-002');
    assert.equal(commandSummary(c({ kind: 'plan_reject' })), 'Tolak usulan RT-002');
    assert.equal(commandSummary(c({ kind: 'plan_change', bay: 'BAY-2', start_min: 500 })), 'Ubah usulan RT-002: BAY-2, bongkar 14:20');
    assert.equal(commandSummary(c({ kind: 'plan_change', start_min: 500 })), 'Ubah usulan RT-002: bongkar 14:20');
    assert.equal(commandSummary(c({ kind: 'truck_hold', duration_min: 60 })), 'Tahan RT-002 di gerbang 1 jam');
    assert.equal(commandSummary(c({ kind: 'truck_release' })), 'Lepas truk RT-002');
    assert.ok(isIntervention('truck_hold') && !isIntervention('ster_down'));

    assert.equal(appliedText(c({ kind: 'plan_approve' })), 'Setujui usulan RT-002');
    assert.equal(appliedText(c({ kind: 'truck_release', blocked: 'truk ditahan gate G1', gate: 'G1' })), 'Lepas truk RT-002 - DIBLOKIR (G1): truk ditahan gate G1');
    assert.equal(appliedText(c({ kind: 'truck_hold', duration_min: 30, blocked: 'sudah melewati gerbang' })), 'Tahan RT-002 di gerbang 30 mnt - DIBLOKIR: sudah melewati gerbang');
});

test('commandLog membawa truk dan status diblokir', () => {
    const model = buildModel([ev(1, '2026-01-01T07:00:00Z', cmd({ kind: 'truck_release', truck: 'RT-008', blocked: 'x', gate: 'G1' }))]);
    const [l] = commandLog(model);
    assert.deepEqual([l.truck, l.blocked, l.gate, l.label], ['RT-008', 'x', 'G1', 'Lepas truk']);
});

test('tank_down: label dan ringkasan menyebut tangki dan durasinya', () => {
    assert.equal(kindLabel('tank_down'), 'Tangki maintenance');
    assert.equal(commandSummary({ kind: 'tank_down', asset: 'TK-STO-2', duration_min: 240 }), 'TK-STO-2 maintenance 4 jam');
});
