// Halaman Digital Twin: panggung 3D/2D penuh layar dengan panel statistik, pelacakan, kontrol peta, dan tabel aset.
import '../css/twin.css';
import { TwinCanvas } from './twin/canvas.js';
import { layoutFromPlant } from './twin/layout/plant.js';
import { fetchReplay, fetchSnapshot, isLiveOperation, liveMinute, nextOperationRun, pollTransition, speedPayload, saveMinute, savedMinute } from './twin/load.js';
import { QualityGovernor, TIERS, detectTier, deviceSignals } from './twin/kit/quality.js';
import { Replay, buildModel } from './twin/state.js';
import { commandLog } from './twin/ui/commands.js';
import { createInterventionPanel } from './twin/ui/intervene.js';
import { decisionsAt, planAt, proposalRows } from './twin/ui/proposals.js';
import { interventionScore } from './twin/ui/score.js';
import { chipEl, h } from './twin/ui/dom.js';
import { clock, dayProgress, fmtL } from './twin/ui/format.js';
import { dayDate, daySummaryRows, historyRows } from './twin/ui/day.js';
import { deltaText, impactRows } from './twin/ui/impact.js';
import { assetRows, layoutCodes, liveStats, trackerSteps } from './twin/ui/live.js';
import { initShell, setStatus } from './twin/ui/shell.js';
import { createStage } from './twin/ui/stage.js';
import { createMaintenance } from './twin/ui/maintenance.js';
import { truckStatus } from './twin/ui/status.js';
import { QA_RESULT_FIELDS, clearQaPending, qaActions, qaPayload, qaPendingKey, qaRequestId, qaResultsDl, readQaPending, writeQaPending } from './twin/ui/qa.js';

const root = document.getElementById('tw');
const $ = (id) => document.getElementById(id);
const runId = root.dataset.runId;
// Denah 3D mengikuti jumlah modul run ini; pabrik bawaan bila tidak diubah.
const LAYOUT = layoutFromPlant(JSON.parse(root.dataset.plant || 'null'));
const CODES = layoutCodes(LAYOUT);

let scene3d = null;
const shell = initShell(root, { onTheme: (t) => scene3d?.setTheme(t) });

// Esc yang tidak dipakai sheet, drawer, atau kolom isian = keluar dari bangunan, atau Perkecil bila sudah di luar.
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open], :popover-open')) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (root.dataset.view === 'process') return;
    if (scene3d?.inside) {
        scene3d.setZone('all');
        markZone('all');
        return;
    }
    $('tw-minimize').click();
});

// Zona Proses: papan alur hidup dari state replay yang sama dengan Twin 3D, dimuat malas saat tombol "Proses" dipakai pertama kali.
let proc = null;
let lastState = null;
let selectedCode = () => null;
const PLANT = JSON.parse(root.dataset.plant || 'null');
async function setSurface(next) {
    const wantProc = next === 'proc';
    if (wantProc && !proc) {
        try {
            const { mountProcess } = await import('./twin/process/zona-proses.js');
            proc = mountProcess($('tw-proc'), {
                plant: PLANT,
                onLocate: (code) => {
                    setSurface('recv');
                    document.dispatchEvent(new CustomEvent('twin:select', { detail: { code } }));
                },
            });
        } catch {
            $('view-msg').textContent = 'Zona Proses tidak dapat dimuat.';
            return;
        }
    }
    root.dataset.view = wantProc ? 'process' : 'recv';
    $('view-recv').setAttribute('aria-pressed', String(!wantProc));
    $('view-proc').setAttribute('aria-pressed', String(wantProc));
    document.dispatchEvent(new CustomEvent('twin:context', { detail: { view: wantProc ? 'process' : 'recv' } }));
    if (wantProc) {
        proc.show();
        if (lastState) proc.update(lastState);
        const sel = selectedCode();
        if (sel) proc.select(sel);
    } else proc?.hide();
}
$('view-recv').addEventListener('click', () => setSurface('recv'));
$('view-proc').addEventListener('click', () => setSurface('proc'));
if (new URLSearchParams(location.search).get('zona') === 'proses') setSurface('proc');

function markZone(zone) {
    document.querySelectorAll('.tw-seg-z button').forEach((o) => o.setAttribute('aria-pressed', String(o.dataset.zone === zone)));
}

function start(data) {
    let active = isLiveOperation(data);
    let rawEvents = data.events;
    let model = buildModel(rawEvents);
    let total = model.events.filter((e) => e.p.type === 'truck.arrived').length;
    let replay = new Replay(model, { live: active });
    const twin = new TwinCanvas($('twin'));
    const maint = createMaintenance(root);
    const stage = createStage(root, { onSelect: (code) => { renderTrack(replay.state); renderQa(replay.state); maint.show(code); }, anomaly: JSON.parse(root.dataset.anomaly || 'null') });
    let view = '2d';
    selectedCode = () => stage.selected;
    document.addEventListener('twin:select', (e) => stage.select(e.detail.code));
    let speed = Number($('speed').value);
    let playing = !active;
    // Cabang simulasi dibuka sedikit sebelum perintah terakhir, supaya sebabnya terlihat.
    const isSim = data.run.kind === 'simulation';
    const saved = savedMinute(runId);
    let minute = active ? liveMinute(0, data.live) : Math.min(saved > 0 ? saved : (isSim && data.run.fork_minute ? Math.max(0, data.run.fork_minute - 15) : 0), model.endMin);
    let tab = 'bay';
    let trackSig = '';
    let rowsSig = '';
    let qaSig = '';
    let qaStorage = null;
    try { qaStorage = sessionStorage; } catch { /* penyimpanan sesi tidak tersedia */ }
    const qaPendingByTruck = new Map();
    const qaDraftByTruck = new Map();
    const qaErrors = new Map();
    const qaMessages = new Map();
    const qaBusy = new Set();

    // Kualitas grafis: otomatis (tier dari perangkat, disesuaikan governor) atau dipilih pengguna.
    const autoTier = detectTier(deviceSignals());
    const qSelect = $('tw-quality');
    let qPref = 'auto';
    try { qPref = localStorage.getItem('twin.quality') ?? 'auto'; } catch { /* preferensi tak tersimpan */ }
    if (qPref !== 'auto' && !TIERS[qPref]) qPref = 'auto';
    const governor = new QualityGovernor(qPref === 'auto' ? autoTier : qPref, (tier) => {
        scene3d?.setQuality(tier);
        qLabel();
    });
    function qLabel() {
        qSelect.value = qPref;
        qSelect.options[0].textContent = qPref === 'auto' ? `Otomatis (${TIERS[governor.tier].label})` : 'Otomatis';
    }
    qSelect.addEventListener('change', () => {
        qPref = qSelect.value;
        try { localStorage.setItem('twin.quality', qPref); } catch { /* preferensi tak tersimpan */ }
        governor.set(qPref === 'auto' ? autoTier : qPref);
        scene3d?.setQuality(governor.tier);
        qLabel();
    });
    qLabel();

    const scrub = $('scrub');
    scrub.max = Math.ceil(model.endMin);
    const replaySpeeds = [...$('speed').options].map((o) => ({ value: o.value, label: o.textContent }));
    function syncLiveControls() {
        root.dataset.live = active ? '1' : '0';
        $('play').hidden = active;
        $('play').disabled = active;
        scrub.disabled = active;
        $('day-end').hidden = active;
        $('day-end').disabled = active;
        $('speed').replaceChildren(...(active
            ? [1, 5, 20, 60].map((n) => h('option', { value: n }, `${n}x`))
            : replaySpeeds.map((o) => h('option', { value: o.value }, o.label))));
        speed = active ? data.live.speed : Number(replaySpeeds[1].value);
        $('speed').value = speed;
        $('speed').disabled = active && root.dataset.canAdvance !== '1';
        $('tw-live-clock').hidden = false;
        $('tw-live-clock').textContent = active ? 'Hari aktif · langsung dari Engine' : 'Riwayat · putar ulang hari selesai';
        $('tw-timer-source').textContent = active ? 'Tersinkron dengan Engine' : 'Posisi putar ulang';
        const timerDay = model.events.find((e) => e.p.type === 'day.started')?.p.day;
        $('tw-timer-day').textContent = timerDay != null ? `Hari ${timerDay}` : `Run #${data.run.id}`;
        const stats = root.querySelector('.tw-stats');
        stats.setAttribute('aria-label', active ? 'Statistik hari aktif' : 'Statistik rekaman');
        stats.querySelector('h2').textContent = active ? 'Statistik Hari Aktif' : 'Statistik Rekaman';
        stats.querySelector('.tw-fold')?.setAttribute('aria-label', `${stats.classList.contains('is-folded') ? 'Buka' : 'Ciutkan'} ${stats.querySelector('h2').textContent}`);
    }
    syncLiveControls();
    maint.setLive(data.live);

    function setStat(id, val) {
        const el = $(id);
        const str = String(val);
        if (el.textContent !== str) {
            const hadPrev = el.dataset.ready === '1';
            el.textContent = str;
            el.dataset.ready = '1';
            if (hadPrev) {
                const box = el.closest('.tw-stat');
                if (box) {
                    box.dataset.flash = '1';
                    setTimeout(() => { delete box.dataset.flash; }, 320);
                }
            }
        }
    }

    function renderStats(s) {
        const k = liveStats(s, total);
        setStat('s-waiting', k.waiting);
        setStat('s-wait', k.avgWaitMin == null ? '-' : Math.round(k.avgWaitMin));
        setStat('s-lab', k.labQueue);
        setStat('s-qa-holds', k.qaHolds);
        $('s-qa-holds-box').dataset.tone = k.qaHolds ? 'bad' : '';
        setStat('s-holds', k.holds);
        $('s-holds-box').dataset.tone = k.holds ? 'bad' : '';
        setStat('s-inbound', k.inbound);
        setStat('s-detected', k.detected);
    }

    /** Truk yang dilacak: truk terpilih, atau truk yang sedang bongkar di aset terpilih. */
    function trackedTruck(s) {
        const sel = stage.selected;
        if (!sel) return null;
        return s.tankers[sel] ?? Object.values(s.tankers).find((t) => t.status === 'unloading' && t.bay === sel) ?? null;
    }

    function renderTrack(s) {
        const t = trackedTruck(s);
        const body = $('tw-track-body');
        const ago = t ? Math.max(0, Math.round(s.m - t.since)) : 0;
        const ph = t?.lab?.ph != null ? ` · pH ${Number(t.lab.ph).toFixed(2).replace('.', ',')}` : '';
        const sig = t ? `${t.code}|${t.plate}|${t.status}|${t.held}|${t.qa?.status}|${ph}|${ago}` : '-';
        if (sig === trackSig) return;
        trackSig = sig;
        if (!t) {
            body.replaceChildren(h('p', { class: 'tw-hint' }, 'Pilih truk pada peta atau tabel untuk melihat tahapnya.'));
            return;
        }
        const st = truckStatus(t);
        body.replaceChildren(
            h('p', { class: 'tw-track-title' }, h('b', {}, t.code), t.plate ? ` · ${t.plate}` : '', ` · ${t.farm} · ${fmtL(t.volume)}${ph}`),
            h('ol', { class: 'tw-steps' }, trackerSteps(t).map((step) => h('li', { dataset: { state: step.state } }, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', {}, step.label), step.state !== 'todo' ? h('span', { class: 'sr-only' }, step.state === 'done' ? ' (selesai)' : step.state === 'bad' ? ' (bermasalah)' : ' (sekarang)') : null))),
            h('p', { class: 'tw-hint' }, `${st.label}, ${ago} mnt di tahap ini`),
        );
    }

    function renderQa(s) {
        const box = $('tw-sheet-qa');
        const content = $('tw-qa-content');
        const code = stage.selected;
        const t = code ? s.tankers[code] : null;
        if (!t || (t.status !== 'qa_hold' && !t.qaHistory?.length)) {
            box.hidden = true;
            content.replaceChildren();
            qaSig = '';
            return;
        }
        box.hidden = false;
        const key = qaPendingKey(runId, t.code);
        let pending = qaPendingByTruck.get(t.code) ?? readQaPending(qaStorage, key);
        if (pending) qaPendingByTruck.set(t.code, pending);
        if (pending && t.qaHistory?.some((event) => event.request_id === pending.payload.request_id)) {
            clearQaPending(qaStorage, key);
            qaPendingByTruck.delete(t.code);
            qaMessages.delete(t.code);
            qaErrors.delete(t.code);
            pending = null;
        }
        const draft = qaDraftByTruck.get(t.code);
        const actions = qaActions(t, { active, canQa: root.dataset.canQa === '1', minute: s.m });
        const sig = JSON.stringify([
            t.code, t.status, t.farm, t.volume, t.qaHistory ?? [], active, root.dataset.canQa,
            actions, pending, draft, qaErrors.get(t.code), qaMessages.get(t.code), qaBusy.has(t.code),
        ]);
        if (sig === qaSig) return;
        qaSig = sig;

        const statusLabels = { held: 'Ditahan', testing: 'Konfirmasi sedang diuji', confirmed: 'Terkonfirmasi', released: 'Dirilis QA', rejected: 'Ditolak' };
        const categoryLabels = { incomplete: 'Belum lengkap', quality: 'Mutu', hazard: 'Bahaya', pass: 'Lulus' };
        const dispositionLabels = { return_supplier: 'Kembalikan ke pemasok', controlled_disposal: 'Pemusnahan terkendali', unresolved_hold: 'Ditolak saat hold belum terselesaikan' };
        const eventRows = (t.qaHistory ?? []).slice().reverse().map((event) => {
            const failures = (event.failures ?? []).map((failure) => {
                const bounds = [
                    failure.minimum == null ? null : `min ${failure.minimum}`,
                    failure.maximum == null ? null : `maks ${failure.maximum}`,
                ].filter(Boolean).join(' · ');
                return h('li', {},
                    h('b', {}, failure.parameter),
                    `: ${failure.value ?? '—'}${bounds ? ` (${bounds})` : ''}`,
                    failure.reason ? ` · ${failure.reason}` : '',
                );
            });
            const results = event.results && Object.keys(event.results).length
                ? h('div', { class: 'tw-qa-values' },
                    h('p', { class: 'tw-qa-synthetic' }, 'Nilai sintetis yang dimasukkan QA di Digital Twin — bukan hasil laboratorium nyata.'),
                    qaResultsDl(event.results))
                : null;
            return h('li', { class: 'tw-qa-event' },
                h('b', {}, statusLabels[event.status] ?? event.status),
                event.category ? h('span', { class: 'tw-qa-category', dataset: { category: event.category } }, categoryLabels[event.category] ?? event.category) : null,
                h('small', {}, `${event.actor ?? 'Engine'} · ${event.reason ?? 'Tanpa alasan'}`),
                event.disposition ? h('small', {}, dispositionLabels[event.disposition] ?? event.disposition) : null,
                event.expires_min != null && event.status === 'held'
                    ? h('small', {}, `Batas hold menit operasi ${event.expires_min}${event.expires_min > s.m ? ` · ${Math.floor(event.expires_min - s.m)} mnt tersisa` : ' · batas waktu tercapai'}`)
                    : null,
                failures.length ? h('ul', { class: 'tw-qa-failures' }, failures) : null,
                results,
            );
        });
        const latest = t.qa;
        const testingAttempts = (t.qaHistory ?? []).filter((event) => event.status === 'testing').length;
        const contentNodes = [
            h('p', { class: 'tw-qa-risk' }, `Pemasok ${t.farm} · ${Number(t.volume).toLocaleString('id-ID', { maximumFractionDigits: 2 })} ton tertahan dari penerimaan. Potensi kekurangan penerimaan sebesar volume ini; stok/pasokan tidak diubah otomatis.`),
            h('p', { class: 'tw-qa-attempts' }, `Konfirmasi retest: ${testingAttempts} dari 1 percobaan`),
            eventRows.length ? h('ol', { class: 'tw-qa-history' }, eventRows) : h('p', { class: 'tw-hint' }, 'Belum ada review QA pada riwayat run ini.'),
        ];
        if (latest?.disposition === 'unresolved_hold') {
            contentNodes.push(h('p', { class: 'tw-qa-note', dataset: { tone: 'warn' } }, 'Penerimaan ditolak karena hold tidak terselesaikan; ini bukan klaim bahwa produk telah dibuang secara fisik.'));
        }
        const error = qaErrors.get(t.code);
        if (error) contentNodes.push(h('p', { class: 'tw-qa-error', role: 'alert' }, error));
        const message = qaMessages.get(t.code) ?? (pending?.accepted
            ? `Perintah ${pending.payload.action} diterima (${pending.commandId ?? 'ID tersimpan'}); menunggu event QA dari Engine.`
            : null);
        if (message) contentNodes.push(h('p', { class: 'tw-qa-message', role: 'status' }, message));

        if (actions.length && !pending?.accepted) {
            const retrying = Boolean(pending);
            const action = retrying ? pending.payload.action : (draft?.action ?? '');
            const select = h('select', { name: 'action', required: true, 'aria-label': 'Tindakan QA', disabled: retrying },
                h('option', { value: '' }, 'Pilih tindakan QA'),
                ...actions.map((item) => h('option', { value: item, selected: item === action }, ({ retest: 'Retest satu kali', release: 'Rilis dari hold QA', reject: 'Tolak truk' })[item])),
            );
            const retestFields = h('fieldset', { class: 'tw-qa-results', hidden: action !== 'retest', disabled: retrying || action !== 'retest' },
                h('legend', {}, 'Nilai konfirmasi retest'),
                ...QA_RESULT_FIELDS.map(([field, label]) => h('label', {}, label,
                    h('input', { type: 'number', name: field, step: 'any', required: true, value: pending?.payload.results?.[field] ?? draft?.results?.[field] ?? '' }),
                )),
            );
            const dispositionField = h('label', { class: 'tw-qa-disposition', hidden: action !== 'reject' }, 'Disposisi penolakan',
                h('select', { name: 'disposition', required: action === 'reject', disabled: retrying },
                    h('option', { value: '' }, 'Pilih disposisi'),
                    h('option', { value: 'return_supplier', selected: (pending?.payload.disposition ?? draft?.disposition) === 'return_supplier' }, 'Kembalikan ke pemasok'),
                    h('option', { value: 'controlled_disposal', selected: (pending?.payload.disposition ?? draft?.disposition) === 'controlled_disposal' }, 'Pemusnahan terkendali'),
                ),
            );
            const syntheticNotice = h('p', { class: 'tw-qa-synthetic', hidden: action !== 'retest' }, 'Nilai pH retest di atas adalah input sintetis QA Digital Twin, bukan hasil lab nyata. Nilai pH wajib diisi; tidak ada nilai otomatis.');
            const form = h('form', { class: 'tw-qa-form' },
                h('label', {}, 'Tindakan', select),
                h('label', {}, 'Alasan (5–200 karakter)',
                    h('input', { name: 'reason', type: 'text', minlength: '5', maxlength: '200', required: true, value: pending?.payload.reason ?? draft?.reason ?? '', disabled: retrying }),
                ),
                retestFields,
                dispositionField,
                syntheticNotice,
                h('button', { type: 'submit', class: 'tw-btn primary block', disabled: qaBusy.has(t.code) || (retrying && !actions.includes(action)) },
                    retrying ? `Kirim ulang dengan ID yang sama` : 'Kirim tindakan QA'),
                retrying ? h('small', {}, `Request ID ${pending.payload.request_id} dipertahankan untuk retry yang aman.`) : null,
            );
            select.addEventListener('change', () => {
                retestFields.hidden = select.value !== 'retest';
                retestFields.disabled = select.value !== 'retest';
                dispositionField.hidden = select.value !== 'reject';
                dispositionField.querySelector('select').required = select.value === 'reject';
                syntheticNotice.hidden = select.value !== 'retest';
            });
            form.addEventListener('submit', (event) => {
                event.preventDefault();
                sendQa(t, form, key, pending);
            });
            contentNodes.push(form);
        } else if (t.status === 'qa_hold' && root.dataset.canQa === '1' && active && latest?.status === 'held' && latest.expires_min != null && s.m >= latest.expires_min) {
            contentNodes.push(h('p', { class: 'tw-qa-note', dataset: { tone: 'warn' } }, 'Batas hold tercapai. Menunggu Engine menolak penerimaan; tidak ada QA release atau klaim disposal fisik.'));
        } else if (t.status === 'qa_hold') {
            contentNodes.push(h('p', { class: 'tw-hint' }, active ? 'Tindakan QA tidak tersedia untuk status ini.' : 'Tindakan hanya tersedia pada run live yang aktif.'));
        }
        content.replaceChildren(...contentNodes);
    }

    async function sendQa(t, form, key, currentPending) {
        const code = t.code;
        if (qaBusy.has(code)) return;
        qaErrors.delete(code);
        qaMessages.delete(code);
        let pending = currentPending ?? qaPendingByTruck.get(code) ?? readQaPending(qaStorage, key);
        if (pending?.accepted) return;
        if (!pending) {
            const fields = new FormData(form);
            const action = fields.get('action');
            const results = action === 'retest' ? {
                ph: fields.get('ph'),
            } : null;
            const draft = { action, reason: fields.get('reason'), disposition: fields.get('disposition'), results };
            qaDraftByTruck.set(code, draft);
            try {
                const payload = qaPayload({
                    requestId: qaRequestId(),
                    runId,
                    truck: code,
                    ...draft,
                });
                qaDraftByTruck.set(code, payload);
                pending = { payload, accepted: false };
                qaPendingByTruck.set(code, pending);
                writeQaPending(qaStorage, key, pending);
            } catch (error) {
                qaErrors.set(code, error.message);
                qaSig = '';
                renderQa(lastState);
                return;
            }
        }
        qaBusy.add(code);
        qaSig = '';
        renderQa(lastState);
        try {
            const res = await fetch(root.dataset.qaUrl, {
                method: 'POST',
                headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf() },
                body: JSON.stringify(pending.payload),
            });
            const out = await res.json().catch(() => ({}));
            if (!res.ok) {
                const message = Object.values(out.errors ?? {}).flat()[0] ?? out.message ?? `Gagal (HTTP ${res.status})`;
                if (res.status >= 400 && res.status < 500 && ![408, 409, 429].includes(res.status)) {
                    clearQaPending(qaStorage, key);
                    qaPendingByTruck.delete(code);
                }
                throw new Error(message);
            }
            if (out.command?.status !== 'accepted') throw new Error('Respons belum mengonfirmasi penerimaan; ulangi dengan request ID yang sama.');
            pending = { ...pending, accepted: true, commandId: out.command.id };
            qaPendingByTruck.set(code, pending);
            writeQaPending(qaStorage, key, pending);
            qaDraftByTruck.delete(code);
            qaMessages.set(code, `Perintah QA diterima · ${out.command.id ?? 'ID tersimpan'}. Menunggu hasil Engine.`);
        } catch (error) {
            qaErrors.set(code, error.message || 'Server QA tidak dapat dihubungi. Request ID tetap disimpan untuk retry.');
        } finally {
            qaBusy.delete(code);
            qaSig = '';
            renderQa(lastState);
        }
    }

    function renderTable(s) {
        const rows = assetRows(s, tab, CODES);
        const sig = tab + JSON.stringify(rows);
        if (sig === rowsSig) return;
        rowsSig = sig;
        const tbody = $('tw-rows');
        if (!rows.length) {
            tbody.replaceChildren(h('tr', {}, h('td', { class: 'tw-hint', colspan: 3 }, 'Tidak ada data.')));
            return;
        }
        tbody.replaceChildren(...rows.map((r) => h('tr', {
            tabindex: 0, role: 'button', title: 'Lihat detail',
            onclick: () => stage.select(r.code),
            onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); stage.select(r.code); } },
        }, h('td', {}, h('b', {}, r.code)), h('td', {}, r.detail + (r.extra ? ` · ${r.extra}` : '')), h('td', {}, chipEl(r.chip)))));
    }

    document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
        tab = b.dataset.tab;
        document.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
        rowsSig = '';
        renderTable(replay.state);
    }));

    function render(opts) {
        const s = replay.seek(minute);
        if (view === '3d') scene3d.draw(s, speed, opts);
        else twin.draw(s, speed);
        stage.update(s);
        maint.setLifecycle(s);
        lastState = s;
        proc?.update(s);
        scrub.value = Math.floor(minute);
        $('clock').textContent = clock(minute);
        const progress = dayProgress(minute);
        $('tw-timer-percent').textContent = progress.overtime ? 'Lembur' : `${progress.percent}%`;
        $('tw-timer-meter').setAttribute('aria-valuenow', progress.percent);
        $('tw-timer-fill').style.width = `${progress.percent}%`;
        $('tw-timer-elapsed').textContent = progress.elapsed;
        syncForkMinute();
        renderStats(s);
        renderTrack(s);
        renderQa(s);
        renderTable(s);
        if (iv && root.dataset.mode === 'simulasi') {
            iv.update(proposalRows(s, planAt(data.plans, model.startMs, minute), decisionsAt(model, minute)), minute);
        }
    }

    /** Pindah ke menit tertentu; status main/jeda tidak berubah. */
    function seekTo(m) {
        if (active) return;
        minute = Math.max(0, Math.min(m, model.endMin));
        render({ snap: true });
    }

    let toastTimer = 0;
    function toast(text) {
        const el = $('view-msg');
        el.dataset.tone = 'info';
        el.textContent = text;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { if (el.dataset.tone === 'info') el.textContent = ''; }, 4000);
    }

    // Mode Simulasi: log perintah, dampak vs dasar, dan form cabang baru.
    const forkForm = $('sim-form');
    const ivForm = $('iv-form');
    const log = commandLog(model);
    let iv = null;
    let forkMin = -1;
    function syncForkMinute() {
        const m = Math.min(1439, Math.floor(minute));
        if (!forkForm || m === forkMin) return;
        forkMin = m;
        $('sim-minute').value = m;
        $('sim-at').textContent = clock(m);
    }

    function setMode(next) {
        root.dataset.mode = next;
        $('tw-sim').hidden = next !== 'simulasi';
        $('mode-sim')?.setAttribute('aria-pressed', String(next === 'simulasi'));
    }

    function initSim() {
        $('mode-sim')?.addEventListener('click', () => {
            setMode(root.dataset.mode === 'simulasi' ? 'pantau' : 'simulasi');
            document.getElementById('tw-more')?.hidePopover?.();
            render();
        });
        setMode(isSim ? 'simulasi' : 'pantau');

        $('sim-log').replaceChildren(...(log.length ? log.map((c) => h('li', {},
            h('button', { type: 'button', title: 'Lompat ke menit ini', onclick: () => seekTo(c.m) }, c.at),
            ` ${c.label}: ${c.summary}`,
            h('small', {}, `${c.actor} · ${c.reason}`),
        )) : [h('li', { class: 'tw-hint' }, 'Belum ada perintah.')]));

        $('scrub-marks').replaceChildren(...log.map((c) => {
            const i = h('i', { title: `${c.at} ${c.label}` });
            i.style.left = `${(c.m / Number(scrub.max)) * 100}%`;
            return i;
        }));

        const rows = impactRows(data.kpi, data.baseline?.kpi);
        $('sim-impact').replaceChildren(rows.length
            ? h('table', { class: 'tw-impact' },
                h('caption', { class: 'sr-only' }, `Dampak dibanding hari dasar`),
                h('thead', {}, h('tr', {}, h('th', {}, 'Ukuran'), h('th', {}, 'Dasar'), h('th', {}, 'Pratinjau'), h('th', {}, 'Selisih'))),
                h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, `${r.label} (${r.unit})`), h('td', {}, String(r.base)), h('td', {}, String(r.now)), h('td', { dataset: { tone: r.tone } }, deltaText(r.delta))))))
            : h('p', { class: 'tw-hint' }, isSim ? 'KPI hari dasar belum tersedia.' : 'Jalankan sebuah kejadian untuk melihat dampaknya terhadap hari ini.'));

        const score = interventionScore(model, data.kpi, data.baseline?.kpi);
        const card = $('sim-score');
        card.hidden = !score;
        if (score) {
            card.dataset.verdict = score.verdict;
            card.replaceChildren(
                h('b', {}, score.headline),
                h('p', {}, `Tunggu rata-rata ${String(score.mean).replace('.', ',')} mnt dibanding ${String(score.base).replace('.', ',')} mnt pada jadwal sistem: ${score.gap}. ${score.decisions} keputusan PPIC tercatat.`),
                score.blocked.length ? h('ul', {}, score.blocked.map((b) => h('li', {}, `${b.at} ${b.text}`))) : null,
            );
        }

        if (ivForm) {
            iv = createInterventionPanel({
                list: $('iv-list'), bays: CODES.bay, reasonInput: $('iv-reason'), errEl: $('iv-err'),
                decide: (kind, args, reason) => postFork({ kind, reason, minute: Math.floor(minute * 10) / 10, ...args }, ivForm, $('iv-err')),
            });
            // Daftar usulan tidak boleh bergeser saat dibaca: fokus ke panel menjeda pemutaran.
            ivForm.addEventListener('focusin', () => { playing = false; stage.setPlaying('pause'); });
        }
        forkForm?.addEventListener('submit', (e) => {
            e.preventDefault();
            postFork(Object.fromEntries(new FormData(forkForm)), forkForm, $('sim-err'), $('sim-go'));
        });
        $('sim-kind')?.addEventListener('change', syncArgs);
        syncArgs();
        syncForkMinute();
    }

    /** Hanya argumen yang berlaku untuk jenis terpilih yang tampil dan terkirim; isinya nilai bawaan. */
    function syncArgs() {
        if (!forkForm) return;
        const defaults = JSON.parse(forkForm.dataset.defaults)[$('sim-kind').value] ?? {};
        forkForm.querySelectorAll('[data-for]').forEach((label) => {
            const key = label.dataset.for;
            const input = label.querySelector('input, select');
            label.hidden = !(key in defaults);
            input.disabled = label.hidden;
            if (!label.hidden) input.value = defaults[key];
        });
    }

    /** Kirim cabang baru (kolom `fields` + token CSRF form), lalu buka run hasilnya. */
    async function postFork(fields, form, err, btn = null) {
        if (active) { err.textContent = 'Pratinjau cabang tersedia setelah hari operasi ditutup.'; return; }
        const body = new FormData();
        body.set('_token', form.querySelector('[name=_token]').value);
        for (const [k, v] of Object.entries(fields)) if (v != null && v !== '') body.set(k, v);
        err.textContent = '';
        if (btn) btn.disabled = true;
        try {
            const res = await fetch(form.action, {
                method: 'POST', body, headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            });
            const out = await res.json().catch(() => ({}));
            if (!res.ok) {
                err.textContent = Object.values(out.errors ?? {}).flat()[0] ?? out.message ?? `Gagal (HTTP ${res.status})`;
                return;
            }
            saveMinute(runId, minute);
            location.href = out.url;
        } catch {
            err.textContent = 'Server tidak dapat dihubungi.';
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    // Three.js dimuat saat pertama dibutuhkan; tanpa WebGL tampilan 2D tetap dipakai.
    async function setView(next) {
        $('view-msg').textContent = '';
        $('view-msg').dataset.tone = '';
        if (next === '3d' && !scene3d) {
            $('twin3d').hidden = false;
            $('view-msg').textContent = 'Memuat model pabrik…';
            try {
                const { TwinScene3D, loadModels, loadPlant } = await import('./twin/scene3d.js');
                const [, model] = await Promise.all([loadModels(), loadPlant()]);
                scene3d = new TwinScene3D($('twin3d'), { layout: LAYOUT, theme: shell.theme.theme, quality: governor.tier, plant: model });
                $('view-msg').textContent = '';
                stage.attach(scene3d);
                scene3d.onZone = markZone;
            } catch {
                next = '2d';
                $('view-msg').textContent = '3D tidak tersedia (WebGL): memakai tampilan 2D.';
            }
        }
        view = next;
        $('twin3d').hidden = view !== '3d';
        $('twin').hidden = view !== '2d';
        document.querySelectorAll('.tw-controls .tw-ico').forEach((b) => { b.disabled = view !== '3d'; });
        stage.setProjector(view === '3d' ? scene3d : twin);
        render({ snap: true });
    }
    $('twin').addEventListener('click', (e) => stage.select(twin.pick(e.clientX, e.clientY)));

    $('cm-in').addEventListener('click', () => scene3d?.zoomBy(1.3));
    $('cm-out').addEventListener('click', () => scene3d?.zoomBy(1 / 1.3));
    $('cm-rot').addEventListener('click', () => scene3d?.rotateStep(0.45));
    $('cm-reset').addEventListener('click', () => {
        stage.closeSheet();
        scene3d?.resetView();
    });

    let last = performance.now();
    function frame(now) {
        const dt = (now - last) / 1000;
        last = now;
        if (playing && !active) {
            minute = Math.min(model.endMin, minute + dt * speed);
            if (minute >= model.endMin) {
                playing = false;
                stage.setPlaying('ended');
                showDay();
            }
            render();
            if (view === '3d' && qPref === 'auto') governor.sample(dt * 1000);
        }
        requestAnimationFrame(frame);
    }

    $('play').addEventListener('click', () => {
        if (active) return;
        if (minute >= model.endMin) minute = 0;
        hideDay();
        playing = !playing;
        stage.setPlaying(playing ? 'play' : 'pause');
    });
    $('speed').addEventListener('change', async (e) => {
        if (!active) { speed = Number(e.target.value); return; }
        const requested = Number(e.target.value);
        if (root.dataset.canAdvance !== '1' || ![1, 5, 20, 60].includes(requested)) { e.target.value = speed; return; }
        e.target.disabled = true;
        try {
            const res = await fetch(root.dataset.opSpeedUrl, {
                method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf() },
                body: JSON.stringify(speedPayload(runId, requested)),
            });
            const out = await res.json();
            if (!res.ok) throw new Error(out.message ?? `HTTP ${res.status}`);
            if (!active) return;
            // Jam tampilan hanya diperbarui bersama snapshot event, bukan dari balasan kontrol.
            speed = out.speed;
            data.live.speed = speed;
        } catch (err) {
            toast(err.message);
        } finally {
            e.target.value = speed;
            e.target.disabled = active && root.dataset.canAdvance !== '1';
        }
    });
    scrub.addEventListener('input', () => {
        if (active) return;
        hideDay();
        playing = false;
        stage.setPlaying('pause');
        minute = Number(scrub.value);
        render({ snap: true });
    });
    let disposed = false;
    let pollTimer = null;
    addEventListener('pagehide', () => {
        disposed = true;
        clearTimeout(pollTimer);
        if (!active) saveMinute(runId, minute);
    });


    // Hari operasi: ringkasan akhir hari, riwayat hari yang sudah lewat, dan lanjut ke hari berikutnya.
    const dayStart = model.events.find((e) => e.p.type === 'day.started')?.p;
    let dayEnd = [...model.events].reverse().find((e) => e.p.type === 'day.summary')?.p;
    let dayNo = dayStart?.day ?? dayEnd?.day ?? null;
    let opState = null;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const csrf = () => document.querySelector('meta[name=csrf-token]')?.content ?? '';

    async function getState() {
        const res = await fetch(root.dataset.opStateUrl, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        opState = await res.json();
        maint.update(opState);
        if (Number(opState.live?.run_id) === Number(runId)) dayNo ??= opState.live.day;
        return opState;
    }

    async function postAdvance() {
        const res = await fetch(root.dataset.opAdvanceUrl, { method: 'POST', headers: { Accept: 'application/json', 'X-CSRF-TOKEN': csrf() } });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(Object.values(out.errors ?? {}).flat()[0] ?? out.message ?? `Gagal (HTTP ${res.status})`);
        opState = out;
        return out;
    }

    /** Minta engine menghitung hari berikutnya bila belum siap, lalu buka hari itu. */
    async function advanceDay(btn, err) {
        err.textContent = '';
        btn.disabled = true;
        btn.textContent = `Menyiapkan Hari ${dayNo + 1}…`;
        try {
            let st = await postAdvance();
            while (st.watch_day < dayNo + 1 && !(st.live?.day >= dayNo + 1)) {
                await sleep(2500);
                st = st.target_status === 'running' ? await getState() : await postAdvance();
            }
            const next = nextOperationRun(st, dayNo);
            location.href = next ? `${root.dataset.twinRunUrl}${next.runId}` : root.dataset.twinUrl;
        } catch (e) {
            err.textContent = e.message;
            btn.disabled = false;
            btn.textContent = `Mulai Hari ${dayNo + 1}`;
        }
    }

    function setNext(btn) {
        const next = nextOperationRun(opState, dayNo);
        btn.onclick = null;
        btn.disabled = false;
        if (next) {
            btn.textContent = `Lihat Hari ${next.day}${next.live ? ' · Langsung' : ''}`;
            btn.onclick = () => { location.href = `${root.dataset.twinRunUrl}${next.runId}`; };
        } else if (root.dataset.canAdvance === '1') {
            btn.textContent = `Mulai Hari ${dayNo + 1}`;
            btn.onclick = () => advanceDay(btn, $('day-err'));
        } else {
            btn.textContent = `Hari ${dayNo + 1} belum dimulai`;
            btn.disabled = true;
        }
    }

    function showDay() {
        if (active || !dayEnd) return;
        $('tw-day-title').textContent = `Ringkasan Hari ${dayEnd.day} · ${dayDate(dayEnd.date)}`;
        $('tw-day-body').replaceChildren(
            h('dl', {}, daySummaryRows(dayEnd, fmtL).flatMap((r) => [h('dt', {}, r.label), h('dd', {}, r.value)])),
            dayEnd.issues.length
                ? h('ul', { class: 'tw-day-issues' }, dayEnd.issues.map((t) => h('li', {}, t)))
                : h('p', { class: 'tw-hint' }, 'Tidak ada masalah hari ini.'),
        );
        $('tw-day').hidden = false;
        setNext($('day-next'));
        getState().then(() => setNext($('day-next'))).catch(() => {});
    }
    function hideDay() { $('tw-day').hidden = true; }
    $('tw-day-close').addEventListener('click', hideDay);
    $('day-replay').addEventListener('click', () => {
        if (active) return;
        hideDay();
        minute = 0;
        playing = true;
        stage.setPlaying('play');
    });
    $('day-end').addEventListener('click', () => {
        if (active) return;
        playing = false;
        stage.setPlaying('ended');
        seekTo(model.endMin);
        showDay();
    });

    // Riwayat hari: daftar hari yang sudah ditutup, tiap hari bisa diputar ulang.
    $('tw-days').addEventListener('toggle', async (e) => {
        if (e.newState !== 'open') return;
        const list = $('tw-days-list');
        list.replaceChildren(h('li', { class: 'tw-hint' }, 'Memuat…'));
        try {
            const st = await getState();
            const closed = { ...st, days: st.days.filter((d) => Number(d.run_id) !== Number(st.live?.run_id) && (d.status == null || d.status === 'closed')) };
            const rows = historyRows(closed, dayNo, fmtL);
            list.replaceChildren(...(rows.length ? rows.map((r) => h('li', { dataset: { current: r.current ? '1' : '' } },
                h('b', {}, r.title), h('span', {}, r.detail),
                r.current ? h('em', {}, 'Sedang diputar') : h('a', { href: `${root.dataset.twinRunUrl}${r.runId}` }, 'Putar ulang'),
            )) : [h('li', { class: 'tw-hint' }, 'Belum ada hari yang selesai.')]), h('li', { class: 'tw-hint' }, st.integrity.ok ? 'Seluruh riwayat tersimpan utuh.' : `Riwayat terganggu pada Hari ${st.integrity.broken_day}.`));
        } catch {
            list.replaceChildren(h('li', { class: 'tw-hint' }, 'Riwayat tidak dapat dimuat.'));
        }
    });

    stage.setPlaying('play');
    initSim();
    if (active) {
        $('mode-sim')?.setAttribute('disabled', '');
        forkForm?.querySelectorAll('input, select, button').forEach((el) => { el.disabled = true; });
        ivForm?.querySelectorAll('input, select, button').forEach((el) => { el.disabled = true; });
        setMode('pantau');
    }
    render();
    async function poll() {
        if (disposed || !active) return;
        try {
            const after = rawEvents.length ? rawEvents.reduce((max, e) => Math.max(max, e.seq), 0) : null;
            const next = await fetchSnapshot(root.dataset.replayUrl, after);
            if (disposed) return;
            const transition = pollTransition(rawEvents, next, minute, runId);
            rawEvents = transition.events;
            model = transition.model;
            total = model.events.filter((e) => e.p.type === 'truck.arrived').length;
            replay = new Replay(model, { live: transition.active });
            Object.assign(data, next);
            active = transition.active;
            minute = transition.minute;
            maint.setLive(next.live);
            dayEnd = [...model.events].reverse().find((e) => e.p.type === 'day.summary')?.p;
            scrub.max = Math.ceil(Math.max(model.endMin, minute));
            if (!active) {
                playing = false;
                syncLiveControls();
                $('mode-sim')?.removeAttribute('disabled');
                forkForm?.querySelectorAll('input, select, button').forEach((el) => { el.disabled = false; });
                ivForm?.querySelectorAll('input, select, button').forEach((el) => { el.disabled = false; });
                syncArgs();
                stage.setPlaying('ended');
            } else {
                speed = next.live.speed;
                $('speed').value = speed;
            }
            render({ snap: true });
            setStatus(root, active ? 'langsung' : 'selesai', 'ok');
            root.dataset.clockStale = '0';
            $('tw-timer-source').textContent = active ? 'Tersinkron dengan Engine' : 'Posisi putar ulang';
            $('tw-live-clock').textContent = active ? 'Hari aktif · langsung dari Engine' : 'Riwayat · putar ulang hari selesai';
            await getState();
            if (!active) showDay();
        } catch (e) {
            setStatus(root, 'langsung terputus', 'bad');
            root.dataset.clockStale = '1';
            $('tw-timer-source').textContent = 'Koneksi terputus · waktu ditahan';
            $('tw-live-clock').textContent = `Data tertahan · ${e.message}`;
            // Jangan mengganti data dengan replay atau mengekstrapolasi jam saat koneksi gagal.
        } finally {
            if (active && !disposed) pollTimer = setTimeout(poll, 1000);
        }
    }
    if (active) {
        getState().catch(() => {});
        pollTimer = setTimeout(poll, 1000);
    }
    // Tautan dari Maps (?truck=KODE): buka detail truk yang baru lewat gerbang.
    const want = new URLSearchParams(location.search).get('truck');
    setView('3d').then(() => { if (want) stage.select(want); });
    requestAnimationFrame(frame);
}

fetchReplay(root.dataset.replayUrl, (status) => setStatus(root, status), { allowLive: true })
    .then((data) => {
        setStatus(root, isLiveOperation(data) ? 'langsung' : 'selesai', 'ok');
        $('tw-loading').hidden = true;
        start(data);
    })
    .catch((e) => {
        setStatus(root, 'gagal', 'bad');
        $('run-msg').textContent = e.message;
    });
