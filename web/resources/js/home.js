// Dashboard: TopBar bersama dan pratinjau mini Twin dan Maps yang berputar dari replay run yang sama.
import '../css/twin.css';
import { TwinCanvas } from './twin/canvas.js';
import { fetchReplay, saveMinute, savedMinute } from './twin/load.js';
import { MapCanvas } from './twin/map/canvas.js';
import { Replay, buildModel } from './twin/state.js';
import { clock } from './twin/ui/format.js';
import { initShell } from './twin/ui/shell.js';

const root = document.getElementById('tw');
const $ = (id) => document.getElementById(id);
const PREVIEW_SPEED = 60; // menit simulasi per detik
const STILL_MINUTE = 480; // pratinjau diam (gerak dikurangi) bila belum ada posisi tersimpan

initShell(root);

function preview(data) {
    const model = buildModel(data.events);
    if (!model.events.length) return;
    const replay = new Replay(model);
    const twin = new TwinCanvas($('mini-twin'));
    const map = new MapCanvas($('mini-map'), { mini: true });
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let minute = Math.min(savedMinute(root.dataset.runId) || (still ? STILL_MINUTE : 0), model.endMin);

    function draw() {
        const s = replay.seek(minute);
        twin.draw(s, PREVIEW_SPEED);
        map.draw(s);
        const t = clock(minute);
        $('mini-twin-clock').textContent = t;
        $('mini-map-clock').textContent = t;
    }

    let last = performance.now();
    function frame(now) {
        minute += ((now - last) / 1000) * PREVIEW_SPEED;
        last = now;
        if (minute >= model.endMin) minute = 0;
        draw();
        requestAnimationFrame(frame);
    }
    draw();
    if (!still) requestAnimationFrame(frame);
    addEventListener('pagehide', () => saveMinute(root.dataset.runId, minute));
}

if ($('mini-twin') && root.dataset.replayUrl) {
    fetchReplay(root.dataset.replayUrl).then(preview).catch(() => {
        for (const id of ['mini-twin', 'mini-map']) $(id).hidden = true;
    });
}
