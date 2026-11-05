// Satu perintah maintenance operasi; waktu dan pelaksanaannya diputuskan Engine.
// Server yang memutuskan (aturan keras, hak akses, hash berantai); modul ini hanya menampilkan dan mengirim.
import { h } from './dom.js';
import { DAY_START_MIN, clockOfDay } from './format.js';
import { MAINTENANCE_LABEL } from '../state.js';

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
    const active = Number(op.live?.run_id) === Number(runId);
    if (!active && !op.days?.some((d) => Number(d.run_id) === Number(runId))) return null;
    const tank = m.tanks.find((t) => t.asset === asset);
    if (!tank) return null;
    const idx = (m.planned ?? []).findIndex((p) => p.asset === asset);
    const mine = idx >= 0 ? m.planned[idx] : null;
    return {
        campaignId: op.campaign_id,
        day: m.day,
        date: m.date,
        status: m.status,
        busy: m.status === 'running',
        form: canManage && (active || m.open || !!op.live),
        active,
        minDay: op.live?.day ?? op.target_day ?? m.day,
        schedules: (m.schedules ?? []).filter((p) => p.asset === asset),
        meter: { cycles: tank.cycles, limit: tank.limit, pct: Math.min(100, Math.round((tank.cycles / tank.limit) * 100)), state: tank.state, tone: TONE[tank.state], label: STATE_LABEL[tank.state] },
        planned: mine ? { index: idx, start: clockOfDay(mine.minute), end: clockOfDay(mine.minute + mine.duration_min), duration: mine.duration_min } : null,
        carried: tank.planned && !mine,
        limits: m.limits,
    };
}

export function maintenancePayload({ requestId, runId, asset, mode, day, time, duration, reason }, op, minute = null) {
    const limits = op.maintenance.limits;
    const durationMin = Number(duration);
    const why = reason.trim();
    if (!TANK.test(asset) || !['now', 'scheduled'].includes(mode)) throw new Error('Perintah maintenance tidak valid.');
    if (!Number.isInteger(durationMin) || durationMin < limits.duration_min[0] || durationMin > limits.duration_min[1]) throw new Error('Durasi di luar batas maintenance.');
    if (why.length < 5 || why.length > 200) throw new Error('Alasan wajib 5–200 karakter.');
    const payload = { request_id: requestId, run_id: Number(runId), asset, mode, duration_min: durationMin, reason: why };
    if (mode === 'scheduled') {
        const d = Number(day);
        const minDay = op.live?.day ?? op.target_day ?? op.maintenance.day;
        const start = minuteOfClock(time);
        if (!Number.isInteger(d) || d < Math.max(minDay, limits.day[0]) || d > limits.day[1]) throw new Error('Hari jadwal di luar batas operasi.');
        if (start === null) throw new Error('Jam mulai tidak valid.');
        if (Number(runId) === Number(op.live?.run_id) && d === Number(op.live.day) && minute != null && start <= minute) throw new Error('Jadwal hari ini harus setelah jam Engine saat ini.');
        Object.assign(payload, { day: d, start_min: start });
    } else {
        if (!op.live) throw new Error('Tidak ada hari operasi aktif untuk maintenance langsung.');
        if (Number(runId) !== Number(op.live.run_id)) throw new Error(`Buka Hari ${op.live.day} yang aktif untuk maintenance langsung; halaman ini adalah riwayat.`);
    }
    return payload;
}

export function maintenanceAcknowledgement(command) {
    if (command?.status === 'error') throw new Error(command.message ?? 'Perintah maintenance ditolak.');
    const labels = { accepted: 'Perintah diterima; menunggu pelaksanaan', scheduled: 'Maintenance dijadwalkan', ...MAINTENANCE_LABEL };
    if (!Object.hasOwn(labels, command?.status)) {
        throw new Error(command?.message ?? 'Penerimaan perintah belum pasti. Coba kembali dengan request_id yang sama.');
    }
    return `Perintah ${command.id}: ${labels[command.status]}${command.day_no != null ? ` · Hari ${command.day_no}` : ''}.`;
}

export function createMaintenance(root, { onChange = () => {} } = {}) {
    const box = root.querySelector('#tw-sheet-maint');
    if (!box || !root.dataset.opStateUrl) return { show() {}, update() {}, setLive() {}, setLifecycle() {} };
    const canManage = root.dataset.canAdvance === '1';
    const runId = Number(root.dataset.runId);
    const csrf = () => document.querySelector('meta[name=csrf-token]')?.content ?? '';
    let op = null;
    let asset = null;
    let message = '';
    let failed = false;
    let pending = false;
    let minute = null;
    let minuteRunId = null;
    let lifecycle = {};
    let lifecycleSig = '';
    let form = null;
    let info = null;
    let status = null;
    let requestId = null;

    const api = async (url, init = {}) => {
        const res = await fetch(url, { credentials: 'same-origin', ...init, headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf(), ...init.headers } });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(Object.values(body.errors ?? {}).flat()[0] ?? body.message ?? `Gagal (HTTP ${res.status})`);
        return body;
    };
    async function send(url, init, ok) {
        message = '';
        failed = false;
        pending = true;
        render();
        try {
            const out = await api(url, init);
            op = out;
            message = init.method === 'POST' ? maintenanceAcknowledgement(out.command) : ok;
            requestId = null;
            onChange(op);
        } catch (e) {
            message = e.message;
            failed = true;
        } finally {
            pending = false;
            render();
        }
    }

    function render() {
        const v = asset && maintenanceView(op, asset, { runId, canManage });
        box.hidden = !v;
        if (!v) {
            if (asset && message && failed) {
                box.hidden = false;
                box.replaceChildren(h('p', { class: 'tw-maint-msg', role: 'alert', dataset: { tone: 'bad' } }, message));
                form = info = status = null;
            }
            return;
        }
        const base = `${root.dataset.opPlanBase}/${v.campaignId}/maintenance`;
        const body = [
            h('h3', {}, 'Maintenance tangki'),
            h('div', { class: 'tw-meter', dataset: { tone: v.meter.tone } },
                h('div', { class: 'tw-meter-bar', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': v.meter.limit, 'aria-valuenow': v.meter.cycles, 'aria-label': 'Siklus sejak servis terakhir' },
                    h('i', { style: `width:${v.meter.pct}%` })),
                h('p', {}, h('b', {}, `${v.meter.cycles} dari ${v.meter.limit} siklus CIP`), ` · ${v.meter.label}`)),
        ];
        if (!v.active) {
            body.push(h('p', { class: 'tw-maint-note' }, `Hari yang ditampilkan sudah selesai dan sedang diputar ulang. Maintenance langsung hanya tersedia pada hari aktif, bukan rekaman ini.`));
            if (op.live) {
                body.push(h('a', { class: 'tw-btn block', href: `${root.dataset.twinRunUrl}${op.live.run_id}` }, `Buka Hari ${op.live.day} · aktif`));
            } else {
                body.push(h('p', { class: 'tw-hint' }, `Belum ada hari aktif. Mulai Hari ${v.minDay} dari ringkasan akhir hari untuk menjalankan operasi langsung.`));
            }
        }
        if (v.planned) {
            body.push(h('p', { class: 'tw-maint-note' }, `Jadwal lama · Hari ${v.day}: ${v.planned.start}–${v.planned.end} (${v.planned.duration} menit).`));
            if (canManage) {
                body.push(h('button', { type: 'button', class: 'tw-btn block', disabled: pending || v.busy,
                    onclick: () => send(`${base}/${v.planned.index}`, { method: 'DELETE' }, `Jadwal ${asset} dibatalkan.`) }, 'Batalkan jadwal lama'));
            }
        } else if (v.carried) {
            body.push(h('p', { class: 'tw-maint-note' }, 'Tangki ini masih dalam servis lanjutan dari hari sebelumnya.'));
        }
        for (const schedule of v.schedules) body.push(h('p', { class: 'tw-maint-note' }, `#${schedule.id} · Hari ${schedule.day_no} · ${clockOfDay(schedule.start_min)} · ${schedule.duration_min} menit · ${schedule.status}`));
        const current = lifecycle[asset];
        if (current) body.push(h('p', { class: 'tw-maint-lifecycle', role: 'status' }, `${MAINTENANCE_LABEL[current.status]} (${current.duration_min} menit).`));
        body.push(h('p', { class: 'tw-hint' }, 'Perintah ini mengatur model operasi Engine, bukan kendali PLC fisik. Maintenance langsung memblokir aliran masuk baru, lalu menunggu pengurasan/pembersihan aman.'));
        if (!info) {
            info = h('div');
            status = h('p', { class: 'tw-maint-msg', role: 'status' });
            box.replaceChildren(info, status);
        }
        info.replaceChildren(...body);
        if (v.form && !form) {
            const timing = h('select', { id: 'mt-mode' }, h('option', { value: 'now' }, 'Langsung'), h('option', { value: 'scheduled' }, 'Jadwalkan'));
            const day = h('input', { id: 'mt-day', type: 'number', step: 1, value: v.minDay, required: true });
            const start = h('input', { id: 'mt-start', type: 'time', value: '08:00', required: true });
            const dur = h('input', { id: 'mt-dur', type: 'number', min: v.limits.duration_min[0], max: v.limits.duration_min[1], step: 15, value: 120, required: true });
            const why = h('input', { id: 'mt-why', type: 'text', minlength: 5, maxlength: 200, value: v.meter.state === 'ok' ? '' : 'Servis berkala', placeholder: 'Alasan (min. 5 karakter)', required: true });
            form = h('form', { class: 'tw-maint-form', oninput: () => { requestId = null; }, onsubmit: (e) => {
                e.preventDefault();
                if (pending) return;
                try {
                    requestId ??= crypto.randomUUID();
                    const payload = maintenancePayload({ requestId, runId, asset, mode: timing.value, day: day.value, time: start.value, duration: dur.value, reason: why.value }, op, Number(op.live?.run_id) === minuteRunId ? minute : null);
                    send(root.dataset.opMaintenanceUrl, { method: 'POST', body: JSON.stringify(payload) }, 'Perintah maintenance diterima.');
                } catch (e) {
                    message = e.message;
                    failed = true;
                    render();
                }
            } },
            h('label', { for: 'mt-mode' }, 'Waktu maintenance'), timing,
            h('label', { for: 'mt-day', 'data-scheduled': true }, 'Hari operasi'), day,
            h('label', { for: 'mt-start' }, 'Mulai'), start,
            h('label', { for: 'mt-dur' }, 'Durasi (menit)'), dur,
            h('label', { for: 'mt-why' }, 'Alasan'), why,
            h('button', { type: 'submit', class: 'tw-btn primary block' }, 'Terapkan maintenance'));
            if (!v.active) timing.value = 'scheduled';
            const syncTiming = () => {
                for (const el of [day, start]) {
                    el.hidden = timing.value !== 'scheduled';
                    el.disabled = el.hidden;
                    form.querySelector(`[for="${el.id}"]`).hidden = el.hidden;
                }
            };
            timing.addEventListener('change', syncTiming);
            syncTiming();
            box.insertBefore(form, status);
        }
        if (form) {
            form.hidden = !v.form;
            form.querySelector('button').disabled = pending;
            const day = form.querySelector('#mt-day');
            day.min = Math.max(v.minDay, v.limits.day?.[0] ?? v.minDay);
            day.max = v.limits.day?.[1] ?? v.minDay;
            form.querySelector('option[value=now]').disabled = !v.active;
            const timing = form.querySelector('#mt-mode');
            if (!v.active && timing.value === 'now') {
                timing.value = 'scheduled';
                timing.dispatchEvent(new Event('change'));
            }
        }
        status.textContent = message || (!canManage ? 'Maintenance hanya dapat diatur PPIC atau Admin.' : '');
        status.dataset.tone = failed ? 'bad' : 'ok';
    }

    return {
        /** Dipanggil saat pilihan di twin berubah (kode aset atau null). */
        async show(code) {
            if (asset === code) return;
            asset = TANK.test(code ?? '') ? code : null;
            form = info = status = null;
            box.replaceChildren();
            message = '';
            failed = false;
            if (!asset) return render();
            try {
                op = await api(root.dataset.opStateUrl);
            } catch {
                message = 'Status maintenance tidak dapat dimuat.';
                failed = true;
            }
            if (asset === code) render();
        },
        update(state) { op = state; render(); },
        setLive(live) { minute = live?.minute ?? null; minuteRunId = live ? runId : null; },
        setLifecycle(state) {
            const next = state.maintenance ?? {};
            const sig = JSON.stringify(next);
            if (sig === lifecycleSig) return;
            lifecycleSig = sig;
            lifecycle = next;
            if (asset) render();
        },
    };
}
