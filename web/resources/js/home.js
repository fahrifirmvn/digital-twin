// Dashboard: TopBar bersama dan pratinjau mini Twin dan Maps yang berputar dari replay run yang sama.
import '../css/twin.css';
import { TwinCanvas } from './twin/canvas.js';
import { fetchReplay, followLive, isLiveOperation, saveMinute, savedMinute } from './twin/load.js';
import { MapCanvas } from './twin/map/canvas.js';
import { detectTier, deviceSignals } from './twin/kit/quality.js';
import { layoutFromPlant } from './twin/layout/plant.js';
import { Replay, buildModel } from './twin/state.js';
import { clock } from './twin/ui/format.js';
import { initShell, setStatus } from './twin/ui/shell.js';

const root = document.getElementById('tw');
const $ = (id) => document.getElementById(id);
const PREVIEW_SPEED = 60; // menit simulasi per detik
const STILL_MINUTE = 480; // pratinjau diam (gerak dikurangi) bila belum ada posisi tersimpan

let scene3d = null;
const shell = initShell(root, { onTheme: (t) => scene3d?.setTheme(t) });

function preview(data) {
    let active = isLiveOperation(data);
    let model = buildModel(data.events);
    if (!model.events.length) return;
    let replay = new Replay(model, { live: active });
    const twin = new TwinCanvas($('mini-twin'));
    const map = new MapCanvas($('mini-map'), { mini: true });
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let minute = active ? data.live.minute : Math.min(savedMinute(root.dataset.runId) || (still ? STILL_MINUTE : 0), model.endMin);
    let endedLive = false;

    // Pratinjau 3D menggantikan kanvas 2D bila perangkat mampu; berhenti saat di luar layar dan dibatasi ~30 fps.
    let visible = true;
    let lastDraw = 0;
    let first = true;
    new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe($('mini-twin'));

    async function upgrade3d() {
        const host = $('home3d');
        if (!host || navigator.connection?.saveData || detectTier(deviceSignals()) === 'low') return;
        try {
            const { TwinScene3D, loadModels, loadPlant } = await import('./twin/scene3d.js');
            const [, plant] = await Promise.all([loadModels(), loadPlant()]);
            host.hidden = false;
            scene3d = new TwinScene3D(host, { layout: layoutFromPlant(JSON.parse(root.dataset.plant || 'null')), theme: shell.theme.theme, quality: 'low', plant });
            $('mini-twin').hidden = true;
            first = true;
            draw();
        } catch {
            scene3d?.dispose();
            scene3d = null;
            host.hidden = true;
        }
    }

    function draw(now = performance.now()) {
        if (!visible || (scene3d && !first && now - lastDraw < 33)) return;
        lastDraw = now;
        const s = replay.seek(minute);
        if (scene3d) {
            scene3d.draw(s, PREVIEW_SPEED, { snap: first || active });
            first = false;
        } else {
            twin.draw(s, PREVIEW_SPEED);
        }
        map.draw(s);
        const t = clock(minute);
        $('mini-twin-clock').textContent = t;
        $('mini-map-clock').textContent = t;
    }

    let last = performance.now();
    function frame(now) {
        if (!active && !endedLive) minute += ((now - last) / 1000) * PREVIEW_SPEED;
        last = now;
        if (!active && !endedLive && minute >= model.endMin) minute = 0;
        draw(now);
        requestAnimationFrame(frame);
    }
    draw();
    if (!still) requestAnimationFrame(frame);
    upgrade3d();
    if (active) setStatus(root, 'langsung', 'ok');
    const stop = active ? followLive(root.dataset.replayUrl, data, (next, transition) => {
        active = transition.active;
        endedLive = !active;
        model = transition.model;
        minute = transition.minute;
        replay = new Replay(model, { live: active });
        first = true;
        draw();
        setStatus(root, active ? 'langsung' : 'selesai', 'ok');
    }, () => setStatus(root, 'langsung terputus', 'bad')) : () => {};
    addEventListener('pagehide', () => { stop(); if (!active) saveMinute(root.dataset.runId, minute); });
}

if ($('mini-twin') && root.dataset.replayUrl) {
    fetchReplay(root.dataset.replayUrl, () => {}, { allowLive: true }).then(preview).catch(() => {
        for (const id of ['mini-twin', 'mini-map']) $(id).hidden = true;
    });
}
