// Halaman tanpa hari yang bisa ditonton: mulai operasi (Hari 1) atau tunggu engine selesai menghitung hari yang disiapkan.
import '../css/twin.css';
import { initShell } from './twin/ui/shell.js';

const root = document.getElementById('tw');
initShell(root);
const btn = document.getElementById('op-start');
const msg = document.getElementById('op-msg');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(url, method) {
    const headers = { Accept: 'application/json' };
    if (method === 'POST') headers['X-CSRF-TOKEN'] = document.querySelector('meta[name=csrf-token]')?.content ?? '';
    const res = await fetch(url, { method, headers });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(Object.values(out.errors ?? {}).flat()[0] ?? out.message ?? `Gagal (HTTP ${res.status})`);
    return out;
}

/** Hitung hari yang dituju sampai siap, lalu buka Twin. Pengguna tanpa hak memulai hanya menunggu. */
async function waitDay(canStart) {
    msg.textContent = 'Menyiapkan hari operasi…';
    if (btn) btn.hidden = true;
    try {
        let st = canStart ? await call(root.dataset.advanceUrl, 'POST') : await call(root.dataset.stateUrl, 'GET');
        const want = st.target_day; // hari yang diminta; target bergeser maju setelah hari itu ditonton
        while (st.watch_day < want) {
            await sleep(2500);
            st = st.target_status === 'running' || !canStart ? await call(root.dataset.stateUrl, 'GET') : await call(root.dataset.advanceUrl, 'POST');
        }
        location.reload();
    } catch (e) {
        msg.textContent = e.message;
        if (btn) btn.hidden = false;
    }
}

const canStart = root.dataset.canStart === '1';
btn?.addEventListener('click', () => waitDay(true));
if (root.dataset.waiting === '1') waitDay(canStart);
