import threading
import time
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.live import LiveEnvironment
from app.main import app
from app.runs import Run, RunManager
from app.sim import TwinSimulation


@pytest.fixture
def live():
    env = LiveEnvironment(60)
    sim = TwinSimulation([], env=env, day=1)
    run = Run(1, 1, 100, live=True, sim=sim, speed=60)
    manager = RunManager()
    errors = []

    def execute():
        try:
            sim.run()
        except RuntimeError as exc:
            errors.append(str(exc))

    env.process(manager._heartbeat(run))
    thread = threading.Thread(target=execute)
    thread.start()
    yield manager, run, sim, env
    env.close()
    thread.join(2)
    assert not thread.is_alive()


def command(**over):
    return {
        "request_id": str(uuid4()),
        "asset": "TK-RAW-1",
        "start_min": None,
        "duration_min": 15,
        "actor": "PPIC",
        "reason": "Servis langsung",
        **over,
    }


def wait_for(predicate, seconds=3):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        if predicate():
            return
        time.sleep(0.01)
    pytest.fail("Live Engine did not reach expected state")


def test_live_command_uses_engine_time_and_is_idempotent(live):
    manager, run, sim, env = live
    body = command()
    receipt = manager.control(run, "maintenance", body)
    assert receipt["start_min"] >= 0
    assert manager.control(run, "maintenance", body) == receipt
    assert len(run.commands) == 1
    with pytest.raises(ValueError, match="isi berbeda"):
        manager.control(run, "maintenance", {**body, "duration_min": 30})
    wait_for(
        lambda: any(
            e.payload.type == "maintenance.status" and e.payload.status == "completed"
            for e in sim.events
        )
    )
    states = [e.payload.status for e in sim.events if e.payload.type == "maintenance.status"]
    assert states == ["waiting_safe", "maintenance", "completed"]
    assert len([e for e in sim.events if e.payload.type == "command.applied"]) == 1
    assert sim.raw.tanks[0].down is False
    assert manager.snapshot(run, sim.events[-1].seq)["events"] == []


def test_live_rejects_past_unknown_and_overlap_and_speed_never_rewinds(live):
    manager, run, sim, env = live
    wait_for(lambda: env.now >= 2)
    before = env.now
    with pytest.raises(ValueError, match="masa depan"):
        manager.control(run, "maintenance", command(start_min=0))
    with pytest.raises(ValueError, match="tidak ada"):
        manager.control(run, "maintenance", command(asset="TK-RAW-99"))
    manager.control(run, "maintenance", command(start_min=before + 30))
    with pytest.raises(ValueError, match="bertumpuk"):
        manager.control(run, "maintenance", command(start_min=before + 35))
    result = manager.control(run, "speed", {"speed": 20})
    assert result["minute"] >= before
    assert env.speed == 20
    run.status = "finished"
    with pytest.raises(ValueError, match="selesai"):
        manager.control(run, "maintenance", command(asset="TK-RAW-2"))


def test_busy_tank_blocks_new_work_and_gets_full_duration_after_draining():
    env = LiveEnvironment(600)
    sim = TwinSimulation([], env=env)
    tank = sim.raw.tanks[0]
    tank.status, tank.level_ton, tank.clean = "filling", 10, False

    def drain():
        yield env.timeout(10)
        tank.level_ton = 0
        tank.status, tank.clean = "idle", True
        sim.raw._notify()

    env.process(drain())
    env.process(sim.raw.maintain(tank.code, 0, 15, str(uuid4())))
    env.run(until=1)
    assert tank.down and tank.level_ton == 10
    env.run()
    states = [
        (e.payload.status, (e.sim_time - sim.day0).total_seconds() / 60)
        for e in sim.events
        if e.payload.type == "maintenance.status"
    ]
    assert states == [("waiting_safe", 0), ("maintenance", 10), ("completed", 25)]
    assert not tank.down and tank.clean


def test_closed_environment_explicitly_rejects_live_work():
    env = LiveEnvironment(1)
    env.close()
    with pytest.raises(ValueError, match="selesai"):
        env.submit(lambda: {})


def test_live_api_controls_same_run_and_rejects_invalid_or_past_commands():
    headers = {"X-Internal-Token": settings.internal_token}
    with TestClient(app) as client:
        response = client.post(
            "/v1/runs",
            headers=headers,
            json={
                "run_id": 931,
                "live": True,
                "speed": 60,
                "config": "A",
                "day": 1,
            },
        )
        assert response.status_code == 201
        run = app.state.runs.get(931)
        wait_for(lambda: run.sim is not None)
        before = client.get("/v1/runs/931/live", headers=headers).json()
        body = command()
        assert client.post("/v1/runs/931/maintenance", json=body).status_code == 401
        first = client.post("/v1/runs/931/maintenance", json=body, headers=headers)
        assert first.status_code == 200
        again = client.post("/v1/runs/931/maintenance", json=body, headers=headers)
        assert first.json() == again.json()
        speed = client.post("/v1/runs/931/speed", json={"speed": 20}, headers=headers)
        assert speed.status_code == 200 and speed.json()["minute"] >= before["minute"]
        assert (
            client.post("/v1/runs/931/speed", json={"speed": 0}, headers=headers).status_code == 422
        )
        past = command(asset="TK-RAW-2", start_min=0)
        assert (
            client.post("/v1/runs/931/maintenance", json=past, headers=headers).status_code == 409
        )
        cursor = client.get("/v1/runs/931/live?after=0", headers=headers).json()
        assert all(e["seq"] > 0 for e in cursor["events"])
        assert len(run.commands) == 1
