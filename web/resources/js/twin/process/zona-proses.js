// Mode "Zona Proses": papan alur proses hidup dari state replay yang sama dengan Twin 3D. Hanya membaca; tidak ada aksi yang mengubah aset.
import '../../../css/process.css';
import { emptyState } from '../state.js';
import { chipEl, h } from '../ui/dom.js';
import { fmtL } from '../ui/format.js';
import { icon } from '../ui/icons.js';
import { askPrompt, detailOf, fmtTph, processModel, simPrompt } from './model.js';

const REFRESH_MS = 200;

const KPI = [
    ['unloaded', 'Truk dibongkar', (v) => String(v)],
    ['rawTon', 'Di tangki mentah', fmtL],
    ['stoTon', 'Di penyimpanan', fmtL],
    ['asepTon', 'Di aseptic tank', fmtL],
    ['fgTon', 'Produk jadi', fmtL],
    ['qaHoldTon', 'Tahan QA', fmtL],
    ['attention', 'Perlu perhatian', (v) => String(v)],
];

const chipSig = (c) => `${c.tone}|${c.label}|${c.icon}`;

export function mountProcess(host, { plant, onLocate } = {}) {
    let model = processModel(plant, emptyState());
    let selected = null;
    let opener = null;
    let tiles = new Map();
    let kpiEls = new Map();
    let linkEls = [];
    let panelSig = '';
    let timer = 0;
    let latest = null;

    const flow = h('ol', { class: 'px-flow', 'aria-label': 'Alur proses dari penerimaan sampai produk jadi' });
    const kpis = h('div', { class: 'px-kpis', role: 'group', 'aria-label': 'Ringkasan proses' });
    const empty = h('p', { class: 'px-empty', role: 'status' }, 'Memuat data hari operasi...');
    const scroll = h('div', { class: 'px-scroll' }, kpis, empty, flow);
    const panel = h('aside', { class: 'px-panel', 'aria-label': 'Detail aset', hidden: true });
    host.replaceChildren(scroll, panel);

    const close = (restore) => {
        selected = null;
        panel.hidden = true;
        host.classList.remove('has-panel');
        tiles.forEach((t) => t.el.setAttribute('aria-pressed', 'false'));
        if (restore && opener) opener.focus();
    };

    const ask = (text) => {
        if (!text) return;
        close(false);
        document.dispatchEvent(new CustomEvent('assistant:ask', { detail: { text } }));
    };

    function buildPanel(code) {
        panelSig = '';
        const closeBtn = h('button', { class: 'px-iconbtn', type: 'button', 'aria-label': 'Tutup detail', onclick: () => close(true) });
        closeBtn.innerHTML = icon('x', 18);
        const body = h('div', { class: 'px-panel-body', 'aria-live': 'off' });
        const sim = simPrompt(code);
        panel.replaceChildren(
            h('header', { class: 'px-panel-head' }, h('div', { class: 'px-panel-title' }, h('b', {}, code), h('span', { id: 'px-panel-sub' })), closeBtn),
            body,
            h('footer', { class: 'px-panel-foot' },
                h('button', { class: 'px-btn', type: 'button', onclick: () => onLocate?.(code) }, 'Lihat di 3D'),
                h('button', { class: 'px-btn', type: 'button', disabled: !sim, title: sim ? 'Menyiapkan pertanyaan di Asisten (tidak mengubah aset)' : 'Hanya untuk tangki', onclick: () => ask(sim) }, 'Simulasikan maintenance'),
                h('button', { class: 'px-btn primary', type: 'button', onclick: () => ask(askPrompt(code)) }, 'Tanya Asisten')),
        );
        panel.hidden = false;
        host.classList.add('has-panel');
    }

    function fillPanel(state) {
        if (!selected) return;
        const d = detailOf(selected, state);
        const sig = JSON.stringify([d.chip, d.pct, d.rows, d.history]);
        if (sig === panelSig) return;
        panelSig = sig;
        panel.querySelector('#px-panel-sub').textContent = d.label;
        const body = panel.querySelector('.px-panel-body');
        const parts = [h('div', { class: 'px-panel-chip' }, chipEl(d.chip))];
        if (d.cap) {
            const gauge = h('div', { class: 'px-gauge is-big', role: 'img', 'aria-label': `Terisi ${d.pct} persen`, dataset: { warn: d.pct >= 90 ? '1' : '' } }, h('i', {}));
            gauge.firstChild.style.height = `${d.pct}%`;
            parts.push(h('div', { class: 'px-panel-level' }, gauge, h('div', {}, h('strong', { class: 'px-big' }, `${d.pct}%`), h('span', { class: 'px-sub' }, `${fmtL(d.level)} / ${fmtL(d.cap)}`))));
        }
        parts.push(h('dl', { class: 'px-rows' }, d.rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])));
        parts.push(h('h4', {}, 'Perpindahan terakhir'));
        parts.push(d.history.length
            ? h('ul', { class: 'px-history' }, d.history.map((e) => h('li', {}, h('span', {}, e.text))))
            : h('p', { class: 'px-muted' }, 'Belum ada perpindahan yang tercatat pada aset ini hari ini.'));
        body.replaceChildren(...parts);
    }

    function open(code, from) {
        if (!tiles.has(code)) return;
        opener = from ?? tiles.get(code).el;
        selected = code;
        buildPanel(code);
        tiles.forEach((t, c) => t.el.setAttribute('aria-pressed', String(c === code)));
        if (latest) fillPanel(latest);
        requestAnimationFrame(() => tiles.get(code)?.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    }

    function tileFor(item) {
        const el = h('button', { type: 'button', class: 'px-tile', 'aria-pressed': 'false', dataset: { code: item.code, kind: item.pct == null ? 'unit' : 'tank' }, onclick: (e) => open(item.code, e.currentTarget) });
        const head = h('span', { class: 'px-tile-head' }, h('b', {}, item.code));
        const chipHost = h('span', { class: 'px-tile-chip' });
        const fill = h('i', {});
        const gauge = item.pct == null ? null : h('span', { class: 'px-gauge', 'aria-hidden': 'true' }, fill);
        const note = h('span', { class: 'px-note' });
        el.append(head, chipHost, ...(gauge ? [gauge] : []), note);
        return { el, chipHost, fill, note, sig: '' };
    }

    function build(m) {
        model = m;
        tiles = new Map();
        linkEls = [];
        flow.replaceChildren(...m.stages.flatMap((s, i) => {
            const link = h('li', { class: 'px-link', 'aria-hidden': 'false' }, h('span', { class: 'px-link-line' }), h('span', { class: 'px-link-chip' }));
            link.querySelector('.px-link-line').innerHTML = icon('arrow-down', 16);
            linkEls.push(link);
            const sec = h('li', { class: 'px-stage', dataset: { stage: s.key } },
                h('header', { class: 'px-stage-head' }, h('span', { class: 'px-step' }, String(i + 1)), h('h3', {}, s.title)),
                s.groups.map((g) => h('section', { class: 'px-group', 'aria-label': g.title },
                    s.groups.length > 1 || s.key === 'fill' ? h('h4', {}, g.title) : null,
                    h('div', { class: 'px-tiles' }, g.items.map((item) => {
                        const t = tileFor(item);
                        tiles.set(item.code, t);
                        return t.el;
                    })))));
            return i < m.stages.length - 1 ? [sec, link] : [sec];
        }));
        kpis.replaceChildren(...KPI.map(([key, label]) => {
            const b = h('b', {});
            kpiEls.set(key, b);
            return h('div', { class: 'px-kpi', dataset: { key } }, b, h('span', {}, label));
        }));
    }
    build(model);

    function paint(state) {
        latest = state;
        const m = processModel(plant, state);
        if (m.codes.join() !== model.codes.join()) {
            const keep = selected;
            build(m);
            if (keep && tiles.has(keep)) tiles.get(keep).el.setAttribute('aria-pressed', 'true');
        }
        model = m;
        empty.hidden = true;
        m.stages.forEach((s, i) => {
            if (linkEls[i]) {
                const chip = linkEls[i].querySelector('.px-link-chip');
                chip.textContent = fmtTph(s.rate.tph);
                linkEls[i].dataset.active = s.rate.active ? '1' : '';
            }
            s.groups.forEach((g) => g.items.forEach((item) => {
                const t = tiles.get(item.code);
                if (!t) return;
                const sig = chipSig(item.chip);
                if (sig !== t.sig) {
                    t.sig = sig;
                    t.chipHost.replaceChildren(chipEl(item.chip));
                }
                if (item.pct != null) t.fill.style.width = `${item.pct}%`;
                t.note.textContent = item.note || (item.pct != null ? '' : '-');
                t.el.dataset.warn = item.warn ? '1' : '';
                t.el.setAttribute('aria-label', `${item.code}, ${item.chip.label}${item.pct != null ? `, terisi ${item.pct} persen` : ''}${item.note ? `, ${item.note}` : ''}`);
            }));
        });
        KPI.forEach(([key, , fmt]) => {
            kpiEls.get(key).textContent = fmt(m.kpis[key]);
        });
        kpis.querySelector('[data-key="attention"]').dataset.warn = m.kpis.attention ? '1' : '';
        fillPanel(state);
    }

    // Pembaruan dibatasi supaya putaran waktu cepat tidak membangun ulang layar tiap frame; keadaan terakhir selalu digambar.
    function update(state) {
        latest = state;
        if (host.hidden) return;
        if (timer) return;
        paint(state);
        timer = setTimeout(() => {
            timer = 0;
            if (latest && !host.hidden) paint(latest);
        }, REFRESH_MS);
    }

    const onKey = (e) => {
        if (e.key !== 'Escape' || host.hidden || !selected) return;
        e.preventDefault();
        close(true);
    };

    return {
        update,
        select(code) {
            if (tiles.has(code)) open(code);
        },
        get selected() { return selected; },
        show() {
            host.hidden = false;
            document.addEventListener('keydown', onKey);
            if (latest) paint(latest);
        },
        hide() {
            host.hidden = true;
            close(false);
            document.removeEventListener('keydown', onKey);
        },
    };
}
