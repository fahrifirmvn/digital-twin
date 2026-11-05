from app.carry import CarryState
from app.commands import Command
from app.contracts.events import GateDecided, LabResult
from app.experiment import simulate
from app.generator import generate_day
from app.sim import TwinSimulation


def run(seed: int = 1, bad: int = 0):
    return TwinSimulation(generate_day(seed, 320, extra_bad=bad), seed=seed).run()


def test_lab_generates_only_ph_and_is_deterministic():
    a = generate_day(3, 320)
    assert a == generate_day(3, 320)
    for s in a:
        assert 5.8 <= s.lab_results["ph"] <= 7.3
        assert set(s.lab_results) == {"ph"}


def test_lab_result_event_per_tested_truck_precedes_g2():
    sim = run(1, 2)
    labs = [e for e in sim.events if isinstance(e.payload, LabResult)]
    tested = [r for r in sim.tankers.values() if r.lab_end is not None]
    assert len(labs) == len(tested) > 0
    for e in labs:
        p = e.payload
        assert p.ph is not None and p.duration_min > 0 and p.analyst
        assert p.fat_pct is None and p.protein_pct is None and p.acidity_pct is None
        assert p.antibiotic_residue is None and p.adulterant is None
        g2 = next(
            x
            for x in sim.events
            if isinstance(x.payload, GateDecided)
            and x.payload.gate == "G2"
            and x.payload.object_id == p.tanker_code
        )
        assert g2.seq > e.seq
        assert g2.payload.decision == p.g2


def test_tank_cycles_accumulate_across_days_and_reset_after_service():
    sim, _ = simulate("A", 1, 300, day=1, carry=CarryState())
    sim.run()
    day1 = CarryState(**sim_carry(sim, 1))
    assert sum(day1.tank_cycles.values()) > 0
    busiest = max(day1.tank_cycles, key=lambda k: day1.tank_cycles[k])

    plain, _ = simulate("A", 2, 300, day=2, carry=day1)
    plain.run()
    d2 = CarryState(**sim_carry(plain, 2, day1))
    assert d2.tank_cycles[busiest] >= day1.tank_cycles[busiest]

    cmd = Command(0.0, "tank_down", "tester", "uji servis", duration_min=60.0, asset=busiest)
    serviced, _ = simulate("A", 2, 300, day=2, carry=day1, commands=(cmd,))
    serviced.run()
    assert busiest in serviced.serviced
    d2s = CarryState(**sim_carry(serviced, 2, day1))
    assert d2s.tank_cycles[busiest] < d2.tank_cycles[busiest]


def sim_carry(sim, day, carry_in=None):
    from app.carry import carry_out

    return carry_out(sim, carry_in or CarryState(), day).model_dump()
