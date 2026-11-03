import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Replay, approachProgress, buildGantt, buildModel, capacityOf, emptyState, apply } from './state.js';

// Contoh nyata dari Engine, sama dengan yang dipakai test Laravel.
const sample = JSON.parse(readFileSync(new URL('../../../../contracts/run-result.sample.json', import.meta.url)));
const raw = sample.events.map((e) => ({ seq: e.seq, t: e.sim_time, p: e.payload }));
const model = buildModel(raw);

test('model: waktu dalam menit sejak event pertama, tidak menurun', () => {
    assert.equal(model.events[0].m, 0);
    for (let i = 1; i < model.events.length; i++) assert.ok(model.events[i].m >= model.events[i - 1].m);
    const end = (Date.parse(sample.sim_end) - Date.parse(sample.sim_start)) / 60000;
    assert.ok(Math.abs(model.endMin - end) < 1e-6);
});

test('replay sampai akhir cocok dengan KPI dan data hasil Engine', () => {
    const s = new Replay(model).seek(model.endMin);
    assert.equal(s.counters.arrived, sample.kpi.trucks);
    assert.equal(s.counters.unloaded, sample.kpi.completed + sample.kpi.held_qa);
    assert.ok(Math.abs(s.counters.fgTon - sample.kpi.fg_ton) < 0.05);
    for (const a of Object.values(s.assets)) assert.equal(a.status, 'idle');
});

test('seek mundur membangun ulang state dan konsisten dengan maju langsung', () => {
    const r = new Replay(model);
    r.seek(model.endMin);
    const mid = model.endMin / 2;
    const back = JSON.stringify(r.seek(mid));
    const fresh = JSON.stringify(new Replay(model).seek(mid));
    assert.equal(back, fresh);
});

test('seek di luar rentang dijepit', () => {
    const r = new Replay(model);
    assert.equal(r.seek(-5).m, 0);
    r.seek(1e9);
    assert.equal(r.minute, model.endMin);
});

test('gantt: interval tidak tumpang tindih per baris dan berada dalam rentang run', () => {
    const rows = buildGantt(model);
    assert.ok(rows.some((r) => r.group === 'aset') && rows.some((r) => r.group === 'truk'));
    for (const row of rows) {
        let prev = 0;
        for (const s of row.segs) {
            assert.ok(s.from >= prev - 1e-9 && s.to > s.from && s.to <= model.endMin + 1e-9, `${row.key} ${JSON.stringify(s)}`);
            prev = s.to;
        }
    }
    // Setiap truk yang dibongkar punya segmen unloading.
    const unloading = rows.filter((r) => r.group === 'truk' && r.segs.some((s) => s.status === 'unloading'));
    assert.equal(unloading.length, sample.kpi.completed + sample.kpi.held_qa);
});

test('truk ditahan G1 ditandai dan keluar dari antrean', () => {
    const synthetic = buildModel([
        { seq: 0, t: '2026-10-28T00:00:00Z', p: { type: 'truck.arrived', tanker_code: 'RT-9', farm_code: 'F', volume_ton: 20, temp_c: 9 } },
        { seq: 1, t: '2026-10-28T00:00:00Z', p: { type: 'gate.decided', gate: 'G1', object_type: 'tanker', object_id: 'RT-9', decision: 'hold', reason: 'suhu', decided_by: 'gate_engine' } },
    ]);
    const s = new Replay(synthetic).seek(1);
    assert.equal(s.tankers['RT-9'].held, 'G1');
    assert.equal(s.counters.heldG1, 1);
    assert.deepEqual(s.gateHolds, { G1: 1 });
});

test('kapasitas tangki diturunkan dari kode aset', () => {
    assert.equal(capacityOf('TK-RAW-2'), 30);
    assert.equal(capacityOf('TK-STO-6'), 60);
    assert.equal(capacityOf('BAY-1'), null);
});

test('keputusan gate per truk dicatat untuk G1-G3 (lolos dan tahan)', () => {
    const gate = (seq, g, decision, reason = null) => ({ seq, t: '2026-10-28T00:00:00Z', p: { type: 'gate.decided', gate: g, object_type: 'tanker', object_id: 'RT-9', decision, reason, decided_by: 'gate_engine' } });
    const m = buildModel([
        { seq: 0, t: '2026-10-28T00:00:00Z', p: { type: 'truck.arrived', tanker_code: 'RT-9', farm_code: 'F', volume_ton: 20, temp_c: 4 } },
        gate(1, 'G1', 'pass'),
        gate(2, 'G2', 'hold', 'lemak rendah'),
        { seq: 3, t: '2026-10-28T00:00:00Z', p: { type: 'gate.decided', gate: 'G4', object_type: 'batch', object_id: 'B-1', decision: 'pass', reason: null, decided_by: 'gate_engine' } },
    ]);
    const t = new Replay(m).seek(1).tankers['RT-9'];
    assert.deepEqual(t.gates, { G1: { decision: 'pass', reason: null }, G2: { decision: 'hold', reason: 'lemak rendah' } });
});

test('truk masuk daftar inbound saat dispatched dan keluar saat tiba, dengan plat', () => {
    const r = new Replay(model);
    const dispatched = model.events.filter((e) => e.p.type === 'truck.dispatched');
    assert.equal(dispatched.length, sample.kpi.trucks);
    const first = dispatched[0];
    const s = r.seek(first.m);
    assert.equal(s.inbound[first.p.tanker_code].zone, 'outside');
    assert.ok(s.inbound[first.p.tanker_code].plate);
    assert.ok(Object.keys(s.inbound).length > 0 || s.counters.arrived > 0);

    const end = r.seek(model.endMin);
    assert.deepEqual(end.inbound, {});
    for (const t of Object.values(end.tankers)) {
        assert.equal(t.zone, 'inside');
        assert.equal(t.plate, model.events.find((e) => e.p.type === 'truck.dispatched' && e.p.tanker_code === t.code).p.plate);
    }
});

test('progres pendekatan naik dari 0 ke 1 sampai ETA dan dijepit', () => {
    const d = model.events.find((e) => e.p.type === 'truck.dispatched' && e.m > 0);
    const s = new Replay(model).seek(d.m);
    const inb = s.inbound[d.p.tanker_code];
    assert.equal(approachProgress(inb, inb.dispatchedAt), 0);
    assert.ok(Math.abs(approachProgress(inb, inb.etaM) - 1) < 1e-9);
    assert.equal(approachProgress(inb, inb.etaM + 99), 1);
    assert.equal(approachProgress(inb, inb.dispatchedAt - 99), 0);
});

test('seek menetapkan waktu tampilan ke menit target, bukan menit event terakhir', () => {
    const r = new Replay(model);
    const s = r.seek(model.events[3].m + 0.5);
    assert.equal(s.m, model.events[3].m + 0.5);
    assert.equal(r.seek(r.minute).m, s.m);
});

test('perintah simulasi masuk ke umpan dan tidak mengubah state lain', () => {
    const p = { type: 'command.applied', command_id: 1, kind: 'ster_down', actor: 'PPIC: Dewi', reason: 'uji', count: 2, duration_min: 240 };
    const m = buildModel([...raw.slice(0, 5), { seq: 99, t: raw[4].t, p }]);
    const s = new Replay(m).seek(m.endMin);
    assert.equal(s.feed[0].text, 'Perintah PPIC: Dewi: 2 sterilizer mati 4 jam');
    assert.equal(s.feed[0].level, 'warn');
    const without = new Replay(buildModel(raw.slice(0, 5))).seek(m.endMin);
    assert.deepEqual({ ...s, feed: [] }, { ...without, feed: [] });
});

test('asset.level: aseptic tank menyimpan isi, lot, umur, dan flag hampir habis', () => {
    const iso = (min) => new Date(Date.parse('2026-10-28T06:00:00Z') + min * 60000).toISOString();
    const m = buildModel([
        { seq: 0, t: iso(0), p: { type: 'sim.clock', speed: 0, paused: false } },
        { seq: 1, t: iso(30), p: { type: 'asset.level', asset_code: 'ASEP-1', level_ton: 20, capacity_ton: 50, lot: 'INT-1', since: iso(30), fill_start: null, hold_max_min: 240, low: false } },
        { seq: 2, t: iso(40), p: { type: 'asset.level', asset_code: 'ASEP-1', level_ton: 2, capacity_ton: 50, lot: 'INT-1', since: iso(30), fill_start: iso(35), hold_max_min: 240, low: true } },
        { seq: 3, t: iso(41), p: { type: 'asset.level', asset_code: 'ASEP-1', level_ton: 0, capacity_ton: 50, lot: null, since: null, fill_start: null, hold_max_min: 240, low: false } },
    ]);
    const r = new Replay(m);
    const a = r.seek(30).assets['ASEP-1'];
    assert.deepEqual([a.status, a.level, a.cap, a.lot, a.sinceM, a.holdMax], ['holding', 20, 50, 'INT-1', 30, 240]);
    const b = r.seek(40).assets['ASEP-1'];
    assert.equal(b.low, true);
    assert.equal(b.fillM, 35);
    assert.match(r.state.feed[0].text, /ASEP-1 hampir habis/);
    const c = r.seek(41).assets['ASEP-1'];
    assert.deepEqual([c.status, c.level, c.sinceM, c.low], ['idle', 0, null, false]);
});

test('line.changeover menempel pada line sampai status berikutnya', () => {
    const s = emptyState();
    apply(s, { m: 1, p: { type: 'asset.status_changed', asset_code: 'LINE-1', status: 'in_use', level_ton: null } });
    apply(s, { m: 1, p: { type: 'line.changeover', asset_code: 'LINE-1', from_sku: 'A', to_sku: 'B', minutes: 40 } });
    assert.deepEqual(s.assets['LINE-1'].changeover, { to: 'B', until: 41 });
    apply(s, { m: 90, p: { type: 'asset.status_changed', asset_code: 'LINE-1', status: 'idle', level_ton: null } });
    assert.equal(s.assets['LINE-1'].changeover, undefined);
});

test('plant.routes disimpan di state dan tetap ada setelah seek mundur', () => {
    const iso = (min) => new Date(Date.parse('2026-10-28T06:00:00Z') + min * 60000).toISOString();
    const routes = { type: 'plant.routes', policy: 'free', skus: ['UHT-FULL-1000'], routes: [] };
    const r = new Replay(buildModel([
        { seq: 0, t: iso(0), p: { type: 'sim.clock', speed: 0, paused: false } },
        { seq: 1, t: iso(0), p: routes },
        { seq: 2, t: iso(10), p: { type: 'asset.status_changed', asset_code: 'LINE-1', status: 'in_use' } },
    ]));
    assert.equal(r.seek(10).routes.policy, 'free');
    assert.equal(r.seek(0).routes.policy, 'free');
});

test('kapasitas tangki dibawa dari event dan bertahan bila event berikutnya tidak memuatnya', () => {
    const s = emptyState();
    apply(s, { m: 1, p: { type: 'asset.status_changed', asset_code: 'TK-RAW-1', status: 'idle', level_ton: 0, capacity_ton: 30 } });
    apply(s, { m: 5, p: { type: 'asset.status_changed', asset_code: 'TK-RAW-1', status: 'filling', level_ton: 7.5 } });
    assert.deepEqual([s.assets['TK-RAW-1'].level, s.assets['TK-RAW-1'].cap], [7.5, 30]);
});
