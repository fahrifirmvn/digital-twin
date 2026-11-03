// Pembuat elemen kecil untuk panel: semua teks lewat textContent, tidak pernah innerHTML dari data run.
import { icon } from './icons.js';

export function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
    }
    el.append(...kids.flat().filter((c) => c != null && c !== false));
    return el;
}

/** Chip status: nada + ikon + label (warna tak pernah berdiri sendiri). */
export function chipEl({ tone, icon: name, label }) {
    const el = h('span', { class: 'tw-status', dataset: { tone } });
    el.innerHTML = icon(name, 14);
    el.append(h('span', {}, label));
    return el;
}
