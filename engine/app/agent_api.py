"""Endpoint Operator Agent. Identitas dan peran pengguna ditentukan Laravel (dipercaya lewat token
internal); Engine tidak pernah menerima peran dari klien browser."""

import logging
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from app.agent.orchestrator import FALLBACK, Agent, AgentReply, ChatTurn
from app.agent.registry import ROLES
from app.agent.whatif import CampaignContext
from app.contracts.result import RunResult
from app.main_deps import require_internal_token
from app.runs import RunManager

log = logging.getLogger("agent")
router = APIRouter(prefix="/v1/agent", dependencies=[Depends(require_internal_token)])


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


class TurnRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    conversation_id: str = Field(pattern=r"^[A-Za-z0-9-]{8,64}$")
    user_id: int = Field(ge=1)
    role: Literal[ROLES]  # type: ignore[valid-type]
    mode: Literal["SIMULASI", "LIVE"]
    message: str = Field(min_length=1, max_length=1000)
    run_id: int | None = Field(default=None, ge=1)
    campaign: CampaignContext | None = None
    history: list[Turn] = Field(default_factory=list, max_length=20)


def agent(request: Request) -> Agent | None:
    return request.app.state.agent


@router.get("/status")
def status(bot: Annotated[Agent | None, Depends(agent)]) -> dict[str, Any]:
    return {
        "available": bot is not None,
        "provider": bot.provider.name if bot else None,
        "model": getattr(bot.provider, "model", bot.provider.name) if bot else None,
    }


@router.post("/turn")
def turn(body: TurnRequest, bot: Annotated[Agent | None, Depends(agent)]) -> dict[str, Any]:
    if bot is None:
        label = f"DATA SINTETIS | mode {body.mode}"
        error = {"code": "llm_unavailable", "message": FALLBACK}
        return AgentReply("unavailable", FALLBACK, body.mode, label, error).as_dict()
    try:
        reply = bot.turn(
            body.conversation_id,
            body.user_id,
            body.role,
            body.mode,
            body.message,
            [ChatTurn(t.role, t.content) for t in body.history],
            body.run_id,
            body.campaign,
        )
    except Exception as exc:  # noqa: BLE001 - kegagalan agen tidak boleh menjatuhkan Engine
        log.exception("agent error")
        raise HTTPException(status_code=500, detail="agent error") from exc
    return reply.as_dict()
