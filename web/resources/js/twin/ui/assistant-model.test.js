import assert from 'node:assert/strict';
import test from 'node:test';
import {
    MAX_HISTORY, buildTurn, canDecide, canSubmit, changeRows, describeWindow, httpError, pushHistory, reasonError, replyNote, statusLabel,
} from './assistant-model.js';

test('buildTurn memotong pesan dan riwayat, hanya mengirim id yang ada', () => {
    const history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}`, extra: 'x' }));
    const body = buildTurn({ message: `  ${'a'.repeat(1500)}  `, conversationId: null, runId: '7', campaignId: '', history });
    assert.equal(body.message.length, 1000);
    assert.equal(body.history.length, MAX_HISTORY);
    assert.deepEqual(Object.keys(body.history[0]), ['role', 'content']);
    assert.equal(body.run_id, 7);
    assert.ok(!('campaign_id' in body));
    assert.ok(!('conversation_id' in body));
});

test('pushHistory tidak menyimpan balasan galat', () => {
    assert.equal(pushHistory([], 'halo', { status: 'ok', text: 'hai' }).length, 2);
    assert.deepEqual(pushHistory([], 'halo', { status: 'error', text: 'x' }), [{ role: 'user', content: 'halo' }]);
    let h = [];
    for (let i = 0; i < 30; i++) h = pushHistory(h, 'q', { status: 'ok', text: 'a' });
    assert.equal(h.length, MAX_HISTORY);
});

test('describeWindow memakai jam dan durasi', () => {
    assert.equal(describeWindow({ asset: 'TK-RAW-1', minute: 0, duration_min: 180 }), 'TK-RAW-1, 06:00 - 09:00 (180 menit)');
});

test('changeRows memberi kata pembeda selain warna', () => {
    const rows = changeRows({ truck_wait_mean_min: { baseline: 10, candidate: 14, change: 4, better: false }, zzz: { baseline: 1, candidate: 0, change: -1, better: true } });
    assert.equal(rows[0].verdict, 'lebih buruk');
    assert.equal(rows[0].tone, 'worse');
    assert.match(rows[0].text, /\+4/);
    assert.equal(rows[1].label, 'zzz');
    assert.equal(rows[1].verdict, 'lebih baik');
    assert.deepEqual(changeRows(null), []);
});

test('hak tombol: pengaju atau approver untuk ajukan, hanya approver untuk memutuskan', () => {
    const draft = { status: 'draft', created_by: 3 };
    assert.equal(canSubmit(draft, 3, false), true);
    assert.equal(canSubmit(draft, 4, false), false);
    assert.equal(canSubmit(draft, 4, true), true);
    assert.equal(canSubmit({ status: 'pending', created_by: 3 }, 3, true), false);
    assert.equal(canDecide({ status: 'pending' }, false), false);
    assert.equal(canDecide({ status: 'pending' }, true), true);
    assert.equal(canDecide({ status: 'approved' }, true), false);
});

test('reasonError menolak alasan terlalu pendek atau panjang', () => {
    assert.ok(reasonError('   ab '));
    assert.ok(reasonError('x'.repeat(501)));
    assert.equal(reasonError('alasan sah'), null);
});

test('replyNote dan httpError', () => {
    assert.equal(replyNote({ status: 'ok', text: 't' }), '');
    assert.equal(replyNote({ status: 'blocked', error: { message: 'diblokir' } }), 'diblokir');
    assert.match(replyNote({ status: 'error' }), /tidak dapat/);
    assert.equal(httpError(422, { errors: { reason: ['Alasan wajib.'] } }), 'Alasan wajib.');
    assert.match(httpError(429, {}), /Terlalu banyak/);
    assert.match(httpError(403, {}), /Peran/);
    assert.match(httpError(500, {}), /HTTP 500/);
    assert.equal(statusLabel('pending'), 'Menunggu persetujuan');
    assert.equal(statusLabel('lain'), 'lain');
});
