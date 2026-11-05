import math
from collections import defaultdict

import pytest

from app.experiment import simulate
from app.generator import generate_day
from app.kpi import evaluate
from app.plan import Plan
from app.plant import PlantConfig
from app.predictor import get_predictor
from app.scheduler import HOLD_MARGIN, build_jobs, make_plan

CFG = PlantConfig()


@pytest.fixture(scope="module")
def specs():
    return generate_day(1, 320)


@pytest.fixture(scope="module")
def plan_c(specs) -> Plan:
    return make_plan(specs, CFG, "C", get_predictor(), time_limit=3.0)


def _no_overlap(intervals: list[tuple[float, float]]) -> bool:
    s = sorted(intervals)
    return all(a[1] <= b[0] + 1e-6 for a, b in zip(s, s[1:], strict=False))


def test_plan_covers_all_trucks_and_orders_stages(specs, plan_c):
    assert set(plan_c.trucks) == {s.code for s in specs}
    assert plan_c.status in {"optimal", "feasible", "heuristic"}
    for t in plan_c.trucks.values():
        assert t.lab_start <= t.unload_start <= t.ster_start <= t.fill_start < t.fill_end


def test_plan_has_no_resource_overlap(specs, plan_c):
    jobs = {j.code: j for j in build_jobs(specs, "C", get_predictor())}
    lines = defaultdict(list)
    for t in plan_c.trucks.values():
        lines[t.line].append((t.fill_start, t.fill_end))
    assert all(_no_overlap(v) for v in lines.values())
    labs = defaultdict(list)
    for t in plan_c.trucks.values():
        labs[t.analyst].append((t.lab_start, t.lab_start + jobs[t.code].lab))
    assert all(_no_overlap(v) for v in labs.values())


def test_plan_respects_holding_margin(specs, plan_c):
    if plan_c.status == "heuristic":
        pytest.skip("fallback greedy tidak menjamin holding time")
    vol = {s.code: s.volume_ton for s in specs}
    for t in plan_c.trucks.values():
        unload = math.ceil(vol[t.code] / CFG.bay_flow_tph * 60 - 1e-9)
        dwell = t.ster_start - (t.unload_start + unload)
        assert dwell <= CFG.thresholds.holding_max_min - HOLD_MARGIN


def test_plan_is_deterministic(specs, plan_c):
    again = make_plan(specs, CFG, "C", get_predictor(), time_limit=3.0)
    assert again.trucks == plan_c.trucks


def test_b_uses_means_c_uses_quantile(specs):
    pred = get_predictor()
    b = build_jobs(specs, "B", pred)
    c = build_jobs(specs, "C", pred)
    assert len({j.lab for j in b}) <= 2  # durasi seragam (rata-rata), kecuali pembulatan
    assert len({j.lab for j in c}) > 2


def test_scheduled_configs_cut_changeovers_vs_fifo():
    results = {}
    for config in ("A", "B", "C"):
        sim, _ = simulate(config, 1, 320, time_limit=3.0)
        sim.run()
        results[config] = evaluate(sim)
    for config in ("B", "C"):
        assert results[config].changeover_min < results["A"].changeover_min
        assert results[config].holding_violations == 0
        assert results[config].false_accept == 0
        assert results[config].completed == results["A"].completed


def test_unknown_config_rejected():
    with pytest.raises(ValueError):
        simulate("Z", 1, 100)


def test_40_truck_scalability_and_dedicated_routing():
    from app.plant import with_params
    from app.routing import Routing

    specs_40 = generate_day(1, 900)
    assert len(specs_40) >= 38
    plan_40 = make_plan(specs_40, CFG, "C", get_predictor(), time_limit=2.0)
    assert plan_40.status in {"optimal", "feasible"}
    assert set(plan_40.trucks) == {s.code for s in specs_40}

    cfg_ded = with_params(CFG, sku_policy="dedicated")
    routing = Routing(cfg_ded, "dedicated")
    specs_ded = generate_day(1, 320)
    plan_ded = make_plan(specs_ded, cfg_ded, "C", get_predictor(), time_limit=2.0)
    sku_by_truck = {s.code: s.sku_code for s in specs_ded}
    for code, tp in plan_ded.trucks.items():
        assert routing.allows(tp.line, sku_by_truck[code])
