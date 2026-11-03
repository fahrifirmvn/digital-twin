import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clock } from './format.js';
import { icon } from './icons.js';
import { MAX_BOXES, MAX_PINS, anomalyMarks, assetChip, assetStatus, asepAge, detailOf, detections, gateChips, levelBadges, pinsOf, truckStatus } from './status.js';

const base = (extra = {}) => ({ m: 100, assets: {}, tankers: {}, ...extra });
const truck = (code, over = {}) => ({ code, farm: 'FRM-01', volume: 22.5, temp: 4.2, status: 'queued', bay: null, held: null, arrivedAt: 40, ...over });
const any = () => true;

test('clock memformat jam dan hari', () => {
    assert.equal(clock(0), '06:00');
    assert.equal(clock(185), '09:05');
    assert.equal(clock(720), '18:00');
    assert.equal(clock(1080), 'H+1 00:00');
    assert.equal(clock(1440 + 61), 'H+1 07:01');
});

test('setiap nada status punya ikon dan label', () => {
    for (const s of ['idle', 'in_use', 'filling', 'holding', 'cip', 'unavailable']) {
        const v = assetStatus(s);
        assert.ok(v.label && icon(v.icon), s);
    }
    for (const s of ['queued', 'sampling', 'lab_test', 'released', 'unloading', 'rejected', 'stored']) {
        const v = truckStatus(truck('T', { status: s }));
        assert.ok(v.label && icon(v.icon), s);
    }
    assert.equal(icon('tidak-ada'), '');
});

test('truk ditahan G1 bernada bad; ditolak tidak ditimpa label tahan', () => {
    assert.equal(truckStatus(truck('T', { held: 'G1' })).label, 'Ditahan G1');
    assert.equal(truckStatus(truck('T', { held: 'G1', status: 'rejected' })).label, 'Ditolak');
});

test('pin hanya untuk perhatian (bad/warn), urut menurut urgensi', () => {
    const s = base({
        assets: {
            'BAY-1': { status: 'in_use', level: null },
            'BAY-2': { status: 'idle', level: null },
            'TK-STO-1': { status: 'unavailable', level: 12 },
            'TK-STO-2': { status: 'filling', level: 41.2 },
            'TK-STO-3': { status: 'cip', level: 0 },
            'DEG-1': { status: 'unavailable', level: null },
        },
        tankers: { 'RT-1': truck('RT-1'), 'RT-2': truck('RT-2', { held: 'G1' }) },
    });
    const pins = pinsOf(s, (c) => !c.startsWith('DEG'));
    assert.deepEqual(pins.map((p) => p.key), ['RT-2', 'TK-STO-1', 'TK-STO-3']);
    assert.equal(pins[1].text, 'TK-STO-1 · Maintenance · 11.650 L');
    assert.equal(pins[0].kind, 'truck');
});

test('pin dibatasi MAX_PINS dengan yang mendesak lebih dulu', () => {
    const tankers = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`RT-${i}`, truck(`RT-${i}`, { held: 'G1' })]));
    const assets = { 'BAY-1': { status: 'in_use', level: null } };
    const pins = pinsOf(base({ tankers, assets }), any);
    assert.equal(pins.length, MAX_PINS);
    assert.ok(pins.every((p) => p.tone === 'bad'));
});

test('detail truk memuat baris data dan lama di pabrik', () => {
    const d = detailOf(base({ tankers: { 'RT-1': truck('RT-1', { status: 'unloading', bay: 'BAY-2' }) } }), 'RT-1');
    assert.equal(d.kind, 'truck');
    assert.deepEqual(d.rows.find((r) => r[0] === 'Bay'), ['Bay', 'BAY-2']);
    assert.deepEqual(d.rows.find((r) => r[0] === 'Di pabrik'), ['Di pabrik', '60 mnt']);
    assert.equal(d.chip.tone, 'brand');
});

test('detail truk selesai tidak menampilkan lama di pabrik', () => {
    const d = detailOf(base({ tankers: { 'RT-1': truck('RT-1', { status: 'stored' }) } }), 'RT-1');
    assert.equal(d.rows.some((r) => r[0] === 'Di pabrik'), false);
});

test('detail aset: isi tangki dan truk yang sedang bongkar di bay', () => {
    const s = base({
        assets: { 'TK-STO-1': { status: 'filling', level: 30 }, 'BAY-1': { status: 'in_use', level: null } },
        tankers: { 'RT-9': truck('RT-9', { status: 'unloading', bay: 'BAY-1' }) },
    });
    assert.deepEqual(detailOf(s, 'TK-STO-1').rows[0], ['Isi', '29.126 L (50%)']);
    assert.deepEqual(detailOf(s, 'BAY-1').rows, [['Truk', 'RT-9']]);
    assert.equal(detailOf(base(), 'BAY-3').chip.label, 'Siaga');
    assert.equal(detailOf(base(), 'XYZ'), null);
});

test('detail aset: unit proses hilir menampilkan jenisnya', () => {
    const d = detailOf(base({ assets: { 'STE-2': { status: 'cip', level: null } } }), 'STE-2');
    assert.deepEqual(d.rows, [['Jenis', 'Sterilizer UHT']]);
    assert.equal(d.chip.label, 'CIP');
    assert.equal(detailOf(base(), 'LINE-3').rows[0][1], 'Filling line');
});

test('chip gate: menunggu, lolos, dan tahan dengan alasan; hanya truk yang punya gate', () => {
    const t = truck('RT-1', { gates: { G1: { decision: 'pass', reason: null }, G2: { decision: 'hold', reason: 'lemak rendah' } } });
    const chips = gateChips(t);
    assert.deepEqual(chips.map((c) => [c.gate, c.tone, c.label]), [['G1', 'ok', 'Lolos'], ['G2', 'bad', 'Tahan'], ['G3', 'mute', 'Menunggu']]);
    assert.equal(chips[1].reason, 'lemak rendah');
    assert.ok(chips.every((c) => icon(c.icon)));
    assert.equal(gateChips(truck('RT-2')).every((c) => c.label === 'Menunggu'), true);
    const s = base({ tankers: { 'RT-1': t }, assets: { 'BAY-1': { status: 'idle', level: null } } });
    assert.equal(detailOf(s, 'RT-1').gates.length, 3);
    assert.equal(detailOf(s, 'BAY-1').gates, undefined);
});

test('plat tampil di sheet detail dan di teks pin truk ditahan', () => {
    const s = base({ tankers: { 'RT-1': truck('RT-1', { plate: 'N 1234 AB', held: 'G1' }) } });
    assert.deepEqual(detailOf(s, 'RT-1').rows.find((r) => r[0] === 'Plat'), ['Plat', 'N 1234 AB']);
    assert.equal(pinsOf(s, any)[0].text, 'RT-1 (N 1234 AB) · Ditahan G1');
    assert.equal(detailOf(base({ tankers: { 'RT-2': truck('RT-2') } }), 'RT-2').rows.some((r) => r[0] === 'Plat'), false);
});

test('deteksi gerbang: hanya truk yang baru tiba, nada mengikuti hasil G1, plat jadi label', () => {
    const s = base({
        tankers: {
            'RT-1': truck('RT-1', { plate: 'N 1 AA', arrivedAt: 95 }),
            'RT-2': truck('RT-2', { plate: 'N 2 BB', arrivedAt: 90, gates: { G1: { decision: 'pass' } } }),
            'RT-3': truck('RT-3', { plate: 'N 3 CC', arrivedAt: 85, gates: { G1: { decision: 'hold', reason: 'suhu' } } }),
            'RT-4': truck('RT-4', { plate: 'N 4 DD', arrivedAt: 10 }),
            'RT-5': truck('RT-5', { arrivedAt: 80 }),
        },
    });
    const d = detections(s);
    assert.deepEqual(d.map((b) => [b.code, b.tone, b.plate]), [['RT-1', 'warn', 'N 1 AA'], ['RT-2', 'ok', 'N 2 BB'], ['RT-3', 'bad', 'N 3 CC'], ['RT-5', 'warn', 'RT-5']]);
    const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`RT-${i}`, truck(`RT-${i}`, { arrivedAt: 99 })]));
    assert.equal(detections(base({ tankers: many })).length, MAX_BOXES);
});

const asep = (over = {}) => ({ status: 'holding', level: 12.5, cap: 50, lot: 'INT-0007', sinceM: 60, fillM: 90, holdMax: 240, low: false, ...over });

test('aseptic tank: panel memuat isi, lot, umur, dan sisa holding', () => {
    const d = detailOf(base({ m: 150, assets: { 'ASEP-1': asep() } }), 'ASEP-1');
    const rows = Object.fromEntries(d.rows);
    assert.equal(rows.Jenis, 'Aseptic tank');
    assert.equal(rows.Isi, '12.136 L (25%)');
    assert.equal(rows['Lot tertua'], 'INT-0007');
    assert.equal(rows['Mulai isi'], clock(90));
    assert.equal(rows['Umur isi'], '90 mnt');
    assert.equal(rows['Sisa holding'], '150 mnt dari 240');
    assert.equal(d.chip.label, 'Menahan');
});

test('aseptic tank: melewati holding, hampir habis, dan kosong punya chip sendiri', () => {
    assert.deepEqual(asepAge(asep(), 400), { age: 340, left: -100, over: true });
    assert.equal(assetChip(asep(), 400).label, 'Melewati holding');
    assert.equal(assetChip(asep({ low: true }), 100).tone, 'warn');
    assert.equal(assetChip(asep({ level: 0, status: 'idle', sinceM: null }), 100).label, 'Kosong');
    assert.equal(asepAge(asep({ sinceM: null }), 100), null);
    const d = detailOf(base({ m: 400, assets: { 'ASEP-1': asep() } }), 'ASEP-1');
    assert.equal(Object.fromEntries(d.rows)['Sisa holding'], 'lewat 100 mnt');
});

test('aseptic tank dan changeover muncul di pin dan panel hanya bila perlu', () => {
    assert.equal(pinsOf(base({ m: 100, assets: { 'ASEP-1': asep() } }), any).length, 0);
    assert.equal(pinsOf(base({ m: 100, assets: { 'ASEP-1': asep({ low: true }) } }), any).length, 1);
    assert.equal(pinsOf(base({ m: 400, assets: { 'ASEP-1': asep() } }), any)[0].tone, 'bad');
    const line = { status: 'in_use', level: null, changeover: { to: 'SKU-2', until: 130 } };
    assert.ok(detailOf(base({ m: 100, assets: { 'LINE-1': line } }), 'LINE-1').rows.some(([k]) => k === 'Changeover'));
    assert.ok(!detailOf(base({ m: 140, assets: { 'LINE-1': line } }), 'LINE-1').rows.some(([k]) => k === 'Changeover'));
    assert.deepEqual(detailOf(base(), 'ASEP-3').rows.at(-1), ['Lot', 'tidak ada isi']);
});

const routes = {
    policy: 'dedicated',
    skus: ['UHT-FULL-1000', 'UHT-CHOC-200'],
    routes: [
        { sterilizer: 'STE-1', aseptic: 'ASEP-1', line: 'LINE-1', usable: true, reason: null, allowed: ['UHT-FULL-1000', 'UHT-CHOC-200'], blocked: [] },
        { sterilizer: 'STE-1', aseptic: 'ASEP-1', line: 'LINE-2', usable: true, reason: null, allowed: ['UHT-FULL-1000'], blocked: [{ sku: 'UHT-CHOC-200', reason: 'UHT-CHOC-200 berukuran 200 ml; LINE-2 khusus 1000 ml' }] },
        { sterilizer: 'STE-2', aseptic: 'ASEP-2', line: 'LINE-3', usable: false, reason: 'Aliran melebihi output aseptic', allowed: [], blocked: [] },
    ],
};

test('rute: ASEP dan STE menampilkan matriks line x SKU, LINE menampilkan alasan penolakan', () => {
    const s = base({ routes });
    const asep = detailOf(s, 'ASEP-1').rows;
    assert.deepEqual(asep.find((r) => r[0] === 'Rute'), ['Rute', 'STE-1 > ASEP-1 > LINE-1, LINE-2']);
    assert.deepEqual(asep.find((r) => r[0] === 'LINE-1'), ['LINE-1', 'semua SKU']);
    assert.deepEqual(asep.find((r) => r[0] === 'LINE-2'), ['LINE-2', 'FULL-1000; ditolak CHOC-200']);
    assert.deepEqual(detailOf(s, 'STE-1').rows.find((r) => r[0] === 'LINE-2')?.[0], 'LINE-2');
    const line = detailOf(s, 'LINE-2').rows;
    assert.deepEqual(line.find((r) => r[0] === 'Sumber'), ['Sumber', 'ASEP-1 (STE-1)']);
    assert.match(line.find((r) => r[0] === 'SKU ditolak')[1], /khusus 1000 ml/);
    assert.deepEqual(detailOf(s, 'LINE-3').rows.find((r) => r[0] === 'Rute diblokir'), ['Rute diblokir', 'Aliran melebihi output aseptic']);
    assert.ok(!detailOf(base(), 'LINE-1').rows.some((r) => r[0] === 'Sumber'), 'tanpa event rute panel tetap normal');
    assert.ok(!detailOf(s, 'BAY-1').rows.some((r) => r[0] === 'Rute'));
});

test('lencana: persen isi tangki dan status singkat unit aktif, tanpa unit siaga', () => {
    const s = base({
        assets: {
            'TK-RAW-1': { status: 'in_use', level: 15, cap: 30 },
            'TK-RAW-2': { status: 'idle', level: 0, cap: 30 },
            'TK-RAW-10': { status: 'filling', level: 29, cap: 30 },
            'TK-STO-1': { status: 'filling', level: 30, cap: 60 },
            'ASEP-1': { status: 'holding', level: 20.9, cap: 50, low: true },
            'STE-1': { status: 'in_use', level: null },
            'STE-2': { status: 'idle', level: null },
            'BAY-1': { status: 'in_use', level: null },
        },
    });
    const b = levelBadges(s, any);
    assert.deepEqual(b.map((x) => x.key), ['ASEP-1', 'STE-1', 'TK-RAW-1', 'TK-RAW-10', 'TK-STO-1']);
    const by = Object.fromEntries(b.map((x) => [x.key, x]));
    assert.deepEqual([by['TK-RAW-1'].text, by['TK-RAW-1'].tone, by['TK-RAW-1'].kind], ['50%', 'brand', 'level']);
    assert.equal(by['TK-RAW-1'].title, 'TK-RAW-1 · 14.563 L / 29.126 L (50%)');
    assert.equal(by['TK-RAW-10'].tone, 'warn');
    assert.equal(by['ASEP-1'].tone, 'warn');
    assert.equal(by['STE-1'].text, 'Aktif');
    assert.equal(by['STE-1'].pct, null);
});

test('lencana dibatasi ke aset berjangkar dan persen tidak melewati 100', () => {
    const s = base({ assets: { 'TK-RAW-1': { status: 'in_use', level: 40, cap: 30 }, 'TK-RAW-2': { status: 'in_use', level: 5, cap: 30 } } });
    const b = levelBadges(s, (c) => c === 'TK-RAW-1');
    assert.equal(b.length, 1);
    assert.equal(b[0].pct, 100);
});

test('anomali AI: hanya bila ditandai, ditempel ke lencana yang ada atau dibuat baru', () => {
    assert.equal(anomalyMarks({ is_anomaly: false, flags: ['FLOW_RATE_ANOMALY'] }).size, 0);
    assert.equal(anomalyMarks(null).size, 0);
    const marks = anomalyMarks({ is_anomaly: true, flags: ['HOLDING_TIME_EXCEEDED', 'FLOW_RATE_ANOMALY', 'LAIN'] });
    assert.deepEqual([...marks.keys()].sort(), ['DEG-1', 'TK-RAW-1']);
    const s = base({ assets: { 'TK-RAW-1': { status: 'in_use', level: 15, cap: 30 }, 'DEG-1': { status: 'idle', level: null } } });
    const by = Object.fromEntries(levelBadges(s, any, marks).map((x) => [x.key, x]));
    assert.deepEqual([by['TK-RAW-1'].text, by['TK-RAW-1'].tone, by['TK-RAW-1'].kind], ['! 50%', 'bad', 'level']);
    assert.match(by['TK-RAW-1'].title, /Anomali AI: Holding time terlampaui/);
    assert.deepEqual([by['DEG-1'].text, by['DEG-1'].kind], ['! Anomali', 'anomaly']);
});

test('tangki tidak tersedia ditampilkan sebagai Maintenance, unit lain tetap Tidak tersedia', () => {
    assert.equal(assetChip({ status: 'unavailable', level: 0, cap: 30 }, 0, 'TK-RAW-3').label, 'Maintenance');
    assert.equal(assetChip({ status: 'unavailable', level: null }, 0, 'STE-1').label, 'Tidak tersedia');
    const s = base({ assets: { 'TK-STO-2': { status: 'unavailable', level: 0, cap: 60 } } });
    assert.equal(levelBadges(s, any)[0].text, 'Maintenance');
});
