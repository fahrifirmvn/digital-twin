import pytest
from fastapi.testclient import TestClient

from app.api import PlantRequest
from app.config import settings
from app.experiment import simulate
from app.main import app
from app.plant import MODULE_FIELDS, MODULE_LIMITS, PlantConfig, plant_with

H = {"X-Internal-Token": settings.internal_token}


def _digest(sim):
    return [(e.seq, e.sim_time, e.payload.model_dump_json()) for e in sim.events]


def test_plant_with_overrides_and_skips_none():
    cfg = plant_with(n_bays=2, n_raw_tanks=None)
    assert cfg.n_bays == 2 and cfg.n_raw_tanks == PlantConfig().n_raw_tanks
    assert plant_with() == PlantConfig()


@pytest.mark.parametrize("bad", [0, 4, -1])
def test_plant_with_rejects_out_of_range(bad):
    with pytest.raises(ValueError):
        plant_with(n_bays=bad)
    with pytest.raises(ValueError):
        plant_with(n_unknown=2)


def test_api_validates_plant_limits():
    with TestClient(app) as client:
        for plant in (
            {"n_bays": 0},
            {"n_bays": 4},
            {"n_bays": 2.5},
            {"n_raw_tanks": 16},
            {"n_sterilizers": 6},
            {"lasers": 1},
        ):
            res = client.post("/v1/runs", json={"run_id": 90, "plant": plant}, headers=H)
            assert res.status_code == 422, plant


def test_every_field_in_request_is_a_module_field():
    assert set(PlantRequest.model_fields) == set(MODULE_FIELDS)


def test_default_plant_leaves_old_runs_unchanged():
    base, _ = simulate("A", 1, 320)
    same, _ = simulate("A", 1, 320, cfg=plant_with())
    assert _digest(base) == _digest(same)


def test_same_seed_and_plant_is_deterministic():
    cfg = plant_with(n_bays=2, n_raw_tanks=3)
    a, _ = simulate("A", 4, 320, cfg=cfg)
    b, _ = simulate("A", 4, 320, cfg=plant_with(n_bays=2, n_raw_tanks=3))
    assert _digest(a) == _digest(b)


def test_bay_count_changes_asset_codes_and_wait():
    def bays_and_wait(n):
        sim, _ = simulate("A", 1, 320, cfg=plant_with(n_bays=n))
        sim.run()
        codes = {
            e.payload.asset_code for e in sim.events if e.payload.type == "asset.status_changed"
        }
        waits = [
            r.unload_start - r.arrived for r in sim.tankers.values() if r.unload_start is not None
        ]
        return {c for c in codes if c.startswith("BAY-")}, sum(waits) / max(len(waits), 1)

    one, wait_one = bays_and_wait(1)
    three, wait_three = bays_and_wait(3)
    assert one == {"BAY-1"}
    assert three == {"BAY-1", "BAY-2", "BAY-3"}
    assert wait_one > wait_three


@pytest.mark.parametrize("config", ["A", "C"])
@pytest.mark.parametrize("edge", [0, 1])
def test_extreme_plants_run_to_completion(config, edge):
    cfg = plant_with(**{k: MODULE_LIMITS[k][edge] for k in MODULE_FIELDS})
    sim, _ = simulate(config, 1, 320, time_limit=2.0, cfg=cfg)
    sim.run()
    assert sim.events and all(r.status for r in sim.tankers.values())
