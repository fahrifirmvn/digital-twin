from dataclasses import replace

import pytest

from app.experiment import simulate
from app.plant import PlantConfig, with_params
from app.routing import Routing, line_cap


def _run(cfg, config="A", seed=1, volume=320):
    sim, _ = simulate(config, seed, volume, time_limit=2.0, cfg=cfg)
    sim.run()
    return sim


def test_default_policy_is_unrestricted_like_before():
    r = Routing(PlantConfig())
    assert r.default
    assert len(r.routes) == 10
    assert all(x.usable and not x.blocked and len(x.allowed) == 4 for x in r.routes)


def test_topology_one_aseptic_serves_two_lines():
    r = Routing(PlantConfig())
    pairs = [(x.sterilizer, x.aseptic, x.line) for x in r.routes]
    assert pairs[0] == ("STE-1", "ASEP-1", "LINE-1")
    assert pairs[1] == ("STE-1", "ASEP-1", "LINE-2")
    assert pairs[2] == ("STE-2", "ASEP-2", "LINE-3")
    assert pairs[-1] == ("STE-5", "ASEP-5", "LINE-10")


def test_dedicated_blocks_small_packs_on_second_line_with_reason():
    r = Routing(PlantConfig(), "dedicated")
    first, second = r.routes[0], r.routes[1]
    assert not first.blocked and len(first.allowed) == 4
    assert {s for s, _ in second.blocked} == {"UHT-FULL-200", "UHT-CHOC-200"}
    assert all("LINE-2" in why and "1000 ml" in why for _, why in second.blocked)
    assert r.allows("LINE-1", "UHT-CHOC-200") and not r.allows("LINE-2", "UHT-CHOC-200")
    assert r.allows("LINE-2", "UHT-FULL-1000")
    assert all(r.sterilizer_ok(k, "UHT-CHOC-200") for k in range(1, 6))


def test_line_flow_cannot_exceed_aseptic_output():
    cfg = with_params(PlantConfig(), filling_tph=15)  # 2 x 15 > 20
    assert line_cap(cfg) == 1
    r = Routing(cfg)
    blocked = [x for x in r.routes if not x.usable]
    assert [x.line for x in blocked] == [f"LINE-{n}" for n in (2, 4, 6, 8, 10)]
    assert all("melebihi output aseptic" in (x.reason or "") for x in blocked)
    assert Routing(PlantConfig()).cap == 2


def test_unknown_policy_rejected():
    with pytest.raises(ValueError):
        Routing(PlantConfig(), "bebas")
    with pytest.raises(ValueError):
        with_params(PlantConfig(), sku_policy="bebas")


def test_route_map_event_sent_once_at_start():
    sim = _run(PlantConfig())
    ev = [e.payload for e in sim.events if e.payload.type == "plant.routes"]
    assert len(ev) == 1 and sim.events[1].payload.type == "plant.routes"
    assert ev[0].policy == "free" and len(ev[0].routes) == 10 and len(ev[0].skus) == 4


def test_dedicated_run_never_fills_small_pack_on_second_line():
    cfg = replace(PlantConfig(), sku_policy="dedicated")
    sim = _run(cfg, seed=3, volume=480)
    small = {"UHT-FULL-200", "UHT-CHOC-200"}
    even = {f"LINE-{n}" for n in (2, 4, 6, 8, 10)}
    filled = [r for r in sim.tankers.values() if r.line]
    assert filled
    assert not [r for r in filled if r.spec.sku_code in small and r.line in even]
    assert all(r.outcome != "in_progress" for r in sim.tankers.values())


def test_blocked_line_by_flow_is_unavailable_and_unused():
    sim = _run(with_params(PlantConfig(), filling_tph=15))
    used = {r.line for r in sim.tankers.values() if r.line}
    assert used and not used & {f"LINE-{n}" for n in (2, 4, 6, 8, 10)}
    marks = [
        e.payload
        for e in sim.events
        if e.payload.type == "asset.status_changed" and e.payload.status == "unavailable"
    ]
    assert {p.asset_code for p in marks} >= {"LINE-2", "LINE-10"}
