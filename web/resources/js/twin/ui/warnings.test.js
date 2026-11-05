import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readWarnings, truckWarningKey } from './warnings.js';
import { MAX_PINS, detailOf, pinsOf } from './status.js';

const truck = (code, over = {}) => ({
    code, status: 'qa_hold', since: 20, farm: 'FRM-01', volume: 20, temp: 4,
    gates: { G2: { decision: 'hold', reason: 'pH di luar batas' } },
    qa: { status: 'held', at: 20, reason: 'pH di luar batas' },
    ...over,
});
const memory = () => {
    const data = new Map();
    return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
};
const state = (tankers) => ({ m: 40, assets: {}, tankers });

test('opening a warning removes only its pin, not the lab state or history', () => {
    const t = truck('RT-001');
    const s = state({ [t.code]: t });
    const original = JSON.stringify(s);
    const warnings = readWarnings(1, memory());
    assert.equal(pinsOf(s, () => true, warnings.has).length, 1);
    warnings.mark(t);
    assert.equal(pinsOf(s, () => true, warnings.has).length, 0);
    assert.equal(JSON.stringify(s), original);
    assert.equal(detailOf(s, t.code).chip.label, 'Ditahan QA');
});

test('read state survives refresh within a tab, is isolated by run, and does not return on replay', () => {
    const storage = memory();
    const t = truck('RT-001');
    readWarnings(1, storage).mark(t);
    assert.equal(readWarnings(1, storage).has(structuredClone(t)), true);
    assert.equal(readWarnings(2, storage).has(t), false);
    const warnings = readWarnings(1, storage);
    warnings.mark(truck(t.code, { status: 'stored' }));
    assert.equal(warnings.has(t), true);
});

test('new QA decisions, failures, and status changes generate a new unread warning', () => {
    const t = truck('RT-001');
    const warnings = readWarnings(1, memory());
    warnings.mark(t);
    for (const changed of [
        { since: 30 },
        { status: 'rejected' },
        { qa: { ...t.qa, status: 'testing', at: 30 } },
        { qa: { ...t.qa, reason: 'pH konfirmasi masih rendah' } },
        { gates: { G2: { decision: 'hold', reason: 'pH tidak tersedia' } } },
    ]) {
        assert.equal(warnings.has({ ...t, ...changed }), false);
    }
    assert.equal(truckWarningKey(truck('RT-002', { status: 'stored' })), null);
});

test('read warnings are filtered before the pin limit so remaining alerts are not hidden', () => {
    const trucks = Array.from({ length: MAX_PINS + 2 }, (_, i) => truck(`RT-${String(i).padStart(3, '0')}`));
    const warnings = readWarnings(1, memory());
    trucks.slice(0, MAX_PINS).forEach(warnings.mark);
    const s = state(Object.fromEntries(trucks.map((t) => [t.code, t])));
    assert.equal(pinsOf(s, () => true, warnings.has).length, 2);
});

test('unavailable storage keeps read state for this page and explicitly reports failures', () => {
    const previous = console.warn;
    const messages = [];
    console.warn = (...args) => messages.push(args[0]);
    try {
        const warnings = readWarnings(1, {
            getItem() { throw new Error('blocked'); },
            setItem() { throw new Error('full'); },
        });
        const t = truck('RT-001');
        assert.equal(warnings.has(t), false);
        warnings.mark(t);
        assert.equal(warnings.has(t), true);
        assert.equal(messages.length, 2);
    } finally {
        console.warn = previous;
    }
});
