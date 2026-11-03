// Halaman Bangun pabrik: atur jumlah modul, pratinjau denah 3D, simpan denah, lalu jalankan sebagai run baru.
import '../css/twin.css';
import { DEFAULT_PLANT, PLANT_FIELDS, layoutFromPlant, normalizePlant, plantChanges } from './twin/layout/plant.js';
import { h } from './twin/ui/dom.js';
import { initShell } from './twin/ui/shell.js';

const root = document.getElementById('tw');
const $ = (id) => document.getElementById(id);
let scene3d = null;
const shell = initShell(root, { onTheme: (t) => scene3d?.setTheme(t) });

document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    $('tw-minimize').click();
});

const csrf = document.querySelector('meta[name="csrf-token"]')?.content ?? '';
let layouts = JSON.parse(root.dataset.layouts || '[]');
let plant = { ...DEFAULT_PLANT };
let timer = 0;

function summary() {
    const l = layoutFromPlant(plant);
    const changed = Object.keys(plantChanges(plant)).length;
    $('b-summary').textContent = `${l.halls[0].bays.length} bay, ${l.silos.length} tangki, ${l.units.length} unit proses di denah. ${changed ? `${changed} modul berbeda dari bawaan.` : 'Sama dengan pabrik bawaan.'}`;
}

function preview() {
    summary();
    clearTimeout(timer);
    timer = setTimeout(() => {
        try { scene3d?.setLayout(layoutFromPlant(plant)); } catch (e) { $('b-err').textContent = e.message; }
    }, 150);
}

function renderFields() {
    $('b-fields').replaceChildren(...PLANT_FIELDS.map((f) => h('label', {},
        h('span', {}, f.label, f.drawn ? '' : ' (hanya simulasi)'),
        h('input', {
            type: 'number', min: f.min, max: f.max, step: 1, value: plant[f.key], 'data-key': f.key,
            oninput: (e) => {
                const n = Math.round(Number(e.target.value));
                if (!Number.isFinite(n) || n < f.min || n > f.max) return;
                plant[f.key] = n;
                preview();
            },
            onchange: (e) => { e.target.value = plant[f.key]; },
        }))));
}

function setPlant(next) {
    plant = normalizePlant(next);
    $('b-err').textContent = '';
    renderFields();
    preview();
}

function renderSaved(selectedId = '') {
    $('b-saved').replaceChildren(
        h('option', { value: '' }, 'Pabrik bawaan'),
        ...layouts.map((l) => h('option', { value: String(l.id) }, l.by ? `${l.name} (${l.by})` : l.name)),
    );
    $('b-saved').value = String(selectedId);
    const cur = layouts.find((l) => String(l.id) === $('b-saved').value);
    $('b-delete').hidden = !cur?.can_delete;
}

$('b-saved').addEventListener('change', () => {
    const cur = layouts.find((l) => String(l.id) === $('b-saved').value);
    setPlant(cur ? cur.plant : DEFAULT_PLANT);
    $('b-delete').hidden = !cur?.can_delete;
});
$('b-reset').addEventListener('click', () => { renderSaved(); setPlant(DEFAULT_PLANT); });

async function call(url, init) {
    const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-TOKEN': csrf } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.errors ? Object.values(body.errors).flat()[0] : (body.message || `Gagal (HTTP ${res.status}).`));
    return body;
}

$('b-save').addEventListener('click', async () => {
    const btn = $('b-save');
    btn.disabled = true;
    $('b-err').textContent = '';
    try {
        const saved = await call(root.dataset.saveUrl, { method: 'POST', body: JSON.stringify({ name: $('b-name').value, plant }) });
        layouts = [...layouts, saved].sort((a, b) => a.name.localeCompare(b.name));
        renderSaved(saved.id);
        $('b-name').value = '';
    } catch (e) {
        $('b-err').textContent = e.message;
    } finally {
        btn.disabled = false;
    }
});

$('b-delete').addEventListener('click', async () => {
    const id = $('b-saved').value;
    if (!id || !confirm('Hapus denah ini?')) return;
    try {
        await call(`${root.dataset.deleteUrl}/${id}`, { method: 'DELETE' });
        layouts = layouts.filter((l) => String(l.id) !== id);
        renderSaved();
    } catch (e) {
        $('b-err').textContent = e.message;
    }
});

// Hanya modul yang berbeda dari bawaan dikirim; pabrik bawaan tidak disimpan di run, jadi tetap sebanding dengan run lain.
$('b-run').addEventListener('submit', () => {
    $('b-plant-inputs').replaceChildren(...Object.entries(plantChanges(plant)).map(([k, v]) => h('input', { type: 'hidden', name: `plant[${k}]`, value: v })));
});

renderFields();
renderSaved();
summary();

(async () => {
    try {
        const { TwinScene3D, loadModels, loadPlant } = await import('./twin/scene3d.js');
        const [, model] = await Promise.all([loadModels(), loadPlant()]);
        scene3d = new TwinScene3D($('twin3d'), { layout: layoutFromPlant(plant), theme: shell.theme.theme, plant: model });
    } catch {
        $('twin3d').hidden = true;
        $('b-nogl').hidden = false;
    }
})();
