// Logika murni Driver PWA / Operator View (tanpa DOM), supaya bisa diuji di Node.

export function taskPhase(task, nowMs) {
    const start = Date.parse(task.start);
    const end = task.end ? Date.parse(task.end) : Infinity;
    if (nowMs < start) return 'upcoming';
    return nowMs < end ? 'active' : 'done';
}

/** Aset yang sedang dipakai pada waktu `nowMs`: { 'BAY-4': 'RT-001', ... }. */
export function busyAssets(tasks, nowMs) {
    const out = {};
    for (const t of tasks) if (taskPhase(t, nowMs) === 'active') out[t.asset] = t.truck;
    return out;
}

export function confirmedKey(kind, subject) {
    return `${kind}|${subject}`;
}

export function uuid4(rand = (a) => crypto.getRandomValues(a)) {
    const b = rand(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Antrian konfirmasi di perangkat; `storage` berantarmuka localStorage. */
export function createQueue(storage, key) {
    const read = () => {
        try {
            const v = JSON.parse(storage.getItem(key));
            return Array.isArray(v) ? v : [];
        } catch {
            return [];
        }
    };
    const write = (items) => storage.setItem(key, JSON.stringify(items));
    return {
        pending: read,
        has: (kind, subject) => read().some((i) => i.kind === kind && i.subject === subject),
        add(item) {
            const items = read();
            if (items.some((i) => i.run_id === item.run_id && i.kind === item.kind && i.subject === item.subject)) return false;
            write([...items, item]);
            return true;
        },
        remove(uuids) {
            const drop = new Set(uuids);
            write(read().filter((i) => !drop.has(i.uuid)));
        },
    };
}

/**
 * Kirim antrian. `send(items)` mengembalikan { ok, status, json }. Gagal jaringan/401/419/5xx: item tetap
 * di antrian. Hasil akhir server (recorded, duplicate, rejected, forbidden) dikeluarkan dari antrian.
 */
export async function flush(queue, send, batch = 50) {
    const items = queue.pending().slice(0, batch);
    if (items.length === 0) return { sent: 0, dropped: 0, error: null };
    let res;
    try {
        res = await send(items);
    } catch {
        return { sent: 0, dropped: 0, error: 'offline' };
    }
    if (!res.ok) return { sent: 0, dropped: 0, error: res.status === 401 || res.status === 419 ? 'auth' : 'server' };

    const results = res.json?.results ?? {};
    const done = items.filter((i) => results[i.uuid] !== undefined);
    queue.remove(done.map((i) => i.uuid));
    const dropped = done.filter((i) => ['rejected', 'forbidden'].includes(results[i.uuid])).length;
    return { sent: done.length - dropped, dropped, error: null };
}
