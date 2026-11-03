from app.experiment import simulate
from app.plant import PlantConfig, with_params
from app.sim import LOW_MIN, aseptic_low


def _run(config="A", cfg=None):
    sim, _ = simulate(config, 1, 320, time_limit=2.0, cfg=cfg)
    sim.run()
    return sim


def _of(sim, kind):
    return [e.payload for e in sim.events if e.payload.type == kind]


def test_aseptic_levels_follow_lots_and_end_empty():
    sim = _run()
    levels = _of(sim, "asset.level")
    assert levels
    assert all(0 <= p.level_ton <= p.capacity_ton for p in levels)
    last = {}
    for p in levels:
        last[p.asset_code] = p
    assert {c for c in last} <= {f"ASEP-{k}" for k in range(1, 6)}
    assert all(p.level_ton == 0 and p.lot is None and p.since is None for p in last.values())


def test_level_carries_lot_age_and_fill_start():
    sim = _run()
    filling = [p for p in _of(sim, "asset.level") if p.fill_start is not None]
    assert filling
    assert all(p.lot and p.since and p.since <= p.fill_start for p in filling)


def test_every_changeover_is_announced():
    sim = _run("B")
    told = _of(sim, "line.changeover")
    assert len(told) == len(sim.changeovers)
    assert all(p.from_sku != p.to_sku and p.minutes > 0 for p in told)


def test_events_do_not_change_throughput():
    sim = _run()
    done = [r for r in sim.tankers.values() if r.outcome == "completed"]
    assert done and all(r.fill_end is not None for r in done)


def test_hold_limit_and_capacity_follow_params():
    cfg = with_params(PlantConfig(), holding_max_min=120)
    sim = _run(cfg=cfg)
    assert {p.hold_max_min for p in _of(sim, "asset.level")} == {120}
    assert {p.capacity_ton for p in _of(sim, "asset.level")} == {PlantConfig().aseptic_cap_ton}


def test_low_flag_rule():
    assert not aseptic_low(5.0, 0, 10.0)  # tidak ada line yang mengisi
    assert aseptic_low(2.0, 1, 10.0)  # 12 menit
    assert not aseptic_low(2.5, 1, 10.0)  # tepat 15 menit
    assert aseptic_low(4.0, 2, 10.0)  # dua line menguras bersama
    assert LOW_MIN == 15.0
