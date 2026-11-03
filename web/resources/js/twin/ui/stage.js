// Panggung Twin: pin status (overlay DOM) dan sheet detail. Tidak menyimpan state simulasi; tema dan mode tidak di sini.
import { icon } from './icons.js';
import { anomalyMarks, detailOf, detections, levelBadges, pinsOf } from './status.js';

const WIDE = '(min-width: 701px)';

export function createStage(root, { onSelect = () => {}, anomaly = null } = {}) {
    const marks = anomalyMarks(anomaly);
    const $ = (sel) => root.querySelector(sel);
    const pinLayer = $('#tw-pins');
    const sheet = $('#tw-sheet');
    const sheetClose = $('#tw-sheet-close');
    const playBtn = $('#play');
    const pinEls = new Map();
    const boxEls = new Map();
    const badgeEls = new Map();
    let scene = null;
    let projector = null;
    let state = null;
    let selected = null;
    let returnTo = null;
    let pinSig = '';

    function buildPin(p) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'tw-pin';
        el.dataset.tone = p.tone;
        el.dataset.kind = p.kind;
        el.title = p.text;
        el.setAttribute('aria-label', `${p.text}. Buka detail`);
        el.innerHTML = icon(p.icon, 16);
        const label = document.createElement('span');
        label.textContent = p.code;
        el.append(label);
        el.addEventListener('click', () => select(p.code));
        return el;
    }

    function syncPins(next) {
        const sig = next.map((p) => `${p.key}|${p.tone}|${p.text}`).join(';');
        if (sig === pinSig) return;
        pinSig = sig;
        const keep = new Set(next.map((p) => p.key));
        for (const [key, el] of pinEls) {
            if (!keep.has(key)) {
                el.remove();
                pinEls.delete(key);
            }
        }
        for (const p of next) {
            const old = pinEls.get(p.key);
            if (old && old.dataset.sig === `${p.tone}|${p.icon}|${p.text}`) continue;
            const el = buildPin(p);
            el.dataset.sig = `${p.tone}|${p.icon}|${p.text}`;
            const focused = old && document.activeElement === old;
            if (old) old.replaceWith(el);
            else pinLayer.append(el);
            pinEls.set(p.key, el);
            if (focused) el.focus({ preventScroll: true });
            if (returnTo === old) returnTo = el;
        }
    }

    // Kotak deteksi gerbang: hiasan visual, bukan kontrol (info yang sama ada di pin, tabel, dan sheet).
    function syncBoxes(next) {
        const keep = new Set(next.map((b) => b.key));
        for (const [key, el] of boxEls) {
            if (!keep.has(key)) {
                el.remove();
                boxEls.delete(key);
            }
        }
        for (const b of next) {
            let el = boxEls.get(b.key);
            if (!el) {
                el = document.createElement('div');
                el.className = 'tw-det';
                el.setAttribute('aria-hidden', 'true');
                el.append(document.createElement('span'));
                pinLayer.append(el);
                boxEls.set(b.key, el);
            }
            el.dataset.tone = b.tone;
            const text = `${b.plate} \u00b7 ${b.label}`;
            if (el.firstChild.textContent !== text) el.firstChild.textContent = text;
        }
    }

    // Lencana persen isi / status unit: elemen dibuat sekali per aset, hanya teks dan nada yang berubah.
    function syncBadges(next) {
        const keep = new Set(next.map((b) => b.key));
        for (const [key, el] of badgeEls) {
            if (!keep.has(key)) {
                el.remove();
                badgeEls.delete(key);
            }
        }
        for (const b of next) {
            let el = badgeEls.get(b.key);
            if (!el) {
                el = document.createElement('button');
                el.type = 'button';
                el.className = 'tw-badge';
                el.addEventListener('click', () => select(el.dataset.code));
                pinLayer.append(el);
                badgeEls.set(b.key, el);
            }
            el.dataset.code = b.code;
            el.dataset.tone = b.tone;
            el.dataset.kind = b.kind;
            el.title = b.title;
            el.setAttribute('aria-label', `${b.title}. Buka detail`);
            if (el.textContent !== b.text) el.textContent = b.text;
        }
    }

    function placePins() {
        const labels = !!projector?.labelsOn?.();
        for (const [key, el] of badgeEls) {
            const at = labels ? projector.project(key) : null;
            el.hidden = !at;
            if (at) el.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px) translate(-50%, ${pinEls.has(key) ? '8px' : 'calc(-100% - 6px)'})`;
        }
        for (const [key, el] of boxEls) {
            const at = projector?.project(key);
            el.hidden = !at;
            if (at) el.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px) translate(-50%, 4px)`;
        }
        let stacked = 0;
        const fallback = projector?.fallbackKey();
        for (const [key, el] of pinEls) {
            let at = projector?.project(key);
            // Truk yang sudah meninggalkan tampilan (ditolak lab) tetap ditandai di area fallback, ditumpuk bila lebih dari satu.
            if (!at && el.dataset.kind === 'truck' && fallback) {
                at = projector.project(fallback);
                if (at) at = { x: at.x, y: at.y - 44 * stacked++ };
            }
            el.hidden = !at;
            if (at) el.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px) translate(-50%, -110%)`;
        }
    }

    function renderSheet() {
        const d = state && selected ? detailOf(state, selected) : null;
        if (!d) return close();
        $('#tw-sheet-title').textContent = d.title;
        const chip = $('#tw-sheet-chip');
        chip.dataset.tone = d.chip.tone;
        chip.innerHTML = icon(d.chip.icon, 16);
        const label = document.createElement('span');
        label.textContent = d.chip.label;
        chip.append(label);
        const rows = $('#tw-sheet-rows');
        rows.replaceChildren(...d.rows.flatMap(([k, v]) => {
            const dt = document.createElement('dt');
            const dd = document.createElement('dd');
            dt.textContent = k;
            dd.textContent = v;
            return [dt, dd];
        }));
        const gates = $('#tw-sheet-gates');
        gates.hidden = !d.gates;
        gates.querySelector('ul').replaceChildren(...(d.gates ?? []).map((g) => {
            const li = document.createElement('li');
            const chip = document.createElement('span');
            chip.className = 'tw-status';
            chip.dataset.tone = g.tone;
            chip.innerHTML = icon(g.icon, 16);
            const text = document.createElement('span');
            text.textContent = `${g.gate} ${g.name} · ${g.label}`;
            chip.append(text);
            li.append(chip);
            if (g.reason) {
                const why = document.createElement('small');
                why.textContent = g.reason;
                li.append(why);
            }
            return li;
        }));
    }

    function select(code) {
        if (!code) return close();
        if (!state || !detailOf(state, code)) return;
        const wasOpen = !sheet.hidden;
        selected = code;
        renderSheet();
        sheet.hidden = false;
        if (!wasOpen) {
            returnTo = document.activeElement;
            sheetClose.focus({ preventScroll: true });
        }
        scene?.focus(code, { inset: window.matchMedia(WIDE).matches ? sheet.offsetWidth + 32 : 0 });
        onSelect(code);
    }

    function close() {
        if (sheet.hidden) return;
        sheet.hidden = true;
        selected = null;
        scene?.resetFocus();
        if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
        returnTo = null;
        onSelect(null);
    }

    sheetClose.addEventListener('click', close);
    root.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !sheet.hidden) {
            e.preventDefault();
            close();
        }
    });
    new ResizeObserver(() => placePins()).observe(pinLayer);

    return {
        get selected() { return selected; },
        /** Hubungkan kamera 3D (fokus ke objek terpilih, klik aset); null bila 3D tidak dipakai. */
        attach(s) {
            scene = s;
            if (!s) return;
            s.onFrame = placePins;
            s.onSelect = select;
        },
        /** Sumber posisi pin: objek dengan has(kode), project(kode) -> {x,y} px, fallbackKey(). Null menyembunyikan semua pin. */
        setProjector(p) {
            projector = p;
            pinSig = '';
            syncPins(state && p ? pinsOf(state, (c) => p.has(c)) : []);
            syncBoxes(state && p ? detections(state) : []);
            syncBadges(state && p ? levelBadges(state, (c) => p.has(c), marks) : []);
            placePins();
        },
        /** Dipanggil tiap state berubah. */
        update(next) {
            state = next;
            syncPins(projector ? pinsOf(next, (c) => projector.has(c)) : []);
            syncBoxes(projector ? detections(next) : []);
            syncBadges(projector ? levelBadges(next, (c) => projector.has(c), marks) : []);
            if (!sheet.hidden) renderSheet();
            placePins();
        },
        refresh: placePins,
        select,
        setPlaying(kind) {
            const m = { play: ['pause', 'Jeda'], pause: ['play', 'Putar'], ended: ['replay', 'Ulangi'] }[kind];
            playBtn.innerHTML = icon(m[0], 22);
            playBtn.setAttribute('aria-label', m[1]);
            playBtn.title = m[1];
        },
        closeSheet: close,
    };
}
