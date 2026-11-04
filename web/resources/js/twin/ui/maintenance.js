// Maintenance tangki langsung dari twin: meter servis, jadwal untuk hari operasi berikutnya, dan batalkan.
// Server yang memutuskan (aturan keras, hak akses, hash berantai); modul ini hanya menampilkan dan mengirim.
import { h } from './dom.js';
import { DAY_START_MIN, clockOfDay } from './format.js';

export const TANK = /^TK-(RAW|STO)-\d{1,2}$/;
const TONE = { ok: 'ok', near: 'warn', due: 'bad' };
const STATE_LABEL = { ok: 'Normal', near: 'Mendekati batas servis', due: 'Perlu servis' };

/** "HH:MM" jam dinding -> menit sejak awal hari operasi (06:00 = 0). */
export function minuteOfClock(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? '');
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
    return (Number(m[1]) * 60 + Number(m[2]) - DAY_START_MIN + 1440) % 1440;
}

/** Ringkasan satu tangki dari state operasi; null bila tangki itu bukan bagian dari data servis. */
export function maintenanceView(op, asset, { runId, canManage } = {}) {
    const m = op?.maintenance;
    if (!op?.exists || !m || !TANK.test(asset ?? '')) return null;
    if (!op.days?.some((d) => d.run_id === Number(runId))) return null;
    const tank = m.tanks.find((t) => t.asset === asset);
    if (!tank) return null;
    const idx = m.planned.findIndex((p) => p.asset === asset);
    const mine = idx >= 0 ? m.planned[idx] : null;
    return {
        campaignId: op.campaign_id,
        day: m.day,
        date: m.date,
        status: m.status,
        busy: m.status === 'running',
        form: canManage && m.open && !tank.planned,
        meter: { cycles: tank.cycles, limit: tank.limit, pct: Math.min(100, Math.round((tank.cycles / tank.limit) * 100)), state: tank.state, tone: TONE[tank.state], label: STATE_LABEL[tank.state] },
        planned: mine ? { index: idx, start: clockOfDay(mine.minute), end: clockOfDay(mine.minute + mine.duration_min), duration: mine.duration_min } : null,
        carried: tank.planned && !mine,
        limits: m.limits,
    };
}

export function createMaintenance(root, { onChange = () => {} } = {}) {
    const box = root.querySelector('#tw-sheet-maint');
    if (!box || !root.dataset.opStateUrl) return { show() {} };
    const canManage = root.dataset.canAdvance === '1';
    const runId = Number(root.dataset.runId);
    const csrf = () => document.querySelector('meta[name=csrf-token]')?.content ?? '';
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let op = null;
    let asset = null;
    let message = '';
    let failed = false;
    let pending = false;

    const api = async (url, init = {}) => {
        const res = await fetch(url, { credentials: 'same-origin', ...init, headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf(), ...init.headers } });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(Object.values(body.errors ?? {}).flat()[0] ?? body.message ?? `Gagal (HTTP ${res.status})`);
        return body;
    };
    const load = async () => { op = await api(root.dataset.opStateUrl); };

    /** Hari berikutnya dihitung ulang engine setelah perubahan; tunggu sampai selesai. */
    async function settle() {
        pending = true;
        render();
        try {
            for (let i = 0; i < 60 && op?.maintenance?.status === 'running'; i++) {
                await sleep(2500);
                await load();
                render();
            }
        } finally {
            pending = false;
            render();
        }
    }

    async function send(url, init, ok) {
        message = '';
        failed = false;
        pending = true;
        render();
        try {
            op = await api(url, init);
            message = ok;
            onChange(op);
            await settle();
        } catch (e) {
            message = e.message;
            failed = true;
            pending = false;
            render();
        }
    }

    function render() {
        const v = asset && maintenanceView(op, asset, { runId, canManage });
        box.hidden = !v;
        if (!v) return box.replaceChildren();
        const base = `${root.dataset.opPlanBase}/${v.campaignId}/maintenance`;
        const body = [
            h('h3', {}, 'Servis tangki'),
            h('div', { class: 'tw-meter', dataset: { tone: v.meter.tone } },
                h('div', { class: 'tw-meter-bar', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': v.meter.limit, 'aria-valuenow': v.meter.cycles, 'aria-label': 'Siklus sejak servis terakhir' },
                    h('i', { style: `width:${v.meter.pct}%` })),
                h('p', {}, h('b', {}, `${v.meter.cycles} dari ${v.meter.limit} siklus CIP`), ` · ${v.meter.label}`)),
        ];
        if (v.planned) {
            body.push(h('p', { class: 'tw-maint-note' }, `Terjadwal Hari ${v.day}: ${v.planned.start}–${v.planned.end} (${v.planned.duration} menit).`));
            if (canManage) {
                body.push(h('button', { type: 'button', class: 'tw-btn block', disabled: pending || v.busy,
                    onclick: () => send(`${base}/${v.planned.index}`, { method: 'DELETE' }, `Jadwal ${asset} dibatalkan.`) }, 'Batalkan jadwal'));
            }
        } else if (v.carried) {
            body.push(h('p', { class: 'tw-maint-note' }, 'Tangki ini masih dalam servis lanjutan dari hari sebelumnya.'));
        } else if (v.form) {
            const start = h('input', { id: 'mt-start', type: 'time', value: '08:00', required: true });
            const dur = h('input', { id: 'mt-dur', type: 'number', min: v.limits.duration_min[0], max: v.limits.duration_min[1], step: 15, value: 120, required: true });
            const why = h('input', { id: 'mt-why', type: 'text', minlength: 5, maxlength: 200, value: v.meter.state === 'ok' ? '' : 'Servis berkala', placeholder: 'Alasan (min. 5 karakter)', required: true });
            body.push(h('form', { class: 'tw-maint-form', onsubmit: (e) => {
                e.preventDefault();
                const minute = minuteOfClock(start.value);
                if (minute === null) { message = 'Jam mulai tidak valid.'; failed = true; return render(); }
                send(base, { method: 'POST', body: JSON.stringify({ asset, start_min: minute, duration_min: Number(dur.value), reason: why.value.trim() }) },
                    `${asset} dijadwalkan servis pada Hari ${v.day}.`);
            } },
            h('label', { for: 'mt-start' }, 'Mulai'), start,
            h('label', { for: 'mt-dur' }, 'Durasi (menit)'), dur,
            h('label', { for: 'mt-why' }, 'Alasan'), why,
            h('button', { type: 'submit', class: 'tw-btn primary block', disabled: pending || v.busy }, `Jadwalkan untuk Hari ${v.day}`)));
            body.push(h('p', { class: 'tw-hint' }, `Berlaku mulai Hari ${v.day} (${v.date}). Hari yang sedang ditonton tidak berubah.`));
        } else if (v.busy) {
            body.push(h('p', { class: 'tw-maint-note' }, `Hari ${v.day} sedang dihitung ulang…`));
        } else if (!canManage) {
            body.push(h('p', { class: 'tw-hint' }, 'Jadwal servis hanya dapat diatur PPIC atau Admin.'));
        }
        if (pending && v.busy) body.push(h('p', { class: 'tw-maint-note', role: 'status' }, `Menghitung ulang Hari ${v.day}…`));
        if (message) body.push(h('p', { class: 'tw-maint-msg', role: 'status', dataset: { tone: failed ? 'bad' : 'ok' } }, message));
        box.replaceChildren(...body);
    }

    return {
        /** Dipanggil saat pilihan di twin berubah (kode aset atau null). */
        async show(code) {
            asset = TANK.test(code ?? '') ? code : null;
            message = '';
            failed = false;
            if (!asset) return render();
            try {
                await load();
            } catch {
                op = null;
            }
            if (asset === code) render();
        },
    };
}
