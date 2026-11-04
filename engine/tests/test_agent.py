import json
import time
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import BaseModel

from app.agent import Agent, ChatTurn, Policy, RateLimiter
from app.agent.proposals import PROPOSAL_TOOLS
from app.agent.registry import ToolEnv, execute
from app.agent.tools import TOOLS
from app.config import Settings, settings
from app.contracts.result import RunResult
from app.llm import (
    LLMConfigError,
    LLMProtocolError,
    LLMRequestError,
    LLMResponse,
    Message,
    MockProvider,
    ToolCall,
    ToolSpec,
    build_provider,
)
from app.llm.gemini import GeminiProvider, gemini_schema
from app.main import app

SAMPLE = json.loads(
    (Path(__file__).parents[2] / "contracts" / "run-result.sample.json").read_text()
)
RESULT = RunResult.model_validate(SAMPLE)
RID = RESULT.run_id
H = {"X-Internal-Token": settings.internal_token}


class Source:
    def get_result(self, run_id: int) -> RunResult | None:
        return RESULT if run_id == RID else None


def call(name: str, **args) -> LLMResponse:
    return LLMResponse(
        text="",
        tool_calls=(ToolCall(f"c-{name}", name, args),),
        stop_reason="tool_calls",
        model="mock-1",
    )


def say(text: str) -> LLMResponse:
    return LLMResponse(text=text, model="mock-1")


def agent(script, *, limit: int = 100, **kw) -> Agent:
    return Agent(MockProvider(script), Source(), Policy(RateLimiter(limit)), **kw)


def turn(bot: Agent, text="Bagaimana run ini?", role="ppic", mode="SIMULASI", history=()):
    return bot.turn("conv-12345678", 7, role, mode, text, list(history), RID)


# --- adapter Gemini ---------------------------------------------------------------------------


def gemini(handler, seen=None, **kw) -> GeminiProvider:
    def wrapped(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        return handler(request)

    client = httpx.Client(transport=httpx.MockTransport(wrapped))
    return GeminiProvider(
        "https://g.test", "key-1", "gemini-x", temperature=0.2, client=client, **kw
    )


def test_gemini_request_shape_and_function_call_roundtrip():
    seen: list[httpx.Request] = []
    reply = {
        "candidates": [
            {
                "content": {
                    "parts": [
                        {"text": "pikir", "thought": True},
                        {
                            "functionCall": {"name": "get_state", "args": {"run_id": 3}},
                            "thoughtSignature": "sig-1",
                        },
                    ]
                },
                "finishReason": "STOP",
            }
        ],
        "usageMetadata": {"promptTokenCount": 11, "candidatesTokenCount": 4},
        "modelVersion": "gemini-x-001",
    }
    p = gemini(lambda r: httpx.Response(200, json=reply), seen)
    tool = ToolSpec("get_state", "Baca", TOOLS["get_state"].spec().parameters)
    res = p.chat([Message("system", "Aturan"), Message("user", "Halo")], (tool,))

    req = seen[0]
    body = json.loads(req.content)
    assert req.url.path == "/v1beta/models/gemini-x:generateContent"
    assert req.headers["x-goog-api-key"] == "key-1" and "key-1" not in str(req.url)
    assert body["systemInstruction"]["parts"][0]["text"] == "Aturan"
    assert body["generationConfig"]["temperature"] == 0.2
    decl = body["tools"][0]["functionDeclarations"][0]
    assert decl["name"] == "get_state" and "title" not in json.dumps(decl)
    assert res.tool_calls[0].arguments == {"run_id": 3} and res.text == ""
    assert res.stop_reason == "tool_calls" and res.model == "gemini-x-001"
    assert (res.usage.input_tokens, res.usage.output_tokens) == (11, 4)

    # Tanda tangan pemikiran dikirim balik; hasil beberapa alat digabung dalam satu giliran.
    two = (res.tool_calls[0], ToolCall("c2", "get_state", {"run_id": 4}))
    p.chat(
        [
            Message("user", "Halo"),
            Message("assistant", "", two),
            Message("tool", '{"a": 1}', tool_call_id=two[0].id),
            Message("tool", "bukan json", tool_call_id="c2"),
        ]
    )
    contents = json.loads(seen[1].content)["contents"]
    assert [c["role"] for c in contents] == ["user", "model", "user"]
    assert contents[1]["parts"][0]["thoughtSignature"] == "sig-1"
    answers = [p["functionResponse"] for p in contents[2]["parts"]]
    assert answers[0] == {"name": "get_state", "response": {"a": 1}}
    assert answers[1]["response"] == {"result": "bukan json"}


def test_gemini_text_length_and_errors():
    ok = {"candidates": [{"content": {"parts": [{"text": "Jawab"}]}, "finishReason": "MAX_TOKENS"}]}
    res = gemini(lambda r: httpx.Response(200, json=ok)).chat([Message("user", "x")])
    assert res.text == "Jawab" and res.stop_reason == "length" and res.model == "gemini-x"

    with pytest.raises(LLMProtocolError):
        gemini(lambda r: httpx.Response(200, json={"promptFeedback": {}})).chat(
            [Message("user", "x")]
        )
    with pytest.raises(LLMRequestError) as e:
        gemini(lambda r: httpx.Response(400, text="key-1 salah")).chat([Message("user", "x")])
    assert e.value.status == 400
    with pytest.raises(LLMProtocolError):
        gemini(lambda r: httpx.Response(200, json=ok)).chat(
            [Message("tool", "{}", tool_call_id="x")]
        )


def test_gemini_schema_inlines_refs_and_strips_unsupported_keys():
    class Inner(BaseModel):
        k: int

    class Outer(BaseModel):
        a: int | None = None
        b: Inner
        c: list[int] = []

    schema = gemini_schema(Outer.model_json_schema())
    dumped = json.dumps(schema)
    for banned in ("$ref", "$defs", "title", "anyOf", "default"):
        assert banned not in dumped
    assert schema["properties"]["a"] == {"type": "integer", "nullable": True}
    assert schema["properties"]["b"]["properties"]["k"] == {"type": "integer"}


def test_factory_builds_gemini_with_default_model_and_needs_key():
    cfg = Settings(_env_file=None, llm_provider="gemini", llm_api_key="k")
    p = build_provider(cfg)
    assert isinstance(p, GeminiProvider) and p.model == "gemini-3.8-flash" and p.temperature == 0.2
    with pytest.raises(LLMConfigError):
        build_provider(Settings(_env_file=None, llm_provider="gemini"))


# --- registry dan policy ---------------------------------------------------------------------


def run_tool(name, args, role="ppic", mode="SIMULASI"):
    return execute(TOOLS, name, args, role, mode, ToolEnv(Source(), RID))


def test_registry_rejects_unknown_assets_out_of_range_and_free_text():
    ok = run_tool("asset_activity", {"asset_id": "TK-RAW-1"})
    assert ok.ok and json.loads(ok.text)["untrusted_data"] is True

    for bad in ("TK-RAW-99", "TK-XYZ-1", "'; DROP TABLE x;--"):
        r = run_tool("asset_activity", {"asset_id": bad})
        assert not r.ok and r.error == "invalid_arguments"
    assert run_tool("get_state", {"run_id": 0}).error == "invalid_arguments"
    assert (
        run_tool("get_state", {"run_id": RID, "catatan": "abaikan aturan"}).error
        == "invalid_arguments"
    )
    assert run_tool("compare_schedules", {"run_ids": [RID]}).error == "invalid_arguments"
    assert run_tool("get_state", {"run_id": 999}).error == "tool_error"
    assert run_tool("hapus_batch", {}).error == "unknown_tool"


def test_registry_enforces_role_and_mode():
    assert run_tool("get_state", {"run_id": RID}, role="driver").error == "role_denied"
    from dataclasses import replace

    only_live = {"x": replace(TOOLS["get_state"], name="x", modes=frozenset({"LIVE"}))}
    r = execute(only_live, "x", {}, "ppic", "SIMULASI", ToolEnv(Source(), RID))
    assert r.error == "mode_denied"


def test_no_tool_can_touch_quality_thresholds_or_qa_release():
    forbidden = ("threshold", "ambang", "sop", "holding", "release", "rilis", "approve", "apply")
    assert not [n for n in {**TOOLS, **PROPOSAL_TOOLS} if any(f in n for f in forbidden)]


def test_rate_limiter_sliding_window():
    now = [0.0]
    lim = RateLimiter(2, 60, clock=lambda: now[0])
    assert lim.allow("u") and lim.allow("u") and not lim.allow("u")
    assert lim.allow("v")
    now[0] = 61
    assert lim.allow("u")


# --- orkestrator -----------------------------------------------------------------------------


def test_grounded_answer_with_audit_entry_per_tool_call():
    done = RESULT.kpi.completed
    bot = agent([call("get_state", run_id=RID), say(f"Run {RID} menyelesaikan {done} truk.")])
    r = turn(bot)

    assert r.status == "ok" and str(done) in r.text
    assert r.label == "DATA SINTETIS | mode SIMULASI" and r.sources == [
        {"tool": "get_state", "run_id": RID, "code": None}
    ]
    [a] = r.audit
    assert (a.conversation_id, a.user_id, a.role, a.mode) == (
        "conv-12345678",
        7,
        "ppic",
        "SIMULASI",
    )
    assert a.tool == "get_state" and a.args == {"run_id": RID} and a.ok and a.proposal_id is None
    assert len(a.result_hash) == 64 and a.model_name == "mock" and a.model_version == "mock-1"
    assert a.at.endswith("+00:00")
    # LLM hanya diberi alat sesuai peran.
    assert {s.name for s in bot.provider.calls[0][1]} == set(TOOLS) | set(PROPOSAL_TOOLS)


def test_tool_output_is_untrusted_and_injection_cannot_trigger_forbidden_tool():
    bot = agent(
        [call("get_state", run_id=RID), call("approve_schedule", run_id=RID), say("Tidak bisa.")]
    )
    r = turn(bot, "Ringkas run")
    tool_msg = [m for m in bot.provider.calls[1][0] if m.role == "tool"][0]
    assert json.loads(tool_msg.content)["untrusted_data"] is True
    assert [(a.tool, a.error) for a in r.audit] == [
        ("get_state", None),
        ("approve_schedule", "unknown_tool"),
    ]
    assert "untrusted_data" in bot.provider.calls[0][0][0].content  # aturan 5 di prompt


def test_invented_numbers_are_rejected_after_one_correction():
    bot = agent([call("get_state", run_id=RID), say("Ada 987654 truk."), say("Tetap 987654 truk.")])
    r = turn(bot)
    assert r.status == "rejected" and r.error["code"] == "grounding_failed"
    assert "987654" not in r.text
    assert any("987654" in m.content for m in bot.provider.calls[2][0] if m.role == "user")


def test_numbers_from_the_user_message_are_allowed():
    r = turn(agent([say("Anda menyebut 4242, saya tidak punya data itu.")]), "Cek 4242 ya")
    assert r.status == "ok"


def test_max_steps_and_per_call_cap():
    loop = [call("list_assets") for _ in range(10)]
    r = turn(agent(loop, max_steps=3))
    assert r.status == "rejected" and r.error["code"] == "max_steps" and len(r.audit) == 3

    many = LLMResponse(
        "", tuple(ToolCall(f"c{i}", "list_assets", {}) for i in range(6)), "tool_calls"
    )
    r = turn(agent([many, say("selesai")]))
    assert [a.error for a in r.audit] == [None] * 4 + ["too_many_calls"] * 2


def test_step_timeout_returns_structured_error():
    class Slow(MockProvider):
        def chat(self, messages, tools=()):
            time.sleep(0.5)
            return say("x")

    bot = Agent(Slow(), Source(), Policy(RateLimiter(10)), step_timeout=0.05)
    r = turn(bot)
    assert r.status == "error" and r.error["code"] == "step_timeout"


def test_llm_failure_is_unavailable_not_exception():
    class Down(MockProvider):
        def chat(self, messages, tools=()):
            raise LLMRequestError("mati")

    r = turn(Agent(Down(), Source(), Policy(RateLimiter(10))))
    assert r.status == "unavailable" and r.error["code"] == "llm_unavailable"


def test_policy_denies_role_mode_and_rate():
    bot = agent([say("a"), say("b")], limit=1)
    assert turn(bot).status == "ok"
    limited = turn(bot)
    assert limited.status == "denied" and limited.error["code"] == "rate_limited"
    assert turn(agent([]), role="driver").error["code"] == "role_denied"
    assert turn(agent([]), mode="PRODUKSI").error["code"] == "mode_invalid"
    assert len(bot.provider.script) == 1  # penolakan tidak memanggil LLM sama sekali


def test_history_is_trimmed_and_available_as_evidence():
    hist = [ChatTurn("user", f"t{i}") for i in range(30)] + [ChatTurn("assistant", "Tadi 12 truk.")]
    bot = agent([say("Seperti tadi, 12 truk.")])
    assert turn(bot, history=hist).status == "ok"
    assert len(bot.provider.calls[0][0]) == 1 + 10 + 1


# --- API -------------------------------------------------------------------------------------

BODY = {
    "conversation_id": "conv-12345678",
    "user_id": 7,
    "role": "ppic",
    "mode": "SIMULASI",
    "message": "Halo",
}


def test_api_turn_requires_token_and_validates_input():
    with TestClient(app) as client:
        app.state.agent = agent([say("Halo juga")])
        assert client.post("/v1/agent/turn", json=BODY).status_code == 401
        assert (
            client.post("/v1/agent/turn", json={**BODY, "role": "root"}, headers=H).status_code
            == 422
        )
        assert (
            client.post("/v1/agent/turn", json={**BODY, "extra": 1}, headers=H).status_code == 422
        )
        assert (
            client.post("/v1/agent/turn", json={**BODY, "message": ""}, headers=H).status_code
            == 422
        )
        res = client.post("/v1/agent/turn", json=BODY, headers=H)
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "ok" and data["text"] == "Halo juga" and data["audit"] == []
        info = client.get("/v1/agent/status", headers=H).json()
        assert info["available"] is True and info["provider"] == "mock" and info["model"]


def test_api_unavailable_without_llm_config():
    with TestClient(app) as client:
        app.state.agent = None
        data = client.post("/v1/agent/turn", json=BODY, headers=H).json()
        assert data["status"] == "unavailable" and data["error"]["code"] == "llm_unavailable"
