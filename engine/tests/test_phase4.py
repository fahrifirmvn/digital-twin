import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.experiment import simulate
from app.generator import generate_day
from app.kpi import adherence, evaluate
from app.main import app
from app.mc import select_plan
from app.plant import PlantConfig
from app.predictor import get_predictor
from app.scenarios import SCENARIO_KEYS, get_scenario
from app.scheduler import Frozen, Pin, build_jobs, make_plan, solve

H = {"X-Internal-Token": settings.internal_token}
CFG = PlantConfig()


def _run(config: str, scenario: str = "normal", volume: float = 150, seed: int = 1):
    sim, plan = simulate(config, seed, volume, time_limit=2.0, scenario=scenario)
    sim.run()
    return sim, plan


def test_scenario_registry():
    assert set(SCENARIO_KEYS) == {
        "normal",
        "truck_surge",
        "sterilizer_down",
        "cip_delay",
        "out_of_spec",
        "peak_450",
    }
    with pytest.raises(ValueError):
        get_scenario("nope")
    assert get_scenario("peak_450").apply(100, 0)[0] == 450
    assert get_scenario("out_of_spec").apply(100, 0)[1] >= 3


def test_surge_trucks_are_unannounced_and_deterministic():
    base = generate_day(1, 150)
    surged = generate_day(1, 150, surge=(600, 720, 8))
    assert all(s.announced for s in base)
    extra = [s for s in surged if not s.announced]
    assert len(extra) == 8
    assert all(600 <= s.scheduled_eta_min <= 720 for s in extra)
    assert all(s.scheduled_eta_min == s.arrival_min for s in extra)
    kept = [s for s in surged if s.announced]
    assert [(s.farm_code, s.arrival_min, s.volume_ton) for s in kept] == [
        (s.farm_code, s.arrival_min, s.volume_ton) for s in base
    ]
    assert surged == generate_day(1, 150, surge=(600, 720, 8))


def test_sterilizer_downtime_is_respected_and_emitted():
    sim, _ = _run("A", "sterilizer_down", volume=320)
    assert len(sim.downtimes) == 4
    for d in sim.downtimes:
        for r in sim.tankers.values():
            if r.sterilizer == d.asset and r.ster_start is not None:
                assert not d.start < r.ster_start < d.end
    assert any(
        e.payload.type == "asset.status_changed" and e.payload.status == "unavailable"
        for e in sim.events
    )
    assert evaluate(sim).false_accept == 0


def test_cip_delay_slows_cip():
    base, _ = _run("A", "normal")
    slow, _ = _run("A", "cip_delay")
    assert sum(c.end - c.start for c in slow.cips) > sum(c.end - c.start for c in base.cips)


def test_pinned_solve_keeps_started_stages_and_is_feasible():
    specs = generate_day(1, 150)
    pred = get_predictor()
    plan = make_plan(specs, CFG, "C", pred, time_limit=2.0)
    sim, _ = _run("C")
    codes = list(plan.trucks)
    done = codes[0]
    tp = plan.trucks[done]
    start = int(tp.lab_start)
    frozen = Frozen(now=start + 5, pins={done: Pin(lab=(start, 0))}, prev=plan)
    jobs = build_jobs(specs, "C", pred)
    new = solve(jobs, CFG, "C", time_limit=3.0, frozen=frozen)
    assert int(new.trucks[done].lab_start) == start
    assert all(t.lab_start >= frozen.now for c, t in new.trucks.items() if c != done)
    assert set(new.trucks) == set(plan.trucks)
    assert sim.plan is not None


def test_rolling_replan_is_safe_and_valid():
    sim, plan = _run("D", volume=150)
    a, _ = _run("A", volume=150)
    k, ka = evaluate(sim), evaluate(a)
    assert sim.replans, "D harus replan berkala"
    assert all(r.status in {"optimal", "feasible", "failed"} for r in sim.replans)
    assert [e for e in sim.events if e.payload.type == "schedule.replanned"]
    assert [v for _, _, v in sim.plan_log][0] is plan
    assert k.completed == ka.completed
    assert k.false_accept == 0 and k.holding_violations == 0
    assert adherence(sim) is not None


def test_adherence_defined_for_planned_configs_only():
    a, _ = _run("A", volume=100)
    c, _ = _run("C", volume=100)
    assert adherence(a) is None and adherence(c) is not None
    assert 0 <= adherence(c) <= 100


def test_monte_carlo_is_deterministic_and_picks_a_candidate():
    specs = generate_day(1, 100)
    pred = get_predictor()
    p1, m1 = select_plan(specs, CFG, pred, 1, samples=6, time_limit=1.5)
    _, m2 = select_plan(specs, CFG, pred, 1, samples=6, time_limit=1.5)
    assert m1.chosen == m2.chosen
    assert m1.chosen in {c.label for c in m1.candidates}
    chosen = next(c for c in m1.candidates if c.label == m1.chosen)
    assert chosen.score == min(c.score for c in m1.candidates)
    assert p1.config == "D"
    assert set(m1.kpi_predicted["truck_wait_mean_min"]) >= {"mean", "p10", "p90"}


def test_api_accepts_config_d_with_scenario_and_rejects_unknown():
    with TestClient(app) as client:
        bad = client.post("/v1/runs", json={"run_id": 1, "scenario": "nope"}, headers=H)
        assert bad.status_code == 422
        res = client.post(
            "/v1/runs",
            json={"run_id": 31, "config": "D", "scenario": "truck_surge", "volume_ton": 100},
            headers=H,
        )
        assert res.status_code == 201
        app.state.runs.get(31).thread.join(timeout=120)
        result = client.get("/v1/runs/31/result", headers=H).json()
        assert result["config"] == "D" and result["scenario"] == "truck_surge"
        assert result["monte_carlo"]["chosen"] in {"B", "C80", "C90"}
        assert result["kpi"]["false_accept"] == 0
