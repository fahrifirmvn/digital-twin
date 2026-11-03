// Halaman Maps: peta geografis (MapLibre + truk 3D) menuju gerbang dengan plat dan ETA, diputar dari replay yang sama dengan Twin.
import '../css/twin.css';
import { GEO_GEOMETRY } from './twin/map/geo-real.js';
import { inboundList, mapStats, recentArrivals } from './twin/map/geo.js';
import { fetchReplay, saveMinute, savedMinute } from './twin/load.js';
import { Replay, buildModel } from './twin/state.js';
import { chipEl, h } from './twin/ui/dom.js';
import { clock } from './twin/ui/format.js';
import { icon } from './twin/ui/icons.js';
import { initShell, setStatus } from './twin/ui/shell.js';

const root = document.getElementById('tw');
const $ = (id) => document.getElementById(id);
const runId = root.dataset.runId;

initShell(root);

// Esc yang tidak dipakai drawer, dialog, atau kolom isian = Perkecil.
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    $('tw-minimize').click();
});

function twinLink(code) {
    const u = new URL(root.dataset.twinUrl, location.href);
    u.searchParams.set('truck', code);
    return u.pathname + u.search;
}

async function start(data) {
    const model = buildModel(data.events);
    const total = model.events.filter((e) => e.p.type === 'truck.arrived').length;
    const hasTrips = model.events.some((e) => e.p.type === 'truck.dispatched');
    const replay = new Replay(model);
    const canvas = $('map');
    canvas.hidden = false;
    const { GeoMap } = await import('./twin/map/geomap.js');
    const map = new GeoMap(canvas, {
        onSelect: (code) => { if (code) select(code); else if (selected) select(selected); },
        onFallback: () => { $('m-offline').hidden = false; },
    });
    const scrub = $('scrub');
    const playBtn = $('play');
    let speed = Number($('speed').value);
    let playing = true;
    let minute = Math.min(savedMinute(runId), model.endMin);
    let selected = null;
    let rowsSig = '';
    let arrivedSig = '';

    scrub.max = Math.ceil(model.endMin);
    $('m-nodata').hidden = hasTrips;

    function setPlaying(kind) {
        const m = { play: ['pause', 'Jeda'], pause: ['play', 'Putar'], ended: ['replay', 'Ulangi'] }[kind];
        playBtn.innerHTML = icon(m[0], 22);
        playBtn.setAttribute('aria-label', m[1]);
        playBtn.title = m[1];
    }

    function select(code) {
        selected = selected === code ? null : code;
        render();
    }

    function renderRows(list) {
        const sig = `${selected}|${list.map((t) => `${t.code}:${t.minsLeft}:${t.inGeofence}`).join(',')}`;
        if (sig === rowsSig) return;
        rowsSig = sig;
        const body = $('m-rows');
        if (!list.length) {
            body.replaceChildren(h('tr', {}, h('td', { class: 'tw-hint', colspan: 3 }, hasTrips ? 'Tidak ada truk di jalan pada menit ini.' : 'Belum ada data perjalanan.')));
            return;
        }
        body.replaceChildren(...list.map((t) => h('tr', {
            tabindex: 0, role: 'button', 'aria-pressed': String(t.code === selected), 'aria-label': `Pilih ${t.plate ?? t.code}`,
            onclick: () => select(t.code),
            onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(t.code); } },
        },
        h('td', {}, h('b', { class: 'mono' }, t.plate ?? t.code), h('small', { class: 'tw-sub' }, `${t.code} · jalur ${t.routeName.toLowerCase()}`)),
        h('td', {}, t.farmName),
        h('td', {}, h('span', { class: 'mono' }, clock(t.etaM)), h('small', { class: 'tw-sub' }, `${t.minsLeft} mnt lagi`), t.inGeofence ? chipEl({ tone: 'ok', icon: 'check', label: 'Di geofence' }) : null))));
    }

    function renderArrived(list) {
        const sig = list.map((t) => `${t.code}:${t.ago}`).join(',');
        if (sig === arrivedSig) return;
        arrivedSig = sig;
        const ul = $('m-arrived-list');
        if (!list.length) {
            ul.replaceChildren(h('li', { class: 'tw-hint' }, 'Belum ada truk yang baru tiba.'));
            return;
        }
        ul.replaceChildren(...list.map((t) => h('li', { class: 'row-item' },
            h('span', {}, h('b', { class: 'mono' }, t.plate ?? t.code), h('small', {}, `${t.farmName} · ${t.ago} mnt lalu`)),
            h('a', { href: twinLink(t.code), 'aria-label': `Buka ${t.plate ?? t.code} di Digital Twin` }, 'Buka di Twin'))));
    }

    function render() {
        const s = replay.seek(minute);
        const list = inboundList(s, GEO_GEOMETRY);
        if (selected && !list.some((t) => t.code === selected)) selected = null;
        map.update(list, recentArrivals(s, 10), selected);
        const k = mapStats(s, total, GEO_GEOMETRY);
        $('m-inbound').textContent = k.inbound;
        $('m-next').textContent = k.nextEtaM == null ? '-' : clock(k.nextEtaM);
        $('m-fence').textContent = k.inGeofence;
        $('m-arrived').textContent = `${k.arrived}/${k.total}`;
        renderRows(list);
        renderArrived(recentArrivals(s, 15));
        scrub.value = Math.floor(minute);
        $('clock').textContent = clock(minute);
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
            }
            render();
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
        render();
    });
    addEventListener('pagehide', () => saveMinute(runId, minute));

    setPlaying('play');
    render();
    requestAnimationFrame(frame);
}

fetchReplay(root.dataset.replayUrl, (status) => setStatus(root, status))
    .then((data) => {
        setStatus(root, 'selesai', 'ok');
        $('tw-loading').hidden = true;
        return start(data);
    })
    .catch((e) => {
        setStatus(root, 'gagal', 'bad');
        $('run-msg').textContent = e.message;
    });
