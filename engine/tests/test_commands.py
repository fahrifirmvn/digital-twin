"""Perintah mode Simulasi: cabang dari menit T harus identik dengan hari dasar sebelum T."""

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app.commands import Command
from app.config import settings
from app.contracts.events import CommandApplied
from app.experiment import simulate
from app.main import app
from app.plant import PlantConfig
from app.sim import DAY_START

H = {"X-Internal-Token": settings.internal_token}
T = 300.0  # menit run (11:00); ada CIP dalam 2 jam sesudahnya

CASES = {
    "ster_down": Command(T, "ster_down", "PPIC: Dewi", "uji sterilizer", count=2, duration_min=180),
    "tank_down": Command(
        T, "tank_down", "PPIC: Dewi", "uji tangki", asset="TK-RAW-2", duration_min=180
    ),
    "cip_delay": Command(T, "cip_delay", "Juri: Budi", "uji CIP", duration_min=120, factor=2.5),
    "truck_surge": Command(T, "truck_surge", "Juri: Budi", "uji truk dadakan", count=5),
}


def run(config: str, *commands: Command, seed: int = 3):
    sim, _ = simulate(config, seed, 320.0, 0, time_limit=2.0, commands=commands)
    sim.run()
    return sim


def prefix(sim, minute: float):
    cut = DAY_START + timedelta(minutes=minute)
    return [(e.seq, e.sim_time, e.payload.model_dump()) for e in sim.events if e.sim_time < cut]


@pytest.mark.parametrize("config", ["A", "D"])
@pytest.mark.parametrize("kind", list(CASES))
def test_prefix_before_command_equals_base_run(config, kind):
    base = run(config)
    fork = run(config, CASES[kind])
    before = prefix(base, T)
    assert len(before) > 50
    assert prefix(fork, T) == before


@pytest.mark.parametrize("kind", list(CASES))
def test_command_is_logged_with_actor_and_reason(kind):
    cmd = CASES[kind]
    applied = [e for e in run("A", cmd).events if isinstance(e.payload, CommandApplied)]
    assert len(applied) == 1
    ev = applied[0]
    assert ev.sim_time == DAY_START + timedelta(minutes=T)
    assert (ev.payload.command_id, ev.payload.kind) == (1, kind)
    assert (ev.payload.actor, ev.payload.reason) == (cmd.actor, cmd.reason)


def test_command_precedes_its_effect():
    sim = run("A", CASES["ster_down"])
    at_t = [e for e in sim.events if e.sim_time == DAY_START + timedelta(minutes=T)]
    kinds = [e.payload.type for e in at_t]
    assert kinds.index("command.applied") < kinds.index("asset.status_changed")


def test_ster_down_takes_assets_out_of_service():
    sim = run("A", CASES["ster_down"])
    cut = DAY_START + timedelta(minutes=T)
    down = {
        e.payload.asset_code
        for e in sim.events
        if e.payload.type == "asset.status_changed"
        and e.sim_time >= cut
        and e.payload.status == "unavailable"
    }
    assert {"STE-1", "STE-2"} <= down


def test_ster_down_count_is_clipped_to_plant():
    cmd = Command(T, "ster_down", "x", "melebihi jumlah aset", count=12, duration_min=60)
    applied = [e for e in run("A", cmd).events if isinstance(e.payload, CommandApplied)]
    assert applied[0].payload.count == PlantConfig().n_sterilizers


def cip_minutes(sim, since: float) -> float:
    started: dict[str, object] = {}
    total = 0.0
    for e in sim.events:
        p = e.payload
        if p.type == "cip.started":
            started[p.asset_code] = e.sim_time
        elif p.type == "cip.finished" and p.asset_code in started:
            t0 = started.pop(p.asset_code)
            if t0 >= DAY_START + timedelta(minutes=since):
                total += (e.sim_time - t0).total_seconds() / 60
    return total


def test_cip_delay_makes_cip_longer():
    base, forked = run("A"), run("A", CASES["cip_delay"])
    assert cip_minutes(base, T) > 0
    assert cip_minutes(forked, T) > cip_minutes(base, T)


def test_surge_trucks_are_unique_unannounced_and_appear_after_command():
    base = run("A")
    fork = run("A", CASES["truck_surge"], Command(600, "truck_surge", "x", "gelombang kedua"))
    new = [r.spec for c, r in fork.tankers.items() if c not in base.tankers]
    assert len(new) == 5 + 4
    specs = [r.spec for r in fork.tankers.values()]
    assert len({s.code for s in specs}) == len(specs)
    assert len({s.plate for s in specs}) == len(specs)
    assert all(s.code.startswith("RT-") and not s.announced for s in new)
    dispatched = {
        e.payload.tanker_code: e
        for e in fork.events
        if e.payload.type == "truck.dispatched" and e.payload.tanker_code in {s.code for s in new}
    }
    assert set(dispatched) == {s.code for s in new}
    for spec in new:
        ev = dispatched[spec.code]
        assert ev.sim_time >= DAY_START + timedelta(minutes=spec.appears_min)
        assert ev.payload.eta > ev.sim_time
    # Truk hari dasar tidak bergeser
    assert all(fork.tankers[c].spec == r.spec for c, r in base.tankers.items())


def test_forks_are_deterministic():
    a, b = run("A", CASES["truck_surge"]), run("A", CASES["truck_surge"])
    assert [e.payload.model_dump() for e in a.events] == [e.payload.model_dump() for e in b.events]


def test_commands_via_api_and_validation():
    body = {
        "run_id": 41,
        "seed": 3,
        "commands": [
            {"minute": 420, "kind": "ster_down", "actor": "PPIC: Dewi", "reason": "uji api"}
        ],
    }
    with TestClient(app) as client:
        assert client.post("/v1/runs", json=body, headers=H).status_code == 201
        app.state.runs.get(41).thread.join(timeout=30)
        events = client.get("/v1/runs/41/result", headers=H).json()["events"]
        applied = [e["payload"] for e in events if e["payload"]["type"] == "command.applied"]
        assert applied[0]["count"] == 1 and applied[0]["duration_min"] == 240

        def bad(**kw):
            cmd = {"minute": 420, "kind": "ster_down", "actor": "a", "reason": "alasan", **kw}
            return client.post("/v1/runs", json={"run_id": 42, "commands": [cmd]}, headers=H)

        assert bad(kind="meteor").status_code == 422
        assert bad(minute=1440).status_code == 422
        assert bad(reason="x").status_code == 422
        assert bad(count=99).status_code == 422
        assert bad(extra_field=1).status_code == 422


def _tank_events(sim, code):
    return [
        (e.sim_time, e.payload.status.value, e.payload.level_ton)
        for e in sim.events
        if e.payload.type == "asset.status_changed" and e.payload.asset_code == code
    ]


def test_tank_in_maintenance_gets_no_milk_and_returns():
    base = run("A")
    victim = next(
        c
        for c in (f"TK-RAW-{n}" for n in range(1, 16))
        if any(
            s == "filling" and t >= DAY_START + timedelta(minutes=T)
            for t, s, _ in _tank_events(base, c)
        )
    )
    cmd = Command(T, "tank_down", "PPIC: Dewi", "perawatan", asset=victim, duration_min=180)
    ev = _tank_events(run("A", cmd), victim)
    start, end = DAY_START + timedelta(minutes=T), DAY_START + timedelta(minutes=T + 180)
    down = [(t, s) for t, s, _ in ev if s == "unavailable"]
    assert down and start <= down[0][0] <= end
    assert not [1 for t, s, _ in ev if s in ("filling", "in_use") and down[0][0] <= t < end]
    assert any(s == "idle" and t >= end for t, s, _ in ev)


def test_tank_levels_rise_and_fall_in_steps():
    levels = [lv for _, s, lv in _tank_events(run("A"), "TK-RAW-1") if lv]
    assert len(levels) >= 6 and max(levels) > levels[0]


def test_tank_down_validation():
    with pytest.raises(ValueError):
        Command(T, "tank_down", "x", "tangki tidak ada", asset="TK-RAW-99").normalized(
            PlantConfig()
        )
    with pytest.raises(ValueError):
        Command(T, "tank_down", "x", "tanpa tangki").normalized(PlantConfig())
