// Drawer detail aset (klik 2x): 5 tab, tanpa tombol yang mengubah kondisi aset.
import { chipEl, h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { FILLERS } from './dummy.js';
import { askPrompt, chipOf, fmtDec, fmtInt, fmtLph, hhmm, historyOf, linksOf, nextStatus, pctOf, scheduleOf, simPrompt, skuMatrix } from './model.js';
import { dataRows, mainBlock, row, sampleChip } from './preview.js';
import { s, siloPath } from './scene.js';

export const TABS = [['ringkasan', 'Ringkasan'], ['parameter', 'Parameter'], ['jadwal', 'Jadwal'], ['rute', 'Rute'], ['riwayat', 'Riwayat']];

function tankPicture(a) {
    const w = 120;
    const hgt = 154;
    const pct = pctOf(a);
    const svg = s('svg', { class: 'px-pic', width: w, height: hgt + 8, viewBox: `0 0 ${w} ${hgt + 8}`, role: 'img', 'aria-label': `Tangki ${a.id} terisi ${pct} persen` });
    svg.append(s('clipPath', { id: 'px-pic-clip' }, s('path', { d: siloPath(w, hgt) })));
    const g = s('g', { transform: 'translate(0 4)' });
    g.append(s('path', { class: 'px-silo', d: siloPath(w, hgt) }));
    g.append(s('rect', { class: 'px-level', x: 0, y: hgt - (hgt * pct) / 100, width: w, height: (hgt * pct) / 100, 'clip-path': 'url(#px-pic-clip)' }));
    g.append(s('path', { class: 'px-silo-edge', d: siloPath(w, hgt) }));
    g.append(s('line', { class: 'px-capline', x1: -2, x2: w + 2, y1: 1, y2: 1 }));
    if (a.minPct != null) {
        const y = hgt - (hgt * a.minPct) / 100;
        g.append(s('line', { class: 'px-minline', x1: -2, x2: w + 2, y1: y, y2: y }));
    }
    g.append(s('text', { class: 'px-pic-pct', x: w / 2, y: hgt / 2 + 8, 'text-anchor': 'middle' }, `${pct}%`));
    svg.append(g);
    return svg;
}

function composition(a) {
    if (!a.batches.length) return h('p', { class: 'px-muted' }, 'Tangki kosong, tidak ada komposisi batch.');
    const strip = h('div', { class: 'px-comp', role: 'img', 'aria-label': a.batches.map((b) => `${b.label} ${b.pct} persen`).join(', ') });
    a.batches.forEach((b, i) => {
        const seg = h('i', { class: `px-comp-${i % 2}` });
        seg.style.width = `${b.pct}%`;
        strip.append(seg);
    });
    return h('div', {}, h('h4', {}, 'Komposisi isi'), strip, h('p', { class: 'px-muted' }, a.batches.map((b) => `${b.label} ${b.pct}%`).join(' · ')));
}

function ringkasan(a) {
    if (a.kind !== 'tank') return h('div', {}, mainBlock(a), h('div', { class: 'px-rows' }, dataRows(a)));
    const pct = pctOf(a);
    const top = h('div', { class: 'px-sum-top' }, tankPicture(a),
        h('div', { class: 'px-sum-side' }, h('strong', { class: 'px-big' }, `${pct}%`), h('span', { class: 'px-sub' }, `${fmtInt(a.levelL)} / ${fmtInt(a.capL)} L`),
            h('span', { class: 'px-muted' }, `Garis putus-putus: kapasitas ${fmtInt(a.capL)} L`),
            a.minPct != null ? h('span', { class: 'px-muted' }, `Level minimum ${a.minPct}%`) : null));
    const rows = h('div', { class: 'px-rows' },
        row('Input sekarang / maks', `${fmtLph(a.inLph)} / ${fmtInt(a.maxInLph)}`),
        row('Output sekarang / maks', `${fmtLph(a.outLph)} / ${fmtInt(a.maxOutLph)}`),
        row('Umur isi / holding time', `${fmtDec(a.ageH)} j / maks ${a.holdMaxH} j`),
        row('Status berikutnya', nextStatus(a)));
    return h('div', {}, top, composition(a), rows);
}

const note = (t) => h('p', { class: 'px-note' }, t);

function paramRows(a) {
    if (a.kind === 'tank') {
        const rows = [['Kapasitas', `${fmtInt(a.capL)} L`], ['Input maks', fmtLph(a.maxInLph)], ['Output maks', fmtLph(a.maxOutLph)], ['Holding time', `<= ${a.holdMaxH} jam`], ['CIP', `${a.cipMin} menit`]];
        if (a.minPct != null) rows.splice(1, 0, ['Level minimum', `${a.minPct}%`]);
        return rows;
    }
    if (a.kind === 'filler') {
        return [['Speed', fmtLph(a.rate, a.unit)], ['Size', `${a.packMl} mL/pack`], ['Size change', `${a.sizeChangeMin} mnt`], ['Paper change', `${a.paperChangeMin} mnt`], ['Variant change', `${a.variantChangeMin} mnt`], ['CIP', 'Sesuai SOP']];
    }
    return [['Laju maks', fmtLph(a.maxRate, a.unit)], ['Laju sekarang', fmtLph(a.rate, a.unit)], ['CIP', 'Sesuai SOP']];
}

function parameter(a) {
    const body = paramRows(a).map(([k, v]) => h('tr', {}, h('th', { scope: 'row' }, k), h('td', {}, v), h('td', {}, h('span', { class: 'px-ph' }, 'Placeholder'))));
    const out = [h('table', { class: 'px-table' }, h('tbody', {}, body))];
    if (a.kind === 'filler') {
        out.push(h('h4', {}, 'Pemicu CIP (sesuai SOP)'),
            h('ul', { class: 'px-list' }, ['Pergantian coklat/strawberry ke full cream', 'Akhir produksi', 'Akhir volume storage'].map((t) => h('li', {}, t))),
            note('Paper change tidak ditambahkan saat size change.'));
    }
    out.push(note('Nilai di tabel ini menunggu master/SOP final.'));
    return h('div', {}, out);
}

const BAND = { isi: 'Isi', kosong: 'Kosong', cip: 'CIP', maintenance: 'Maintenance' };

function jadwal(a, now) {
    const X0 = 360;
    const W = 364;
    const span = 1440;
    const xOf = (m) => ((m - X0) / span) * W;
    const segs = scheduleOf(a);
    const svg = s('svg', { class: 'px-timeline', width: W, height: 62, viewBox: `0 0 ${W} 62`, role: 'img', 'aria-label': 'Jadwal 06:00 sampai 06:00' });
    for (const g of segs) svg.append(s('rect', { class: `px-band is-${g.type}`, x: xOf(g.from), y: 8, width: Math.max(1, xOf(g.to) - xOf(g.from)), height: 24 }));
    [360, 720, 1080, 1440, 1800].forEach((m, i) => {
        svg.append(s('line', { class: 'px-tick', x1: xOf(m), x2: xOf(m), y1: 6, y2: 36 }));
        svg.append(s('text', { class: 'px-tick-txt', x: Math.min(W - 14, Math.max(14, xOf(m))), y: 54, 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle' }, hhmm(m)));
    });
    svg.append(s('line', { class: 'px-now', x1: xOf(now), x2: xOf(now), y1: 2, y2: 38 }));
    const label = (t) => (a.kind === 'tank' ? BAND[t] : 'Beroperasi');
    const items = segs.map((g) => h('li', {}, h('i', { class: `px-swatch is-${g.type}` }), h('span', {}, `${label(g.type)} ${hhmm(g.from)}–${hhmm(g.to)}`)));
    return h('div', {}, svg, h('p', { class: 'px-muted' }, `Sekarang ${hhmm(now)} (garis tegak)`), h('ul', { class: 'px-legend' }, items));
}

function matrix() {
    const head = h('tr', {}, h('th', {}, 'SKU'), ...FILLERS.map((f) => h('th', {}, f.id)));
    const rows = skuMatrix().map((r) => h('tr', {}, h('th', { scope: 'row' }, r.name), ...r.FL.map((c) => {
        const cell = h('td', { class: c.ok ? 'is-ok' : 'is-no' });
        cell.innerHTML = icon(c.ok ? 'check' : 'minus', 16);
        cell.append(h('span', { class: 'sr-only' }, c.ok ? 'Bisa' : 'Tidak bisa'));
        return cell;
    })));
    return h('div', {}, h('h4', {}, 'Kelayakan AT-FL-SKU'), h('table', { class: 'px-table px-matrix' }, h('thead', {}, head), h('tbody', {}, rows)));
}

function rute(a) {
    const links = linksOf(a);
    const box = (t, cls = '') => h('div', { class: `px-node ${cls}`.trim() }, t);
    const arrow = (lph) => {
        const el = h('div', { class: 'px-hop' });
        el.innerHTML = icon('arrow-right', 16);
        el.append(h('span', {}, fmtLph(lph)));
        return el;
    };
    const from = links.find((l) => l.dir === 'from');
    const to = links.find((l) => l.dir === 'to');
    const flow = h('div', { class: 'px-route' }, from ? [box(from.label), arrow(from.lph)] : null, box(a.id, 'is-self'), to ? [arrow(to.lph), box(to.label)] : null);
    const out = [flow];
    if (a.kind === 'filler') out.push(h('p', { class: 'px-muted' }, `AT-01 -> ${a.id} via Dedicated pipe`));
    if (a.id === 'AT-01' || a.kind === 'filler') out.push(matrix());
    return h('div', {}, out);
}

function riwayat(a, now) {
    return h('ol', { class: 'px-history' }, historyOf(a, now).map((e) => h('li', {},
        h('span', { class: 'px-time' }, e.at), h('span', { class: `px-actor${e.actor === 'PPIC' ? ' is-user' : ''}` }, e.actor === 'PPIC' ? 'Pengguna' : 'Sistem'), h('span', {}, e.reason))));
}

const PANES = { ringkasan, parameter, jadwal, rute, riwayat };

export function createDrawer({ onClose, onAsk, now }) {
    const el = h('aside', { class: 'px-drawer', 'aria-label': 'Detail aset', hidden: true });
    let current = null;
    let tab = 'ringkasan';
    let pinned = false;

    const render = () => {
        const a = current;
        const pin = h('button', { class: 'px-iconbtn', type: 'button', 'aria-pressed': String(pinned), 'aria-label': 'Sematkan panel', title: 'Sematkan panel', onclick: () => {
            pinned = !pinned;
            render();
        } });
        pin.innerHTML = icon('pin', 18);
        const close = h('button', { class: 'px-iconbtn', type: 'button', 'aria-label': 'Tutup detail', onclick: () => onClose() });
        close.innerHTML = icon('x', 18);
        const head = h('header', { class: 'px-dr-head' }, close, h('div', { class: 'px-dr-title' }, h('b', {}, a.id), h('span', {}, a.name)), chipEl(chipOf(a)), pin);
        const tabs = h('div', { class: 'px-tabs', role: 'tablist', 'aria-label': 'Bagian detail' }, TABS.map(([k, label]) => h('button', {
            type: 'button', role: 'tab', id: `px-tab-${k}`, 'aria-selected': String(k === tab), 'aria-controls': 'px-pane', tabindex: k === tab ? 0 : -1,
            onclick: () => {
                tab = k;
                render();
                el.querySelector(`#px-tab-${k}`).focus();
            },
            onkeydown: (e) => {
                const i = TABS.findIndex(([x]) => x === tab);
                const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
                if (!d) return;
                e.preventDefault();
                tab = TABS[(i + d + TABS.length) % TABS.length][0];
                render();
                el.querySelector(`#px-tab-${tab}`).focus();
            },
        }, label)));
        const pane = h('div', { class: 'px-pane', id: 'px-pane', role: 'tabpanel', 'aria-labelledby': `px-tab-${tab}`, tabindex: 0 }, sampleChip(), PANES[tab](a, now));
        const sim = simPrompt(a);
        const simBtn = h('button', { class: 'px-btn', type: 'button', disabled: !sim, title: sim ? 'Menyiapkan pertanyaan simulasi di Asisten (tidak mengubah aset)' : 'Belum ada padanan di mesin simulasi (data contoh)', onclick: () => onAsk(sim) }, 'Simulasikan maintenance');
        const askBtn = h('button', { class: 'px-btn primary', type: 'button', title: 'Menyiapkan pertanyaan di Asisten (tidak mengubah aset)', onclick: () => onAsk(askPrompt(a)) }, 'Tanya Asisten');
        el.replaceChildren(head, tabs, pane, h('footer', { class: 'px-dr-foot' }, simBtn, askBtn));
    };

    return {
        el,
        get current() { return current; },
        get pinned() { return pinned; },
        get isOpen() { return !el.hidden; },
        open(a) {
            if (current?.id !== a.id) tab = 'ringkasan';
            current = a;
            el.hidden = false;
            render();
        },
        close() {
            el.hidden = true;
            current = null;
        },
    };
}
