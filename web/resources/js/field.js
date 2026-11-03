import { busyAssets, confirmedKey, createQueue, flush, taskPhase, uuid4 } from './field/model.js';

const root = document.getElementById('field');
const { mode, user, manifestUrl, confirmUrl, token } = root.dataset;
const queue = createQueue(localStorage, `lactos.queue.${user}`);
const cacheKey = `lactos.manifest.${user}`;

let manifest = null;
let offlineData = false;
let lastError = null;
let simFraction = 0;

const $ = (id) => document.getElementById(id);
const el = (tag, text, attrs = {}) => {
    const n = document.createElement(tag);
    if (text != null) n.textContent = text;
    Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
    return n;
};
const hhmm = (iso) => (iso ? new Date(iso).toISOString().slice(11, 16) : '-');

async function loadManifest() {
    try {
        const res = await fetch(manifestUrl, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
        if (!res.ok) throw new Error(String(res.status));
        manifest = await res.json();
        offlineData = false;
        localStorage.setItem(cacheKey, JSON.stringify(manifest));
    } catch {
        const cached = localStorage.getItem(cacheKey);
        manifest = cached ? JSON.parse(cached) : null;
        offlineData = true;
    }
}

async function sync() {
    const r = await flush(queue, async (items) => {
        const res = await fetch(confirmUrl, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-TOKEN': token },
            body: JSON.stringify({ items }),
        });
        return { ok: res.ok, status: res.status, json: res.ok ? await res.json() : null };
    });
    lastError = r.error;
    if (r.sent > 0 || r.dropped > 0) await loadManifest();
    render();
}

function confirm(kind, subject) {
    if (!manifest?.run) return;
    queue.add({ uuid: uuid4(), run_id: manifest.run.id, kind, subject, client_at: new Date().toISOString() });
    render();
    if (navigator.onLine) sync();
}

function isDone(kind, subject) {
    return manifest.confirmed.includes(confirmedKey(kind, subject));
}

function actionCell(kind, subject, label) {
    const td = el('td');
    if (isDone(kind, subject)) td.append(el('span', 'terkonfirmasi', { class: 'ok' }));
    else if (queue.has(kind, subject)) td.append(el('span', 'menunggu kirim'));
    else {
        const b = el('button', label, { type: 'button' });
        b.addEventListener('click', () => confirm(kind, subject));
        td.append(b);
    }
    return td;
}

function renderStatus() {
    const pending = queue.pending().length;
    const parts = [navigator.onLine ? 'Daring' : 'Luring', `${pending} menunggu kirim`];
    if (offlineData) parts.push('data tersimpan di perangkat');
    if (lastError === 'auth') parts.push('sesi berakhir: masuk lagi, antrian tetap tersimpan');
    if (lastError === 'server') parts.push('server gagal, akan dicoba lagi');
    $('field-status').textContent = parts.join(' · ');
    $('field-sync').hidden = pending === 0;
}

function renderTrucks() {
    const body = $('trucks-body');
    body.replaceChildren();
    for (const t of manifest.trucks) {
        const tr = el('tr');
        tr.append(el('td', t.code, { class: 'mono' }), el('td', t.farm_code), el('td', hhmm(t.eta)), actionCell('check_in', t.code, 'Check-in'));
        body.append(tr);
    }
}

function renderOperator() {
    const run = manifest.run;
    const t0 = Date.parse(run.sim_start);
    const t1 = Date.parse(run.sim_end);
    const now = t0 + simFraction * (t1 - t0);
    $('tasks-empty').hidden = manifest.tasks.length > 0;
    $('sim-clock').textContent = hhmm(new Date(now).toISOString());

    const busy = busyAssets(manifest.tasks, now);
    const assets = [...new Set(manifest.tasks.map((t) => t.asset))].sort();
    const abody = $('assets-body');
    abody.replaceChildren();
    for (const a of assets) {
        const tr = el('tr');
        tr.append(el('td', a, { class: 'mono' }), el('td', busy[a] ? `dipakai ${busy[a]}` : 'tersedia'));
        abody.append(tr);
    }

    const labels = { active: 'aktif', upcoming: 'berikutnya', done: 'selesai' };
    const tbody = $('tasks-body');
    tbody.replaceChildren();
    for (const t of manifest.tasks) {
        const phase = taskPhase(t, now);
        if (phase === 'done') continue;
        const tr = el('tr');
        tr.append(el('td', hhmm(t.start)), el('td', t.truck, { class: 'mono' }), el('td', t.label), el('td', labels[phase]), actionCell('handoff', t.key, 'Konfirmasi serah terima'));
        tbody.append(tr);
    }
}

function render() {
    renderStatus();
    if (!manifest?.run) {
        $('field-empty').hidden = false;
        $('field-content').hidden = true;
        return;
    }
    $('field-empty').hidden = true;
    $('field-content').hidden = false;
    renderTrucks();
    if (mode === 'operator') renderOperator();
}

$('field-sync').addEventListener('click', sync);
if (mode === 'operator') {
    $('sim-slider').addEventListener('input', (e) => {
        simFraction = Number(e.target.value) / 100;
        if (manifest?.run) renderOperator();
    });
}
window.addEventListener('online', () => { sync(); });
window.addEventListener('offline', renderStatus);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

(async () => {
    await loadManifest();
    render();
    if (navigator.onLine) await sync();
})();
