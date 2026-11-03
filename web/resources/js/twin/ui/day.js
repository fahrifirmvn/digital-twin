// Hari operasi: format tanggal, baris ringkasan akhir hari, dan baris riwayat hari (murni, tanpa DOM).

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

/** "2026-11-03" -> "3 Nov 2026". */
export function dayDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '';
}

/** Ringkasan akhir hari (payload day.summary) -> baris label/nilai; ton ditampilkan sebagai liter lewat fmt. */
export function daySummaryRows(sum, fmt) {
    const rows = [
        { label: 'Truk datang', value: String(sum.trucks) },
        { label: 'Diterima', value: fmt(sum.received_ton) },
        { label: 'Ditolak', value: fmt(sum.rejected_ton) },
        { label: 'Diolah', value: fmt(sum.processed_ton) },
        { label: 'Dirilis', value: fmt(sum.released_ton) },
    ];
    if (sum.qa_hold_ton > 0) rows.push({ label: 'Ditahan QA', value: fmt(sum.qa_hold_ton) });
    rows.push({ label: 'Stok barang jadi', value: fmt(sum.stock_ton) });
    return rows;
}

/** Status operasi dari server -> baris riwayat, hari terbaru di atas; `current` menandai hari yang sedang diputar. */
export function historyRows(state, currentDay, fmt) {
    return [...state.days].reverse().map((d) => ({
        day: d.day,
        runId: d.run_id,
        current: d.day === currentDay,
        title: `Hari ${d.day} · ${dayDate(d.date)}`,
        detail: d.summary ? `Diterima ${fmt(d.summary.received_ton)}, dirilis ${fmt(d.summary.released_ton)}` : 'Ringkasan tidak tersedia',
    }));
}
