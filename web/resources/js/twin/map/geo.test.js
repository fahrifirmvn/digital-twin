import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Replay, buildModel } from '../state.js';
import { GATE, ROUTES, inGeofence, inboundList, mapStats, recentArrivals, routeOf, routePoint } from './geo.js';

const sample = JSON.parse(readFileSync(new URL('../../../../../contracts/run-result.sample.json', import.meta.url)));
const model = buildModel(sample.events.map((e) => ({ seq: e.seq, t: e.sim_time, p: e.payload })));

test('routePoint: awal jalur di tepi peta, akhir tepat di gerbang, jarak ke gerbang menurun', () => {
    ROUTES.forEach((r, i) => {
        const a = routePoint(i, 0);
        assert.deepEqual([a.x, a.y], r.pts[0]);
        const z = routePoint(i, 1);
        assert.deepEqual([z.x, z.y], [GATE.x, GATE.y]);
        let prev = Infinity;
        for (let p = 0; p <= 1; p += 0.05) {
            const q = routePoint(i, p);
            const d = Math.hypot(q.x - GATE.x, q.y - GATE.y);
            assert.ok(d <= prev + 1e-6);
            prev = d;
        }
    });
});

test('routePoint: progress dijepit dan indeks jalur dibungkus', () => {
    assert.deepEqual(routePoint(0, -3), routePoint(0, 0));
    assert.deepEqual(routePoint(1, 9), routePoint(1, 1));
    assert.equal(routeOf(3), ROUTES[0]);
    assert.equal(routeOf(-1), ROUTES[2]);
});

test('geofence: gerbang di dalam, awal jalur di luar', () => {
    assert.equal(inGeofence(GATE), true);
    assert.equal(inGeofence(routePoint(2, 0)), false);
});

test('serah-terima: truk ada di daftar menuju gerbang sebelum tiba, lalu pindah ke baru tiba', () => {
    const d = model.events.find((e) => e.p.type === 'truck.dispatched' && e.etaM >= 60);
    assert.ok(d, 'sampel harus punya truk yang tiba setelah menit 60');
    const code = d.p.tanker_code;
    const arrived = model.events.find((e) => e.p.type === 'truck.arrived' && e.p.tanker_code === code);
    const r = new Replay(model);

    const before = r.seek(arrived.m - 10);
    const row = inboundList(before).find((t) => t.code === code);
    assert.ok(row);
    assert.equal(row.plate, d.p.plate);
    assert.equal(row.minsLeft, Math.ceil(arrived.m - before.m));
    assert.ok(row.progress > 0 && row.progress < 1);
    assert.equal(recentArrivals(before).some((t) => t.code === code), false);

    const after = r.seek(arrived.m + 1);
    assert.equal(inboundList(after).some((t) => t.code === code), false);
    const got = recentArrivals(after).find((t) => t.code === code);
    assert.equal(got.plate, d.p.plate);
    assert.equal(got.ago, 1);
});

test('inboundList: terurut ETA, dan truk yang tiba tidak dihitung dua kali', () => {
    const r = new Replay(model);
    for (const m of [60, 240, 600]) {
        const s = r.seek(m);
        const list = inboundList(s);
        for (let i = 1; i < list.length; i++) assert.ok(list[i].etaM >= list[i - 1].etaM);
        for (const t of list) assert.equal(s.tankers[t.code], undefined);
    }
});

test('mapStats: ringkasan dan hari tanpa truk menuju gerbang', () => {
    const s = new Replay(model).seek(model.endMin);
    const k = mapStats(s, 9);
    assert.equal(k.inbound, 0);
    assert.equal(k.nextEtaM, null);
    assert.equal(k.arrived, s.counters.arrived);
    assert.equal(k.total, 9);
});
