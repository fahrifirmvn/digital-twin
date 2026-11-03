import json

import pytest

from app.contracts.result import RunResult
from app.copilot import ChatTurn, Copilot
from app.copilot.guard import unsupported_numbers
from app.copilot.tools import TOOLS, ToolEnv, ToolError, tools_for
from app.experiment import simulate
from app.kpi import build_result
from app.llm import LLMRequestError, LLMResponse, Message, MockProvider, ToolCall
from app.ml.service import build_ai
from app.predictor import get_predictor


def make_result(run_id: int, config: str, seed: int = 1) -> RunResult:
    sim, plan = simulate(config, seed, 320.0, 0, run_id=run_id, time_limit=3.0)
    sim.run()
    specs = [r.spec for r in sim.tankers.values() if r.spec.announced]
    delay = get_predictor().forecast("eta_delay", specs)
    return build_result(
        sim,
        {"volume_ton": 320.0, "extra_bad": 0},
        seed,
        config=config,
        plan=plan,
        eta_forecast={s.code: f for s, f in zip(specs, delay, strict=True)},
        ai=build_ai(sim),
    )


@pytest.fixture(scope="module")
def results() -> dict[int, RunResult]:
    return {1: make_result(1, "A"), 2: make_result(2, "C")}


class Source:
    def __init__(self, results):
        self.results = results

    def get_result(self, run_id):
        return self.results.get(run_id)


@pytest.fixture
def source(results):
    return Source(results)


def call(name, **args):
    return ToolCall(f"id-{name}", name, args)


def tool_turn(*calls):
    return LLMResponse("", tuple(calls), "tool_calls")


def answer(text):
    return LLMResponse(text, (), "stop")


def ask(source, script, role="ppic", run_id=1, text="tolong"):
    bot = Copilot(MockProvider(script), source)
    return bot, bot.chat(text, [], role, run_id)


def test_roles_decide_which_tools_exist():
    names = lambda role: {t.name for t in tools_for(role)}  # noqa: E731
    assert names("ppic") == set(TOOLS)
    assert names("admin") == {
        "get_state",
        "compare_schedules",
        "explain",
        "trace_batch",
        "predict_truck",
        "anomaly_status",
        "run_scenario",
    }
    assert names("qa") == {
        "get_state",
        "compare_schedules",
        "explain",
        "trace_batch",
        "predict_truck",
        "anomaly_status",
    }
    assert names("driver") == set()
    # Tidak ada alat untuk keputusan QA, ambang, SOP atau holding time.
    assert not {
        n for n in TOOLS if any(w in n for w in ("release", "threshold", "gate", "sop", "holding"))
    }


def test_answer_with_tool_numbers_is_accepted_with_sources(source, results):
    mean = results[1].kpi.truck_wait_min.mean
    bot, reply = ask(
        source,
        [tool_turn(call("get_state")), answer(f"Rata-rata tunggu truk run 1 adalah {mean} menit.")],
    )
    assert reply.status == "ok" and str(mean) in reply.text
    assert reply.sources == [{"tool": "get_state", "run_id": 1, "code": None}]
    assert reply.tool_trace[0]["ok"] is True
    # Hasil alat sampai ke LLM pada giliran kedua.
    last = bot.provider.calls[1][0][-1]
    assert last.role == "tool" and json.loads(last.content)["run_id"] == 1


def test_unsourced_number_is_corrected_once_then_rejected(source):
    _, reply = ask(source, [answer("Tunggu truk 99.9 menit.")] * 2)
    assert reply.status == "rejected" and "99.9" not in reply.text

    _, reply = ask(
        source, [answer("Tunggu truk 99.9 menit."), answer("Saya belum punya angkanya.")]
    )
    assert reply.status == "ok" and reply.text == "Saya belum punya angkanya."


def test_user_numbers_and_list_markers_and_rounding_pass(results):
    kpi = '{"v": 45.346}'
    assert unsupported_numbers("1. Naik 450 ton\n2. Nilai 45,3 dan 45", ["450", kpi]) == []
    assert unsupported_numbers("Nilai 46", [kpi]) == [46.0]


def test_tool_arguments_are_validated_and_roles_enforced(source):
    bad = call("run_scenario", config="Z", threshold_ph=7)
    _, reply = ask(source, [tool_turn(bad), answer("Tidak bisa.")])
    assert reply.tool_trace[0]["ok"] is False and "tidak valid" in reply.tool_trace[0]["error"]
    assert reply.proposals == []

    _, reply = ask(
        source, [tool_turn(call("solve_schedule", config="C")), answer("Ditolak.")], role="admin"
    )
    assert reply.tool_trace[0]["denied"] is True and reply.proposals == []

    _, reply = ask(
        source, [tool_turn(call("release_batch", code="X")), answer("Tidak ada alatnya.")]
    )
    assert reply.tool_trace[0]["ok"] is False and reply.proposals == []


def test_proposals_are_not_executed_and_carry_diff(source):
    script = [
        tool_turn(call("run_scenario", config="D", scenario="peak_450", volume_ton=450)),
        answer("Usulan run D skenario peak_450 menunggu persetujuan."),
    ]
    _, reply = ask(source, script)
    (p,) = reply.proposals
    assert p["kind"] == "run" and p["params"]["config"] == "D" and p["params"]["volume_ton"] == 450
    assert p["diff"]["config"] == {"dari": "A", "menjadi": "D"}
    assert reply.tool_trace[0]["ok"] is True


def test_solve_and_propose_plan(source, results):
    _, reply = ask(
        source, [tool_turn(call("solve_schedule", config="D")), answer("Usulan siap.")], run_id=1
    )
    p = reply.proposals[0]
    assert (
        p["base_run_id"] == 1
        and p["params"]["seed"] == results[1].seed
        and p["params"]["config"] == "D"
    )

    _, reply = ask(
        source,
        [
            tool_turn(call("propose_plan", version=1, rationale="Adherence lebih baik")),
            answer("Usulan."),
        ],
        run_id=2,
    )
    assert reply.proposals[0] == {
        "kind": "approve_plan",
        "tool": "propose_plan",
        "run_id": 2,
        "version": 1,
        "rationale": "Adherence lebih baik",
    }

    for run_id, version in ((1, 1), (2, 99)):  # tanpa rencana / versi tidak ada
        _, reply = ask(
            source,
            [
                tool_turn(call("propose_plan", version=version, rationale="alasan cukup panjang")),
                answer("Gagal."),
            ],
            run_id=run_id,
        )
        assert reply.proposals == [] and reply.tool_trace[0]["ok"] is False


def test_compare_precomputes_delta_and_best(source, results):
    env = ToolEnv(source, 1)
    out = TOOLS["compare_schedules"].handler(env, TOOLS["compare_schedules"].args(run_ids=[1, 2]))
    assert out["same_day"] is True and out["baseline_run_id"] == 1
    a, c = results[1].kpi, results[2].kpi
    assert (
        out["delta_vs_baseline"]["changeover_count"][2] == c.changeover_count - a.changeover_count
    )


def test_explain_truck_and_trace(source, results):
    env = ToolEnv(source, 2)
    r = results[2]
    code = r.tankers[0].code
    out = TOOLS["explain"].handler(env, TOOLS["explain"].args(kind="truck", code=code))
    assert out["truck"]["code"] == code and out["plan"] is not None
    holds = TOOLS["explain"].handler(env, TOOLS["explain"].args(kind="holds"))
    assert holds["total"] == sum(1 for g in r.gates if g.decision != "pass")

    fg = next(b for b in r.batches if b.type == "fg")
    tr = TOOLS["trace_batch"].handler(env, TOOLS["trace_batch"].args(batch_code=fg.code))
    assert tr["batch"]["code"] == fg.code and tr["tankers"] and tr["upstream"]
    assert {t["code"] for t in tr["tankers"]} <= {t.code for t in r.tankers}


def test_ai_tools_read_prediction_and_cite(source, results):
    env = ToolEnv(source, run_id=1)
    code = results[1].tankers[0].code
    t = TOOLS["predict_truck"].handler(env, TOOLS["predict_truck"].args(code=code))
    assert t["code"] == code and t["label"] == "DATA SINTETIS" and 0 <= t["qc_release_prob"] <= 1
    an = TOOLS["anomaly_status"].handler(env, TOOLS["anomaly_status"].args())
    assert "risk_score" in an and an["label"] == "DATA SINTETIS"
    assert {c["tool"] for c in env.cited} == {"predict_truck", "anomaly_status"}
    with pytest.raises(ToolError):
        TOOLS["predict_truck"].handler(env, TOOLS["predict_truck"].args(code="XX"))


def test_missing_run_and_provider_failure_fall_back(source):
    _, reply = ask(
        source, [tool_turn(call("get_state", run_id=404)), answer("Run tidak ditemukan.")]
    )
    assert reply.tool_trace[0]["ok"] is False and reply.status == "ok"

    class Down:
        name = "down"

        def chat(self, messages, tools=()):
            raise LLMRequestError("boom", 503)

    reply = Copilot(Down(), source).chat("halo", [ChatTurn("user", "a")], "ppic", 1)
    assert reply.status == "unavailable" and "Panel Skenario" in reply.text


def test_history_is_bounded_and_system_prompt_pins_rules(source):
    history = [ChatTurn("user" if i % 2 == 0 else "assistant", f"t{i}") for i in range(30)]
    bot = Copilot(MockProvider(), source)
    bot.chat("halo", history, "qa", 1)
    sent: list[Message] = bot.provider.calls[0][0]
    assert sent[0].role == "system" and "tidak dapat meluluskan" in sent[0].content
    assert len(sent) == 1 + 10 + 1 and {m.role for m in sent[1:]} <= {"user", "assistant"}


def test_chat_endpoint_auth_validation_and_fallback():
    from fastapi.testclient import TestClient

    from app.config import settings
    from app.main import app

    h = {"X-Internal-Token": settings.internal_token}
    body = {"role": "ppic", "message": "halo 12", "run_id": 3}
    with TestClient(app) as client:
        assert client.post("/v1/copilot/chat", json=body).status_code == 401
        assert (
            client.post("/v1/copilot/chat", json={**body, "role": "root"}, headers=h).status_code
            == 422
        )
        assert (
            client.post(
                "/v1/copilot/chat", json={**body, "message": "x" * 1001}, headers=h
            ).status_code
            == 422
        )
        assert client.get("/v1/copilot/status", headers=h).json() == {
            "available": True,
            "provider": "mock",
        }
        ok = client.post("/v1/copilot/chat", json=body, headers=h).json()
        assert ok["status"] == "ok" and ok["text"] == "[mock] halo 12" and ok["provider"] == "mock"

        app.state.copilot = None
        down = client.post("/v1/copilot/chat", json=body, headers=h).json()
        assert down["status"] == "unavailable" and "Panel Skenario" in down["text"]
