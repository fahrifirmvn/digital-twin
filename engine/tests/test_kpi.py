import json

import httpx
import pytest

from app.contracts.result import RunResult
from app.generator import generate_day
from app.kpi import build_result, evaluate, stat
from app.relay import Relay
from app.runs import RunManager
from app.sim import TwinSimulation

SCENARIOS = [(320, 1, 0), (450, 2, 0), (450, 5, 4), (320, 9, 6)]


def run(volume, seed, bad):
    return TwinSimulation(generate_day(seed, volume, extra_bad=bad), seed=seed).run()


def test_stat_nearest_rank():
    assert stat([]).n == 0
    s = stat([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
    assert (s.mean, s.p90, s.max) == (55.0, 90.0, 100.0)


@pytest.mark.parametrize(("volume", "seed", "bad"), SCENARIOS)
def test_kpi_invariants(volume, seed, bad):
    sim = run(volume, seed, bad)
    k = evaluate(sim)
    assert k.false_accept == 0
    assert k.holding_violations == 0
    assert k.trace_coverage_pct == 100.0
    assert k.trucks == len(sim.tankers)
    assert k.completed + k.held_g1 + k.rejected_g2 + k.held_qa == k.trucks
    assert k.truck_wait_min.mean >= 0 and k.lab_wait_min.mean >= 30
    assert all(0 <= v <= 100 for v in k.utilization_pct.values())
    assert set(k.utilization_pct) == {
        "bay", "degassing", "thermal", "separator", "sterilizer", "filling_line"
    }  # fmt: skip
    assert k.fg_ton <= k.raw_ton
    assert k.unscheduled_cip == sum(1 for c in sim.cips if not c.scheduled)


def test_failed_sterilization_triggers_emergency_cip():
    # Seed dipilih agar G5 gagal setidaknya sekali pada beban tinggi.
    found = [
        sim
        for sim in (run(450, s, 0) for s in range(1, 40))
        if any(g.gate == "G5" and g.decision == "hold" for g in sim.gate_log)
    ]
    assert found, "tidak ada seed dengan kegagalan G5"
    sim = found[0]
    emergency = [c for c in sim.cips if not c.scheduled]
    assert emergency and all(c.asset.startswith("STE-") for c in emergency)
    assert all(60 <= c.end - c.start <= 90 for c in emergency)
    assert evaluate(sim).unscheduled_cip == len(emergency)
    # Sterilizer tidak dipakai selama CIP darurat.
    for c in emergency:
        for t in sim.transfers:
            if t.to_asset == c.asset:
                assert not c.start < t.t < c.end


def test_result_is_valid_and_complete():
    sim = run(320, 3, 0)
    result = build_result(sim, {"volume_ton": 320, "extra_bad": 0}, 3)
    again = RunResult.model_validate_json(result.model_dump_json())
    assert len(again.events) == len(sim.events)
    assert len(again.transfers) == len(sim.transfers)
    assert {b.code for b in again.batches} == set(sim.batches)
    assert again.sim_end > again.sim_start


def test_result_is_posted_with_retry_and_token():
    received: list[dict] = []
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["X-Internal-Token"] == "tok"
        if request.url.path.endswith("/result"):
            calls["n"] += 1
            if calls["n"] == 1:
                return httpx.Response(503)
            received.append(json.loads(request.content))
        return httpx.Response(204)

    relay = Relay(
        "http://web/internal/twin-events",
        "tok",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
        result_url="http://web/internal/runs/{run_id}/result",
        retry_delay=0.01,
    )
    runs = RunManager(relay)
    r = runs.start(run_id=42, seed=1, volume_ton=320)
    r.thread.join(timeout=30)
    relay.close()

    assert r.delivered and calls["n"] == 2
    assert received[0]["run_id"] == 42 and received[0]["status"] == "finished"
    assert received[0]["kpi"]["false_accept"] == 0
