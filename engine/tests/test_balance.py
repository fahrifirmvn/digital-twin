import pytest

from app.api import ParamsRequest
from app.contracts.events import VolumeBalance
from app.experiment import simulate
from app.plant import PlantConfig, with_params


def _balance(seed=3, volume=320, cfg=None):
    sim, _ = simulate("A", seed, volume, time_limit=2.0, cfg=cfg)
    sim.run()
    return sim, [e.payload for e in sim.events if isinstance(e.payload, VolumeBalance)]


def test_balance_closes_on_a_finished_day():
    sim, ev = _balance()
    assert len(ev) == 1
    b = ev[0]
    assert b.received_ton > 0 and b.fg_ton > 0
    assert b.in_process_ton == 0
    assert b.tank_end_ton == pytest.approx(0, abs=0.01)
    assert b.fg_ton + b.loss_ton + b.qa_hold_ton + b.tank_end_ton == pytest.approx(
        b.received_ton, abs=0.05
    )
    assert b.fg_ton == pytest.approx(
        sum(x.volume_ton for x in sim.batches.values() if x.type == "fg"), abs=0.01
    )


def test_balance_is_emitted_before_the_final_clock_and_after_orders():
    sim, _ = _balance()
    kinds = [e.payload.type for e in sim.events[-4:]]
    assert kinds == ["orders.evaluated", "volume.balance", "fouling.expiry", "sim.clock"]


def test_qa_hold_and_unreceived_milk_are_reported():
    for seed in range(1, 12):
        sim, ev = _balance(seed=seed, volume=400)
        b = ev[0]
        held = sum(r.spec.volume_ton for r in sim.tankers.values() if r.outcome == "held_qa")
        assert b.in_process_ton == 0
        assert b.qa_hold_ton == pytest.approx(held * 0.995, abs=0.1)
        if b.not_received_ton > 0:
            return
    pytest.skip("tidak ada truk ditolak pada seed uji")


def test_opening_stock_is_param_with_limits():
    cfg = ParamsRequest(opening_stock_ton=25).apply(PlantConfig())
    assert cfg.opening_stock_ton == 25
    _, ev = _balance(cfg=cfg)
    assert ev[0].opening_stock_ton == 25
    for bad in (-1, 501):
        with pytest.raises(ValueError):
            with_params(PlantConfig(), opening_stock_ton=bad)


def test_mixing_and_splitting_genealogy_conserves_volume():
    sim, ev = _balance(seed=3, volume=320)
    fgs = [b for b in sim.batches.values() if b.type == "fg"]
    mixed = [b for b in fgs if len(b.parents) > 1]
    assert mixed, "Harus ada lot FG hasil commingling (mixing >= 2 batch intermediate di TK-STO)"
    child_count: dict[str, int] = {}
    for b in fgs:
        for p in b.parents:
            child_count[p] = child_count.get(p, 0) + 1
    assert any(c > 1 for c in child_count.values()), (
        "Harus ada batch intermediate yang terpecah (splitting) ke >= 2 lot FG"
    )
    assert ev[0].in_process_ton == 0


def test_detailed_balance_loss_split_and_zero_residual():
    from app.balance import compute_detailed

    cfg = ParamsRequest(opening_stock_ton=15).apply(PlantConfig())
    sim, _ = _balance(seed=3, volume=320, cfg=cfg)
    d = compute_detailed(sim)
    assert d["residual_ton"] == 0.0
    assert d["loss_therm_sep_ton"] > 0 and d["loss_filling_ton"] > 0
    assert d["loss_therm_sep_ton"] + d["loss_filling_ton"] == pytest.approx(d["loss_ton"], abs=0.02)
    assert d["closing_stock_ton"] == pytest.approx(
        d["opening_stock_ton"] + d["tank_end_ton"], abs=0.01
    )
    assert 90.0 <= d["yield_pct"] <= 100.0
