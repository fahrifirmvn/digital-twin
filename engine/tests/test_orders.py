import pytest

from app.api import ParamsRequest
from app.contracts.events import OrdersEvaluated
from app.experiment import simulate
from app.orders import YIELD_FG, evaluate
from app.plant import PlantConfig, with_params


class _Spec:
    def __init__(self, sku_code, volume_ton):
        self.sku_code = sku_code
        self.volume_ton = volume_ton


class _Rec:
    def __init__(self, sku, vol, outcome):
        self.spec = _Spec(sku, vol)
        self.outcome = outcome


def _cfg(**kw):
    return with_params(PlantConfig(), **kw)


def test_planned_orders_are_met_when_everything_completes():
    t = [_Rec("UHT-FULL-1000", 30, "completed"), _Rec("UHT-CHOC-200", 20, "completed")]
    r = evaluate(PlantConfig(), t)
    assert r["source"] == "planned"
    assert [o["sku"] for o in r["orders"]] == ["UHT-FULL-1000", "UHT-CHOC-200"]
    assert all(o["feasible"] and o["shortfall_ton"] == 0 for o in r["orders"])
    choc = r["orders"][1]
    assert choc["ordered_ton"] == pytest.approx(20 * YIELD_FG / 0.9, abs=0.01)


def test_manual_order_shortfall_is_attributed_to_largest_cause_first():
    t = [
        _Rec("UHT-FULL-200", 20, "completed"),
        _Rec("UHT-FULL-200", 10, "held_g1"),
        _Rec("UHT-FULL-200", 5, "held_qa"),
    ]
    cfg = with_params(PlantConfig(), orders=(("UHT-FULL-200", 33.0),))
    o = evaluate(cfg, t)["orders"][0]
    assert not o["feasible"] and o["shortfall_ton"] > 0
    assert o["milk_needed_ton"] == pytest.approx(33 / YIELD_FG, abs=0.01)
    codes = [c["code"] for c in o["causes"]]
    assert codes == ["gate", "qa"]
    assert sum(c["milk_ton"] for c in o["causes"]) == pytest.approx(
        o["milk_needed_ton"] - o["milk_used_ton"], abs=0.02
    )


def test_order_without_any_planned_milk_is_a_supply_shortage():
    t = [_Rec("UHT-FULL-1000", 30, "completed")]
    cfg = with_params(PlantConfig(), orders=(("UHT-CHOC-200", 10.0),))
    o = evaluate(cfg, t)["orders"][0]
    assert [c["code"] for c in o["causes"]] == ["supply"]
    assert o["fulfilled_ton"] == 0 and not o["feasible"]


def test_two_orders_of_same_sku_share_the_same_milk():
    t = [_Rec("UHT-FULL-1000", 20, "completed")]
    cfg = with_params(PlantConfig(), orders=(("UHT-FULL-1000", 15.0), ("UHT-FULL-1000", 15.0)))
    a, b = evaluate(cfg, t)["orders"]
    assert a["feasible"] and not b["feasible"]
    assert a["milk_used_ton"] + b["milk_used_ton"] == pytest.approx(20, abs=0.01)


def test_milk_use_pct_changes_milk_need():
    t = [_Rec("UHT-CHOC-200", 30, "completed")]
    lo = with_params(PlantConfig(), orders=(("UHT-CHOC-200", 20.0),), milk_use_flavour_pct=80)
    hi = with_params(PlantConfig(), orders=(("UHT-CHOC-200", 20.0),), milk_use_flavour_pct=100)
    assert (
        evaluate(lo, t)["orders"][0]["milk_needed_ton"]
        < evaluate(hi, t)["orders"][0]["milk_needed_ton"]
    )


def test_params_validation():
    for bad in (
        {"orders": (("UHT-XXX", 10.0),)},
        {"orders": (("UHT-FULL-200", 0.0),)},
        {"orders": (("UHT-FULL-200", 10.0),) * 7},
        {"milk_use_flavour_pct": 10},
    ):
        with pytest.raises(ValueError):
            with_params(PlantConfig(), **bad)
    req = ParamsRequest(orders=[{"sku": "UHT-CHOC-200", "ton": 12}], milk_use_full_pct=95)
    cfg = req.apply(PlantConfig())
    assert cfg.orders == (("UHT-CHOC-200", 12.0),) and cfg.milk_use_full_pct == 95


def test_simulation_emits_one_orders_event_before_the_final_clock():
    sim, _ = simulate("A", 3, 240, time_limit=2.0)
    sim.run()
    ev = [e for e in sim.events if isinstance(e.payload, OrdersEvaluated)]
    assert len(ev) == 1
    assert (
        ev[0].seq == sim.events[-4].seq
    )  # disusul neraca volume, fouling/umur simpan, dan SimClock terakhir
    assert ev[0].payload.orders


def test_dynamic_order_allocation_in_simulation():
    cfg = with_params(PlantConfig(), orders=(("UHT-CHOC-200", 120.0),))
    sim, _ = simulate("A", 3, 240, time_limit=2.0, cfg=cfg)
    sim.run()
    ev = [e.payload for e in sim.events if isinstance(e.payload, OrdersEvaluated)][0]
    assert ev.source == "manual"
    assert ev.orders[0].sku == "UHT-CHOC-200"
    assert ev.orders[0].feasible is True
