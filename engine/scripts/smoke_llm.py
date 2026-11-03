"""Uji asap LLM sungguhan (butuh ENGINE_LLM_* di engine/.env atau lingkungan). Jalankan:

    uv run python -m scripts.smoke_llm

Hanya mencetak LULUS/GAGAL dan alasan singkat; kunci API tidak pernah dicetak. Kode keluar 1 bila ada yang gagal.
"""

import sys
import uuid
from collections.abc import Callable
from pathlib import Path

from app.agent import Agent, ChatTurn, Policy, RateLimiter
from app.config import Settings, settings
from app.contracts.result import RunResult
from app.llm import LLMError, LLMRequestError, Message, build_provider

SAMPLE = Path(__file__).resolve().parents[2] / "contracts" / "run-result.sample.json"


class SampleSource:
    def __init__(self) -> None:
        self.result = RunResult.model_validate_json(SAMPLE.read_text())

    def get_result(self, run_id: int) -> RunResult | None:
        return self.result if run_id == self.result.run_id else None


def check_plain(provider) -> str:
    res = provider.chat(
        [Message("system", "Jawab singkat."), Message("user", "Sapa saya dalam satu kalimat.")]
    )
    assert res.text.strip(), (
        f"jawaban kosong (stop={res.stop_reason}); coba ENGINE_LLM_THINKING_BUDGET=0"
    )
    return f"{res.model or provider.model}, {res.usage.output_tokens} token keluar"


def turn(bot: Agent, text: str, history=(), run_id: int | None = None):
    return bot.turn(str(uuid.uuid4()), 1, "ppic", "SIMULASI", text, list(history), run_id)


def check_tool(bot: Agent, source: SampleSource) -> str:
    reply = turn(bot, "Ringkas KPI run ini.", run_id=source.result.run_id)
    assert reply.status == "ok", f"status {reply.status}: {reply.text[:80]}"
    assert reply.audit, "LLM tidak memanggil alat apa pun"
    return f"alat: {', '.join(a.tool for a in reply.audit)}"


def check_chitchat(bot: Agent) -> str:
    reply = turn(bot, "Halo! Singkatnya, apa itu holding time?")
    assert reply.status == "ok", f"status {reply.status}: {reply.text[:80]}"
    assert not reply.audit, (
        f"obrolan konsep tidak perlu alat, tapi memanggil {[a.tool for a in reply.audit]}"
    )
    return "tanpa alat"


def check_memory(bot: Agent) -> str:
    first = turn(bot, "Namaku Dewi, ingat ya.")
    assert first.status == "ok", f"status {first.status}"
    history = [ChatTurn("user", "Namaku Dewi, ingat ya."), ChatTurn("assistant", first.text)]
    reply = turn(bot, "Siapa namaku?", history)
    assert reply.status == "ok" and "dewi" in reply.text.lower(), (
        f"tidak ingat konteks: {reply.text[:80]}"
    )
    return "mengingat giliran sebelumnya"


def check_bad_key() -> str:
    bad = Settings(
        _env_file=None,
        llm_provider="gemini",
        llm_api_key="kunci-palsu",
        llm_model=settings.llm_model,
    )
    provider = build_provider(bad)
    try:
        provider.chat([Message("user", "halo")])
    except LLMRequestError as exc:
        assert "kunci-palsu" not in str(exc), "kunci bocor di pesan galat"
        return f"galat terkendali (HTTP {exc.status})"
    raise AssertionError("kunci palsu seharusnya ditolak")


def scrub(text: str) -> str:
    key = settings.llm_api_key.get_secret_value()
    return text.replace(key, "***") if key else text


def main() -> int:
    try:
        provider = build_provider()
    except LLMError as exc:
        print(f"GAGAL  konfigurasi: {scrub(str(exc))}")
        return 1
    source = SampleSource()
    bot = Agent(provider, source, Policy(RateLimiter(1000)), max_steps=settings.agent_max_steps)
    checks: list[tuple[str, Callable[[], str]]] = [
        ("teks biasa", lambda: check_plain(provider)),
        ("panggilan alat", lambda: check_tool(bot, source)),
        ("obrolan konsep", lambda: check_chitchat(bot)),
        ("ingatan percakapan", lambda: check_memory(bot)),
        ("kunci salah", check_bad_key),
    ]
    failed = 0
    for name, fn in checks:
        try:
            print(f"LULUS  {name}: {scrub(fn())}")
        except (AssertionError, LLMError) as exc:
            failed += 1
            print(f"GAGAL  {name}: {type(exc).__name__}: {scrub(str(exc))[:160]}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
