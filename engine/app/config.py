from typing import Literal

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ENGINE_", env_file=".env", extra="ignore")

    database_url: str = "postgresql://lactos:lactos@localhost:5432/lactos"
    # Token bersama untuk panggilan Laravel -> Engine di jaringan internal.
    internal_token: str = "change-me"
    # Kosong berarti event tidak direlay ke Laravel.
    web_url: str = ""

    # builtin = prediktor LightGBM internal; greenfields = model paket (sintetis) untuk ETA/lab.
    predictor: Literal["builtin", "greenfields"] = "builtin"

    # Copilot LLM (PRD 10.6). mock = tanpa jaringan; local = server/router berformat OpenAI.
    llm_provider: Literal["mock", "openai", "anthropic", "local"] = "mock"
    llm_base_url: str = ""
    llm_api_key: SecretStr = SecretStr("")
    llm_model: str = ""
    llm_timeout: float = 60.0
    llm_max_tokens: int = 1024
    # None = tidak dikirim (sebagian model penalaran menolak nilai selain bawaan).
    llm_temperature: float | None = None
    llm_retries: int = 2


settings = Settings()
