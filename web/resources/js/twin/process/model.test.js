import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AT, ASSETS, FILLERS, MACHINES, PIPES, SFP, STORAGE_TANKS } from './dummy.js';
import { FRAME, NODES, PIPE_PATHS, VIEW, tankCell } from './layout.js';
import {
    badgeOf, chipOf, emptyAtMin, flowCheck, fmtDec, fmtInt, hhmm, isAged, kpis, linksOf, nextStatus, pctOf, pipeFlow,
    pipesOf, placeCard, scheduleOf, simPrompt, simTarget, skuMatrix, statusLine,
} from './model.js';

const st = (id) => STORAGE_TANKS.find((t) => t.id === id);

test('data contoh sesuai bagan: 15 tangki dan persen = isi / kapasitas', () => {
    assert.equal(STORAGE_TANKS.length, 15);
    const pct = STORAGE_TANKS.map(pctOf);
    assert.deepEqual(pct, [70, 90, 40, 70, 55, 82, 62, 0, 35, 78, 0, 48, 91, 66, 24]);
    assert.equal(st('ST-07').levelL, 37200);
    assert.equal(pctOf(SFP), 58);
    assert.equal(AT.levelL, 26400);
    assert.equal(pctOf(AT), 44);
});

test('angka antaraset konsisten (thermizer = keluaran ST-07, sterilizer = masukan AT)', () => {
    const thm = MACHINES.find((m) => m.id === 'THM-01');
    const ste = MACHINES.find((m) => m.id === 'STE-01');
    assert.equal(thm.rate, 18000);
    assert.equal(st('ST-07').outLph, thm.rate);
    assert.equal(ste.rate, 16000);
    assert.equal(AT.inLph, ste.rate);
    assert.equal(MACHINES.find((m) => m.id === 'FL-01').rate, 8000);
    assert.equal(MACHINES.find((m) => m.id === 'FL-02').rate, 20000);
    assert.equal(AT.outLph, 13000);
});

test('total flow FL diturunkan dari ukuran kemasan: 8.000 x 1 L + 20.000 x 0,25 L = 13.000 <= 18.000', () => {
    const c = flowCheck(AT, FILLERS);
    assert.equal(c.total, 13000);
    assert.equal(c.max, 18000);
    assert.equal(c.ok, true);
    assert.equal(flowCheck({ maxOutLph: 12000 }, FILLERS).ok, false);
});

test('lencana amber: >= 90% atau di bawah minimum; ikon jam bila umur isi > 80% holding', () => {
    assert.equal(badgeOf(st('ST-02')).warn, true);
    assert.equal(badgeOf(st('ST-02')).icon, 'arrow-up');
    assert.equal(badgeOf(st('ST-13')).warn, true);
    assert.equal(badgeOf(st('ST-06')).warn, false);
    assert.equal(badgeOf({ ...AT, levelL: 0.1 * AT.capL }).icon, 'arrow-down');
    assert.equal(badgeOf(AT).warn, false);
    assert.equal(isAged(st('ST-02')), true);
    assert.equal(isAged({ levelL: 1, ageH: 4.8, holdMaxH: 6 }), false);
    assert.equal(isAged({ levelL: 1, ageH: 4.81, holdMaxH: 6 }), true);
    assert.equal(isAged({ levelL: 0, ageH: 9, holdMaxH: 6 }), false);
});

test('status memakai ikon + teks; CIP dan maintenance mengikuti data', () => {
    assert.deepEqual(statusLine(st('ST-08')), { dot: 'cyan', text: 'CIP 18/45 mnt' });
    assert.deepEqual(statusLine(st('ST-11')), { dot: 'slate', text: 'Maintenance 14:00' });
    assert.equal(statusLine(MACHINES.find((m) => m.id === 'THM-01')).text, '18.000 L/jam');
    for (const a of ASSETS.filter((x) => x.kind !== 'node')) {
        const c = chipOf(a);
        assert.ok(c.icon && c.label && c.tone, a.id);
    }
    assert.equal(chipOf(st('ST-07')).label, 'Menahan');
});

test('ST-07: kosong sekitar 11:25 lalu CIP 45 mnt', () => {
    assert.equal(hhmm(emptyAtMin(st('ST-07'))), '11:25');
    assert.equal(nextStatus(st('ST-07')), 'Kosong sekitar 11:25, lalu CIP 45 mnt');
    assert.match(nextStatus(st('ST-05')), /^Penuh sekitar/);
});

test('format angka Indonesia dan jam 24', () => {
    assert.equal(fmtInt(37200), '37.200');
    assert.equal(fmtDec(3.2), '3,2');
    assert.equal(hhmm(1500), '01:00');
});

test('matriks SKU: Full Cream 1000 dan Low Fat 1000 di FL-01; 250/200 mL di FL-02', () => {
    const m = skuMatrix();
    const row = (n) => m.find((r) => r.name === n).FL.map((c) => c.ok);
    assert.deepEqual(row('Full Cream 1000 mL'), [true, false]);
    assert.deepEqual(row('Full Cream 250 mL'), [false, true]);
    assert.deepEqual(row('Low Fat 1000 mL'), [true, false]);
    assert.deepEqual(row('Coklat 200 mL'), [false, true]);
});

test('hubungan aliran dan pipa tersambung', () => {
    assert.deepEqual(linksOf(st('ST-07')), [
        { dir: 'from', label: 'Bay 2', lph: 0 },
        { dir: 'to', label: 'Thermizer', lph: 18000 },
    ]);
    assert.deepEqual(pipesOf('ST-07').sort(), ['bay-st', 'st-thm']);
    assert.deepEqual(pipesOf('AT-01').sort(), ['at-fl1', 'at-fl2', 'ste-at']);
    const p = (id) => PIPES.find((x) => x.id === id);
    assert.equal(pipeFlow(p('st-thm'), st('ST-07')), 18000);
    assert.equal(pipeFlow(p('bay-st'), st('ST-07')), 0);
    assert.equal(pipeFlow(p('st-thm'), null), 18000);
});

test('KPI ringkas dan jadwal 06:00 sampai 06:00', () => {
    assert.deepEqual(kpis(), { bongkar: 24000, filling: 13000, attention: 2 });
    for (const a of ASSETS.filter((x) => x.kind === 'tank')) {
        const s = scheduleOf(a);
        assert.equal(s[0].from, 360);
        assert.equal(s.at(-1).to, 1800);
    }
    assert.deepEqual(scheduleOf(st('ST-07')).map((x) => x.type), ['isi', 'cip', 'isi']);
    assert.ok(scheduleOf(st('ST-11')).some((x) => x.type === 'maintenance'));
});

test('handoff asisten: hanya tangki ST-n yang dipetakan ke TK-RAW-n', () => {
    assert.equal(simTarget(st('ST-07')), 'TK-RAW-7');
    assert.equal(simTarget(AT), null);
    assert.equal(simPrompt(AT), null);
    assert.match(simPrompt(st('ST-07')), /TK-RAW-7/);
});

test('penempatan kartu: 12 px dari aset, memilih sisi lega, tidak menutup aset', () => {
    const size = { w: 288, h: 264 };
    const bounds = { w: 1440, h: 960 };
    const left = placeCard({ x: 100, y: 400, w: 56, h: 96 }, size, bounds);
    assert.equal(left.side, 'right');
    assert.equal(left.x, 168);
    const right = placeCard({ x: 1300, y: 400, w: 56, h: 96 }, size, bounds);
    assert.equal(right.side, 'left');
    assert.equal(right.x, 1300 - 12 - 288);
    for (const rect of [{ x: 100, y: 10, w: 56, h: 96 }, { x: 700, y: 880, w: 80, h: 60 }, { x: 600, y: 440, w: 100, h: 80 }]) {
        const c = placeCard(rect, size, bounds);
        const apart = c.x + size.w <= rect.x || c.x >= rect.x + rect.w || c.y + size.h <= rect.y || c.y >= rect.y + rect.h;
        assert.ok(apart, JSON.stringify(rect));
        assert.ok(c.x >= 0 && c.y >= 0 && c.x + size.w <= bounds.w && c.y + size.h <= bounds.h);
    }
});

const inside = (r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= VIEW.w && r.y + r.h <= VIEW.h;
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('tata letak: semua aset di dalam 1440x960 dan tidak saling tumpang tindih', () => {
    const ids = Object.keys(NODES);
    for (const id of ids) assert.ok(inside(NODES[id]), id);
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) assert.ok(!overlap(NODES[ids[i]], NODES[ids[j]]), `${ids[i]} x ${ids[j]}`);
});

test('tata letak: 15 silo 56x72 berada di dalam rak 5 x 3', () => {
    for (let i = 0; i < 15; i++) {
        const c = tankCell(i);
        assert.deepEqual([c.w, c.h], [56, 72]);
        assert.ok(c.x >= FRAME.x && c.x + c.w <= FRAME.x + FRAME.w && c.y >= FRAME.y && c.y + c.h + 40 <= FRAME.y + FRAME.h, `ST-${i + 1}`);
    }
    assert.equal(tankCell(0).y, tankCell(4).y);
    assert.equal(tankCell(5).x, tankCell(0).x);
});

test('tata letak: setiap pipa menyentuh tepi aset hulu dan hilirnya', () => {
    const touches = (pt, r) => pt[0] >= r.x - 1 && pt[0] <= r.x + r.w + 1 && pt[1] >= r.y - 1 && pt[1] <= r.y + r.h + 1;
    for (const p of PIPES) {
        const path = PIPE_PATHS[p.id];
        assert.ok(path, p.id);
        assert.ok(touches(path.pts[0], NODES[p.from]), `${p.id} hulu`);
        assert.ok(touches(path.pts.at(-1), NODES[p.to]), `${p.id} hilir`);
    }
});
