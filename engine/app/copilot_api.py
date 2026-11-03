"""Endpoint Copilot. Peran pengguna ditentukan Laravel (dipercaya lewat token internal); Engine
tidak pernah menerima peran dari klien browser."""

import logging
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.contracts.result import RunResult
from app.copilot import ChatTurn, Copilot
from app.copilot.orchestrator import FALLBACK
from app.copilot.tools import ROLES
from app.main_deps import require_internal_token
from app.runs import RunManager

log = logging.getLogger("copilot")
router = APIRouter(prefix="/v1/copilot", dependencies=[Depends(require_internal_token)])


class RunManagerSource:
    """Hasil run yang selesai di proses Engine ini (hilang bila Engine dimulai ulang)."""

    def __init__(self, runs: RunManager):
        self.runs = runs

    def get_result(self, run_id: int) -> RunResult | None:
        run = self.runs.get(run_id)
        return run.result if run and run.status == "finished" else None


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=2000)


class ChatRequest(BaseModel):
    role: Literal[ROLES]  # type: ignore[valid-type]
    message: str = Field(min_length=1, max_length=1000)
    run_id: int | None = Field(default=None, ge=1)
    history: list[Turn] = Field(default_factory=list, max_length=20)


class ChatResponse(BaseModel):
    status: Literal["ok", "rejected", "unavailable"]
    text: str
    sources: list[dict[str, Any]] = []
    proposals: list[dict[str, Any]] = []
    tool_trace: list[dict[str, Any]] = []
    provider: str = ""
    model: str = ""
    input_tokens: int = 0
    output_tokens: int = 0


def copilot(request: Request) -> Copilot | None:
    return request.app.state.copilot


@router.get("/status")
def status(bot: Annotated[Copilot | None, Depends(copilot)]) -> dict[str, Any]:
    return {"available": bot is not None, "provider": bot.provider.name if bot else None}


@router.post("/chat")
def chat(body: ChatRequest, bot: Annotated[Copilot | None, Depends(copilot)]) -> ChatResponse:
    if bot is None:
        # Pagar 7: antarmuka tetap bisa memakai Panel Skenario.
        return ChatResponse(status="unavailable", text=FALLBACK)
    try:
        reply = bot.chat(
            body.message,
            [ChatTurn(t.role, t.content) for t in body.history],
            body.role,
            body.run_id,
        )
    except Exception as exc:  # noqa: BLE001 - kegagalan Copilot tidak boleh menjatuhkan Engine
        log.exception("copilot error")
        raise HTTPException(status_code=500, detail="copilot error") from exc
    return ChatResponse(**reply.__dict__)
