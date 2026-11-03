// Skema SVG 2D Zona Proses. Semua teks lewat textContent; ikon hanya dari konstanta ikon.
import { iconBody } from '../ui/icons.js';
import { ASSETS, PIPES, STORAGE_TANKS } from './dummy.js';
import { BADGE_H, NODES, PIPE_PATHS, VIEW, tankCell } from './layout.js';
import { badgeOf, fmtLph, pctOf, statusLine } from './model.js';

const NS = 'http://www.w3.org/2000/svg';

export function s(tag, attrs = {}, ...kids) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
    for (const k of kids.flat()) if (k != null && k !== false) el.append(typeof k === 'string' ? document.createTextNode(k) : k);
    return el;
}

export function svgIcon(name, x, y, size, cls = '') {
    const g = s('svg', { x, y, width: size, height: size, viewBox: '0 0 24 24', class: `px-ico ${cls}`.trim(), fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    g.innerHTML = iconBody(name);
    return g;
}

const textW = (str, per = 7.4) => Math.ceil(str.length * per);

/** Bentuk silo (kapsul tegak) pada ukuran w x h. */
export function siloPath(w, h) {
    const r = (14 * w) / 56;
    return `M0 ${r}Q0 0 ${w / 2} 0Q${w} 0 ${w} ${r}V${h - r}Q${w} ${h} ${w / 2} ${h}Q0 ${h} 0 ${h - r}Z`;
}

function capsule(text, cx, y) {
    const w = textW(text, 8.4) + 24;
    return s('g', { class: 'px-cap', transform: `translate(${cx - w / 2} ${y})` },
        s('rect', { width: w, height: 24, rx: 12 }), s('text', { x: w / 2, y: 16.5, 'text-anchor': 'middle' }, text));
}

function badge(a, cx, y) {
    const b = badgeOf(a);
    const tw = textW(b.text);
    const w = 8 + 4 + 6 + tw + (b.icon ? 18 : 0) + 8;
    const g = s('g', { class: `px-badge${b.warn ? ' is-warn' : ''}`, transform: `translate(${cx - w / 2} ${y})` });
    g.append(s('rect', { class: 'px-badge-bg', width: w, height: BADGE_H, rx: BADGE_H / 2 }));
    g.append(s('rect', { class: 'px-mini-track', x: 8, y: 4, width: 4, height: 12, rx: 2 }));
    const fill = (12 * b.pct) / 100;
    g.append(s('rect', { class: 'px-mini-fill', x: 8, y: 4 + 12 - fill, width: 4, height: fill, rx: 2 }));
    g.append(s('text', { class: 'px-badge-txt', x: 18, y: 14.5 }, b.text));
    if (b.icon) g.append(svgIcon(b.icon, 18 + tw + 4, 4, 12, 'px-badge-ico'));
    if (b.aged) {
        g.append(s('circle', { class: 'px-aged', cx: w - 2, cy: 1, r: 8 }));
        g.append(svgIcon('clock', w - 7, -4, 10, 'px-aged-ico'));
        g.append(s('title', {}, 'Umur isi melewati 80% batas holding time'));
    }
    return { el: g, w };
}

function dotText(kind, text, cx, y) {
    const w = textW(text, 7);
    return s('g', { class: `px-statusline${kind === 'ok' ? ' is-rate' : ''}`, transform: `translate(${cx} ${y})` },
        s('circle', { class: `px-dot is-${kind}`, cx: -w / 2 - 9, cy: -4, r: 4 }),
        s('text', { x: 0, y: 0, 'text-anchor': 'middle' }, text));
}

function silo(a, node, size, cx) {
    const { w, h } = size;
    const pct = pctOf(a);
    const clip = `px-clip-${a.id}`;
    const g = s('g', { transform: `translate(${node.x} ${node.y})` });
    g.append(s('clipPath', { id: clip }, s('path', { d: siloPath(w, h) })));
    g.append(s('path', { class: 'px-silo', d: siloPath(w, h) }));
    g.append(s('rect', { class: 'px-level', x: 0, y: h - (h * pct) / 100, width: w, height: (h * pct) / 100, 'clip-path': `url(#${clip})` }));
    g.append(s('path', { class: 'px-silo-edge', d: siloPath(w, h) }));
    if (a.minPct != null) {
        const y = h - (h * a.minPct) / 100;
        g.append(s('line', { class: 'px-minline', x1: -4, x2: w + 4, y1: y, y2: y }));
        g.append(s('title', {}, `Garis level minimum ${a.minPct}%`));
    }
    g.append(s('text', { class: 'px-id', x: w / 2, y: 24, 'text-anchor': 'middle' }, a.id));
    return g;
}

function buildTank(a, node, size, label) {
    const g = s('g', { class: 'px-asset', 'data-id': a.id, tabindex: 0, role: 'button', 'aria-label': `${a.id} ${a.name} ${pctOf(a)} persen` });
    const cx = node.x + size.w / 2;
    const bottom = node.y + size.h;
    g.append(s('rect', { class: 'px-ring', x: node.x - 8, y: node.y - 8, width: size.w + 16, height: size.h + BADGE_H + 4 + 16, rx: 16 }));
    g.append(silo(a, node, size, cx));
    g.append(badge(a, cx, bottom + 4).el);
    const sl = a.status === 'cip' || a.status === 'maintenance' ? statusLine(a) : null;
    if (sl) g.append(dotText(sl.dot, sl.text, cx, bottom + 4 + BADGE_H + 14));
    if (label) g.append(capsule(label, cx, bottom + 4 + BADGE_H + 12));
    return g;
}

function buildMachine(a, node) {
    const g = s('g', { class: 'px-asset', 'data-id': a.id, tabindex: 0, role: 'button', 'aria-label': `${a.name} ${a.id}` });
    g.append(s('rect', { class: 'px-ring', x: node.x - 8, y: node.y - 8, width: node.w + 16, height: node.h + 16, rx: 26 }));
    g.append(s('rect', { class: 'px-machine', x: node.x, y: node.y, width: node.w, height: node.h, rx: 20 }));
    g.append(svgIcon(node.icon, node.x + node.w / 2 - 14, node.y + 14, 28, 'px-machine-ico'));
    const sl = statusLine(a);
    g.append(dotText(sl.dot, sl.text, node.x + node.w / 2 + 4, node.y + node.h - 14));
    g.append(capsule(node.label, node.x + node.w / 2, node.y + node.h + 12));
    return g;
}

function buildReceiving(node) {
    const g = s('g', { class: 'px-static' });
    g.append(s('rect', { class: 'px-machine', x: node.x, y: node.y, width: node.w, height: node.h, rx: 20 }));
    g.append(svgIcon(node.icon, node.x + node.w / 2 - 16, node.y + node.h / 2 - 16, 32, 'px-machine-ico'));
    g.append(capsule(node.label, node.x + node.w / 2, node.y + node.h + 12));
    return g;
}

function buildPipe(p) {
    const path = PIPE_PATHS[p.id];
    const d = path.pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join('');
    const g = s('g', { class: 'px-pipe', 'data-id': p.id });
    g.append(s('path', { class: 'px-pipe-line', d, 'marker-end': 'url(#px-arrow)' }));
    if (path.label) g.append(capsule(p.label, path.label[0], path.label[1] - 34));
    const [cx, cy] = path.chip;
    const chip = s('g', { class: 'px-chip', transform: `translate(${cx} ${cy})` });
    g.append(chip);
    return g;
}

function setChipText(chip, text) {
    const w = textW(text, 7.2) + 16;
    chip.replaceChildren(s('rect', { x: -w / 2, y: -11, width: w, height: 22, rx: 11 }), s('text', { x: 0, y: 4.5, 'text-anchor': 'middle' }, text));
}

/** Membangun skema; mengembalikan svg, peta grup aset, dan pembaruan status pipa. */
export function buildScene() {
    const svg = s('svg', { class: 'px-svg', viewBox: `0 0 ${VIEW.w} ${VIEW.h}`, role: 'group', 'aria-label': 'Skema Zona Proses', preserveAspectRatio: 'xMidYMid meet' });
    const defs = s('defs', {},
        s('marker', { id: 'px-arrow', viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 5, markerHeight: 5, orient: 'auto', markerUnits: 'userSpaceOnUse' },
            s('path', { d: 'M1 1 9 5 1 9z', fill: 'context-stroke' })));
    svg.append(defs);
    const frame = NODES.STORAGE;
    svg.append(s('rect', { class: 'px-frame', x: frame.x, y: frame.y, width: frame.w, height: frame.h, rx: 28 }));
    svg.append(capsule(frame.label, frame.x + frame.w / 2, frame.y + frame.h + 8));

    const pipes = new Map();
    for (const p of PIPES) {
        const el = buildPipe(p);
        pipes.set(p.id, { el, chip: el.querySelector('.px-chip') });
        svg.append(el);
    }

    const assets = new Map();
    const add = (a, el) => {
        assets.set(a.id, el);
        svg.append(el);
    };
    svg.append(buildReceiving(NODES['RCV-01']));
    STORAGE_TANKS.forEach((a, i) => add(a, buildTank(a, tankCell(i), tankCell(i))));
    for (const a of ASSETS) {
        if (a.kind === 'tank' && a.group !== 'storage') add(a, buildTank(a, NODES[a.id], NODES[a.id], NODES[a.id].label));
        else if (a.kind !== 'node' && a.kind !== 'tank') add(a, buildMachine(a, NODES[a.id]));
    }

    const setPipe = (id, { flow, lit, unit = 'L/jam' }) => {
        const p = pipes.get(id);
        p.el.classList.toggle('is-active', flow > 0);
        p.el.classList.toggle('is-lit', lit);
        setChipText(p.chip, fmtLph(flow, unit));
    };
    const resetPipes = () => PIPES.forEach((p) => setPipe(p.id, { flow: p.lph, lit: false }));
    resetPipes();
    return { svg, assets, setPipe, resetPipes };
}
