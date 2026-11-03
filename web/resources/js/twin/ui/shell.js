// Perilaku TopBar yang sama di Dashboard dan Twin: ikon, tema, dan drawer Asisten AI (lihat assistant.js).
import { hydrateIcons, icon } from './icons.js';
import { initTheme } from './theme.js';
import { initDraggable } from './drag.js';
import { initAssistant } from './assistant.js';

// Kartu [data-collapse] bisa diciutkan ke judulnya; pilihan diingat per kartu, default ciut di layar kecil.
function initFolds(root) {
    const small = window.matchMedia('(max-width: 700px)').matches;
    root.querySelectorAll('[data-collapse]').forEach((card) => {
        const head = card.querySelector(':scope > h2');
        if (!head) return;
        const key = `twin.fold.${card.dataset.collapse}`;
        let saved = null;
        try { saved = localStorage.getItem(key); } catch { /* preferensi tak tersimpan */ }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tw-fold';
        btn.innerHTML = icon('chevron-up', 18);
        head.after(btn);
        function set(folded, remember) {
            card.classList.toggle('is-folded', folded);
            btn.setAttribute('aria-expanded', String(!folded));
            btn.setAttribute('aria-label', `${folded ? 'Buka' : 'Ciutkan'} ${head.textContent}`);
            if (remember) {
                try { localStorage.setItem(key, folded ? '1' : '0'); } catch { /* preferensi tak tersimpan */ }
            }
        }
        const toggle = () => set(!card.classList.contains('is-folded'), true);
        btn.addEventListener('click', toggle);
        head.addEventListener('click', toggle);
        set(saved === null ? small || card.dataset.foldDefault === '1' : saved === '1', false);
    });
}

// Panel kontrol peta: bisa digeser dan diciutkan ke gagangnya; pilihan diingat, default ciut di layar kecil.
function initControls(panel) {
    const btn = panel?.querySelector('.tw-ctl-toggle');
    if (!btn) return;
    const drag = initDraggable(panel, 'twin-controls');
    const key = 'twin.fold.twin-controls';
    function set(folded, remember) {
        panel.classList.toggle('is-collapsed', folded);
        btn.setAttribute('aria-expanded', String(!folded));
        btn.setAttribute('aria-label', `${folded ? 'Tampilkan' : 'Sembunyikan'} kontrol peta`);
        btn.title = btn.getAttribute('aria-label');
        drag?.refit();
        if (remember) {
            try { localStorage.setItem(key, folded ? '1' : '0'); } catch { /* preferensi tak tersimpan */ }
        }
    }
    let saved = null;
    try { saved = localStorage.getItem(key); } catch { /* preferensi tak tersimpan */ }
    btn.addEventListener('click', () => set(!panel.classList.contains('is-collapsed'), true));
    set(saved === null ? window.matchMedia('(max-width: 700px)').matches : saved === '1', false);
}

export function initShell(root, { onTheme } = {}) {
    hydrateIcons(root);
    initFolds(root);
    initControls(root.querySelector('.tw-controls'));
    const theme = initTheme(root, root.querySelector('#tw-theme'), onTheme);

    initAssistant(root);
    return { theme };
}

export function setStatus(root, text, tone = '') {
    const pill = root.querySelector('#run-status');
    pill.textContent = text;
    pill.dataset.tone = tone;
}
