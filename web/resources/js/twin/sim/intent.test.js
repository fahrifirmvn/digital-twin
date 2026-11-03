import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_LAYOUT } from '../layout/default.js';
import { activeFlowLinks, placeTrucks, truckSlots } from './intent.js';

const tanker = (code, status, arrivedAt, extra = {}) => ({ code, status, arrivedAt, bay: null, held: null, ...extra });
const state = (tankers, flows = [], m = 0) => ({ m, tankers: Object.fromEntries(tankers.map((t) => [t.code, t])), flows });

test('slot antre V6: depan di 62 sebelum gerbang, mundur tiap 74', () => {
    const { queue } = truckSlots(DEFAULT_LAYOUT);
    assert.equal(queue[0].a, 338);
    assert.equal(queue[1].a, 264);
    assert.ok(queue.every((s) => s.b === 0 && s.facing === 'a'));
    assert.ok(queue.at(-1).a >= -320 + 30);
});

test('slot area tunggu, lab dan bay sesuai V6', () => {
    const s = truckSlots(DEFAULT_LAYOUT);
    assert.deepEqual(s.pad.map((p) => p.a), [520, 580, 640]);
    assert.equal(s.pad[0].b, 84);
    assert.deepEqual(s.lab.map((p) => p.a), [668, 594, 520]);
    assert.equal(s.bay.get('BAY-1').a, 614);
    assert.equal(s.bay.get('BAY-1').b, 340);
    assert.equal(s.bay.size, 3);
});

test('truk menempati slot menurut status dan urutan tiba', () => {
    const st = state([
        tanker('T-2', 'queued', 5),
        tanker('T-1', 'queued', 1),
        tanker('T-3', 'sampling', 2),
        tanker('T-4', 'released', 3),
        tanker('T-5', 'unloading', 0, { bay: 'BAY-2' }),
        tanker('T-6', 'queued', 4, { held: 'G1' }),
        tanker('T-7', 'stored', 0),
    ]);
    const { trucks, overflow } = placeTrucks(st, DEFAULT_LAYOUT);
    const at = (code) => trucks.find((t) => t.code === code);
    assert.equal(at('T-1').a, 338);
    assert.equal(at('T-2').a, 264);
    assert.equal(at('T-3').a, 668);
    assert.equal(at('T-3').b, 640);
    assert.equal(at('T-4').a, 520);
    assert.equal(at('T-5').a, 680);
    assert.equal(at('T-5').b, 340);
    assert.equal(at('T-6'), undefined);
    assert.equal(at('T-7'), undefined);
    assert.equal(overflow, 0);
});

test('kelebihan truk dihitung sebagai overflow', () => {
    const cap = truckSlots(DEFAULT_LAYOUT).queue.length;
    const many = Array.from({ length: cap + 3 }, (_, i) => tanker(`T-${i}`, 'queued', i));
    const { trucks, overflow } = placeTrucks(state(many), DEFAULT_LAYOUT);
    assert.equal(trucks.length, cap);
    assert.equal(overflow, 3);
});

test('aliran memudar menurut umur dan RT- menjadi ENTRANCE', () => {
    const st = state([], [
        { from: 'RT-1', to: 'TK-RAW-1', m: 90 },
        { from: 'BAY-1', to: 'BAY-1', m: 90 },
        { from: 'TK-RAW-1', to: 'QA-HOLD', m: 10 },
    ], 100);
    const links = activeFlowLinks(st, 60);
    assert.equal(links.length, 1);
    assert.equal(links[0].from, 'ENTRANCE');
    assert.ok(links[0].alpha > 0 && links[0].alpha < 1);
});
