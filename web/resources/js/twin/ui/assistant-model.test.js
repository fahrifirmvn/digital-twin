import assert from 'node:assert/strict';
import test from 'node:test';
import {
    ALLOW_REASON, MAX_HISTORY, allowReason, buildTurn, canDecide, canSubmit, changeRows, describeWindow, dueNotice, httpError, modelNote, pushHistory, reasonError, replyNote, statusLabel,
} from './assistant-model.js';

test('dueNotice: hanya tangki yang mendekati/melewati batas dan belum dijadwalkan', () => {
    const op = (open = true) => ({ exists: true, maintenance: { day: 3, open, tanks: [
        { asset: 'TK-RAW-1', cycles: 2, limit: 10, state: 'ok', planned: false },
        { asset: 'TK-RAW-2', cycles: 11, limit: 10, state: 'due', planned: false },
        { asset: 'TK-STO-1', cycles: 8, limit: 10, state: 'near', planned: false },
        { asset: 'TK-STO-2', cycles: 12, limit: 10, state: 'due', planned: true },
    ] } });
    const n = dueNotice(op());
    assert.deepEqual(n.tanks.map((t) => t.asset), ['TK-RAW-2', 'TK-STO-1']);
    assert.match(n.text, /TK-RAW-2 \(11\/10 siklus, perlu servis\)/);
    assert.match(n.prompt, /Hari 3/);
    assert.equal(dueNotice(op(false)), null);
    assert.equal(dueNotice({ exists: false }), null);
    assert.equal(dueNotice(null), null);
});

test('allowReason memakai catatan bila cukup panjang, selain itu alasan bawaan', () => {
    assert.equal(allowReason('  servis rutin  '), 'servis rutin');
    assert.equal(allowReason('ab'), ALLOW_REASON);
    assert.equal(allowReason(undefined), ALLOW_REASON);
    assert.equal(allowReason('x'.repeat(900)).length, 500);
});

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

test('storageKey memisahkan pengguna dan konteks', async () => {
    const { storageKey } = await import('./assistant-model.js');
    const a = storageKey({ userId: 1, campaignId: 5, runId: '' });
    assert.notEqual(a, storageKey({ userId: 2, campaignId: 5, runId: '' }));
    assert.notEqual(a, storageKey({ userId: 1, campaignId: '', runId: 5 }));
    assert.notEqual(a, storageKey({ userId: 1, campaignId: 6, runId: '' }));
});

test('serializeChat dan restoreChat bolak-balik dengan batas', async () => {
    const { serializeChat, restoreChat, MAX_STORED } = await import('./assistant-model.js');
    const messages = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `m${i}`, meta: '', error: i === 59 }));
    const id = '11111111-2222-4333-8444-555555555555';
    const back = restoreChat(serializeChat({ conversationId: id, history: [{ role: 'user', content: 'x' }], messages }));
    assert.equal(back.conversationId, id);
    assert.equal(back.messages.length, MAX_STORED);
    assert.equal(back.messages.at(-1).error, true);
    assert.equal(back.history.length, 1);
});

test('restoreChat menolak data rusak, versi lain, dan id bukan uuid', async () => {
    const { restoreChat } = await import('./assistant-model.js');
    assert.equal(restoreChat('{bukan json'), null);
    assert.equal(restoreChat(JSON.stringify({ v: 2, messages: [], history: [] })), null);
    assert.equal(restoreChat(JSON.stringify({ v: 1, messages: 'x', history: [] })), null);
    const r = restoreChat(JSON.stringify({
        v: 1, conversationId: '../../etc', history: [{ role: 'system', content: 'x' }, { role: 'user', content: 'ok' }],
        messages: [{ role: 'system', text: 'x' }, { role: 'user', text: 'halo' }, { role: 'user', text: 5 }],
    }));
    assert.equal(r.conversationId, null);
    assert.deepEqual(r.history, [{ role: 'user', content: 'ok' }]);
    assert.equal(r.messages.length, 1);
});

test('suggestions tanpa angka dan sesuai konteks serta izin', async () => {
    const { suggestions } = await import('./assistant-model.js');
    const camp = suggestions({ campaignId: 3, runId: '', canApprove: true });
    assert.ok(camp.length >= 3);
    assert.ok(suggestions({ campaignId: 3, runId: '', canApprove: false }).length < camp.length);
    for (const s of [...camp, ...suggestions({ campaignId: '', runId: 4, canApprove: false }), ...suggestions({})]) assert.ok(!/\d/.test(s));
});

test('revisePrompt menyebut jendela dan versi; revealStep terbatas', async () => {
    const { revisePrompt, revealStep } = await import('./assistant-model.js');
    const p = revisePrompt({ version: 2, payload: { asset: 'TK-RAW-1', minute: 360, duration_min: 180 } });
    assert.match(p, /TK-RAW-1/);
    assert.match(p, /versi 2/);
    assert.equal(revealStep(10), 2);
    assert.ok(Math.ceil(1500 / revealStep(1500)) <= 70);
});

test('modelNote menandai mock sebagai mode demo dan menampilkan model sungguhan', () => {
    assert.match(modelNote({ provider: 'mock', model: 'mock' }), /mode demo/);
    assert.equal(modelNote({ provider: 'gemini', model: 'gemini-2.5-flash' }), 'model: gemini-2.5-flash');
    assert.equal(modelNote({}), '');
});
