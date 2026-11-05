// Pemuatan replay dan posisi waktu simulasi yang dibagi Dashboard dan Twin (sessionStorage per run).
import { buildModel } from './state.js';

export function speedPayload(runId, speed) {
    const payload = { run_id: Number(runId), speed: Number(speed) };
    if (!Number.isInteger(payload.run_id) || payload.run_id <= 0 || ![1, 5, 20, 60].includes(payload.speed)) throw new Error('Kontrol kecepatan tidak valid.');
    return payload;
}

export function nextOperationRun(state, day) {
    if (state?.live?.run_id && Number(state.live.day) > Number(day)) return { runId: state.live.run_id, day: Number(state.live.day), live: true };
    const closed = state?.days?.find((d) => Number(d.day) === Number(day) + 1 && (d.status == null || d.status === 'closed'));
    return closed ? { runId: closed.run_id, day: Number(closed.day), live: false } : null;
}

export function pollTransition(previous, next, minute, runId) {
    if (Number(next.run.id) !== Number(runId)) throw new Error('Snapshot bukan untuk run yang ditampilkan.');
    const active = isLiveOperation(next);
    if (!active && String(next.run.status).toLowerCase() !== 'finished') throw new Error('Operasi langsung tidak tersedia.');
    const current = active ? liveMinute(minute, next.live) : null;
    const events = mergeEvents(previous, next.events);
    const model = buildModel(events);
    return { events, model, active, minute: active ? current : model.endMin };
}

/** Snapshot consumers never advance a live clock locally; errors retain the last Engine state. */
export function followLive(url, initial, onSnapshot, onError = () => {}) {
    let events = initial.events;
    let minute = liveMinute(0, initial.live);
    let stopped = false;
    let timer;
    async function poll() {
        try {
            const after = events.length ? events.reduce((max, e) => Math.max(max, e.seq), 0) : null;
            const next = await fetchSnapshot(url, after);
            if (stopped) return;
            const transition = pollTransition(events, next, minute, initial.run.id);
            events = transition.events;
            minute = transition.minute;
            stopped = !transition.active;
            onSnapshot(next, transition);
        } catch (error) {
            if (!stopped) onError(error);
        } finally {
            if (!stopped) timer = setTimeout(poll, 1000);
        }
    }
    timer = setTimeout(poll, 1000);
    return () => { stopped = true; clearTimeout(timer); };
}

export function readOnlyLiveControls(root, active) {
    root.dataset.live = active ? '1' : '0';
    for (const id of ['play', 'speed']) {
        const el = root.querySelector(`#${id}`);
        if (el) { el.hidden = active; el.disabled = active; }
    }
    const scrub = root.querySelector('#scrub');
    if (scrub) scrub.disabled = active;
}

export function isLiveOperation(data) {
    return String(data.run.status).toLowerCase() === 'running' && data.run.kind !== 'simulation'
        && (['campaign', 'operation'].includes(data.run.kind) || data.live != null);
}

export function liveMinute(previous, live) {
    if (!live || !Number.isFinite(live.minute) || live.minute < 0) throw new Error('Jam operasi langsung tidak tersedia.');
    if (live.minute < previous) throw new Error('Jam Engine mundur; tampilan langsung dihentikan.');
    return live.minute;
}

export function mergeEvents(previous, incoming) {
    return [...new Map([...previous, ...incoming].map((e) => [e.seq, e])).values()].sort((a, b) => a.seq - b.seq);
}

export async function fetchSnapshot(url, after = null) {
    const target = new URL(url, globalThis.location?.href ?? 'http://localhost');
    if (after != null) target.searchParams.set('after', after);
    const res = await fetch(target.href, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Data operasi tidak tersedia (HTTP ${res.status}).`);
    const data = await res.json();
    if (isLiveOperation(data)) liveMinute(0, data.live);
    if (String(data.run.status).toLowerCase() === 'failed') throw new Error(data.run.error ?? 'run gagal');
    return data;
}

/** Twin boleh membuka live; konsumen replay lain tetap menunggu hasil selesai. */
export async function fetchReplay(url, onWait = () => {}, { allowLive = false } = {}) {
    for (;;) {
        const data = await fetchSnapshot(url);
        if (String(data.run.status).toLowerCase() === 'finished') return data;
        if (allowLive && isLiveOperation(data) && data.events.length) return data;
        onWait(allowLive && isLiveOperation(data) ? 'menyiapkan operasi' : data.run.status);
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
