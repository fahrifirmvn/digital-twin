// Halaman Digital Twin: panggung 3D/2D penuh layar dengan panel statistik, pelacakan, kontrol peta, dan tabel aset.
import '../css/twin.css';
import { TwinCanvas } from './twin/canvas.js';
import { layoutFromPlant } from './twin/layout/plant.js';
import { fetchReplay, saveMinute, savedMinute } from './twin/load.js';
import { QualityGovernor, TIERS, detectTier, deviceSignals } from './twin/kit/quality.js';
import { Replay, buildModel } from './twin/state.js';
import { commandLog } from './twin/ui/commands.js';
import { createInterventionPanel } from './twin/ui/intervene.js';
import { decisionsAt, planAt, proposalRows } from './twin/ui/proposals.js';
import { interventionScore } from './twin/ui/score.js';
import { chipEl, h } from './twin/ui/dom.js';
import { clock, fmtL } from './twin/ui/format.js';
import { deltaText, impactRows } from './twin/ui/impact.js';
import { nextNotable } from './twin/ui/jump.js';
import { assetRows, layoutCodes, liveStats, trackerSteps } from './twin/ui/live.js';
import { initShell, setStatus } from './twin/ui/shell.js';
import { createStage } from './twin/ui/stage.js';
import { truckStatus } from './twin/ui/status.js';

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
    if (scene3d?.inside) {
        scene3d.setZone('all');
        markZone('all');
        return;
    }
    $('tw-minimize').click();
});

function markZone(zone) {
    document.querySelectorAll('.tw-seg-z button').forEach((o) => o.setAttribute('aria-pressed', String(o.dataset.zone === zone)));
}

function start(data) {
    const model = buildModel(data.events);
    const total = model.events.filter((e) => e.p.type === 'truck.arrived').length;
    const replay = new Replay(model);
    const twin = new TwinCanvas($('twin'));
    const stage = createStage(root, { onSelect: () => renderTrack(replay.state), anomaly: JSON.parse(root.dataset.anomaly || 'null') });
    let view = '2d';
    let speed = Number($('speed').value);
    let playing = true;
    // Cabang simulasi dibuka sedikit sebelum perintah terakhir, supaya sebabnya terlihat.
    const isSim = data.run.kind === 'simulation';
    const saved = savedMinute(runId);
    let minute = Math.min(saved > 0 ? saved : (isSim && data.run.fork_minute ? Math.max(0, data.run.fork_minute - 15) : 0), model.endMin);
    let tab = 'bay';
    let trackSig = '';
    let rowsSig = '';

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

    function renderStats(s) {
        const k = liveStats(s, total);
        $('s-waiting').textContent = k.waiting;
        $('s-wait').textContent = k.avgWaitMin == null ? '-' : Math.round(k.avgWaitMin);
        $('s-lab').textContent = k.labQueue;
        $('s-holds').textContent = k.holds;
        $('s-holds-box').dataset.tone = k.holds ? 'bad' : '';
        $('s-inbound').textContent = k.inbound;
        $('s-detected').textContent = k.detected;
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
        const sig = t ? `${t.code}|${t.plate}|${t.status}|${t.held}|${ago}` : '-';
        if (sig === trackSig) return;
        trackSig = sig;
        if (!t) {
            body.replaceChildren(h('p', { class: 'tw-hint' }, 'Pilih truk pada peta atau tabel untuk melihat tahapnya.'));
            return;
        }
        const st = truckStatus(t);
        body.replaceChildren(
            h('p', { class: 'tw-track-title' }, h('b', {}, t.code), t.plate ? ` · ${t.plate}` : '', ` · ${t.farm} · ${fmtL(t.volume)}`),
            h('ol', { class: 'tw-steps' }, trackerSteps(t).map((step) => h('li', { dataset: { state: step.state } }, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', {}, step.label), step.state !== 'todo' ? h('span', { class: 'sr-only' }, step.state === 'done' ? ' (selesai)' : step.state === 'bad' ? ' (bermasalah)' : ' (sekarang)') : null))),
            h('p', { class: 'tw-hint' }, `${st.label}, ${ago} mnt di tahap ini`),
        );
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
        scrub.value = Math.floor(minute);
        $('clock').textContent = clock(minute);
        syncForkMinute();
        renderStats(s);
        renderTrack(s);
        renderTable(s);
        if (iv && root.dataset.mode === 'simulasi') {
            iv.update(proposalRows(s, planAt(data.plans, model.startMs, minute), decisionsAt(model, minute)), minute);
        }
    }

    /** Pindah ke menit tertentu; status main/jeda tidak berubah. */
    function seekTo(m) {
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

    // Lompat ke kejadian penting berikutnya (truk tiba, gate tahan, aset mati, CIP darurat, replan, perintah).
    $('jump').addEventListener('click', () => {
        const next = nextNotable(model, minute);
        if (!next) return toast('Tidak ada kejadian penting lagi.');
        seekTo(next.m);
        toast(`${clock(next.m)}: ${next.label}`);
    });

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
        $('mode-watch')?.setAttribute('aria-pressed', String(next === 'pantau'));
        $('mode-sim')?.setAttribute('aria-pressed', String(next === 'simulasi'));
    }

    function initSim() {
        const badge = data.run.badge;
        const chip = $('run-mode');
        if (badge && chip) {
            chip.textContent = badge.label;
            chip.dataset.mode = badge.key;
        }
        $('mode-watch')?.addEventListener('click', () => setMode('pantau'));
        $('mode-sim')?.addEventListener('click', () => { setMode('simulasi'); render(); });
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
                h('caption', { class: 'sr-only' }, `Dampak dibanding Run #${data.baseline.id}`),
                h('thead', {}, h('tr', {}, h('th', {}, `Run #${data.baseline.id}`), h('th', {}, 'Dasar'), h('th', {}, 'Simulasi'), h('th', {}, 'Selisih'))),
                h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, `${r.label} (${r.unit})`), h('td', {}, String(r.base)), h('td', {}, String(r.now)), h('td', { dataset: { tone: r.tone } }, deltaText(r.delta))))))
            : h('p', { class: 'tw-hint' }, isSim ? 'KPI run dasar belum tersedia.' : 'Jalankan sebuah kejadian untuk melihat dampaknya terhadap run ini.'));

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
        $('view-3d').setAttribute('aria-pressed', String(view === '3d'));
        $('view-2d').setAttribute('aria-pressed', String(view === '2d'));
        document.querySelectorAll('.tw-controls .tw-ico, .tw-seg-z button').forEach((b) => { b.disabled = view !== '3d'; });
        stage.setProjector(view === '3d' ? scene3d : twin);
        render({ snap: true });
    }
    $('view-3d').addEventListener('click', () => setView('3d'));
    $('view-2d').addEventListener('click', () => setView('2d'));
    $('twin').addEventListener('click', (e) => stage.select(twin.pick(e.clientX, e.clientY)));

    document.querySelectorAll('.tw-seg-z button').forEach((b) => b.addEventListener('click', () => {
        markZone(b.dataset.zone);
        scene3d?.setZone(b.dataset.zone);
    }));
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
        if (playing) {
            minute = Math.min(model.endMin, minute + dt * speed);
            if (minute >= model.endMin) {
                playing = false;
                stage.setPlaying('ended');
            }
            render();
            if (view === '3d' && qPref === 'auto') governor.sample(dt * 1000);
        }
        requestAnimationFrame(frame);
    }

    $('play').addEventListener('click', () => {
        if (minute >= model.endMin) minute = 0;
        playing = !playing;
        stage.setPlaying(playing ? 'play' : 'pause');
    });
    $('speed').addEventListener('change', (e) => { speed = Number(e.target.value); });
    scrub.addEventListener('input', () => {
        playing = false;
        stage.setPlaying('pause');
        minute = Number(scrub.value);
        render({ snap: true });
    });
    addEventListener('pagehide', () => saveMinute(runId, minute));

    stage.setPlaying('play');
    initSim();
    render();
    // Tautan dari Maps (?truck=KODE): buka detail truk yang baru lewat gerbang.
    const want = new URLSearchParams(location.search).get('truck');
    setView('3d').then(() => { if (want) stage.select(want); });
    requestAnimationFrame(frame);
}

fetchReplay(root.dataset.replayUrl, (status) => setStatus(root, status))
    .then((data) => {
        setStatus(root, 'selesai', 'ok');
        $('tw-loading').hidden = true;
        start(data);
    })
    .catch((e) => {
        setStatus(root, 'gagal', 'bad');
        $('run-msg').textContent = e.message;
    });
