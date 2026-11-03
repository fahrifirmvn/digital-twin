"""
Phase 6 Tests: FastAPI REST Endpoints Suite.
Verifies all 9 operational API endpoints:
- POST /predict/eta
- POST /predict/lab
- POST /plan
- POST /replan
- POST /whatif
- GET /explain/{schedule_id}
- GET /trace/forward/{trip_id}
- GET /trace/backward/{lot_id}
- GET /neraca
Data Classification: DATA SINTETIS
Partner: [Nama Pabrik]
"""

import pytest
from fastapi.testclient import TestClient
from src.api.app import app


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


def test_root_endpoint(client):
    res = client.get("/")
    assert res.status_code == 200
    data = res.json()
    assert data["partner"] == "[Nama Pabrik]"
    assert data["data_classification"] == "DATA SINTETIS"
    assert data["status"] == "ONLINE"


def test_predict_eta_endpoint(client):
    payload = {
        "farm_id": "FARM-01",
        "departure_hour": 8,
        "day_of_week": 2,
        "volume_l": 10000.0,
        "historical_avg_transit_min": 55.0
    }
    res = client.post("/predict/eta", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert data["farm_id"] == "FARM-01"
    assert "p50_minutes" in data
    assert "p80_minutes" in data
    assert "p90_minutes" in data
    assert data["p50_minutes"] <= data["p80_minutes"] <= data["p90_minutes"]
    assert data["label"] == "DATA SINTETIS"


def test_predict_lab_endpoint(client):
    payload = {
        "farm_id": "FARM-02",
        "sampling_hour": 9,
        "shift_id": 1,
        "is_shift_change": 0,
        "queue_length_at_sampling": 2
    }
    res = client.post("/predict/lab", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert data["farm_id"] == "FARM-02"
    assert "p50_minutes" in data
    assert "p80_minutes" in data
    assert data["p50_minutes"] <= data["p80_minutes"] <= data["p90_minutes"]
    assert data["label"] == "DATA SINTETIS"


def test_plan_and_explain_endpoints(client):
    payload = {
        "tankers": [
            {
                "trip_id": "TRIP-API-01",
                "farm_id": "FARM-01",
                "volume_l": 10000.0,
                "planned_slot_minute": 120,
                "predicted_arrival_p50": 90,
                "predicted_arrival_p80": 110,
                "predicted_lab_duration": 25,
                "p_release": 0.98,
                "allow_split": False
            },
            {
                "trip_id": "TRIP-API-02",
                "farm_id": "FARM-02",
                "volume_l": 12000.0,
                "planned_slot_minute": 160,
                "predicted_arrival_p50": 130,
                "predicted_arrival_p80": 150,
                "predicted_lab_duration": 25,
                "p_release": 0.98,
                "allow_split": False
            }
        ],
        "production_orders": [
            {
                "order_id": "ORD-API-01",
                "sku_id": "ESL-FC",
                "pack_size_code": "LARGE_A",
                "due_time_minute": 600,
                "target_volume_l": 10000.0
            }
        ]
    }
    res_plan = client.post("/plan", json=payload)
    assert res_plan.status_code == 200
    plan_data = res_plan.json()
    sched_id = plan_data["schedule_id"]
    assert sched_id.startswith("PLAN-")
    assert len(plan_data["receiving_schedule"]["tanker_decisions"]) == 2

    # Call /explain for this schedule
    res_explain = client.get(f"/explain/{sched_id}")
    assert res_explain.status_code == 200
    exp_data = res_explain.json()
    assert exp_data["schedule_id"] == sched_id
    assert len(exp_data["tanker_rationales"]) == 2
    assert len(exp_data["tanker_rationales"][0]["reasons"]) > 0


def test_replan_endpoint(client):
    # Base plan first
    plan_payload = {
        "tankers": [
            {
                "trip_id": "TRIP-REP-01",
                "farm_id": "FARM-01",
                "volume_l": 10000.0,
                "planned_slot_minute": 120,
                "predicted_arrival_p50": 90,
                "predicted_arrival_p80": 110,
                "predicted_lab_duration": 25
            }
        ]
    }
    base_res = client.post("/plan", json=plan_payload).json()

    replan_payload = {
        "events": [
            {
                "event_type": "ETA_SHIFT",
                "entity_id": "TRIP-REP-01",
                "new_value": 140, # shifted +50m
                "timestamp_minute": 80
            }
        ],
        "previous_schedule": base_res["receiving_schedule"],
        "tankers": plan_payload["tankers"],
        "force": True
    }
    res_replan = client.post("/replan", json=replan_payload)
    assert res_replan.status_code == 200
    data = res_replan.json()
    assert data["replan_triggered"] is True
    assert len(data["receiving_schedule"]["tanker_decisions"]) == 1


def test_whatif_endpoint(client):
    plan_payload = {
        "tankers": [
            {
                "trip_id": "TRIP-WIF-01",
                "farm_id": "FARM-01",
                "volume_l": 10000.0,
                "planned_slot_minute": 120,
                "predicted_arrival_p50": 90,
                "predicted_arrival_p80": 110,
                "predicted_lab_duration": 25
            }
        ]
    }
    base_res = client.post("/plan", json=plan_payload).json()

    whatif_payload = {
        "scenario": {
            "scenario_id": "WIF-TEST",
            "description": "Increase bay flow by 20%",
            "bay_flow_multiplier": 1.2
        },
        "base_receiving_schedule": base_res["receiving_schedule"],
        "tankers": plan_payload["tankers"]
    }
    res = client.post("/whatif", json=whatif_payload)
    assert res.status_code == 200
    data = res.json()
    assert data["scenario_id"] == "WIF-TEST"
    assert "delta_kpis" in data
    assert "delta_total_waiting_time_minutes" in data["delta_kpis"]


def test_trace_forward_endpoint(client):
    res = client.get("/trace/forward/TRIP-001")
    assert res.status_code == 200
    data = res.json()
    assert data["source_trip_id"] == "001"
    assert "SFP-01" in data["impacted_storage_tanks"]
    assert "FG-ORD-01" in data["finished_goods_lots"]
    assert data["volume_conserved"] is True


def test_trace_backward_endpoint(client):
    res = client.get("/trace/backward/FG-ORD-01")
    assert res.status_code == 200
    data = res.json()
    assert data["finished_lot_id"] == "FG-ORD-01"
    assert data["packaging_line_id"] == "FL-01"
    assert "SFP-01" in data["source_storage_tanks"]
    assert data["volume_conserved"] is True


def test_neraca_endpoint(client):
    res = client.get("/neraca")
    assert res.status_code == 200
    data = res.json()
    assert data["partner"] == "[Nama Pabrik]"
    assert data["data_classification"] == "DATA SINTETIS"
    assert data["is_conserved"] is True
    assert data["volume_residual_l"] <= 1.0
