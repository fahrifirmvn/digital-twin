// Panel melayang yang bisa digeser dengan mouse, sentuh, atau tombol panah pada gagangnya; posisi diingat sebagai pecahan area induk.
const STEP = 16;

export function initDraggable(panel, key) {
    const grip = panel?.querySelector('.tw-grip');
    const area = panel?.offsetParent;
    if (!grip || !area) return;
    const small = () => window.matchMedia('(max-width: 700px)').matches;
    const storeKey = `twin.pos.${key}`;
    const clamp = (v, max) => Math.min(Math.max(v, 0), Math.max(max, 0));

    function place(x, y) {
        const px = clamp(x, area.clientWidth - panel.offsetWidth);
        const py = clamp(y, area.clientHeight - panel.offsetHeight);
        Object.assign(panel.style, { left: `${px}px`, top: `${py}px`, right: 'auto', bottom: 'auto' });
        return [px, py];
    }
    function save(px, py) {
        try { localStorage.setItem(storeKey, JSON.stringify([px / area.clientWidth, py / area.clientHeight])); } catch { /* posisi tak tersimpan */ }
    }
    function clear() {
        Object.assign(panel.style, { left: '', top: '', right: '', bottom: '' });
    }
    function reset() {
        clear();
        try { localStorage.removeItem(storeKey); } catch { /* posisi tak tersimpan */ }
    }
    function restore() {
        if (small()) { clear(); return; }
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem(storeKey)); } catch { /* data rusak: abaikan */ }
        if (Array.isArray(saved) && saved.every(Number.isFinite)) place(saved[0] * area.clientWidth, saved[1] * area.clientHeight);
    }

    let start = null;
    grip.addEventListener('pointerdown', (e) => {
        if (small() || e.button !== 0) return;
        const r = panel.getBoundingClientRect();
        const a = area.getBoundingClientRect();
        start = { dx: e.clientX - r.left + a.left, dy: e.clientY - r.top + a.top };
        grip.setPointerCapture(e.pointerId);
        panel.classList.add('is-dragging');
    });
    grip.addEventListener('pointermove', (e) => {
        if (start) place(e.clientX - start.dx, e.clientY - start.dy);
    });
    const end = () => {
        if (!start) return;
        start = null;
        panel.classList.remove('is-dragging');
        save(panel.offsetLeft, panel.offsetTop);
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    grip.addEventListener('dblclick', reset);
    grip.addEventListener('keydown', (e) => {
        const d = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP], ArrowDown: [0, STEP] }[e.key];
        if (e.key === 'Home') { e.preventDefault(); reset(); return; }
        if (!d || small()) return;
        e.preventDefault();
        const [px, py] = place(panel.offsetLeft + d[0], panel.offsetTop + d[1]);
        save(px, py);
    });
    window.addEventListener('resize', restore);
    restore();
    return { refit: restore };
}
