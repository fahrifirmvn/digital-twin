import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildPipeGraph, flowEnds, flowRoute, shortestRoute } from './pipes.js';

const line = (id, name, pts) => ({ id, name, r: 0.1, pts });

test('ujung pipa menyambung ke tengah pipa lain (T-junction) dan rute mengikuti pipa', () => {
    const g = buildPipeGraph([line('A', 'Header', [[0, 0, 0], [10, 0, 0]]), line('B', 'Cabang', [[4, 0, 0], [4, 0, 5]]), line('C', 'Jauh', [[20, 0, 0], [30, 0, 0]])]);
    const r = shortestRoute(g, g.lines.get('A')[0], g.lines.get('B').at(-1));
    assert.deepEqual(r.ids, ['A', 'B']);
    assert.equal(r.length, 9);
    assert.equal(shortestRoute(g, g.lines.get('A')[0], g.lines.get('C')[0]), null);
});

test('jarak kecil antar ujung dijembatani tanpa menjadi bagian pipa', () => {
    const g = buildPipeGraph([line('A', 'A', [[0, 0, 0], [5, 0, 0]]), line('B', 'B', [[5.5, 0, 0], [10, 0, 0]])]);
    const r = shortestRoute(g, 0, g.lines.get('B')[1]);
    assert.deepEqual(r.ids, ['A', 'B']);
    assert.equal(r.length, 10);
});

const meta = JSON.parse(readFileSync(new URL('../../../../public/models/plant.json', import.meta.url)));
const two = (n) => String(n).padStart(2, '0');
const taps = Object.fromEntries(meta.bays.map((b, i) => [`BAY-${i + 1}`, b.join]));

test('plant.json: seluruh rute aliran engine tersambung lewat pipa', () => {
    const g = buildPipeGraph(meta.pipes, taps);
    const must = (from, to) => {
        const r = flowRoute(g, from, to);
        assert.ok(r, `${from} -> ${to} tidak tersambung`);
        assert.ok(r.ids.length >= 1 && r.length > 0.5, `${from} -> ${to} terlalu pendek`);
        return r;
    };
    for (let b = 1; b <= 3; b++) must(`BAY-${b}`, 'DEG-1');
    for (let i = 1; i <= 15; i++) {
        must('DEG-1', `TK-RAW-${i}`);
        must(`TK-RAW-${i}`, 'THM-1');
    }
    must('THM-1', 'SEP-1');
    for (let j = 1; j <= 6; j++) {
        must('SEP-1', `TK-STO-${j}`);
        must(`TK-STO-${j}`, 'STE-1');
    }
    for (let k = 1; k <= 5; k++) must('STE-1', `ASEP-${k}`);
    for (let m = 1; m <= 10; m++) must(`ASEP-${Math.ceil(m / 2)}`, `LINE-${m}`);
    for (const f of ['RT-1>BAY-1', 'LINE-1>PACK-OUT', 'TK-STO-1>QA-HOLD']) assert.equal(flowEnds(g, ...f.split('>')), null, f);
    assert.equal(two(5), '05');
});

test('plant.json: cabang tangki berujung bebas di tangki dan rute tiap tangki berbeda', () => {
    const g = buildPipeGraph(meta.pipes, taps);
    const a = flowRoute(g, 'DEG-1', 'TK-RAW-1');
    const b = flowRoute(g, 'DEG-1', 'TK-RAW-15');
    assert.notDeepEqual(a.pts.at(-1), b.pts.at(-1));
    for (const r of [a, b]) assert.ok(r.length > 5 && r.length < 80, `panjang rute ${r.length}`);
    for (const p of meta.pipes) assert.ok(p.pts.length >= 2 && p.r > 0, p.name);
});
