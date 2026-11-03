// Halaman Dashboard: KPI langsung, jadwal (Gantt), keputusan, uji mutu, daftar truk, dan pratinjau twin pada menit simulasi terpilih.
import '../css/twin.css';
import { TwinCanvas } from './twin/canvas.js';
import { Gantt } from './twin/gantt.js';
import { fetchReplay, saveMinute, savedMinute } from './twin/load.js';
import { Replay, buildGantt, buildModel } from './twin/state.js';
import { chipEl, h } from './twin/ui/dom.js';
import { clock, fmtL } from './twin/ui/format.js';
import { icon } from './twin/ui/icons.js';
import { decisions, labPrep, liveStats, truckRows } from './twin/ui/live.js';
import { initShell, setStatus } from './twin/ui/shell.js';

const root = document.getElementById('tw');
const $ = (id) => document.getElementById(id);
const runId = root.dataset.runId;
const num = (v, d = 1) => (v === null || v === undefined ? '-' : Number(v).toFixed(d));
const stat = (s) => (s.n ? `${num(s.mean)} / ${num(s.p90)} / ${num(s.max)} mnt` : '-');

const KPI_ROWS = [
    ['Waktu tunggu truk (rata-rata / p90 / maks)', (k) => stat(k.truck_wait_min), 'Selisih waktu tiba dan mulai bongkar'],
    ['Waktu tunggu lab', (k) => stat(k.lab_wait_min), 'Tiba (sampling) sampai hasil uji dirilis'],
    ['Waktu susu di tangki', (k) => stat(k.tank_dwell_min), 'Selesai bongkar sampai mulai sterilisasi; batas holding 240 mnt'],
    ['CIP tak terjadwal', (k) => k.unscheduled_cip, 'CIP darurat per run'],
    ['Utilisasi aset (% waktu aktif)', (k) => Object.entries(k.utilization_pct).map(([a, v]) => `${a} ${num(v)}%`).join(', '), 'Persen waktu in_use per tipe aset, dihitung sampai run selesai'],
    ['Reject pengemasan', (k) => `${num(k.packaging_reject_pct)}%`, 'Batch terdampak changeover atau ditahan QA'],
    ['Changeover', (k) => `${k.changeover_count}x, ${num(k.changeover_min, 0)} mnt`, 'Jumlah dan total durasi'],
    ['Ketepatan jadwal', (k) => (k.schedule_adherence_pct === null ? 'belum dihitung (Monte Carlo)' : `${num(k.schedule_adherence_pct)}%`), 'Diisi pada Fase 4'],
    ['False accept', (k) => k.false_accept, 'Target 0 pada semua skenario'],
    ['Pelanggaran holding time', (k) => k.holding_violations, 'Target 0'],
    ['Cakupan traceability FG', (k) => `${num(k.trace_coverage_pct)}%`, 'FG lot dengan rantai lengkap sampai tanker'],
    ['Hasil', (k) => `${fmtL(k.raw_ton)} raw -> ${fmtL(k.fg_ton)} FG`, 'Volume bahan baku masuk dan FG keluar'],
    ['Truk selesai / G1 / G2 / QA', (k) => `${k.completed} / ${k.held_g1} / ${k.rejected_g2} / ${k.held_qa}`, 'Selesai, ditahan G1, ditolak G2, ditahan QA'],
    ['Gate menahan', (k) => Object.entries(k.gate_holds).map(([g, n]) => `${g}: ${n}`).join(', ') || 'tidak ada', 'G3 mencatat tunggu tangki'],
];

let gantt = null;
initShell(root, { onTheme: () => gantt?.retheme() });

function renderKpi(k) {
    $('kpi-body').replaceChildren(...KPI_ROWS.map(([label, fn, tip]) => h('tr', { title: tip }, h('td', {}, label), h('td', { class: 'mono' }, String(fn(k))))));
}

/** Ganti isi daftar hanya bila tanda-tangannya berubah; kosong menampilkan teks pengganti. */
function fill(listId, sig, items) {
    const list = $(listId);
    if (list.dataset.sig === sig) return;
    list.dataset.sig = sig;
    list.replaceChildren(...items);
    $(`${listId}-empty`).hidden = items.length > 0;
}

function start(data) {
    const model = buildModel(data.events);
    const total = model.events.filter((e) => e.p.type === 'truck.arrived').length;
    const replay = new Replay(model);
    const preview = new TwinCanvas($('twin-preview'));
    const scrub = $('scrub');
    const playBtn = $('play');
    let speed = Number($('speed').value);
    let playing = true;
    let minute = Math.min(savedMinute(runId), model.endMin);
    let lastDom = -1;
    scrub.max = Math.ceil(model.endMin);

    function setPlaying(kind) {
        const m = { play: ['pause', 'Jeda'], pause: ['play', 'Putar'], ended: ['replay', 'Ulangi'] }[kind];
        playBtn.innerHTML = icon(m[0], 22);
        playBtn.setAttribute('aria-label', m[1]);
        playBtn.title = m[1];
    }

    gantt = new Gantt($('gantt'), buildGantt(model), model.endMin, (m) => {
        playing = false;
        setPlaying('pause');
        minute = m;
        render(true);
    });

    function renderPanels(s) {
        const k = liveStats(s, total);
        $('k-wait').textContent = k.avgWaitMin == null ? '-' : Math.round(k.avgWaitMin);
        $('k-waiting').textContent = k.waiting;
        $('k-transit').textContent = k.inTransit;
        $('k-lab').textContent = k.labQueue;
        $('k-lab-sub').textContent = `sedang diuji: ${k.labTesting}`;
        $('k-gate').textContent = k.gatePassPct == null ? '-' : `${Math.round(k.gatePassPct)}%`;
        $('k-gate-sub').textContent = k.gatePassPct == null ? 'belum ada keputusan' : `${k.holds} tahan`;
        $('k-unloaded').textContent = s.counters.unloaded;
        $('k-fg').textContent = `${fmtL(s.counters.fgTon)} FG keluar`;

        const dec = decisions(s);
        fill('d-decisions', JSON.stringify(dec), dec.map((d) => h('li', { class: 'row-item' },
            h('div', {}, h('b', {}, d.code), h('small', {}, `${d.farm}${d.reason ? ` · ${d.reason}` : ''} · ${d.ago} mnt`)),
            chipEl({ tone: d.tone, icon: 'alert', label: d.label }),
        )));

        const prep = labPrep(s);
        fill('d-prep', JSON.stringify(prep), prep.map((p) => h('li', { class: 'row-item' },
            h('div', {}, h('b', {}, p.code), h('small', {}, `${p.farm} · ${fmtL(p.volume)} · ${p.ago} mnt`)),
            chipEl(p.chip),
        )));

        const rows = truckRows(s);
        const sig = JSON.stringify(rows);
        const body = $('d-trucks');
        if (body.dataset.sig !== sig) {
            body.dataset.sig = sig;
            body.replaceChildren(...rows.map((r) => h('tr', {},
                h('td', {}, h('b', {}, r.code)), h('td', {}, r.farm), h('td', {}, fmtL(r.volume)),
                h('td', {}, chipEl(r.chip)), h('td', {}, r.bay ?? '-'), h('td', {}, r.wait == null ? '-' : `${r.wait} mnt`),
            )));
        }

        const alerts = s.feed.filter((f) => f.level !== 'info').slice(0, 8);
        fill('d-alerts', JSON.stringify(alerts), alerts.map((a) => h('li', { class: `alert ${a.level}` },
            h('span', { class: 'mono' }, clock(a.m)), ` ${a.text}`,
        )));
        preview.draw(s, speed);
    }

    // Jam dan slider tiap frame; panel berat diperbarui paling cepat 4x/dtk saat memutar.
    function render(force = false) {
        const s = replay.seek(minute);
        scrub.value = Math.floor(minute);
        $('clock').textContent = clock(minute);
        gantt.draw(minute);
        const now = performance.now();
        if (force || now - lastDom > 250) {
            lastDom = now;
            renderPanels(s);
        }
    }

    let last = performance.now();
    function frame(now) {
        const dt = (now - last) / 1000;
        last = now;
        if (playing) {
            minute = Math.min(model.endMin, minute + dt * speed);
            if (minute >= model.endMin) {
                playing = false;
                setPlaying('ended');
                render(true);
            } else {
                render();
            }
        }
        requestAnimationFrame(frame);
    }

    playBtn.addEventListener('click', () => {
        if (minute >= model.endMin) minute = 0;
        playing = !playing;
        setPlaying(playing ? 'play' : 'pause');
    });
    $('speed').addEventListener('change', (e) => { speed = Number(e.target.value); });
    scrub.addEventListener('input', () => {
        playing = false;
        setPlaying('pause');
        minute = Number(scrub.value);
        render(true);
    });
    addEventListener('pagehide', () => saveMinute(runId, minute));

    setPlaying('play');
    renderKpi(data.kpi);
    render(true);
    requestAnimationFrame(frame);
}

fetchReplay(root.dataset.replayUrl, (status) => setStatus(root, status))
    .then((data) => {
        setStatus(root, 'selesai', 'ok');
        start(data);
    })
    .catch((e) => {
        setStatus(root, 'gagal', 'bad');
        $('run-msg').textContent = e.message;
    });
