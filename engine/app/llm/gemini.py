"""Adapter Gemini (REST generateContent v1beta) dengan function calling bawaan."""

import json
from typing import Any

from app.llm._http import HttpProvider
from app.llm.types import LLMProtocolError, LLMResponse, Message, ToolCall, ToolSpec, Usage

# Gemini hanya menerima subset OpenAPI; kunci ini ada di JSON Schema Pydantic tetapi ditolak.
_DROP = {
    "title",
    "additionalProperties",
    "default",
    "$defs",
    "exclusiveMinimum",
    "exclusiveMaximum",
}


def gemini_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """JSON Schema Pydantic -> subset OpenAPI Gemini ($ref diinline, anyOf-null jadi nullable)."""
    defs = schema.get("$defs", {})

    def walk(node: Any) -> Any:
        if isinstance(node, list):
            return [walk(x) for x in node]
        if not isinstance(node, dict):
            return node
        if "$ref" in node:
            return walk(defs[node["$ref"].rsplit("/", 1)[-1]])
        if "anyOf" in node:
            options = [o for o in node["anyOf"] if o.get("type") != "null"]
            if len(options) == 1:
                merged = walk(options[0])
                if len(options) != len(node["anyOf"]):
                    merged["nullable"] = True
                return merged
        if "const" in node:
            node = {**node, "enum": [node["const"]]}
        return {k: walk(v) for k, v in node.items() if k not in _DROP and k != "const"}

    return walk(schema)


def _response_object(content: str) -> dict[str, Any]:
    try:
        data = json.loads(content)
    except ValueError:
        return {"result": content}
    return data if isinstance(data, dict) else {"result": data}


def _contents(messages: list[Message]) -> list[dict[str, Any]]:
    names = {c.id: c.name for m in messages for c in m.tool_calls}
    out: list[dict[str, Any]] = []

    def add(role: str, parts: list[dict[str, Any]]) -> None:
        if out and out[-1]["role"] == role:  # respons beberapa alat harus satu giliran
            out[-1]["parts"].extend(parts)
        else:
            out.append({"role": role, "parts": parts})

    for m in messages:
        if m.role == "system":
            continue
        if m.role == "user":
            add("user", [{"text": m.content}])
        elif m.role == "assistant":
            parts: list[dict[str, Any]] = [{"text": m.content}] if m.content else []
            for c in m.tool_calls:
                part: dict[str, Any] = {"functionCall": {"name": c.name, "args": c.arguments}}
                if sig := c.meta.get("thoughtSignature"):
                    part["thoughtSignature"] = sig
                parts.append(part)
            add("model", parts)
        else:
            name = names.get(m.tool_call_id or "")
            if name is None:
                raise LLMProtocolError("hasil alat tanpa tool call yang cocok")
            add(
                "user",
                [{"functionResponse": {"name": name, "response": _response_object(m.content)}}],
            )
    return out


class GeminiProvider(HttpProvider):
    name = "gemini"
    # Token berpikir 2.5-flash memakan jatah maxOutputTokens; 0 mematikannya agar jawaban tidak kosong.
    thinking_budget: int | None = None
    # Vertex AI (Agent Platform) memakai path berbeda dari Gemini API; project/lokasi hanya untuk key terikat project.
    vertex_project: str = ""
    vertex_location: str = "global"

    _adc: Any = None

    def _auth_headers(self) -> dict[str, str]:
        if self.api_key:
            return {"x-goog-api-key": self.api_key}
        # Vertex terikat project tidak menerima API key; pakai Application Default Credentials.
        import google.auth
        from google.auth.transport.requests import Request

        if self._adc is None:
            self._adc, _ = google.auth.default(
                scopes=["https://www.googleapis.com/auth/cloud-platform"]
            )
        if not self._adc.valid:
            self._adc.refresh(Request())
        return {"Authorization": f"Bearer {self._adc.token}"}

    def _url(self) -> str:
        if "aiplatform.googleapis.com" not in self.base_url:
            return f"{self.base_url}/v1beta/models/{self.model}:generateContent"
        scope = (
            f"projects/{self.vertex_project}/locations/{self.vertex_location}/"
            if self.vertex_project
            else ""
        )
        return f"{self.base_url}/v1/{scope}publishers/google/models/{self.model}:generateContent"

    def chat(self, messages: list[Message], tools: tuple[ToolSpec, ...] = ()) -> LLMResponse:
        system = "\n\n".join(m.content for m in messages if m.role == "system")
        config: dict[str, Any] = {"maxOutputTokens": self.max_tokens}
        if self.temperature is not None:
            config["temperature"] = self.temperature
        if self.thinking_budget is not None:
            config["thinkingConfig"] = {"thinkingBudget": self.thinking_budget}
        payload: dict[str, Any] = {
            "contents": _contents(messages),
            "generationConfig": config,
        }
        if system:
            payload["systemInstruction"] = {"parts": [{"text": system}]}
        if tools:
            payload["tools"] = [
                {
                    "functionDeclarations": [
                        {
                            "name": t.name,
                            "description": t.description,
                            "parameters": gemini_schema(t.parameters),
                        }
                        for t in tools
                    ]
                }
            ]
        data = self._post(self._url(), payload, self._auth_headers())
        try:
            return self._parse(data)
        except (KeyError, IndexError, TypeError, AttributeError) as exc:
            raise LLMProtocolError(
                f"respons LLM tidak sesuai format ({type(exc).__name__})"
            ) from exc

    def _parse(self, data: dict) -> LLMResponse:
        candidates = data.get("candidates") or []
        if not candidates:
            raise LLMProtocolError("Gemini tidak mengembalikan kandidat (permintaan diblokir?)")
        cand = candidates[0]
        text, calls = [], []
        for i, part in enumerate((cand.get("content") or {}).get("parts") or []):
            if "functionCall" in part:
                fc = part["functionCall"]
                args = fc.get("args") or {}
                if not isinstance(args, dict):
                    raise LLMProtocolError("argumen tool call bukan objek")
                meta = (
                    {"thoughtSignature": part["thoughtSignature"]}
                    if "thoughtSignature" in part
                    else {}
                )
                calls.append(ToolCall(fc.get("id") or f"call_{i}", fc["name"], args, meta))
            elif part.get("text") and not part.get("thought"):
                text.append(part["text"])
        usage = data.get("usageMetadata") or {}
        length = cand.get("finishReason") == "MAX_TOKENS"
        return LLMResponse(
            text="".join(text),
            tool_calls=tuple(calls),
            stop_reason="tool_calls" if calls else ("length" if length else "stop"),
            usage=Usage(usage.get("promptTokenCount", 0), usage.get("candidatesTokenCount", 0)),
            model=data.get("modelVersion") or self.model,
        )
