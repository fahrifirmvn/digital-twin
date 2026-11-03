import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GATE_LL, GEOFENCE_M, GEO_GEOMETRY, ROUTES_LL, geofenceRing, routeLength, routePointLL, toMeters } from './geo-real.js';

test('jalur nyata: awal = titik awal, akhir tepat di gerbang, jarak ke gerbang menurun di ujung', () => {
    ROUTES_LL.forEach((r, i) => {
        const a = routePointLL(i, 0);
        assert.deepEqual([a.lng, a.lat], r.pts[0]);
        const z = routePointLL(i, 1);
        assert.ok(Math.hypot(z.e, z.n) < 1);
        assert.ok(routeLength(i) > 15000, 'jalur harus panjang (puluhan km)');
    });
});

test('routePointLL: progress dijepit, indeks dibungkus, arah 0..360', () => {
    assert.deepEqual(routePointLL(0, -2), routePointLL(0, 0));
    assert.deepEqual(routePointLL(4, 0.5), routePointLL(1, 0.5));
    for (let p = 0; p <= 1; p += 0.1) {
        const { bearing } = routePointLL(2, p);
        assert.ok(bearing >= 0 && bearing < 360);
    }
});

test('geofence: gerbang di dalam, awal jalur di luar, cincin berjari-jari GEOFENCE_M', () => {
    assert.equal(GEO_GEOMETRY.inGeofence(routePointLL(0, 1)), true);
    assert.equal(GEO_GEOMETRY.inGeofence(routePointLL(0, 0)), false);
    for (const p of geofenceRing(12)) {
        const [e, n] = toMeters(p);
        assert.ok(Math.abs(Math.hypot(e, n) - GEOFENCE_M) < 1);
    }
    assert.deepEqual(toMeters([GATE_LL.lng, GATE_LL.lat]), [0, 0]);
});
