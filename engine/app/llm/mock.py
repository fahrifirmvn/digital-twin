from app.llm.types import LLMResponse, Message, ToolSpec


class MockProvider:
    """Provider deterministik untuk demo dan test tanpa kunci API. Memutar ulang `script` bila ada."""

    name = "mock"

    def __init__(self, script: list[LLMResponse] | None = None):
        self.script = list(script or [])
        self.calls: list[tuple[list[Message], tuple[ToolSpec, ...]]] = []

    def chat(self, messages: list[Message], tools: tuple[ToolSpec, ...] = ()) -> LLMResponse:
        self.calls.append((list(messages), tools))
        if self.script:
            return self.script.pop(0)
        last = next((m.content for m in reversed(messages) if m.role == "user"), "")
        return LLMResponse(text=f"[mock] {last}", model="mock")
