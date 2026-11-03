import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.window = { devicePixelRatio: 1 };
const { LAYOUT, TwinCanvas } = await import('./canvas.js');

const make = (cw, ch) => new TwinCanvas({
    getContext: () => ({ scale() {} }),
    style: {},
    clientWidth: cw,
    clientHeight: ch,
    getBoundingClientRect: () => ({ left: 100, top: 50 }),
});

test('proyeksi 2D: skala sama, letterbox di tengah, node atas-tengah', () => {
    const c = make(1180, 800); // lebih tinggi dari diagram: offset vertikal 100
    const n = LAYOUT['BAY-1'];
    assert.deepEqual(c.project('BAY-1'), { x: n.x + n.w / 2, y: 100 + n.y });
    const half = make(590, 300);
    assert.deepEqual(half.project('BAY-1'), { x: (n.x + n.w / 2) / 2, y: n.y / 2 });
    assert.equal(c.project('TIDAK-ADA'), null);
    assert.equal(make(0, 0).project('BAY-1'), null);
    assert.ok(c.project('REJECT'));
});

test('pick 2D membalik proyeksi dan mengabaikan area kosong', () => {
    const c = make(590, 300);
    const n = LAYOUT['TK-RAW-1'];
    const at = { x: 100 + (n.x + n.w / 2) / 2, y: 50 + (n.y + n.h / 2) / 2 };
    assert.equal(c.pick(at.x, at.y), 'TK-RAW-1');
    assert.equal(c.pick(100 + 2, 50 + 2), null);
    assert.equal(c.has('BAY-4'), true);
    assert.equal(c.has('RT-1'), false);
});
