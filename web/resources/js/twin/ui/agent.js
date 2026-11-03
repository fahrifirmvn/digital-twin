// Agen Copilot (P6): teks status, ringkasan, dan panel umpan "Ditangani otomatis". Semua teks lewat textContent.
import { h } from './dom.js';
import { clock } from './format.js';

const fmt = (n) => String(n).replace('.', ',');

export const STATUS = {
    verifying: { label: 'Memverifikasi', tone: 'info' },
    awaiting: { label: 'Menunggu persetujuan PPIC', tone: 'warn' },
    applied: { label: 'Diterapkan', tone: 'ok' },
    rejected: { label: 'Tidak lulus verifikasi', tone: 'bad' },
    vetoed: { label: 'Di-veto', tone: 'bad' },
    undone: { label: 'Dibatalkan', tone: 'bad' },
};

/** "Setujui 3 usulan jadwal, tahan 1 truk di gerbang" untuk satu tindakan. */
export function actionTitle(a) {
    const parts = [];
    if (a.approve?.length) parts.push(`setujui ${a.approve.length} usulan jadwal`);
    if (a.hold?.length) parts.push(`tahan ${a.hold.length} truk di gerbang`);
    const text = parts.join(', ') || 'tanpa perintah';
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Hasil verifikasi cabang kandidat dibanding run asalnya, satu kalimat. */
export function verdictText(v) {
    if (!v) return 'Verifikasi sedang berjalan di Engine.';
    switch (v.verdict) {
        case 'lulus': {
            const gap = v.delta === 0 ? 'sama dengan jadwal sistem' : `${fmt(Math.abs(v.delta))} mnt lebih cepat`;
            return `Lulus: tunggu rata-rata ${fmt(v.mean)} mnt dibanding ${fmt(v.base)} mnt, ${gap}.`;
        }
        case 'belum': return `Belum lebih baik: tunggu rata-rata ${fmt(v.mean)} mnt dibanding ${fmt(v.base)} mnt (${fmt(v.delta)} mnt lebih lama).`;
        case 'gagal': return `Gagal: ${v.violations} upaya melewati gate SOP (diblokir).`;
        case 'gagal_run': return 'Simulasi kandidat gagal dijalankan Engine.';
        default: return 'KPI belum tersedia untuk memutuskan.';
    }
}

/** 600 -> "10:00", 65 -> "1:05", <=0 -> "0:00". */
export function countdown(sec) {
    const s = Math.max(0, Math.floor(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Tombol yang berlaku untuk satu tindakan menurut status dan hak pengguna. */
export function actionButtons(a, canAct) {
    if (!canAct) return [];
    if (a.status === 'awaiting') return ['approve', 'veto'];
    if (a.status === 'applied') return a.can_veto ? ['veto', 'undo'] : ['undo'];
    return [];
}

const BTN = { approve: 'Terapkan', veto: 'Veto', undo: 'Batalkan' };

/**
 * Panel agen. `api(method, path, fields)` -> Promise<{ok, data, error}>; `getMinute()` menit penunjuk waktu.
 * `el` memuat seluruh isi kartu; dibuat ulang tiap ada data baru, kecuali saat fokus ada di dalamnya.
 */
export function createAgentPanel({ el, api, runId, getMinute }) {
    let state = null;
    let timer = 0;
    let busy = false;
    let error = '';
    const reasonInput = h('input', { type: 'text', maxlength: '300', autocomplete: 'off', placeholder: 'Alasan keputusan (wajib untuk veto dan batalkan)', 'aria-label': 'Alasan keputusan atas tindakan agen' });
    reasonInput.addEventListener('input', () => {
        error = '';
        const err = el.querySelector('.tw-ag-err');
        if (err) err.textContent = '';
    });
    const errEl = () => h('p', { class: 'tw-sim-err tw-ag-err', role: 'alert' }, error);

    async function call(method, path, fields) {
        busy = true;
        error = '';
        el.setAttribute('aria-busy', 'true');
        const res = await api(method, path, fields);
        busy = false;
        el.removeAttribute('aria-busy');
        if (!res.ok) error = res.error;
        return res;
    }

    // Muat ulang tanpa menghapus pesan galat dari aksi terakhir.
    async function refresh() {
        const res = await api('GET', `/runs/${runId}/agent`);
        if (res.ok) state = res.data;
        else error = res.error;
        render();
        schedule();
    }

    async function decide(a, op) {
        const reason = reasonInput.value.trim() || (op === 'approve' ? 'Lulus verifikasi simulasi' : '');
        if (reason.length < 5) {
            error = 'Isi alasan keputusan dulu (minimal 5 huruf).';
            render();
            reasonInput.focus();
            return;
        }
        const res = await call('POST', `/agent/actions/${a.id}/${op}`, { reason });
        if (res.ok) reasonInput.value = '';
        await refresh();
    }

    async function propose() {
        const res = await call('POST', `/runs/${runId}/agent`, { minute: Math.min(1439, Math.floor(getMinute())) });
        await refresh();
        return res;
    }

    async function saveMandate(form) {
        const f = new FormData(form);
        await call('POST', '/agent/mandate', { level: f.get('level'), max_actions: f.get('max_actions'), reason: f.get('reason') });
        await refresh();
    }

    function item(a) {
        const st = STATUS[a.status] ?? { label: a.status, tone: 'info' };
        const left = a.status === 'applied' && a.can_veto ? h('span', { class: 'tw-ag-left', 'data-until': String(Date.now() + a.veto_left * 1000) }, `veto ${countdown(a.veto_left)}`) : null;
        const who = a.decided_by ? `${a.status === 'applied' ? 'Diterapkan' : 'Diputuskan'} oleh ${a.decided_by}` : null;
        return h('li', { class: 'tw-ag-item', dataset: { status: a.status, tone: st.tone } },
            h('div', { class: 'tw-iv-head' }, h('b', {}, actionTitle(a)), ` pukul ${clock(a.minute)}`, h('span', { class: 'tw-iv-chip' }, st.label)),
            h('p', {}, verdictText(a.verdict)),
            who ? h('p', { class: 'tw-hint' }, `${who}${a.decided_reason ? `: ${a.decided_reason}` : ''}`) : null,
            h('div', { class: 'tw-iv-actions' },
                ...actionButtons(a, state.can.act).map((op) => h('button', { type: 'button', class: `tw-iv-btn${op === 'approve' ? ' primary' : ''}`, onclick: () => !busy && decide(a, op) }, BTN[op])),
                a.fork_url ? h('a', { class: 'tw-iv-btn', href: a.fork_url }, 'Buka cabang') : null,
                left));
    }

    function mandateForm() {
        const m = state.mandate;
        const form = h('form', { class: 'tw-ag-mandate', onsubmit: (e) => { e.preventDefault(); if (!busy) saveMandate(form); } },
            h('label', {}, 'Tingkat otomasi',
                h('select', { name: 'level' }, Object.entries(state.levels).map(([k, v]) => h('option', { value: k, selected: Number(k) === m.level }, `${k}. ${v.label}`)))),
            h('label', {}, 'Maks. perintah per tindakan', h('input', { name: 'max_actions', type: 'number', min: '1', max: String(state.limits.max_actions), value: String(m.max_actions) })),
            h('label', {}, 'Alasan mandat (dicatat)', h('input', { name: 'reason', type: 'text', required: true, minlength: '5', maxlength: '300', autocomplete: 'off', placeholder: 'Mis. shift siang, antrean ringan' })),
            h('button', { type: 'submit', class: 'tw-iv-btn primary' }, 'Simpan mandat'));
        return h('details', { class: 'tw-ag-set' }, h('summary', {}, 'Atur mandat agen'), form);
    }

    function render() {
        // Jangan menimpa isian yang sedang diketik; tombol yang baru diklik boleh digambar ulang.
        if (!state || (el.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName))) return;
        const m = state.mandate;
        const lv = state.levels[m.level];
        const can = state.can;
        const kids = [
            h('p', { class: 'tw-ag-level', dataset: { level: String(m.level) } }, h('b', {}, `Tingkat ${m.level}: ${lv.label}`), h('span', {}, lv.hint),
                m.by ? h('small', {}, `Mandat oleh ${m.by}${m.reason ? `: ${m.reason}` : ''}`) : h('small', {}, 'Bawaan: agen mati sampai PPIC memberi mandat.')),
            can.act ? h('button', { type: 'button', class: 'tw-btn primary block', disabled: m.level < 1, title: m.level < 1 ? 'Naikkan tingkat otomasi dulu' : null, onclick: () => !busy && propose() }, h('span', {}, 'Minta agen bertindak dari ', h('b', { class: 'tw-ag-at' }, clock(getMinute())))) : null,
            errEl(),
            h('h3', {}, 'Ditangani otomatis'),
            state.actions.length ? h('ul', { class: 'tw-iv-list' }, state.actions.map(item)) : h('p', { class: 'tw-hint' }, 'Belum ada tindakan agen pada run ini.'),
            can.act && state.actions.some((a) => actionButtons(a, true).length) ? h('label', { class: 'tw-ag-reason' }, 'Alasan keputusan', reasonInput) : null,
            can.mandate ? mandateForm() : null,
            h('p', { class: 'tw-hint' }, 'Agen hanya menyiapkan cabang simulasi dan memverifikasinya. Gate SOP G1 sampai G6, ambang mutu, dan rilis QA tidak pernah otomatis. Data simulasi, bukan perubahan jadwal nyata.'),
        ];
        el.replaceChildren(...kids.filter(Boolean));
    }

    /** Polling cepat selama ada yang diverifikasi; hitung mundur veto jalan lokal tiap detik. */
    function schedule() {
        clearTimeout(timer);
        if (state?.actions.some((a) => a.status === 'verifying')) timer = setTimeout(refresh, 3000);
    }
    setInterval(() => {
        el.querySelectorAll('.tw-ag-left').forEach((n) => {
            const left = (Number(n.dataset.until) - Date.now()) / 1000;
            n.textContent = `veto ${countdown(left)}`;
            if (left <= 0 && !busy) refresh();
        });
    }, 1000);

    /** Jam di tombol mengikuti penunjuk waktu tanpa menggambar ulang kartu. */
    function sync() {
        const at = el.querySelector('.tw-ag-at');
        if (at) at.textContent = clock(getMinute());
    }

    return { refresh, render, sync };
}
