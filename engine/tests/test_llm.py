import json

import httpx
import pytest

from app.config import Settings
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
from app.llm.anthropic import AnthropicProvider
from app.llm.openai_compat import LocalProvider, OpenAIProvider

TOOL = ToolSpec(
    "get_state",
    "Baca status",
    {"type": "object", "properties": {"code": {"type": "string"}}, "required": ["code"]},
)
CONVERSATION = [
    Message("system", "Kamu copilot."),
    Message("user", "Status RT-001?"),
    Message(
        "assistant",
        "",
        (
            ToolCall("c1", "get_state", {"code": "RT-001"}),
            ToolCall("c2", "get_state", {"code": "RT-002"}),
        ),
    ),
    Message("tool", '{"status":"queued"}', tool_call_id="c1"),
    Message("tool", '{"status":"lab"}', tool_call_id="c2"),
]


def client(handler, seen: list | None = None) -> httpx.Client:
    def wrapped(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        return handler(request)

    return httpx.Client(transport=httpx.MockTransport(wrapped))


def openai_reply(message: dict, finish: str = "stop") -> dict:
    return {
        "model": "m",
        "choices": [{"message": message, "finish_reason": finish}],
        "usage": {"prompt_tokens": 7, "completion_tokens": 3},
    }


def test_openai_request_and_tool_call_response():
    seen: list[httpx.Request] = []
    reply = openai_reply(
        {
            "content": None,
            "tool_calls": [
                {
                    "id": "x1",
                    "type": "function",
                    "function": {"name": "get_state", "arguments": '{"code": "RT-009"}'},
                }
            ],
        },
        "tool_calls",
    )
    p = OpenAIProvider(
        "https://api.example/v1/",
        "sk-secret",
        "gpt-x",
        client=client(lambda r: httpx.Response(200, json=reply), seen),
    )

    res = p.chat(CONVERSATION, (TOOL,))

    req = seen[0]
    body = json.loads(req.content)
    assert str(req.url) == "https://api.example/v1/chat/completions"
    assert req.headers["Authorization"] == "Bearer sk-secret"
    assert (
        body["max_completion_tokens"] == 1024
        and "max_tokens" not in body
        and "temperature" not in body
    )
    assert body["tools"][0]["function"]["parameters"] == TOOL.parameters
    assert body["messages"][2]["tool_calls"][0]["function"]["arguments"] == '{"code": "RT-001"}'
    assert body["messages"][3] == {
        "role": "tool",
        "tool_call_id": "c1",
        "content": '{"status":"queued"}',
    }
    assert res.tool_calls == (ToolCall("x1", "get_state", {"code": "RT-009"}),)
    assert res.stop_reason == "tool_calls" and res.usage.input_tokens == 7 and res.text == ""


def test_local_router_without_key_uses_max_tokens_and_tolerates_quirks():
    seen: list[httpx.Request] = []
    reply = openai_reply(
        {
            "content": [{"type": "text", "text": "ha"}, {"type": "text", "text": "lo"}],
            "tool_calls": [{"function": {"name": "get_state", "arguments": {"code": "A"}}}],
        }
    )
    p = LocalProvider(
        "http://localhost:11434/v1",
        "",
        "llama",
        temperature=0.0,
        client=client(lambda r: httpx.Response(200, json=reply), seen),
    )

    res = p.chat([Message("user", "hai")])

    body = json.loads(seen[0].content)
    assert "authorization" not in seen[0].headers
    assert body["max_tokens"] == 1024 and body["temperature"] == 0.0 and "tools" not in body
    assert res.text == "halo" and res.tool_calls == (
        ToolCall("call_0", "get_state", {"code": "A"}),
    )


def test_openai_rejects_malformed_responses():
    bad_args = openai_reply(
        {
            "content": "",
            "tool_calls": [{"id": "1", "function": {"name": "t", "arguments": "{oops"}}],
        }
    )
    for payload in (bad_args, {"choices": []}, {"unexpected": 1}):
        p = LocalProvider(
            "http://x/v1", "", "m", client=client(lambda r, d=payload: httpx.Response(200, json=d))
        )
        with pytest.raises(LLMProtocolError):
            p.chat([Message("user", "hai")])
    p = LocalProvider(
        "http://x/v1", "", "m", client=client(lambda r: httpx.Response(200, text="<html>"))
    )
    with pytest.raises(LLMProtocolError):
        p.chat([Message("user", "hai")])


def test_anthropic_request_and_response():
    seen: list[httpx.Request] = []
    reply = {
        "model": "claude-x",
        "stop_reason": "tool_use",
        "content": [
            {"type": "text", "text": "Saya cek."},
            {"type": "tool_use", "id": "tu1", "name": "get_state", "input": {"code": "RT-001"}},
        ],
        "usage": {"input_tokens": 11, "output_tokens": 5},
    }
    p = AnthropicProvider(
        "https://api.anthropic.com",
        "ak-secret",
        "claude-x",
        max_tokens=300,
        client=client(lambda r: httpx.Response(200, json=reply), seen),
    )

    res = p.chat(CONVERSATION, (TOOL,))

    req = seen[0]
    body = json.loads(req.content)
    assert str(req.url) == "https://api.anthropic.com/v1/messages"
    assert (
        req.headers["x-api-key"] == "ak-secret" and req.headers["anthropic-version"] == "2023-06-01"
    )
    assert body["system"] == "Kamu copilot." and body["max_tokens"] == 300
    assert body["tools"][0]["input_schema"] == TOOL.parameters
    roles = [m["role"] for m in body["messages"]]
    assert roles == ["user", "assistant", "user"]  # hasil tool beruntun digabung
    assert [b["type"] for b in body["messages"][1]["content"]] == ["tool_use", "tool_use"]
    assert [b["tool_use_id"] for b in body["messages"][2]["content"]] == ["c1", "c2"]
    assert res.text == "Saya cek." and res.tool_calls == (
        ToolCall("tu1", "get_state", {"code": "RT-001"}),
    )
    assert res.stop_reason == "tool_calls" and res.usage.output_tokens == 5


def test_anthropic_router_base_url_ending_in_v1():
    seen: list[httpx.Request] = []
    reply = {"content": [{"type": "text", "text": "ok"}], "stop_reason": "max_tokens"}
    p = AnthropicProvider(
        "http://router:4000/v1",
        "k",
        "m",
        client=client(lambda r: httpx.Response(200, json=reply), seen),
    )
    res = p.chat([Message("user", "hai")])
    assert str(seen[0].url) == "http://router:4000/v1/messages" and res.stop_reason == "length"


def test_retries_transient_errors_but_not_client_errors_and_never_leaks_key():
    attempts = {"n": 0}

    def flaky(request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        return (
            httpx.Response(503, text="busy")
            if attempts["n"] < 3
            else httpx.Response(200, json=openai_reply({"content": "ok"}))
        )

    p = LocalProvider("http://x/v1", "sk-secret", "m", backoff=0, client=client(flaky))
    assert p.chat([Message("user", "hai")]).text == "ok" and attempts["n"] == 3

    attempts["n"] = 0
    p = LocalProvider(
        "http://x/v1",
        "sk-secret",
        "m",
        backoff=0,
        client=client(lambda r: httpx.Response(401, text="no")),
    )
    with pytest.raises(LLMRequestError) as e:
        p.chat([Message("user", "hai")])
    assert e.value.status == 401 and "sk-secret" not in str(e.value)

    def down(request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        raise httpx.ConnectError("boom sk-secret")

    p = LocalProvider("http://x/v1", "sk-secret", "m", retries=1, backoff=0, client=client(down))
    with pytest.raises(LLMRequestError) as e:
        p.chat([Message("user", "hai")])
    assert attempts["n"] == 2 and "sk-secret" not in str(e.value)


def cfg(**kw) -> Settings:
    return Settings(_env_file=None, **kw)


def test_factory_builds_each_provider_and_validates_config():
    assert isinstance(build_provider(cfg(llm_provider="mock")), MockProvider)
    assert isinstance(
        build_provider(cfg(llm_provider="openai", llm_api_key="k", llm_model="m")), OpenAIProvider
    )
    a = build_provider(cfg(llm_provider="anthropic", llm_api_key="k", llm_model="m"))
    assert isinstance(a, AnthropicProvider) and a.base_url == "https://api.anthropic.com"
    local = build_provider(
        cfg(llm_provider="local", llm_base_url="http://localhost:11434/v1", llm_model="llama")
    )
    assert isinstance(local, LocalProvider) and local.api_key == ""

    for bad in (
        cfg(llm_provider="openai", llm_model="m"),  # tanpa kunci
        cfg(llm_provider="anthropic", llm_api_key="k"),  # tanpa model
        cfg(llm_provider="local", llm_model="m"),  # tanpa base url
    ):
        with pytest.raises(LLMConfigError):
            build_provider(bad)
    assert "rahasia" not in repr(cfg(llm_api_key="rahasia"))


def test_mock_provider_scripts_and_echo():
    script = [LLMResponse("satu", (ToolCall("a", "get_state", {}),), "tool_calls")]
    m = MockProvider(script)
    assert m.chat([Message("user", "x")], (TOOL,)).tool_calls[0].name == "get_state"
    assert m.chat([Message("user", "halo")]).text == "[mock] halo"
    assert len(m.calls) == 2


def test_gemini_thinking_budget_defaults_to_zero_for_flash_only():
    flash = build_provider(cfg(llm_provider="gemini", llm_api_key="k"))
    pro = build_provider(cfg(llm_provider="gemini", llm_api_key="k", llm_model="gemini-2.5-pro"))
    custom = build_provider(cfg(llm_provider="gemini", llm_api_key="k", llm_thinking_budget=256))
    assert (flash.thinking_budget, pro.thinking_budget, custom.thinking_budget) == (0, None, 256)

    seen: list[httpx.Request] = []
    body = {"candidates": [{"content": {"parts": [{"text": "hai"}]}}]}
    flash.client = client(lambda r: httpx.Response(200, json=body), seen)
    flash.chat([Message("user", "hai")])
    sent = json.loads(seen[0].content)["generationConfig"]
    assert sent["thinkingConfig"] == {"thinkingBudget": 0}
    pro.client = client(lambda r: httpx.Response(200, json=body), seen)
    pro.chat([Message("user", "hai")])
    assert "thinkingConfig" not in json.loads(seen[1].content)["generationConfig"]
