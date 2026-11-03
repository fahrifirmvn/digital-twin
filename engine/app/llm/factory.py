import httpx

from app.config import Settings, settings
from app.llm.anthropic import AnthropicProvider
from app.llm.mock import MockProvider
from app.llm.openai_compat import LocalProvider, OpenAIProvider
from app.llm.types import LLMConfigError, Provider

DEFAULT_BASE_URL = {
    "openai": "https://api.openai.com/v1",
    "anthropic": "https://api.anthropic.com",
}


def build_provider(cfg: Settings | None = None, client: httpx.Client | None = None) -> Provider:
    """Bangun provider dari ENGINE_LLM_*; `local` = router/server berformat OpenAI (Ollama, LiteLLM, vLLM, dll)."""
    cfg = cfg or settings
    kind = cfg.llm_provider
    if kind == "mock":
        return MockProvider()

    key = cfg.llm_api_key.get_secret_value()
    base = cfg.llm_base_url or DEFAULT_BASE_URL.get(kind, "")
    problems = []
    if not base:
        problems.append("ENGINE_LLM_BASE_URL")
    if not cfg.llm_model:
        problems.append("ENGINE_LLM_MODEL")
    if kind in DEFAULT_BASE_URL and not key:
        problems.append("ENGINE_LLM_API_KEY")
    if problems:
        raise LLMConfigError(f"provider '{kind}' butuh: {', '.join(problems)}")

    cls = {"openai": OpenAIProvider, "anthropic": AnthropicProvider, "local": LocalProvider}[kind]
    return cls(
        base,
        key,
        cfg.llm_model,
        timeout=cfg.llm_timeout,
        max_tokens=cfg.llm_max_tokens,
        temperature=cfg.llm_temperature,
        retries=cfg.llm_retries,
        client=client,
    )
