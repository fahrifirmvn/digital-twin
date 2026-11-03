import json

from app.llm._http import HttpProvider
from app.llm.types import LLMProtocolError, LLMResponse, Message, ToolCall, ToolSpec, Usage


class OpenAICompatProvider(HttpProvider):
    """Chat Completions bergaya OpenAI: OpenAI, OpenRouter, LiteLLM, Ollama, LM Studio, vLLM."""

    name = "openai"
    # OpenAI memakai max_completion_tokens; server lokal umumnya hanya mengenal max_tokens.
    max_tokens_param = "max_tokens"

    def chat(self, messages: list[Message], tools: tuple[ToolSpec, ...] = ()) -> LLMResponse:
        payload: dict = {
            "model": self.model,
            "messages": [_message(m) for m in messages],
            self.max_tokens_param: self.max_tokens,
        }
        if self.temperature is not None:
            payload["temperature"] = self.temperature
        if tools:
            payload["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    },
                }
                for t in tools
            ]
        headers = {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}
        data = self._post(f"{self.base_url}/chat/completions", payload, headers)
        try:
            return self._parse(data)
        except (KeyError, IndexError, TypeError, AttributeError) as exc:
            raise LLMProtocolError(
                f"respons LLM tidak sesuai format ({type(exc).__name__})"
            ) from exc

    def _parse(self, data: dict) -> LLMResponse:
        choice = data["choices"][0]
        msg = choice["message"]
        content = msg.get("content") or ""
        if isinstance(content, list):  # sebagian router mengembalikan bagian-bagian teks
            content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
        calls = []
        for i, tc in enumerate(msg.get("tool_calls") or []):
            fn = tc["function"]
            args = fn.get("arguments") or {}
            if isinstance(args, str):
                try:
                    args = json.loads(args or "{}")
                except ValueError as exc:
                    raise LLMProtocolError("argumen tool call bukan JSON valid") from exc
            if not isinstance(args, dict):
                raise LLMProtocolError("argumen tool call bukan objek")
            calls.append(ToolCall(tc.get("id") or f"call_{i}", fn["name"], args))
        usage = data.get("usage") or {}
        return LLMResponse(
            text=content,
            tool_calls=tuple(calls),
            stop_reason="tool_calls"
            if calls
            else ("length" if choice.get("finish_reason") == "length" else "stop"),
            usage=Usage(usage.get("prompt_tokens", 0), usage.get("completion_tokens", 0)),
            model=data.get("model") or self.model,
        )


class OpenAIProvider(OpenAICompatProvider):
    max_tokens_param = "max_completion_tokens"


class LocalProvider(OpenAICompatProvider):
    name = "local"


def _message(m: Message) -> dict:
    if m.role == "tool":
        return {"role": "tool", "tool_call_id": m.tool_call_id, "content": m.content}
    out: dict = {"role": m.role, "content": m.content}
    if m.tool_calls:
        out["content"] = m.content or None
        out["tool_calls"] = [
            {
                "id": c.id,
                "type": "function",
                "function": {"name": c.name, "arguments": json.dumps(c.arguments)},
            }
            for c in m.tool_calls
        ]
    return out
