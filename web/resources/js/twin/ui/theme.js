// Preferensi tampilan bersama Dashboard dan Twin: tema (terang/gelap) tersimpan di localStorage.
import { icon } from './icons.js';

export const store = {
    get(key, fallback) {
        try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
    },
    set(key, value) {
        try { localStorage.setItem(key, value); } catch { /* penyimpanan dinonaktifkan: preferensi tak tersimpan */ }
    },
};

/** Pasang tema pada root dan tombol pengganti; onChange(theme) dipanggil tiap tema berubah (termasuk awal). */
export function initTheme(root, btn, onChange = () => {}) {
    let theme = 'light';
    function set(next) {
        theme = next === 'dark' ? 'dark' : 'light';
        root.dataset.theme = theme;
        btn.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon', 20);
        btn.setAttribute('aria-label', theme === 'dark' ? 'Ganti ke tema terang' : 'Ganti ke tema gelap');
        btn.title = btn.getAttribute('aria-label');
        store.set('twin.theme', theme);
        onChange(theme);
    }
    btn.addEventListener('click', () => set(theme === 'dark' ? 'light' : 'dark'));
    set(store.get('twin.theme', window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
    return { get theme() { return theme; }, set };
}
