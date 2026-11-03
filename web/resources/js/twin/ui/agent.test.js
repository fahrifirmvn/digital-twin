import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actionButtons, actionTitle, countdown, STATUS, verdictText } from './agent.js';

test('actionTitle: ringkas jenis dan jumlah perintah', () => {
    assert.equal(actionTitle({ approve: ['A', 'B', 'C'], hold: [] }), 'Setujui 3 usulan jadwal');
    assert.equal(actionTitle({ approve: ['A'], hold: ['B', 'C'] }), 'Setujui 1 usulan jadwal, tahan 2 truk di gerbang');
    assert.equal(actionTitle({ approve: [], hold: [] }), 'Tanpa perintah');
});

test('verdictText: lulus, belum, gagal, dan belum ada hasil', () => {
    assert.match(verdictText({ verdict: 'lulus', mean: 18.4, base: 20, delta: -1.6, violations: 0 }), /18,4 mnt dibanding 20 mnt, 1,6 mnt lebih cepat/);
    assert.match(verdictText({ verdict: 'lulus', mean: 20, base: 20, delta: 0, violations: 0 }), /sama dengan jadwal sistem/);
    assert.match(verdictText({ verdict: 'belum', mean: 25, base: 20, delta: 5, violations: 0 }), /Belum lebih baik.*5 mnt lebih lama/);
    assert.match(verdictText({ verdict: 'gagal', violations: 2 }), /Gagal: 2 upaya melewati gate/);
    assert.match(verdictText(null), /berjalan di Engine/);
});

test('countdown: menit:detik, tidak pernah negatif', () => {
    assert.equal(countdown(600), '10:00');
    assert.equal(countdown(65.9), '1:05');
    assert.equal(countdown(-5), '0:00');
});

test('actionButtons: hanya yang berwenang; veto hanya selama jendela terbuka', () => {
    assert.deepEqual(actionButtons({ status: 'awaiting' }, true), ['approve', 'veto']);
    assert.deepEqual(actionButtons({ status: 'applied', can_veto: true }, true), ['veto', 'undo']);
    assert.deepEqual(actionButtons({ status: 'applied', can_veto: false }, true), ['undo']);
    assert.deepEqual(actionButtons({ status: 'rejected' }, true), []);
    assert.deepEqual(actionButtons({ status: 'awaiting' }, false), []);
});

test('STATUS: setiap status punya label dan nada', () => {
    for (const k of ['verifying', 'awaiting', 'applied', 'rejected', 'vetoed', 'undone']) assert.ok(STATUS[k].label && STATUS[k].tone);
});
