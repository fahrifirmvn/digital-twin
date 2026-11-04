import httpx

from app.config import Settings, settings
from app.llm.anthropic import AnthropicProvider
from app.llm.gemini import GeminiProvider
from app.llm.mock import MockProvider
from app.llm.openai_compat import LocalProvider, OpenAIProvider
from app.llm.types import LLMConfigError, Provider

DEFAULT_BASE_URL = {
    "gemini": "https://generativelanguage.googleapis.com",
    "openai": "https://api.openai.com/v1",
    "anthropic": "https://api.anthropic.com",
}
DEFAULT_MODEL = {"gemini": "gemini-3.8-flash"}


def build_provider(cfg: Settings | None = None, client: httpx.Client | None = None) -> Provider:
    """Bangun provider dari ENGINE_LLM_*; `local` = router/server berformat OpenAI (Ollama, LiteLLM, vLLM, dll)."""
    cfg = cfg or settings
    kind = cfg.llm_provider
    if kind == "mock":
        return MockProvider()

    key = cfg.llm_api_key.get_secret_value()
    base = cfg.llm_base_url or DEFAULT_BASE_URL.get(kind, "")
    model = cfg.llm_model or DEFAULT_MODEL.get(kind, "")
    problems = []
    if not base:
        problems.append("ENGINE_LLM_BASE_URL")
    if not model:
        problems.append("ENGINE_LLM_MODEL")
    if kind in DEFAULT_BASE_URL and not key and not (kind == "gemini" and cfg.llm_vertex_project):
        problems.append("ENGINE_LLM_API_KEY")
    if problems:
        raise LLMConfigError(f"provider '{kind}' butuh: {', '.join(problems)}")

    cls = {
        "gemini": GeminiProvider,
        "openai": OpenAIProvider,
        "anthropic": AnthropicProvider,
        "local": LocalProvider,
    }[kind]
    provider = cls(
        base,
        key,
        model,
        timeout=cfg.llm_timeout,
        max_tokens=cfg.llm_max_tokens,
        temperature=cfg.llm_temperature,
        retries=cfg.llm_retries,
        client=client,
    )
    if isinstance(provider, GeminiProvider):
        budget = cfg.llm_thinking_budget
        if budget is None and "flash" in model:
            budget = 0
        provider.thinking_budget = budget
        provider.vertex_project = cfg.llm_vertex_project
        provider.vertex_location = cfg.llm_vertex_location
    return provider
