"""Operasi harian: keadaan terbawa antar hari, kejadian acak, ringkasan, dan determinisme."""

from datetime import timedelta

import pytest

from app.carry import CarryState, day_date
from app.contracts.events import AssetStatusChanged, DayIncident, DayStarted, DaySummary
from app.experiment import simulate
from app.kpi import build_result
from app.sim import FLOW_STEPS


def run_day(day: int, carry: CarryState | None = None, seed: int = 11, config: str = "A"):
    sim, plan = simulate(config, seed, 320.0, speed=0.0, day=day, carry=carry, time_limit=3.0)
    sim.run()
    result = build_result(
        sim, {"volume_ton": 320.0, "extra_bad": 0}, seed, config=config, plan=plan
    )
    return sim, result


def chain(n: int, base_seed: int = 100):
    carry, out = CarryState(), []
    for d in range(1, n + 1):
        sim, res = run_day(d, carry, seed=base_seed + d)
        carry = CarryState(**res.carry_out)
        out.append((sim, res))
    return out


def test_tank_levels_step_instead_of_jumping():
    """Isi tangki naik/turun bertahap: fill dan drain tidak pernah lompat dalam satu timestamp."""
    sim, _ = run_day(1)
    levels: dict[str, list[tuple]] = {}
    for e in sim.events:
        p = e.payload
        if isinstance(p, AssetStatusChanged) and p.level_ton is not None:
            levels.setdefault(p.asset_code, []).append((e.sim_time, p.level_ton))
    used = {c: v for c, v in levels.items() if c.startswith(("TK-RAW", "TK-STO")) and len(v) > 2}
    assert used
    for code, seq in used.items():
        for (t0, l0), (t1, l1) in zip(seq, seq[1:], strict=False):
            if t0 == t1:
                assert l0 == l1, f"{code}: dua level berbeda pada {t0}"
        assert len({lv for _, lv in seq}) >= FLOW_STEPS


def test_day_events_are_emitted_in_order():
    sim, res = run_day(1)
    kinds = [type(e.payload) for e in sim.events]
    assert kinds.index(DayStarted) < 3
    summary = [e for e in sim.events if isinstance(e.payload, DaySummary)]
    assert len(summary) == 1 and summary[0].payload.day == 1
    assert res.day == 1 and res.day_summary["day"] == 1
    assert sim.day0 == day_date(1).replace(hour=6, tzinfo=sim.day0.tzinfo)


def test_next_day_starts_where_previous_ended():
    (s1, r1), (s2, r2) = chain(2)
    c1 = CarryState(**r1.carry_out)
    started = next(e.payload for e in s2.events if isinstance(e.payload, DayStarted))
    assert started.day == 2 and started.stock_ton == c1.fg_stock_ton > 0
    # SKU terakhir tiap line terbawa, jadi line yang sama bisa mengalami changeover di awal hari
    assert {
        c: (s.code if s else None) for c, s in s2.line_sku.items() if c in c1.line_sku
    } != {} or not c1.line_sku
    assert s2.day0 - s1.day0 == timedelta(days=1)
    # stok kumulatif bertambah
    assert r2.day_summary["stock_ton"] == pytest.approx(
        c1.fg_stock_ton + r2.day_summary["released_ton"], abs=0.01
    )


def test_late_trucks_are_deferred_not_lost():
    days = chain(4)
    for (s, r), (_, r_next) in zip(days, days[1:], strict=False):
        late = CarryState(**r.carry_out).late_trucks
        assert len(late) == len(s.deferred)
        assert r_next.day_summary["late_carried_in"] == len(late)
    for s, r in days[1:]:
        carried = [c for c in s.tankers if c.startswith("RT-T")]
        assert len(carried) == r.day_summary["late_carried_in"]


def test_volume_is_conserved_each_day():
    for s, r in chain(3):
        b = next(e.payload for e in s.events if e.payload.type == "volume.balance")
        assert b.in_process_ton == 0
        tot = r.day_summary
        assert tot["received_ton"] >= tot["released_ton"]
        assert tot["received_ton"] == pytest.approx(
            sum(x.volume_ton for x in s.batches.values() if x.type == "raw"), abs=0.01
        )


def test_chain_is_deterministic():
    a = [r.carry_out for _, r in chain(3)]
    b = [r.carry_out for _, r in chain(3)]
    assert a == b
    ea = [e.model_dump_json() for e in chain(2)[1][0].events]
    eb = [e.model_dump_json() for e in chain(2)[1][0].events]
    assert ea == eb


def test_random_incidents_are_seeded_and_reported():
    seen = set()
    for seed in range(1, 40):
        sim, res = run_day(1, seed=seed)
        inc = [e.payload for e in sim.events if isinstance(e.payload, DayIncident)]
        assert len(inc) <= 1
        if inc:
            seen.add(inc[0].kind)
            assert any(inc[0].text == i for i in res.day_summary["issues"])
    assert seen == {"machine", "tank"}


def test_single_run_without_day_is_unchanged():
    sim, _ = simulate("A", 1, 320.0, speed=0.0)
    sim.run()
    assert not any(isinstance(e.payload, (DayStarted, DaySummary)) for e in sim.events)
