import re
from dataclasses import replace

import pytest

from app import generator
from app.generator import APPROACH_MIN, N_ROUTES, generate_day
from app.kpi import evaluate
from app.sim import DAY_START, TwinSimulation

PLATE = re.compile(r"^[A-Z]{1,2} \d{4} [A-Z]{2,3}$")


def run(seed=1, volume=320, bad=0, surge=None):
    specs = generate_day(seed, volume, extra_bad=bad, surge=surge)
    return TwinSimulation(specs, seed=seed).run()


def test_plates_are_unique_wellformed_and_seeded():
    a, b = generate_day(1, 320), generate_day(1, 320)
    assert [s.plate for s in a] == [s.plate for s in b]
    plates = [s.plate for s in a]
    assert len(set(plates)) == len(plates)
    assert all(PLATE.match(p) for p in plates)
    assert plates != [s.plate for s in generate_day(2, 320)]


def test_plates_do_not_shift_other_generated_data(monkeypatch):
    kwargs = {"extra_bad": 2, "surge": (8 * 60, 9 * 60, 3)}
    specs = generate_day(3, 450, **kwargs)
    monkeypatch.setattr(generator, "_plates", lambda seed, farms: [""] * len(farms))
    assert [replace(s, plate="") for s in specs] == generate_day(3, 450, **kwargs)
    assert {s.route for s in specs} <= set(range(N_ROUTES))


@pytest.mark.parametrize("surge", [None, (8 * 60, 9 * 60, 4)])
def test_every_truck_is_dispatched_once_before_it_arrives(surge):
    sim = run(5, 450, 2, surge)
    dispatched, arrived = {}, {}
    for e in sim.events:
        p = e.payload
        if p.type == "truck.dispatched":
            assert p.tanker_code not in dispatched
            dispatched[p.tanker_code] = e
        elif p.type == "truck.arrived":
            arrived[p.tanker_code] = e
    assert dispatched.keys() == arrived.keys() == sim.tankers.keys()
    for code, d in dispatched.items():
        a = arrived[code]
        assert d.seq < a.seq
        assert d.payload.eta == a.sim_time
        assert d.payload.plate == a.payload.plate == sim.tankers[code].spec.plate
        assert 0 <= d.payload.route < N_ROUTES
        assert d.payload.window_min == APPROACH_MIN
        lead = (a.sim_time - d.sim_time).total_seconds() / 60
        arrival_min = (a.sim_time - DAY_START).total_seconds() / 60
        assert lead == pytest.approx(min(APPROACH_MIN, arrival_min))


def test_dispatch_does_not_change_simulation_results(monkeypatch):
    with_dispatch = run(1, 450, 4)
    kpi_with = evaluate(with_dispatch).model_dump(mode="json")

    def no_dispatch(self, spec):
        return
        yield

    monkeypatch.setattr(TwinSimulation, "_dispatch", no_dispatch)
    without = run(1, 450, 4)

    def core(sim):
        return [
            (e.sim_time, e.payload.model_dump_json())
            for e in sim.events
            if e.payload.type != "truck.dispatched"
        ]

    assert core(with_dispatch) == core(without)
    assert kpi_with == evaluate(without).model_dump(mode="json")
