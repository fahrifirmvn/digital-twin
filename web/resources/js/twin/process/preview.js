// Kartu pratinjau hover: tanpa tombol, hanya membaca.
import { chipEl, h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { AT, FILLERS, SAMPLE_CHIP } from './dummy.js';
import { chipOf, fillerLph, flowCheck, fmtDec, fmtInt, fmtLph, linksOf, pctOf } from './model.js';

export function bar(pct, { tick, tone } = {}) {
    const fill = h('i');
    fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    const el = h('div', { class: 'px-bar', dataset: { tone: tone ?? '' }, role: 'img', 'aria-label': `${Math.round(pct)} persen` }, fill);
    if (tick != null) {
        const t = h('b', { class: 'px-bar-tick', title: `Minimum ${tick}%` });
        t.style.left = `${tick}%`;
        el.append(t);
    }
    return el;
}

export const row = (label, value, ...extra) => h('div', { class: 'px-row' }, h('span', { class: 'px-k' }, label), h('span', { class: 'px-v' }, value), ...extra);

export function flowStrip(a) {
    return h('div', { class: 'px-strip' }, linksOf(a).map((l) => {
        const line = h('div', { class: 'px-strip-row' });
        line.innerHTML = icon(l.dir === 'from' ? 'arrow-down' : 'arrow-right', 14);
        line.append(h('span', {}, `${l.dir === 'from' ? 'Dari' : 'Ke'} ${l.label} · ${fmtLph(l.lph, l.unit)}`));
        return line;
    }));
}

/** Angka utama + sub teks + bar; persen untuk tangki, laju untuk mesin. */
export function mainBlock(a) {
    if (a.kind === 'tank') {
        const pct = pctOf(a);
        return h('div', { class: 'px-main' },
            h('div', { class: 'px-main-line' }, h('strong', { class: 'px-big' }, `${pct}%`), h('span', { class: 'px-sub' }, `${fmtInt(a.levelL)} / ${fmtInt(a.capL)} L`)),
            bar(pct, { tick: a.minPct }));
    }
    const rate = a.rate;
    return h('div', { class: 'px-main' },
        h('div', { class: 'px-main-line' }, h('strong', { class: 'px-big' }, fmtInt(rate)), h('span', { class: 'px-sub' }, `${a.unit} · maks ${fmtInt(a.maxRate)}`)),
        bar((rate / a.maxRate) * 100));
}

export function dataRows(a) {
    if (a.kind === 'tank') {
        const rows = [
            row('Input', fmtLph(a.inLph)),
            row('Output', `${fmtLph(a.outLph)} (maks ${fmtInt(a.maxOutLph)})`),
            h('div', { class: 'px-row px-row-age' }, h('span', { class: 'px-k' }, 'Umur isi'), h('span', { class: 'px-v' }, `${fmtDec(a.ageH)} j / maks ${a.holdMaxH} j`),
                bar((a.ageH / a.holdMaxH) * 100, { tone: a.ageH > 0.8 * a.holdMaxH ? 'warn' : '' })),
        ];
        if (a.id === AT.id) {
            const c = flowCheck(a, FILLERS);
            const line = h('div', { class: `px-check${c.ok ? ' is-ok' : ' is-bad'}` });
            line.innerHTML = icon(c.ok ? 'check' : 'alert', 14);
            line.append(h('span', {}, `Total flow FL ${fmtInt(c.total)} ${c.ok ? '<=' : '>'} output AT ${fmtInt(c.max)} L/jam`));
            rows.splice(2, 0, line);
        }
        return rows;
    }
    if (a.kind === 'filler') {
        return [row('Kecepatan', fmtLph(a.rate, a.unit)), row('Ukuran kemasan', `${a.packMl} mL/pack`), row('Setara', fmtLph(fillerLph(a)))];
    }
    if (a.id === 'UBAY-01') return [row('Sedang bongkar', 'Bay 1, Bay 3'), row('Menganggur', 'Bay 2'), row('Total', fmtLph(a.rate))];
    return [row('Input', fmtLph(a.inLph)), row('Output', fmtLph(a.outLph)), row('Beban', `${Math.round((a.rate / a.maxRate) * 100)}% dari maks`)];
}

export const sampleChip = () => h('span', { class: 'px-sample' }, SAMPLE_CHIP);

export function previewCard(a) {
    const head = h('div', { class: 'px-card-head' }, h('b', {}, a.id), h('span', { class: 'px-name' }, a.name), chipEl(chipOf(a)));
    return h('div', { class: 'px-card-body' }, head, mainBlock(a), h('div', { class: 'px-rows' }, dataRows(a)), flowStrip(a),
        h('p', { class: 'px-foot' }, 'Klik 2x untuk detail'), sampleChip());
}
