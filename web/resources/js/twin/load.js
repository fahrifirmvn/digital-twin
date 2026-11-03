// Pemuatan replay dan posisi waktu simulasi yang dibagi Dashboard dan Twin (sessionStorage per run).

/** Ambil replay sampai run selesai; onWait(status) dipanggil selama masih berjalan. */
export async function fetchReplay(url, onWait = () => {}) {
    for (;;) {
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.run.status === 'finished') return data;
        if (data.run.status === 'failed') throw new Error(data.run.error ?? 'run gagal');
        onWait(data.run.status);
        await new Promise((r) => setTimeout(r, 1000));
    }
}

const keyOf = (id) => `twin.minute.${id}`;

export function savedMinute(id) {
    try {
        const v = Number(sessionStorage.getItem(keyOf(id)));
        return Number.isFinite(v) && v > 0 ? v : 0;
    } catch { return 0; }
}

export function saveMinute(id, minute) {
    try { sessionStorage.setItem(keyOf(id), String(minute)); } catch { /* sesi tak menyimpan: mulai dari awal */ }
}
