import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ORDER, QualityGovernor, TIERS, detectTier } from './quality.js';
import { createKit } from './ctx.js';

test('detectTier: perangkat lemah, menengah, dan kuat', () => {
    assert.equal(detectTier({ saveData: true, cores: 16 }), 'low');
    assert.equal(detectTier({ cores: 8, memory: 2 }), 'low');
    assert.equal(detectTier({ cores: 2 }), 'low');
    assert.equal(detectTier({ cores: 8, memory: 4, coarse: true, narrow: true }), 'low');
    assert.equal(detectTier({ cores: 8, coarse: true, narrow: true }), 'medium');
    assert.equal(detectTier({ cores: 4, memory: 8 }), 'medium');
    assert.equal(detectTier({ cores: 8, memory: 4 }), 'medium');
    assert.equal(detectTier({ cores: 8, memory: 8 }), 'high');
    assert.equal(detectTier({ cores: 12 }), 'high');
    assert.equal(detectTier({}), 'high');
});

test('TIERS naik monoton dan ORDER mencakup semuanya', () => {
    assert.deepEqual([...ORDER].sort(), Object.keys(TIERS).sort());
    for (let i = 1; i < ORDER.length; i++) {
        const lo = TIERS[ORDER[i - 1]];
        const hi = TIERS[ORDER[i]];
        assert.ok(hi.detail > lo.detail && hi.shadow > lo.shadow && hi.pixelRatio > lo.pixelRatio);
    }
});

/** Beri n frame dengan interval ms; kembalikan perubahan tier yang terjadi. */
function feed(g, n, ms) {
    for (let i = 0; i < n; i++) g.sample(ms);
}
const WARM = 45;
const WIN = 90;

function make(tier) {
    const changes = [];
    const g = new QualityGovernor(tier, (t) => changes.push(t));
    return { g, changes };
}

test('governor: warmup diabaikan, lalu turun satu tier saat lambat', () => {
    const { g, changes } = make('high');
    feed(g, WARM, 100);
    assert.deepEqual(changes, []);
    feed(g, WIN, 40);
    assert.deepEqual(changes, ['medium']);
    assert.equal(g.tier, 'medium');
});

test('governor: tier terendah tidak turun lagi', () => {
    const { g, changes } = make('low');
    feed(g, WARM + WIN * 3, 60);
    assert.deepEqual(changes, []);
});

test('governor: interval besar (jeda) mengulang jendela tanpa mengubah tier', () => {
    const { g, changes } = make('high');
    feed(g, WARM + WIN - 1, 40);
    g.sample(2000);
    feed(g, WIN - 1, 40);
    assert.deepEqual(changes, []);
    feed(g, WARM + 1, 40);
    assert.deepEqual(changes, ['medium']);
});

test('governor: naik hanya setelah lama stabil', () => {
    const { g, changes } = make('low');
    feed(g, WARM + WIN * 7, 8);
    assert.deepEqual(changes, []);
    feed(g, WIN, 8);
    assert.deepEqual(changes, ['medium']);
});

test('governor: naik yang segera disusul turun mengunci batas atas', () => {
    const { g, changes } = make('low');
    feed(g, WARM + WIN * 8, 8);
    assert.deepEqual(changes, ['medium']);
    feed(g, WARM + WIN, 40);
    assert.deepEqual(changes, ['medium', 'low']);
    assert.equal(g.ceiling, 'low');
    feed(g, WARM + WIN * 30, 8);
    assert.deepEqual(changes, ['medium', 'low']);
});

test('governor: set() menyetel ulang tier dan batas atas', () => {
    const { g, changes } = make('low');
    g.ceiling = 'low';
    g.set('medium');
    assert.equal(g.ceiling, 'high');
    feed(g, WARM + WIN, 40);
    assert.deepEqual(changes, ['low']);
});

test('kit.seg menskalakan segmen dengan batas bawah', () => {
    const full = createKit({}, { detail: 1 });
    const low = createKit({}, { detail: 0.35 });
    assert.equal(full.seg(64), 64);
    assert.equal(low.seg(64), 22);
    assert.equal(low.seg(8), 6);
    assert.equal(low.seg(8, 3), 3);
    assert.equal(low.seg(3, 1), 1);
});
