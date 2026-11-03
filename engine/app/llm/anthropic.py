from app.llm._http import HttpProvider
from app.llm.types import LLMProtocolError, LLMResponse, Message, ToolCall, ToolSpec, Usage

API_VERSION = "2023-06-01"


class AnthropicProvider(HttpProvider):
    """Messages API Anthropic; base_url juga bisa menunjuk router yang meniru API ini."""

    name = "anthropic"

    def chat(self, messages: list[Message], tools: tuple[ToolSpec, ...] = ()) -> LLMResponse:
        payload: dict = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "messages": _messages(messages),
        }
        system = "\n\n".join(m.content for m in messages if m.role == "system")
        if system:
            payload["system"] = system
        if self.temperature is not None:
            payload["temperature"] = self.temperature
        if tools:
            payload["tools"] = [
                {"name": t.name, "description": t.description, "input_schema": t.parameters}
                for t in tools
            ]
        headers = {"x-api-key": self.api_key, "anthropic-version": API_VERSION}
        path = "/messages" if self.base_url.endswith("/v1") else "/v1/messages"
        data = self._post(self.base_url + path, payload, headers)
        try:
            return self._parse(data)
        except (KeyError, IndexError, TypeError, AttributeError) as exc:
            raise LLMProtocolError(
                f"respons LLM tidak sesuai format ({type(exc).__name__})"
            ) from exc

    def _parse(self, data: dict) -> LLMResponse:
        text, calls = [], []
        for block in data["content"]:
            if block["type"] == "text":
                text.append(block["text"])
            elif block["type"] == "tool_use":
                if not isinstance(block["input"], dict):
                    raise LLMProtocolError("input tool_use bukan objek")
                calls.append(ToolCall(block["id"], block["name"], block["input"]))
        usage = data.get("usage") or {}
        stop = data.get("stop_reason")
        return LLMResponse(
            text="".join(text),
            tool_calls=tuple(calls),
            stop_reason="tool_calls" if calls else ("length" if stop == "max_tokens" else "stop"),
            usage=Usage(usage.get("input_tokens", 0), usage.get("output_tokens", 0)),
            model=data.get("model") or self.model,
        )


def _messages(messages: list[Message]) -> list[dict]:
    out: list[dict] = []
    in_tool_results = False  # hasil tool beruntun harus digabung dalam satu pesan user
    for m in messages:
        if m.role == "system":
            continue
        if m.role == "tool":
            block = {"type": "tool_result", "tool_use_id": m.tool_call_id, "content": m.content}
            if in_tool_results:
                out[-1]["content"].append(block)
            else:
                out.append({"role": "user", "content": [block]})
            in_tool_results = True
            continue
        in_tool_results = False
        if m.role == "assistant":
            blocks: list[dict] = [{"type": "text", "text": m.content}] if m.content else []
            blocks += [
                {"type": "tool_use", "id": c.id, "name": c.name, "input": c.arguments}
                for c in m.tool_calls
            ]
            out.append({"role": "assistant", "content": blocks})
        else:
            out.append({"role": "user", "content": m.content})
    return out
