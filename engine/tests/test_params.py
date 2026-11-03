"""Parameter operasional per run (Q1): batas, bawaan tidak mengubah hasil, dan efek yang terukur."""

import pytest
from fastapi.testclient import TestClient

from app.api import ParamsRequest
from app.config import settings
from app.experiment import simulate
from app.kpi import adherence, evaluate
from app.main import app
from app.plant import (
    PARAM_LIMITS,
    SKUS,
    Maintenance,
    PlantConfig,
    changeover_minutes,
    plant_with,
    with_params,
)

H = {"X-Internal-Token": settings.internal_token}


def _digest(sim):
    return [(e.seq, e.sim_time, e.payload.model_dump_json()) for e in sim.events]


def test_request_fields_match_param_limits():
    assert set(ParamsRequest.model_fields) - {"maintenance", "sku_policy", "orders"} == set(
        PARAM_LIMITS
    )


def test_no_params_is_the_default_plant():
    assert with_params(PlantConfig()) == PlantConfig()


def test_default_params_do_not_change_the_run():
    base, _ = simulate("A", 3, 320)
    same, _ = simulate("A", 3, 320, cfg=with_params(PlantConfig()))
    assert _digest(base.run()) == _digest(same.run())


@pytest.mark.parametrize("name", sorted(PARAM_LIMITS))
def test_limits_are_enforced(name):
    lo, hi = PARAM_LIMITS[name]
    with_params(
        PlantConfig(),
        **{name: lo},
        **({"cip_min_minutes": lo} if name == "cip_max_minutes" else {}),
    )
    for bad in (lo - 1, hi + 1):
        with pytest.raises(ValueError):
            with_params(PlantConfig(), **{name: bad})


def test_unknown_parameter_and_inverted_cip_are_rejected():
    with pytest.raises(ValueError):
        with_params(PlantConfig(), lasers=3)
    with pytest.raises(ValueError):
        with_params(PlantConfig(), cip_min_minutes=100, cip_max_minutes=40)


def test_parameters_land_in_the_config():
    cfg = with_params(
        PlantConfig(), filling_tph=8, cip_min_minutes=50, holding_max_min=200, slot_tolerance_min=15
    )
    assert cfg.filling_tph == 8 and cfg.cip_minutes == (50.0, 90.0)
    assert cfg.thresholds.holding_max_min == 200 and cfg.slot_tolerance_min == 15
    assert cfg.n_bays == PlantConfig().n_bays


def test_changeover_follows_parameters():
    a, b = SKUS[0], SKUS[3]  # beda ukuran dan rasa
    assert changeover_minutes(a, b) == 70
    assert changeover_minutes(a, b, 10, 5) == 15
    assert changeover_minutes(a, a, 10, 5) == 0


def test_slower_filling_delays_the_day():
    def last_fill(cfg):
        sim, _ = simulate("A", 3, 320, cfg=cfg)
        sim.run()
        return max(r.fill_end for r in sim.tankers.values() if r.fill_end is not None)

    assert last_fill(with_params(PlantConfig(), filling_tph=6)) > last_fill(PlantConfig())


def test_shorter_holding_limit_flags_more_violations():
    sim, _ = simulate("A", 3, 320, cfg=with_params(PlantConfig(), holding_max_min=60))
    sim.run()
    base, _ = simulate("A", 3, 320)
    base.run()
    assert evaluate(sim).holding_violations >= evaluate(base).holding_violations


def test_maintenance_makes_the_sterilizer_unavailable():
    cfg = with_params(PlantConfig(), maintenance=(Maintenance("STE-2", 120, 90),))
    sim, _ = simulate("A", 3, 320, cfg=cfg)
    sim.run()
    windows = [(d.asset, d.start, d.end) for d in sim.downtimes]
    assert ("STE-2", 120.0, 210.0) in windows


def test_adherence_uses_the_slot_tolerance():
    tight, _ = simulate(
        "B", 3, 320, time_limit=2.0, cfg=with_params(PlantConfig(), slot_tolerance_min=5)
    )
    wide, _ = simulate(
        "B", 3, 320, time_limit=2.0, cfg=with_params(PlantConfig(), slot_tolerance_min=120)
    )
    tight.run(), wide.run()
    assert adherence(tight) <= adherence(wide)


def test_api_validates_params():
    bad = (
        {"filling_tph": 99},
        {"cip_min_minutes": 100, "cip_max_minutes": 40},
        {"lasers": 1},
        {"maintenance": [{"asset": "STE-2", "start_min": 5000, "duration_min": 60}]},
        {"maintenance": [{"asset": "BAY-1", "start_min": 10, "duration_min": 60}]},
        {"maintenance": [{"asset": "STE-9", "start_min": 10, "duration_min": 60}]},
        {"maintenance": [{"asset": "STE-1", "start_min": 10, "duration_min": 60}] * 7},
    )
    with TestClient(app) as client:
        for params in bad:
            res = client.post("/v1/runs", json={"run_id": 91, "params": params}, headers=H)
            assert res.status_code == 422, params
        # sterilizer di luar jumlah terpasang pada pabrik kecil
        res = client.post(
            "/v1/runs",
            json={
                "run_id": 92,
                "plant": {"n_sterilizers": 2},
                "params": {
                    "maintenance": [{"asset": "STE-3", "start_min": 10, "duration_min": 60}]
                },
            },
            headers=H,
        )
        assert res.status_code == 422


def test_plant_and_params_combine():
    cfg = with_params(plant_with(n_bays=2), filling_tph=8)
    assert cfg.n_bays == 2 and cfg.filling_tph == 8
