import logging
from contextlib import asynccontextmanager

import psycopg
from fastapi import Depends, FastAPI, HTTPException

from app.agent import Agent, Policy, RateLimiter
from app.agent_api import RunManagerSource
from app.agent_api import router as agent_router
from app.api import router
from app.config import settings
from app.llm import LLMConfigError, build_provider
from app.main_deps import require_internal_token
from app.relay import Relay
from app.runs import RunManager

log = logging.getLogger("engine")


def _build_agent(runs: RunManager) -> Agent | None:
    """None bila LLM belum dikonfigurasi; antarmuka tetap bisa memakai Panel Skenario."""
    try:
        provider = build_provider()
    except LLMConfigError as exc:
        log.warning("Asisten AI nonaktif: %s", exc)
        return None
    return Agent(
        provider,
        RunManagerSource(runs),
        Policy(RateLimiter(settings.agent_rate_per_min)),
        max_steps=settings.agent_max_steps,
        step_timeout=settings.agent_step_timeout,
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    base = settings.web_url.rstrip("/")
    relay = (
        Relay(
            f"{base}/internal/twin-events",
            settings.internal_token,
            result_url=f"{base}/internal/runs/{{run_id}}/result",
        )
        if settings.web_url
        else None
    )
    app.state.runs = RunManager(relay)
    app.state.agent = _build_agent(app.state.runs)
    yield
    if relay:
        relay.close()


app = FastAPI(title="LactaTwin Engine", version="0.1.0", lifespan=lifespan)
app.include_router(router)
app.include_router(agent_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/ready", dependencies=[Depends(require_internal_token)])
def ready() -> dict[str, str]:
    try:
        with psycopg.connect(settings.database_url, connect_timeout=3) as conn:
            conn.execute("SELECT 1")
    except psycopg.Error as exc:
        raise HTTPException(status_code=503, detail="database unavailable") from exc
    return {"status": "ready"}
