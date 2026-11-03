import json

import httpx
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.relay import Relay
from app.runs import RunManager

H = {"X-Internal-Token": settings.internal_token}


def test_run_lifecycle_and_event_replay():
    with TestClient(app) as client:
        assert client.post("/v1/runs", json={}).status_code == 401
        res = client.post("/v1/runs", json={"run_id": 7, "seed": 2, "volume_ton": 320}, headers=H)
        assert res.status_code == 201
        run_id = res.json()["run_id"]
        assert run_id == 7
        app.state.runs.get(run_id).thread.join(timeout=30)

        dup = client.post("/v1/runs", json={"run_id": 7}, headers=H)
        assert dup.status_code == 409

        result = client.get(f"/v1/runs/{run_id}/result", headers=H).json()
        assert result["run_id"] == 7 and result["kpi"]["false_accept"] == 0
        assert len(result["events"]) > 100

        info = client.get(f"/v1/runs/{run_id}", headers=H).json()
        assert info["status"] == "finished" and info["last_seq"] > 100

        first = client.get(f"/v1/runs/{run_id}/events?limit=10", headers=H).json()["events"]
        rest = client.get(f"/v1/runs/{run_id}/events?after=9&limit=10", headers=H).json()["events"]
        assert [e["seq"] for e in first + rest] == list(range(20))
        assert client.get("/v1/runs/999", headers=H).status_code == 404


def test_request_validation():
    with TestClient(app) as client:
        assert (
            client.post("/v1/runs", json={"run_id": 1, "volume_ton": 5}, headers=H).status_code
            == 422
        )
        assert client.post("/v1/runs", json={"run_id": 1, "speed": 0}, headers=H).status_code == 422
        assert client.post("/v1/runs", json={}, headers=H).status_code == 422


def test_relay_posts_batches_with_token_and_survives_failures():
    received: list[dict] = []
    fail = {"on": True}

    def handler(request: httpx.Request) -> httpx.Response:
        if fail["on"]:
            fail["on"] = False
            return httpx.Response(503)
        assert request.headers["X-Internal-Token"] == "tok"
        received.extend(json.loads(request.content)["events"])
        return httpx.Response(204)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    relay = Relay("http://web/internal/twin-events", "tok", client=client, flush_interval=0.01)
    runs = RunManager(relay)
    run = runs.start(run_id=1, seed=1, volume_ton=320)
    run.thread.join(timeout=30)
    relay.close()

    assert run.status == "finished"
    # Batch pertama sengaja gagal, sisanya sampai dengan urutan terjaga.
    seqs = [e["seq"] for e in received]
    assert seqs == sorted(seqs) and len(seqs) > 100 and len(seqs) < len(run.sim.events)


def test_scheduled_config_returns_plan_and_eta_forecasts():
    with TestClient(app) as client:
        body = {"run_id": 31, "seed": 3, "volume_ton": 150, "config": "C"}
        assert client.post("/v1/runs", json=body, headers=H).status_code == 201
        app.state.runs.get(31).thread.join(timeout=60)
        result = client.get("/v1/runs/31/result", headers=H).json()
        assert result["config"] == "C"
        assert result["plan"]["status"] in {"optimal", "feasible", "heuristic"}
        assert len(result["plan"]["trucks"]) == len(result["tankers"])
        t = result["tankers"][0]
        assert t["eta_p50"] <= t["eta_p80"] <= t["eta_p90"]
        bad = client.post("/v1/runs", json={"run_id": 32, "config": "Z"}, headers=H)
        assert bad.status_code == 422


def test_predictor_metrics_endpoint():
    with TestClient(app) as client:
        m = client.get("/v1/predictor/metrics", headers=H).json()
        assert "eta_delay" in m and "lab_duration" in m
