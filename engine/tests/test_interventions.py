"""Intervensi PPIC (setujui/ubah/tolak usulan, tahan/lepas truk): tercatat, deterministik, dan tidak menembus gate SOP."""

from dataclasses import replace
from datetime import timedelta
from functools import cache

import pytest
from fastapi.testclient import TestClient

from app.commands import Command
from app.config import settings
from app.contracts.events import CommandApplied, GateId
from app.experiment import simulate
from app.main import app
from app.sim import DAY_START

H = {"X-Internal-Token": settings.internal_token}
T = 550.0
SEED, EXTRA_BAD = 3, 3
WAITING = "RT-008"  # tiba 520, mulai bongkar 576 pada hari dasar
INBOUND = "RT-010"  # tiba 559
G1_HELD = "RT-009"  # ditahan G1 pada hari dasar
BY = "PPIC: Dewi"


def cmd(kind: str, truck: str, minute: float = T, **kw) -> Command:
    return Command(minute, kind, BY, "uji intervensi", truck=truck, **kw)


@cache
def run(config: str, *commands: Command):
    sim, _ = simulate(config, SEED, 320.0, EXTRA_BAD, time_limit=1.0, commands=commands)
    sim.run()
    return sim


def applied(sim) -> list[CommandApplied]:
    return [e.payload for e in sim.events if isinstance(e.payload, CommandApplied)]


def sampling_at(sim, code: str) -> float:
    ev = next(
        e
        for e in sim.events
        if e.payload.type == "tanker.status_changed"
        and e.payload.tanker_code == code
        and e.payload.status.value == "sampling"
    )
    return (ev.sim_time - DAY_START).total_seconds() / 60


def prefix(sim, minute: float):
    cut = DAY_START + timedelta(minutes=minute)
    return [(e.seq, e.sim_time, e.payload.model_dump()) for e in sim.events if e.sim_time < cut]


CASES = [
    cmd("plan_approve", WAITING),
    cmd("plan_change", WAITING, bay="BAY-2", start_min=640.0),
    cmd("plan_reject", WAITING),
    cmd("truck_hold", INBOUND, duration_min=45),
    cmd("truck_release", INBOUND),
]


@pytest.mark.parametrize("c", CASES, ids=lambda c: c.kind)
def test_prefix_before_intervention_equals_base_run(c):
    base = run("B")
    before = prefix(base, T)
    assert len(before) > 50
    assert prefix(run("B", c), T) == before


@pytest.mark.parametrize("c", CASES, ids=lambda c: c.kind)
def test_intervention_is_logged_with_truck_and_actor(c):
    (p,) = applied(run("B", c))
    assert (p.kind, p.truck, p.actor, p.reason) == (c.kind, c.truck, BY, "uji intervensi")


@pytest.mark.parametrize("c", CASES[:4], ids=lambda c: c.kind)
def test_valid_intervention_is_not_blocked(c):
    (p,) = applied(run("B", c))
    assert (p.blocked, p.gate) == (None, None)


def test_hold_delays_the_truck_at_the_gate_by_its_duration():
    arrived = sampling_at(run("B"), INBOUND)
    held = sampling_at(run("B", cmd("truck_hold", INBOUND, duration_min=45)), INBOUND)
    assert held == pytest.approx(arrived + 45, abs=0.01)


def test_release_ends_the_hold_early():
    base = sampling_at(run("B"), INBOUND)
    sim = run(
        "D",
        cmd("truck_hold", INBOUND, duration_min=120),
        cmd("truck_release", INBOUND, minute=base + 10),
    )
    assert [p.blocked for p in applied(sim)] == [None, None]
    assert sampling_at(sim, INBOUND) == pytest.approx(base + 10, abs=0.01)


def test_hold_on_a_truck_already_past_the_gate_is_blocked_without_violation():
    (p,) = applied(run("B", cmd("truck_hold", WAITING)))
    assert "gerbang" in p.blocked and p.gate is None


def test_release_of_a_gate_held_truck_is_a_blocked_violation_attempt():
    base = run("B")
    assert base.tankers[G1_HELD].outcome == "held_g1"
    sim = run("B", cmd("truck_release", G1_HELD, minute=base.tankers[G1_HELD].arrived + 5))
    (p,) = applied(sim)
    assert p.gate == GateId.G1 and p.blocked
    assert sim.tankers[G1_HELD].outcome == "held_g1"  # tetap tertahan


def test_release_of_a_rejected_truck_names_g2():
    base = run("B")
    code = next(r.spec.code for r in base.tankers.values() if r.outcome == "rejected_g2")
    (p,) = applied(run("B", cmd("truck_release", code, minute=1300)))
    assert p.gate == GateId.G2


def test_release_when_nothing_is_held_is_blocked_without_gate():
    (p,) = applied(run("B", cmd("truck_release", INBOUND)))
    assert p.blocked and p.gate is None


def test_unknown_truck_is_blocked_not_an_error():
    (p,) = applied(run("B", cmd("plan_approve", "ZZ-999")))
    assert "tidak ditemukan" in p.blocked


def test_plan_commands_need_a_plan():
    (p,) = applied(run("A", cmd("plan_approve", WAITING)))
    assert "usulan" in p.blocked


def test_unknown_bay_is_blocked():
    (p,) = applied(run("B", cmd("plan_change", WAITING, bay="BAY-99")))
    assert "BAY-99" in p.blocked


def test_same_commands_give_the_same_events():
    cs = (cmd("plan_change", WAITING, start_min=640.0), cmd("truck_hold", INBOUND))
    a = [e.model_dump() for e in run("B", *cs).events]
    assert a == [e.model_dump() for e in run("B", *cs).events]


def plain_sim():
    sim, plan = simulate("B", SEED, 320.0, EXTRA_BAD, time_limit=1.0)
    return sim, plan.trucks


def test_approve_pins_the_proposal_through_replans():
    sim, trucks = plain_sim()
    code = next(iter(trucks))
    original = trucks[code]
    assert sim._intervene(cmd("plan_approve", code)) == (None, None)
    sim.plan.trucks[code] = replace(trucks[code], unload_start=9999.0)
    assert sim._truck_plan(code) == original


def test_reject_drops_the_truck_from_the_plan_and_change_restores_it():
    sim, trucks = plain_sim()
    code = next(iter(trucks))
    sim._intervene(cmd("plan_reject", code))
    assert sim._truck_plan(code) is None
    assert "usulan" in sim._intervene(cmd("plan_change", code, start_min=100.0))[0]


def test_change_shifts_every_stage_by_the_same_delta_and_sets_the_bay():
    sim, trucks = plain_sim()
    code = next(iter(trucks))
    tp = trucks[code]
    bay = "BAY-2" if tp.bay != "BAY-2" else "BAY-1"
    assert sim._intervene(cmd("plan_change", code, bay=bay, start_min=tp.unload_start + 30)) == (
        None,
        None,
    )
    new = sim._truck_plan(code)
    assert new.bay == bay
    assert new.unload_start == tp.unload_start + 30
    assert new.lab_start == tp.lab_start + 30
    assert new.fill_end == tp.fill_end + 30
    assert (new.analyst, new.sterilizer) == (tp.analyst, tp.sterilizer)


def test_normalized_drops_arguments_that_do_not_apply():
    from app.plant import PlantConfig

    c = Command(
        T,
        "plan_approve",
        BY,
        "alasan",
        truck="RT-001",
        bay="BAY-1",
        start_min=5,
        count=3,
        duration_min=30,
        factor=2,
    ).normalized(PlantConfig())
    assert (c.bay, c.start_min, c.count, c.duration_min, c.factor) == (None,) * 5
    assert cmd("truck_hold", INBOUND).normalized(PlantConfig()).duration_min == 60.0


def test_normalized_requires_a_truck_and_a_change():
    from app.plant import PlantConfig

    with pytest.raises(ValueError):
        Command(T, "truck_hold", BY, "alasan").normalized(PlantConfig())
    with pytest.raises(ValueError):
        cmd("plan_change", WAITING).normalized(PlantConfig())


def body(**over):
    return {"run_id": 4401, "seed": 3, "volume_ton": 50, "config": "A", "commands": [over]}


def command(**over):
    return {"minute": 100, "actor": "PPIC: Dewi", "reason": "uji intervensi", **over}


@pytest.mark.parametrize(
    "over",
    [
        {"kind": "truck_hold"},
        {"kind": "plan_change", "truck": "RT-001"},
        {"kind": "plan_approve", "truck": "bukan kode"},
        {"kind": "plan_change", "truck": "RT-001", "bay": "BAY-x"},
        {"kind": "plan_change", "truck": "RT-001", "start_min": 5000},
    ],
)
def test_api_rejects_invalid_interventions(over):
    with TestClient(app) as client:
        res = client.post("/v1/runs", headers=H, json=body(**command(**over)))
    assert res.status_code == 422


def test_api_accepts_a_valid_intervention():
    with TestClient(app) as client:
        kw = command(kind="plan_change", truck="RT-001", bay="BAY-2", start_min=300)
        res = client.post("/v1/runs", headers=H, json=body(**kw))
    assert res.status_code == 201
