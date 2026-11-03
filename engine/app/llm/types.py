"""Tipe netral-provider untuk copilot: pesan, tool call, dan respons."""

from dataclasses import dataclass, field
from typing import Literal, Protocol

Role = Literal["system", "user", "assistant", "tool"]
StopReason = Literal["stop", "tool_calls", "length"]


class LLMError(Exception):
    pass


class LLMConfigError(LLMError):
    """Konfigurasi provider tidak lengkap atau tidak dikenal."""


class LLMRequestError(LLMError):
    """Provider tidak terjangkau atau menolak permintaan."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class LLMProtocolError(LLMError):
    """Respons provider tidak sesuai format yang dijanjikan."""


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    parameters: dict  # JSON Schema objek


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    arguments: dict
    # Data khusus provider yang harus dikirim balik apa adanya (mis. thoughtSignature Gemini).
    meta: dict = field(default_factory=dict, compare=False)


@dataclass(frozen=True)
class Message:
    role: Role
    content: str = ""
    tool_calls: tuple[ToolCall, ...] = ()  # hanya untuk role assistant
    tool_call_id: str | None = None  # hanya untuk role tool


@dataclass(frozen=True)
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0


@dataclass(frozen=True)
class LLMResponse:
    text: str
    tool_calls: tuple[ToolCall, ...] = ()
    stop_reason: StopReason = "stop"
    usage: Usage = field(default_factory=Usage)
    model: str = ""

    def as_message(self) -> Message:
        return Message("assistant", self.text, self.tool_calls)


class Provider(Protocol):
    name: str

    def chat(self, messages: list[Message], tools: tuple[ToolSpec, ...] = ()) -> LLMResponse: ...
