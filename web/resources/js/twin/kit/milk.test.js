import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeGeometry } from './milk.js';

test('tabung susu: jarak aDist mengikuti panjang rute dan tikungan tertutup bola', () => {
    const g = routeGeometry([[0, 0, 0], [4, 0, 0], [4, 3, 0]], [0.1, 0.1]);
    const d = g.attributes.aDist;
    let max = 0;
    for (let i = 0; i < d.count; i++) max = Math.max(max, d.getX(i));
    assert.ok(Math.abs(max - 7) < 1e-4, `aDist maks ${max}`);
    assert.ok(g.attributes.position.count > 12 + 12);
    assert.equal(g.attributes.uv, undefined);
});

test('segmen nol panjang tidak merusak geometri', () => {
    const g = routeGeometry([[0, 0, 0], [0, 0, 0], [2, 0, 0]], [0.1, 0.1]);
    assert.ok(g.attributes.position.count > 0);
});
