from datetime import timedelta

import pytest

from app.api import ParamsRequest
from app.contracts.events import FoulingExpiry
from app.experiment import simulate
from app.plant import PlantConfig, with_params


def _wear(seed=3, volume=320, cfg=None):
    sim, _ = simulate("A", seed, volume, time_limit=2.0, cfg=cfg)
    sim.run()
    return sim, [e.payload for e in sim.events if isinstance(e.payload, FoulingExpiry)]


def test_one_event_per_run_with_every_sterilizer():
    sim, ev = _wear()
    assert len(ev) == 1
    assert [s.asset_code for s in ev[0].fouling.sterilizers] == sim.sterilizers.codes


def test_run_minutes_match_sterilizer_batches_without_cip():
    sim, ev = _wear(volume=200)
    cfg = sim.cfg
    inter = {b.tanker: b for b in sim.batches.values() if b.type == "intermediate"}
    for s in ev[0].fouling.sterilizers:
        if s.cip_count:
            continue
        expect = sum(
            inter[r.spec.code].volume_ton / cfg.sterilizer_tph * 60
            for r in sim.tankers.values()
            if r.sterilizer == s.asset_code and r.ster_start is not None
        )
        assert s.run_min == pytest.approx(expect, abs=0.1)
        assert s.peak_min == s.run_min


def test_limit_drives_state_and_reached_time():
    _, ev = _wear(cfg=with_params(PlantConfig(), fouling_max_min=60))
    over = [s for s in ev[0].fouling.sterilizers if s.state == "over"]
    assert over and all(s.reached_at is not None for s in over)
    _, ev = _wear(cfg=with_params(PlantConfig(), fouling_max_min=720))
    assert all(s.state == "ok" and s.reached_at is None for s in ev[0].fouling.sterilizers)


def test_emergency_cip_resets_the_count():
    for seed in range(1, 15):
        sim, ev = _wear(seed=seed, volume=400, cfg=with_params(PlantConfig(), fouling_max_min=60))
        cipped = [s for s in ev[0].fouling.sterilizers if s.cip_count]
        if cipped:
            assert all(s.run_min <= s.peak_min for s in cipped)
            return
    pytest.skip("tidak ada CIP darurat pada seed uji")


def test_expiry_dates_and_remaining_life():
    sim, ev = _wear()
    e = ev[0].expiry
    assert e.skus
    made = {b.sku for b in sim.batches.values() if b.type == "fg"}
    assert {s.sku for s in e.skus} == made
    for s in e.skus:
        first = min(
            r.fill_end for r in sim.tankers.values() if r.spec.sku_code == s.sku and r.fill_end
        )
        made = sim.at(first).date()
        assert s.produced_on == made.isoformat()
        assert s.expires_on == (made + timedelta(days=180)).isoformat()
        assert s.remaining_pct == pytest.approx(100 * 150 / 180, abs=0.1)
        assert s.state == "ok"
    assert sum(s.volume_ton for s in e.skus) == pytest.approx(
        sum(b.volume_ton for b in sim.batches.values() if b.type == "fg"), abs=0.05
    )


def test_long_lead_time_makes_remaining_life_short():
    cfg = ParamsRequest(shelf_life_days=100, dispatch_lead_days=60).apply(PlantConfig())
    _, ev = _wear(cfg=cfg)
    assert all(s.state == "short" and s.remaining_pct == 40 for s in ev[0].expiry.skus)


def test_params_have_limits():
    cfg = ParamsRequest(fouling_max_min=120, shelf_life_days=90, dispatch_lead_days=10).apply(
        PlantConfig()
    )
    assert (cfg.fouling_max_min, cfg.shelf_life_days, cfg.dispatch_lead_days) == (120, 90, 10)
    for k, bad in (("fouling_max_min", 59), ("shelf_life_days", 366), ("dispatch_lead_days", -1)):
        with pytest.raises(ValueError):
            with_params(PlantConfig(), **{k: bad})


def test_paper_changeover_is_not_added_during_size_change_and_flavour_cip_rule():
    from app.plant import Sku, changeover_minutes, needs_flavour_cip

    a = Sku("UHT-FULL-1000-REG", 1000, "full_cream", "regular")
    b_paper = Sku("UHT-FULL-1000-PRM", 1000, "full_cream", "promo")
    b_size_paper = Sku("UHT-FULL-200-PRM", 200, "full_cream", "promo")
    choc = Sku("UHT-CHOC-200", 200, "chocolate", "regular")
    straw = Sku("UHT-STRW-200", 200, "strawberry", "regular")

    # Paper change alone adds paper_min (20)
    assert changeover_minutes(a, b_paper, size_min=40, flavor_min=30, paper_min=20) == 20.0
    # Size + paper change: paper is NOT added during size change (brief SOP rule)
    assert changeover_minutes(a, b_size_paper, size_min=40, flavor_min=30, paper_min=20) == 40.0
    # Flavour-to-white triggers CIP
    assert needs_flavour_cip(choc, a) is True
    assert needs_flavour_cip(straw, a) is True
    assert needs_flavour_cip(a, choc) is False


def test_fouling_limit_triggers_scheduled_sterilizer_cip_and_flavour_line_cip():
    sim, _ = _wear(seed=2, volume=320, cfg=with_params(PlantConfig(), fouling_max_min=60))
    ste_cips = [c for c in sim.cips if c.asset.startswith("STE-") and c.scheduled]
    assert ste_cips, "Sterilizer harus menjalani CIP terjadwal saat melewati fouling_max_min"
    line_cips = [c for c in sim.cips if c.asset.startswith("LINE-")]
    assert len(line_cips) == 2
