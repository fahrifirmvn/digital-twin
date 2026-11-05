import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, emptyState } from '../state.js';
import { detailOf, processModel, rateTph, routesOf, simPrompt } from './model.js';

const transfer = (from, to, vol, m) => ({ m, p: { type: 'transfer.completed', from_asset: from, to_asset: to, volume_ton: vol } });

test('rateTph sums matching transfers over the recent window', () => {
    const flows = [{ from: 'TK-RAW-1', to: 'DEG-1', vol: 10, m: 40 }, { from: 'TK-RAW-2', to: 'DEG-1', vol: 5, m: 75 }, { from: 'TK-RAW-1', to: 'DEG-1', vol: 90, m: 39 }];
    assert.equal(rateTph(flows, 100, (f) => f.to === 'DEG-1'), 5);
});

test('process model follows plant counts, route availability and tank levels', () => {
    const state = emptyState();
    state.m = 80;
    state.assets['TK-RAW-1'] = { status: 'holding', level: 27, cap: 30 };
    state.assets['TK-STO-1'] = { status: 'idle', level: 0, cap: 60 };
    state.routes = { routes: [{ line: 'LINE-1', usable: true }] };
    state.flows = [{ from: 'BAY-1', to: 'TK-RAW-1', vol: 10, m: 50 }];
    const plant = { n_bays: 1, n_raw_tanks: 1, n_storage_tanks: 1, n_degassing: 1, n_thermal: 1, n_separators: 1, n_sterilizers: 1 };
    const model = processModel(plant, state);
    assert.deepEqual(model.codes, ['BAY-1', 'TK-RAW-1', 'DEG-1', 'THM-1', 'SEP-1', 'TK-STO-1', 'STE-1', 'ASEP-1', 'LINE-1']);
    assert.equal(model.stages[0].rate.tph, 10);
    assert.equal(model.stages[1].groups[0].items[0].pct, 90);
    assert.deepEqual(routesOf(plant, state)[0].lines, ['LINE-1']);
    assert.equal(model.kpis.attention, 1);
});

test('detail includes live truck sample values and maintenance prompts are tank-only', () => {
    const state = emptyState();
    state.m = 30;
    state.tankers.TK1 = { code: 'TK1', farm: 'FARM-1', volume: 24, temp: 4.2, status: 'unloading', bay: 'BAY-1' };
    const details = detailOf('BAY-1', state);
    assert.ok(details.rows.some(([key, value]) => key === 'Suhu tiba' && value.includes('4,2')));
    assert.match(simPrompt('TK-RAW-1'), /maintenance/);
    assert.equal(simPrompt('BAY-1'), null);
    assert.equal(simPrompt('ASEP-1'), null);
});

test('replay retains enough recent flows for the 60-minute process window', () => {
    const state = emptyState();
    for (let m = 1; m <= 75; m++) apply(state, transfer('TK-RAW-1', 'DEG-1', 1, m));
    assert.equal(state.flows.length, 75);
    assert.equal(rateTph(state.flows, 75, () => true), 60);
    for (let m = 76; m <= 500; m++) apply(state, transfer('TK-RAW-1', 'DEG-1', 1, m));
    assert.equal(state.flows.length, 400);
    assert.equal(state.flows[0].m, 101);
});
