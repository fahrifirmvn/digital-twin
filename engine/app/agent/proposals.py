"""Alat usulan Operator Agent (P1, P2, P3). `run_whatif` menghitung dampak maintenance tangki lewat
simulasi dan validator; `create_proposal` hanya membuat DRAF yang merujuk id what-if. Tidak ada alat
yang menerapkan perubahan: pengajuan dan persetujuan adalah tindakan manusia lewat Laravel."""

import uuid
from typing import Any

from pydantic import Field

from app.agent.guard import unsupported_numbers
from app.agent.registry import READ_ROLES, Args, AssetId, Tool, ToolEnv, ToolError
from app.agent.tools import HIGHER_BETTER, LOWER_BETTER, _kpi_row
from app.agent.whatif import (
    MAX_DURATION,
    MIN_DURATION,
    CampaignContext,
    Finding,
    MaintenanceEntry,
    WhatIf,
    blocked,
    check_window,
    digest_json,
    simulate_day,
)

SIMULASI = frozenset({"SIMULASI"})  # kampanye adalah sandbox; mode LIVE tidak menulis apa pun
MAX_WHATIF_PER_TURN = 4
METRICS = (*LOWER_BETTER, *HIGHER_BETTER, "trucks")
UUID_PATTERN = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"


class NoArgs(Args):
    pass


class WhatIfArgs(Args):
    asset: AssetId = Field(
        description="Tangki yang dimaintenance, mis. TK-RAW-3; harus ada di campaign_state"
    )
    minute: float = Field(ge=0, lt=1440, description="Menit mulai sejak awal hari")
    duration_min: float = Field(ge=MIN_DURATION, le=MAX_DURATION, description="Durasi (menit)")


class CreateProposalArgs(Args):
    whatif_id: str = Field(pattern=r"^wi-[0-9a-f]{12}$", description="id dari run_whatif")
    rationale: str = Field(
        min_length=10, max_length=400, description="Alasan singkat yang hanya memakai hasil alat"
    )
    supersedes: str | None = Field(
        default=None, pattern=UUID_PATTERN, description="id usulan di open_proposals yang direvisi"
    )


def _campaign(env: ToolEnv) -> CampaignContext:
    if env.campaign is None:
        raise ToolError("tidak ada kampanye yang dibuka; usulan hanya untuk hari kampanye")
    return env.campaign


def _metrics(result) -> dict[str, Any]:
    row = _kpi_row(result)
    return {k: row[k] for k in METRICS if row.get(k) is not None}


def _delta(base: dict[str, Any], cand: dict[str, Any]) -> dict[str, Any]:
    """Hanya metrik yang berubah; selisih dan arah dihitung di sini supaya LLM tidak menghitung."""
    out: dict[str, Any] = {}
    for key in METRICS:
        if key not in base or key not in cand:
            continue
        change = round(cand[key] - base[key], 2)
        if change == 0:
            continue
        better = change < 0 if key in LOWER_BETTER else change > 0
        out[key] = {
            "baseline": base[key],
            "candidate": cand[key],
            "change": change,
            "better": better,
        }
    return out


def campaign_state(env: ToolEnv, a: NoArgs) -> dict[str, Any]:
    ctx = _campaign(env)
    counts = ctx.tank_counts()
    return {
        "campaign_id": ctx.campaign_id,
        "day_no": ctx.day_no,
        "editable": ctx.editable,
        "config": ctx.config,
        "scenario": ctx.scenario,
        "raw_tanks": counts["TK-RAW"],
        "storage_tanks": counts["TK-STO"],
        "tanks": sorted(ctx.tank_ids()),
        "maintenance_today": [e.model_dump() for e in ctx.existing],
        "planned_count": ctx.planned_count,
        "max_planned": ctx.max_planned,
        "open_proposals": [p.model_dump() for p in ctx.open_proposals],
    }


def run_whatif(env: ToolEnv, a: WhatIfArgs) -> dict[str, Any]:
    ctx = _campaign(env)
    if env.whatif_runs >= MAX_WHATIF_PER_TURN:
        raise ToolError(f"maksimal {MAX_WHATIF_PER_TURN} what-if per giliran")
    env.whatif_runs += 1

    window = {"asset": a.asset, "minute": a.minute, "duration_min": a.duration_min}
    findings: list[Finding] = check_window(ctx, a.asset, a.minute, a.duration_min)
    if blocked(findings):
        return {
            "whatif_id": None,
            "verdict": "diblokir",
            "window": window,
            "findings": [f.as_dict() for f in findings],
            "note": "Diblokir validator sebelum simulasi; tidak ada usulan yang dapat dibuat.",
        }

    base = env.whatifs.baseline(ctx.key(), lambda: _metrics(simulate_day(ctx)))
    entry = MaintenanceEntry(**window)
    cand = _metrics(simulate_day(ctx, (entry,)))
    if cand.get("holding_violations", 0) > 0:
        findings.append(
            Finding("holding_time_violated", "Simulasi menunjukkan pelanggaran holding time.")
        )
    if cand.get("false_accept", 0) > 0:
        findings.append(
            Finding("false_accept", "Simulasi menunjukkan batch tidak layak lolos gate.")
        )

    delta = _delta(base, cand)
    config_used = "C" if ctx.config == "D" else ctx.config
    item = WhatIf(
        id=env.whatifs.new_id(),
        campaign_id=ctx.campaign_id,
        day_no=ctx.day_no,
        ctx_key=ctx.key(),
        window=window,
        config_requested=ctx.config,
        config_used=config_used,
        baseline=base,
        candidate=cand,
        delta=delta,
        findings=[f.as_dict() for f in findings],
        blocked=blocked(findings),
        result_hash=digest_json({"baseline": base, "candidate": cand, "window": window}),
    )
    env.whatifs.put(item)
    env.cited.append({"tool": "run_whatif", "run_id": None, "code": item.id})
    return {
        "whatif_id": item.id,
        "verdict": "diblokir" if item.blocked else "dapat_diusulkan",
        "window": window,
        "config_requested": ctx.config,
        "config_used": config_used,
        "note": "Hari yang sama dan seed yang sama; D dihitung sebagai C."
        if ctx.config == "D"
        else None,
        "baseline": base,
        "candidate": cand,
        "changes": delta,
        "findings": item.findings,
    }


def create_proposal(env: ToolEnv, a: CreateProposalArgs) -> dict[str, Any]:
    ctx = _campaign(env)
    # Alasan tampil di kartu PPIC: angka di dalamnya harus dari hasil alat, sama seperti jawaban (P4).
    if ungrounded := unsupported_numbers(a.rationale, env.evidence):
        shown = ", ".join(f"{n:g}" for n in ungrounded[:8])
        raise ToolError(
            f"alasan memuat angka yang tidak ada di hasil alat: {shown}; tulis ulang tanpa angka itu"
        )
    item = env.whatifs.get(a.whatif_id)
    if item is None:
        raise ToolError("what-if tidak ditemukan atau sudah kedaluwarsa; jalankan run_whatif lagi")
    if (item.campaign_id, item.day_no) != (
        ctx.campaign_id,
        ctx.day_no,
    ) or item.ctx_key != ctx.key():
        raise ToolError("what-if dibuat untuk keadaan hari yang berbeda; jalankan run_whatif lagi")
    if any(p["evidence"]["whatif_id"] == item.id for p in env.proposals):
        raise ToolError("what-if ini sudah dipakai untuk satu usulan")
    if a.supersedes and a.supersedes not in {p.id for p in ctx.open_proposals}:
        raise ToolError("usulan yang direvisi tidak ada di open_proposals (campaign_state)")
    # Aturan keras diperiksa lagi terhadap keadaan sekarang (P3).
    now = check_window(
        ctx, item.window["asset"], item.window["minute"], item.window["duration_min"]
    )
    if item.blocked or blocked(now):
        raise ToolError("usulan diblokir validator (aturan keras) dan tidak dapat dibuat")

    proposal_id = str(uuid.uuid4())
    env.proposals.append(
        {
            "id": proposal_id,
            "kind": "tank_maintenance",
            "campaign_id": ctx.campaign_id,
            "day_no": ctx.day_no,
            "payload": item.window,
            "rationale": a.rationale,
            "supersedes": a.supersedes,
            "evidence": {
                "whatif_id": item.id,
                "result_hash": item.result_hash,
                "config_requested": item.config_requested,
                "config_used": item.config_used,
                "baseline": item.baseline,
                "candidate": item.candidate,
                "changes": item.delta,
                "findings": item.findings,
            },
        }
    )
    env.cited.append({"tool": "create_proposal", "run_id": None, "code": proposal_id})
    return {
        "proposal_id": proposal_id,
        "status": "draft",
        "kind": "tank_maintenance",
        "payload": item.window,
        "whatif_id": item.id,
        "note": "Draf belum diterapkan. Pengguna harus mengajukan, lalu PPIC menyetujui dengan alasan.",
    }


PROPOSAL_TOOLS: dict[str, Tool] = {
    t.name: t
    for t in (
        Tool("campaign_state", "Hari kampanye yang sedang disusun: tangki yang ada, maintenance yang sudah dijadwalkan, dan batasnya.", NoArgs, READ_ROLES, campaign_state, SIMULASI),
        Tool("run_whatif", "Simulasikan maintenance satu tangki pada hari kampanye ini dan bandingkan KPI dengan hari tanpa maintenance itu; validator aturan keras ikut memeriksa. Hanya menghitung, tidak mengubah apa pun.", WhatIfArgs, READ_ROLES, run_whatif, SIMULASI),
        Tool("create_proposal", "Buat DRAF usulan dari satu what-if yang tidak diblokir. Draf tidak menerapkan apa pun; manusia harus mengajukan dan PPIC menyetujui.", CreateProposalArgs, READ_ROLES, create_proposal, SIMULASI),
    )
}  # fmt: skip
