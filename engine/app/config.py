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

    # builtin = prediktor LightGBM internal; core = model paket (sintetis) untuk ETA/lab.
    predictor: Literal["builtin", "core"] = "builtin"

    # LLM Asisten Operator. mock = tanpa jaringan; local = server/router berformat OpenAI.
    llm_provider: Literal["mock", "gemini", "openai", "anthropic", "local"] = "gemini"
    llm_base_url: str = ""
    llm_api_key: SecretStr = SecretStr("")
    llm_model: str = ""
    llm_vertex_project: str = ""
    llm_vertex_location: str = "global"
    llm_timeout: float = 60.0
    llm_max_tokens: int = 2048
    # Hanya Gemini. None = otomatis (0 untuk model flash, bawaan model lain).
    llm_thinking_budget: int | None = None
    # Suhu rendah: jawaban agen harus stabil dan berbasis alat. None = tidak dikirim (sebagian model penalaran menolak).
    llm_temperature: float | None = 0.2
    llm_retries: int = 2

    # Batas agen: langkah per giliran, detik per langkah, giliran per pengguna per menit.
    agent_max_steps: int = 8
    agent_step_timeout: float = 30.0
    agent_rate_per_min: int = 20


settings = Settings()
