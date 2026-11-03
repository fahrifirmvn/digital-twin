// Mode "Zona Proses": skema 2D yang dimuat malas dari twin.js. Hanya membaca; tidak ada aksi yang mengubah aset.
import '../../../css/process.css';
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { NOW_MIN, PIPES, PLANT_NAME } from './dummy.js';
import { createDrawer } from './drawer.js';
import { assetById, fmtInt, kpis, pipeFlow, pipesOf, placeCard } from './model.js';
import { previewCard, sampleChip } from './preview.js';
import { buildScene } from './scene.js';

const LAYERS = [['level', 'Level %', 'droplets'], ['flow', 'Laju aliran', 'arrow-right'], ['status', 'Status', 'check']];
const CARD_W = 288;
const GAP = 12;
const DRAWER_W = 428;

export function mountProcess(host) {
    const scene = buildScene();
    const canvas = h('div', { class: 'px-canvas' }, h('div', { class: 'px-inner' }, scene.svg));
    const card = h('div', { class: 'px-card', hidden: true, role: 'status', 'aria-live': 'polite' });
    let hoverId = null;
    let opener = null;

    const ask = (text) => {
        if (!text) return;
        drawer.close();
        sync();
        document.dispatchEvent(new CustomEvent('assistant:ask', { detail: { text } }));
    };
    const drawer = createDrawer({ now: NOW_MIN, onClose: () => closeDrawer(true), onAsk: ask });

    const sync = () => host.classList.toggle('has-drawer', drawer.isOpen);

    const clearHover = () => {
        if (!hoverId) return;
        hoverId = null;
        card.hidden = true;
        scene.svg.classList.remove('is-hovering');
        scene.assets.forEach((g) => g.classList.remove('is-on'));
        scene.resetPipes();
    };

    const showHover = (id) => {
        if (hoverId === id) return;
        clearHover();
        const a = assetById(id);
        const g = scene.assets.get(id);
        if (!a || !g) return;
        hoverId = id;
        scene.svg.classList.add('is-hovering');
        g.classList.add('is-on');
        for (const pid of pipesOf(id)) scene.setPipe(pid, { flow: pipeFlow(PIPES.find((p) => p.id === pid), a), lit: true });
        card.replaceChildren(previewCard(a));
        card.hidden = false;
        card.style.visibility = 'hidden';
        const hostBox = host.getBoundingClientRect();
        const box = g.getBoundingClientRect();
        const bounds = { w: host.clientWidth - (drawer.isOpen ? DRAWER_W : 0), h: host.clientHeight };
        const rect = { x: box.left - hostBox.left, y: box.top - hostBox.top, w: box.width, h: box.height };
        const pos = placeCard(rect, { w: CARD_W, h: card.offsetHeight }, bounds, GAP);
        card.style.transform = `translate(${Math.round(pos.x)}px, ${Math.round(pos.y)}px)`;
        card.style.visibility = '';
    };

    const openDrawer = (id) => {
        const a = assetById(id);
        if (!a) return;
        opener = scene.assets.get(id);
        clearHover();
        drawer.open(a);
        sync();
        revealAsset(opener);
    };

    // Aset yang tertutup drawer digeser ke area kosong di sebelah kiri.
    function revealAsset(g) {
        requestAnimationFrame(() => {
            const over = g.getBoundingClientRect().right + GAP - (host.getBoundingClientRect().right - DRAWER_W);
            if (over > 0) canvas.scrollBy({ left: over, behavior: 'smooth' });
        });
    }

    function closeDrawer(restoreFocus) {
        drawer.close();
        sync();
        if (restoreFocus && opener) opener.focus();
    }

    scene.assets.forEach((g, id) => {
        g.addEventListener('pointerenter', () => showHover(id));
        g.addEventListener('pointerleave', () => hoverId === id && clearHover());
        g.addEventListener('focus', () => showHover(id));
        g.addEventListener('blur', () => hoverId === id && clearHover());
        g.addEventListener('dblclick', () => openDrawer(id));
        g.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openDrawer(id);
            }
        });
    });

    canvas.addEventListener('click', (e) => {
        if (!e.target.closest('.px-asset') && !drawer.pinned && drawer.isOpen) closeDrawer(false);
    });

    const onKey = (e) => {
        if (e.key !== 'Escape' || host.hidden) return;
        if (drawer.isOpen) closeDrawer(true);
        else if (hoverId) clearHover();
        else return;
        e.preventDefault();
    };

    const k = kpis();
    const kpi = h('div', { class: 'px-kpi tw-card', 'aria-label': 'Ringkasan proses' },
        h('div', { class: 'px-kpi-top' }, h('b', {}, PLANT_NAME), sampleChip()),
        h('div', { class: 'px-kpi-vals' }, h('span', {}, `Bongkar ${fmtInt(k.bongkar)} L/jam`), h('span', {}, `Filling ${fmtInt(k.filling)} L/jam`), h('span', { class: 'px-kpi-warn' }, `${k.attention} perlu perhatian`)));

    const tools = h('div', { class: 'px-tools tw-card', role: 'group', 'aria-label': 'Lapisan skema' }, LAYERS.map(([key, label, ico]) => {
        const b = h('button', { type: 'button', class: 'px-toggle', 'aria-pressed': 'true', onclick: () => {
            const on = b.getAttribute('aria-pressed') !== 'true';
            b.setAttribute('aria-pressed', String(on));
            host.classList.toggle(`px--no-${key}`, !on);
        } }, h('span', {}, label));
        b.insertAdjacentHTML('afterbegin', icon(ico, 16));
        return b;
    }));

    host.replaceChildren(canvas, kpi, tools, card, drawer.el);

    return {
        show() {
            host.hidden = false;
            document.addEventListener('keydown', onKey);
        },
        hide() {
            host.hidden = true;
            clearHover();
            closeDrawer(false);
            document.removeEventListener('keydown', onKey);
        },
    };
}
