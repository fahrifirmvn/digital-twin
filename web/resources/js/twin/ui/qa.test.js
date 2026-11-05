import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearQaPending, qaActions, qaPayload, qaPendingKey, qaRequestId, qaResultsDl, readQaPending, writeQaPending } from './qa.js';

const requestId = 'c0a80123-4567-489a-9abc-0123456789ab';
const held = (over = {}) => ({
    status: 'qa_hold',
    qa: { status: 'held', category: 'quality' },
    qaHistory: [],
    ...over,
});

test('QA results render dt/dd DOM nodes, never stringified nested elements', () => {
    const previousDocument = globalThis.document;
    class Element {
        constructor(tag) { this.tagName = tag; this.children = []; }
        append(...nodes) {
            this.children.push(...nodes.map((node) => node instanceof Element ? node : String(node)));
        }
        get textContent() {
            return this.children.map((node) => node instanceof Element ? node.textContent : node).join('');
        }
        toString() { return '[object HTMLElement]'; }
    }
    globalThis.document = { createElement: (tag) => new Element(tag) };
    try {
        const dl = qaResultsDl({
            fat_pct: 3.2, protein_pct: 2.9, acidity_pct: 0.15,
            ph: 6.7, antibiotic_residue: false, adulterant: true,
        });
        assert.equal(dl.tagName, 'dl');
        assert.deepEqual(dl.children.map((node) => node.tagName), ['dt', 'dd']);
        assert.deepEqual(dl.children.filter((node) => node.tagName === 'dd').map((node) => node.textContent), ['6.7']);
        assert.doesNotMatch(dl.textContent, /Lemak|Protein|Keasaman|Antibiotik|Adulteran/);
        assert.doesNotMatch(dl.textContent, /\[object HTMLElement\]/);
    } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    }
});

test('QA actions require active live run, permission, and valid held/confirmed state', () => {
    assert.deepEqual(qaActions(held(), { active: true, canQa: true }), ['retest', 'reject']);
    assert.deepEqual(qaActions(held(), { active: false, canQa: true }), []);
    assert.deepEqual(qaActions(held(), { active: true, canQa: false }), []);
    assert.deepEqual(qaActions(held({ qa: { status: 'held', category: 'hazard' } }), { active: true, canQa: true }), ['reject']);
    assert.deepEqual(qaActions(held({ qa: { status: 'confirmed', category: 'pass' } }), { active: true, canQa: true }), ['release', 'reject']);
    assert.deepEqual(qaActions(held({ qa: { status: 'testing', category: 'quality' } }), { active: true, canQa: true }), []);
    assert.deepEqual(qaActions(held({ qa: { status: 'held', category: 'quality', expires_min: 90 } }), { active: true, canQa: true, minute: 90 }), []);
});

test('only one confirm/retest attempt is offered, while reject remains available', () => {
    const t = held({ qaHistory: [{ status: 'testing' }] });
    assert.deepEqual(qaActions(t, { active: true, canQa: true }), ['reject']);
});

test('QA payload requires only valid pH and omits removed measurements', () => {
    const base = { requestId, runId: '23', truck: 'RT-17', action: 'retest', reason: 'Konfirmasi QA' };
    assert.throws(() => qaPayload(base), /Isi nilai pH/);
    for (const ph of [null, '', ' ', 'invalid', Infinity, true, -1, 15]) {
        assert.throws(() => qaPayload({ ...base, results: { ph } }), /Isi nilai pH/);
    }
    assert.deepEqual(qaPayload({ ...base, results: { ph: 6.7 } }).results, { ph: 6.7 });
    assert.deepEqual(qaPayload({
        ...base,
        results: { fat_pct: '3.2', protein_pct: '2.9', acidity_pct: '0.15', ph: '6.7', antibiotic_residue: false, adulterant: true },
    }), {
        request_id: requestId,
        run_id: 23,
        truck: 'RT-17',
        action: 'retest',
        reason: 'Konfirmasi QA',
        results: { ph: 6.7 },
    });
});

test('reject requires a valid disposition; other actions do not carry test results', () => {
    const base = { requestId, runId: 23, truck: 'RT-17', action: 'reject', reason: 'Tidak memenuhi mutu' };
    assert.throws(() => qaPayload(base), /Pilih disposisi/);
    assert.equal(qaPayload({ ...base, disposition: 'return_supplier' }).disposition, 'return_supplier');
    assert.equal('results' in qaPayload({ ...base, disposition: 'controlled_disposal' }), false);
});

test('request IDs are valid UUIDs and pending request storage can be retried unchanged', () => {
    const key = qaPendingKey(23, 'RT-17');
    const data = new Map();
    const storage = {
        getItem: (k) => data.get(k) ?? null,
        setItem: (k, v) => data.set(k, v),
        removeItem: (k) => data.delete(k),
    };
    const payload = { request_id: requestId, action: 'release' };
    const record = { payload, accepted: false };
    assert.equal(writeQaPending(storage, key, record), true);
    assert.deepEqual(readQaPending(storage, key), record);
    assert.match(qaRequestId({ randomUUID: () => requestId }), /^[\da-f-]{36}$/i);
    clearQaPending(storage, key);
    assert.equal(readQaPending(storage, key), null);
});
