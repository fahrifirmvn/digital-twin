import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dayDate, daySummaryRows, historyRows } from './day.js';

const fmt = (t) => `${t} L`;

test('memformat tanggal Indonesia dan menolak masukan salah', () => {
    assert.equal(dayDate('2026-11-03'), '3 Nov 2026');
    assert.equal(dayDate('2026-05-21'), '21 Mei 2026');
    assert.equal(dayDate(null), '');
});

test('ringkasan menampilkan baris QA hanya bila ada', () => {
    const base = { trucks: 12, received_ton: 300, rejected_ton: 20, processed_ton: 280, released_ton: 250, qa_hold_ton: 0, stock_ton: 400 };
    assert.deepEqual(daySummaryRows(base, fmt).map((r) => r.label), ['Truk datang', 'Diterima', 'Ditolak', 'Diolah', 'Dirilis', 'Stok barang jadi']);
    assert.ok(daySummaryRows({ ...base, qa_hold_ton: 5 }, fmt).some((r) => r.label === 'Ditahan QA'));
});

test('riwayat menaruh hari terbaru di atas dan menandai hari yang sedang diputar', () => {
    const state = { days: [
        { day: 1, date: '2026-11-03', run_id: 10, summary: { received_ton: 1, released_ton: 2 } },
        { day: 2, date: '2026-11-04', run_id: 11, summary: null },
    ] };
    const rows = historyRows(state, 1, fmt);
    assert.deepEqual(rows.map((r) => r.day), [2, 1]);
    assert.equal(rows[1].current, true);
    assert.equal(rows[0].detail, 'Ringkasan tidak tersedia');
    assert.equal(rows[1].title, 'Hari 1 · 3 Nov 2026');
});
