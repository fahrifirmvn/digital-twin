// Halaman Maps: peta geografis (MapLibre + truk 3D) menuju gerbang dengan plat dan ETA, diputar dari replay yang sama dengan Twin.
import '../css/twin.css';
import { GEO_GEOMETRY } from './twin/map/geo-real.js';
import { inboundList, mapStats, recentArrivals } from './twin/map/geo.js';
import { fetchReplay, followLive, isLiveOperation, readOnlyLiveControls, saveMinute, savedMinute } from './twin/load.js';
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
    let active = isLiveOperation(data);
    let model = buildModel(data.events);
    let total = model.events.filter((e) => e.p.type === 'truck.arrived').length;
    let hasTrips = model.events.some((e) => e.p.type === 'truck.dispatched');
    let replay = new Replay(model, { live: active });
    const canvas = $('map');
    canvas.hidden = false;
    const { GeoMap } = await import('./twin/map/geomap.js');
    const map = await GeoMap.create(canvas, {
        onSelect: (code) => { if (code) select(code); else if (selected) select(selected); },
        onFallback: () => { $('m-offline').hidden = false; },
    });
    const scrub = $('scrub');
    const playBtn = $('play');
    let speed = Number($('speed').value);
    let playing = !active;
    let minute = active ? data.live.minute : Math.min(savedMinute(runId), model.endMin);
    let selected = null;
    let rowsSig = '';

    scrub.max = Math.ceil(model.endMin);
    $('m-nodata').hidden = hasTrips;
    readOnlyLiveControls(root, active);

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

    function closeBtn(code) {
        const b = h('button', { class: 'tw-ico', type: 'button', 'aria-label': 'Tutup kartu truk', onclick: () => select(code) });
        b.innerHTML = icon('x', 18);
        return b;
    }

    // Kartu truk di bawah peta (ala Google Maps): plat, asal, ETA, kemajuan, dan tombol ikuti.
    let cardSig = '';
    function renderCard(list) {
        const card = $('m-card');
        const t = selected ? list.find((x) => x.code === selected) : null;
        if (!t) {
            card.hidden = true;
            cardSig = '';
            return;
        }
        const sig = `${t.code}|${t.minsLeft}|${t.inGeofence}|${Math.round(t.progress * 100)}|${map.following}`;
        if (sig === cardSig) return;
        cardSig = sig;
        card.hidden = false;
        const bar = h('span', { class: 'tw-gm-bar' }, h('i', {}));
        bar.firstChild.style.width = `${Math.round(Math.max(0, Math.min(1, t.progress)) * 100)}%`;
        card.replaceChildren(
            h('div', { class: 'tw-gm-card-head' },
                h('b', { class: 'mono' }, t.plate ?? t.code),
                t.inGeofence ? chipEl({ tone: 'ok', icon: 'check', label: 'Di geofence' }) : h('span', { class: 'tw-sub' }, 'Menuju gerbang'),
                closeBtn(t.code)),
            h('p', { class: 'tw-sub' }, `${t.farmName} · jalur ${t.routeName.toLowerCase()}`),
            h('p', { class: 'tw-gm-eta' }, h('b', {}, `${t.minsLeft} mnt lagi`), h('span', { class: 'mono' }, ` tiba ${clock(t.etaM)}`)),
            bar,
            h('div', { class: 'tw-gm-card-actions' },
                h('button', { class: 'tw-btn', type: 'button', 'aria-pressed': String(Boolean(map.following)), onclick: () => { map.following = !map.following; cardSig = ''; renderCard(list); } }, map.following ? 'Berhenti ikuti' : 'Ikuti'),
                h('a', { class: 'tw-btn', href: twinLink(t.code) }, 'Buka di Twin')),
        );
    }

    function render() {
        const s = replay.seek(minute);
        const list = inboundList(s, GEO_GEOMETRY);
        if (selected && !list.some((t) => t.code === selected)) selected = null;
        map.update(list, recentArrivals(s, 10), selected, true);
        const k = mapStats(s, total, GEO_GEOMETRY);
        $('m-inbound').textContent = k.inbound;
        $('m-next').textContent = k.nextEtaM == null ? '-' : clock(k.nextEtaM);
        $('m-fence').textContent = k.inGeofence;
        $('m-arrived').textContent = `${k.arrived}/${k.total}`;
        renderRows(list);
        renderCard(list);
        scrub.value = Math.floor(minute);
        $('clock').textContent = clock(minute);
    }

    let last = performance.now();
    function frame(now) {
        const dt = (now - last) / 1000;
        last = now;
        if (playing && !active) {
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
        if (active) return;
        if (minute >= model.endMin) minute = 0;
        playing = !playing;
        setPlaying(playing ? 'play' : 'pause');
    });
    $('speed').addEventListener('change', (e) => { if (!active) speed = Number(e.target.value); });
    scrub.addEventListener('input', () => {
        if (active) return;
        playing = false;
        setPlaying('pause');
        minute = Number(scrub.value);
        render();
    });
    const stop = active ? followLive(root.dataset.replayUrl, data, (next, transition) => {
        active = transition.active;
        model = transition.model;
        minute = transition.minute;
        replay = new Replay(model, { live: active });
        total = model.events.filter((e) => e.p.type === 'truck.arrived').length;
        hasTrips = model.events.some((e) => e.p.type === 'truck.dispatched');
        $('m-nodata').hidden = hasTrips;
        scrub.max = Math.ceil(Math.max(model.endMin, minute));
        readOnlyLiveControls(root, active);
        if (!active) setPlaying('ended');
        render();
        setStatus(root, active ? 'langsung' : 'selesai', 'ok');
    }, () => setStatus(root, 'langsung terputus', 'bad')) : () => {};
    addEventListener('pagehide', () => { stop(); if (!active) saveMinute(runId, minute); });

    setPlaying('play');
    render();
    requestAnimationFrame(frame);
}

fetchReplay(root.dataset.replayUrl, (status) => setStatus(root, status), { allowLive: true })
    .then((data) => {
        setStatus(root, isLiveOperation(data) ? 'langsung' : 'selesai', 'ok');
        $('tw-loading').hidden = true;
        return start(data);
    })
    .catch((e) => {
        setStatus(root, 'gagal', 'bad');
        $('run-msg').textContent = e.message;
    });
