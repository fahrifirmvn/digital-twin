import logging
from contextlib import asynccontextmanager

import psycopg
from fastapi import Depends, FastAPI, HTTPException

from app.api import router
from app.config import settings
from app.main_deps import require_internal_token
from app.relay import Relay
from app.runs import RunManager

log = logging.getLogger("engine")


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
    yield
    if relay:
        relay.close()


app = FastAPI(title="LactOS Engine", version="0.1.0", lifespan=lifespan)
app.include_router(router)


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
