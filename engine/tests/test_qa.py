import threading
import time
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.api import LiveQaIn
from app.api import manager as api_manager
from app.config import settings
from app.generator import TankerSpec
from app.kpi import build_result
from app.live import LiveEnvironment
from app.main import app
from app.plant import Thresholds
from app.qa import assess
from app.runs import Run, RunManager
from app.sim import TwinSimulation

GOOD = dict(ph=6.7)


def wait_for(predicate):
    end = time.monotonic() + 3
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(0.005)
    pytest.fail("QA state was not reached")


@pytest.fixture
def live_qa():
    managers = []

    def create(results):
        env = LiveEnvironment(120)
        spec = TankerSpec("RT-001", "FRM-01", 20, 0, 0, 4, True, 1, results)
        sim = TwinSimulation([spec], env=env, day=3)
        run = Run(1, 1, 20, live=True, sim=sim)
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
        managers.append((env, thread))
        wait_for(lambda: "RT-001" in sim.qa_reviews)
        return manager, run, sim, env

    yield create
    for env, thread in managers:
        env.close()
        thread.join(2)
        assert not thread.is_alive()


def body(action, **over):
    return LiveQaIn(
        request_id=str(uuid4()),
        truck="RT-001",
        action=action,
        actor="QA: Analis",
        reason="Konfirmasi sampel tercatat",
        **over,
    ).model_dump()


def test_assessment_checks_only_ph_and_missing_is_incomplete():
    category, failures = assess({}, Thresholds())
    assert category == "incomplete" and len(failures) == 1
    category, failures = assess(
        {**GOOD, "fat_pct": 1, "ph": 5, "antibiotic_residue": True}, Thresholds()
    )
    assert category == "quality"
    assert {f.parameter for f in failures} == {"ph"}
    assert assess(GOOD, Thresholds()) == ("pass", [])
    assert assess({**GOOD, "antibiotic_residue": True, "fat_pct": 0}, Thresholds()) == ("pass", [])


def test_hold_confirm_release_same_run_with_original_results_and_no_override(live_qa):
    original = {**GOOD, "ph": 5.0}
    manager, run, sim, env = live_qa(original)
    assert sim.tankers["RT-001"].status == "qa_hold"
    assert not sim.batches
    with pytest.raises(ValueError, match="override"):
        manager.control(run, "qa", body("release"))
    command = body("retest", results=GOOD)
    receipt = manager.control(run, "qa", command)
    assert manager.control(run, "qa", command) == receipt
    wait_for(lambda: sim.qa_reviews["RT-001"].status == "confirmed")
    assert not sim.batches
    assert sim.tankers["RT-001"].spec.lab_results == original
    assert sim.tankers["RT-001"].status == "qa_hold"
    manager.control(run, "qa", body("release"))
    wait_for(lambda: sim.tankers["RT-001"].unload_start is not None)
    assert sim.qa_reviews["RT-001"].status == "released"
    states = [e.payload.status for e in sim.events if e.payload.type == "qa.review"]
    assert states == ["held", "testing", "confirmed", "released"]
    assert sim.day == 3 and sim.run_id == 1
    manager.control(run, "speed", {"speed": 12000})
    wait_for(lambda: sim.tankers["RT-001"].outcome == "completed")
    result = build_result(sim, {"volume_ton": 20}, 1)
    assert result.kpi.false_accept == 0
    assert result.tankers[0].lab_results == original
    assert any(e.payload.type == "qa.review" for e in result.events)


def test_ph_hold_can_be_rejected_with_disposition_and_retry_is_idempotent(live_qa):
    manager, run, sim, env = live_qa({"ph": 5})
    reject = body("reject", disposition="return_supplier")
    receipt = manager.control(run, "qa", reject)
    assert manager.control(run, "qa", reject) == receipt
    with pytest.raises(ValueError, match="isi berbeda"):
        manager.control(run, "qa", {**reject, "reason": "Alasan lain"})
    wait_for(lambda: sim.tankers["RT-001"].status == "rejected")
    assert not sim.batches
    assert sim.tankers["RT-001"].outcome == "rejected_g2"
    last = [e.payload for e in sim.events if e.payload.type == "qa.review"][-1]
    assert last.disposition == "return_supplier"


def test_failed_confirmation_cannot_be_repeated_until_pass(live_qa):
    manager, run, sim, env = live_qa({**GOOD, "ph": 5})
    manager.control(run, "qa", body("retest", results={**GOOD, "ph": 5.5}))
    wait_for(lambda: sim.qa_reviews["RT-001"].status == "held")
    with pytest.raises(ValueError, match="satu kali"):
        manager.control(run, "qa", body("retest", results=GOOD))
    with pytest.raises(ValueError, match="override"):
        manager.control(run, "qa", body("release"))
    assert not sim.batches


def test_unanswered_live_hold_expires_without_accepting_or_claiming_disposal(live_qa):
    manager, run, sim, env = live_qa({**GOOD, "ph": 5})
    manager.control(run, "speed", {"speed": 12000})
    wait_for(lambda: sim.tankers["RT-001"].status == "rejected")
    assert not sim.batches
    last = [e.payload for e in sim.events if e.payload.type == "qa.review"][-1]
    assert last.disposition == "unresolved_hold"
    assert last.actor == "system"


def test_offline_hold_has_explicit_unresolved_disposition_and_no_unloading():
    spec = TankerSpec("RT-001", "FRM-01", 20, 0, 0, 4, True, 1, {})
    sim = TwinSimulation([spec])
    sim.run()
    assert sim.tankers["RT-001"].status == "rejected"
    assert not sim.batches
    reviews = [e.payload for e in sim.events if e.payload.type == "qa.review"]
    assert [r.status for r in reviews] == ["held", "rejected"]
    assert reviews[-1].disposition == "unresolved_hold"
    initial = next(e.payload for e in sim.events if e.payload.type == "lab.result")
    assert initial.fat_pct is None and initial.ph is None
    assert initial.antibiotic_residue is None and initial.adulterant is None


def test_qa_api_auth_and_invalid_confirmation_are_explicit():
    with TestClient(app) as client:
        assert client.post("/v1/runs/99/qa", json={}).status_code == 401
        headers = {"X-Internal-Token": settings.internal_token}
        command = body("retest", results=GOOD)
        command["results"].pop("ph")
        assert client.post("/v1/runs/99/qa", headers=headers, json=command).status_code == 422
        for invalid in (None, True, -1, 15, "invalid"):
            command = body("retest", results=GOOD)
            command["results"]["ph"] = invalid
            assert client.post("/v1/runs/99/qa", headers=headers, json=command).status_code == 422
        for removed in (
            "fat_pct",
            "protein_pct",
            "acidity_pct",
            "antibiotic_residue",
            "adulterant",
        ):
            command = body("retest", results=GOOD)
            command["results"][removed] = 0
            assert client.post("/v1/runs/99/qa", headers=headers, json=command).status_code == 422
        assert (
            client.post("/v1/runs/99/qa", headers=headers, json=body("release")).status_code == 404
        )


def test_http_qa_command_updates_live_snapshot_and_never_forks(live_qa, monkeypatch):
    manager, run, sim, env = live_qa({**GOOD, "ph": 5})
    monkeypatch.setattr(manager, "get", lambda run_id: run if run_id == 1 else None)
    app.dependency_overrides[api_manager] = lambda: manager
    try:
        with TestClient(app) as client:
            headers = {"X-Internal-Token": settings.internal_token}
            assert (
                client.post("/v1/runs/1/qa", headers=headers, json=body("release")).status_code
                == 409
            )
            command = body("retest", results=GOOD)
            response = client.post("/v1/runs/1/qa", headers=headers, json=command)
            assert response.status_code == 200 and response.json()["status"] == "accepted"
            assert (
                client.post("/v1/runs/1/qa", headers=headers, json=command).json()
                == response.json()
            )
            wait_for(lambda: sim.qa_reviews["RT-001"].status == "confirmed")
            snapshot = client.get("/v1/runs/1/live", headers=headers).json()
            reviews = [
                e["payload"] for e in snapshot["events"] if e["payload"]["type"] == "qa.review"
            ]
            assert reviews[-1]["status"] == "confirmed"
            assert reviews[-1]["results"]["ph"] == 6.7
            assert (
                client.post("/v1/runs/1/qa", headers=headers, json=body("release")).status_code
                == 200
            )
            wait_for(lambda: sim.tankers["RT-001"].unload_start is not None)
            assert run.id == 1 and run.commands == ()
    finally:
        app.dependency_overrides.pop(api_manager, None)
