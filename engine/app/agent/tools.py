"""Alat baca Operator Agent. Semuanya hanya membaca hasil run yang sudah selesai; tidak ada alat
untuk ambang mutu, SOP, holding time, atau keputusan rilis QA, jadi LLM tidak punya jalur ke sana.
Alat yang mengusulkan perubahan (Fase 3) tidak pernah mengeksekusi apa pun."""

from collections import Counter, deque
from collections.abc import Callable
from datetime import datetime
from typing import Any, Literal

from pydantic import Field

from app.agent.registry import (
    LIST_LIMIT,
    READ_ROLES,
    Args,
    AssetId,
    Tool,
    ToolEnv,
    ToolError,
)
from app.contracts.result import RunResult, TruckPlanOut


class RunRef(Args):
    run_id: int | None = Field(default=None, ge=1, description="Kosong = run yang sedang dibuka")


class CompareArgs(Args):
    run_ids: list[int] = Field(min_length=2, max_length=4, description="ID run yang dibandingkan")


class ExplainArgs(Args):
    run_id: int | None = Field(default=None, ge=1)
    kind: Literal["truck", "holds", "plan"] = Field(
        description="truck = riwayat satu truk, holds = semua penahanan gate, plan = ringkasan rencana"
    )
    code: str | None = Field(
        default=None, max_length=40, description="Kode truk (wajib untuk kind=truck)"
    )


class TraceArgs(Args):
    run_id: int | None = Field(default=None, ge=1)
    batch_code: str = Field(min_length=1, max_length=40)


class AssetArgs(Args):
    run_id: int | None = Field(default=None, ge=1)
    asset_id: AssetId = Field(description="Kode tangki, mis. TK-RAW-3 atau TK-STO-2")


def _minutes(a: datetime | None, b: datetime | None) -> float | None:
    return None if a is None or b is None else round((b - a).total_seconds() / 60, 1)


def _iso(d: datetime | None) -> str | None:
    return d.isoformat() if d else None


def _kpi_row(r: RunResult) -> dict[str, Any]:
    k = r.kpi
    return {
        "run_id": r.run_id,
        "config": r.config,
        "scenario": r.scenario,
        "truck_wait_mean_min": k.truck_wait_min.mean,
        "truck_wait_p90_min": k.truck_wait_min.p90,
        "lab_wait_mean_min": k.lab_wait_min.mean,
        "tank_dwell_mean_min": k.tank_dwell_min.mean,
        "changeover_count": k.changeover_count,
        "changeover_min": k.changeover_min,
        "schedule_adherence_pct": k.schedule_adherence_pct,
        "unscheduled_cip": k.unscheduled_cip,
        "held_qa": k.held_qa,
        "holding_violations": k.holding_violations,
        "false_accept": k.false_accept,
        "completed": k.completed,
        "trucks": k.trucks,
        "makespan_min": k.makespan_min,
    }


# Metrik yang lebih kecil lebih baik; adherence dan completed lebih besar lebih baik.
LOWER_BETTER = (
    "truck_wait_mean_min", "truck_wait_p90_min", "lab_wait_mean_min", "tank_dwell_mean_min",
    "changeover_count", "changeover_min", "unscheduled_cip", "held_qa", "holding_violations",
    "false_accept", "makespan_min",
)  # fmt: skip
HIGHER_BETTER = ("schedule_adherence_pct", "completed")


def get_state(env: ToolEnv, a: RunRef) -> dict[str, Any]:
    r = env.result(a.run_id)
    env.cite("get_state", r.run_id)
    return {
        "run_id": r.run_id,
        "config": r.config,
        "scenario": r.scenario,
        "params": r.params,
        "kpi": _kpi_row(r),
        "utilization_pct": r.kpi.utilization_pct,
        "gate_holds": r.kpi.gate_holds,
        "tankers_by_outcome": dict(Counter(t.outcome for t in r.tankers)),
        "batches_by_status": dict(Counter(b.status for b in r.batches)),
        "plan_status": r.plan.status if r.plan else None,
        "replans": len(r.replans),
    }


def compare_schedules(env: ToolEnv, a: CompareArgs) -> dict[str, Any]:
    results = [env.result(i) for i in dict.fromkeys(a.run_ids)]
    if len(results) < 2:
        raise ToolError("butuh dua run berbeda")
    rows = [_kpi_row(r) for r in results]
    base = rows[0]
    delta, best = {}, {}
    for key in (*LOWER_BETTER, *HIGHER_BETTER):
        vals = [(row["run_id"], row[key]) for row in rows if row[key] is not None]
        if len(vals) < 2:
            continue
        pick = min if key in LOWER_BETTER else max
        target = pick(v for _, v in vals)
        best[key] = (
            [rid for rid, v in vals if v == target] if len({v for _, v in vals}) > 1 else "sama"
        )
        if base[key] is not None:
            delta[key] = {
                row["run_id"]: round(row[key] - base[key], 2)
                for row in rows[1:]
                if row[key] is not None
            }
    same_day = len({(r.seed, r.scenario, tuple(sorted(r.params.items()))) for r in results}) == 1
    for r in results:
        env.cite("compare_schedules", r.run_id)
    return {
        "same_day": same_day,
        "warning": None
        if same_day
        else "run tidak memakai seed/skenario/volume yang sama; perbandingan tidak apel-ke-apel",
        "baseline_run_id": base["run_id"],
        "runs": rows,
        "delta_vs_baseline": delta,
        "best": best,
    }


def _latest_plan_entry(r: RunResult, code: str) -> tuple[int, TruckPlanOut] | None:
    entry, version = None, 1
    if r.plan:
        entry = next((t for t in r.plan.trucks if t.code == code), None)
    for rp in r.replans:
        if rp.status == "failed" or rp.plan is None:
            continue
        hit = next((t for t in rp.plan.trucks if t.code == code), None)
        if hit:
            entry, version = hit, rp.version
    return None if entry is None else (version, entry)


def explain(env: ToolEnv, a: ExplainArgs) -> dict[str, Any]:
    r = env.result(a.run_id)
    if a.kind == "truck":
        if not a.code:
            raise ToolError("code truk wajib untuk kind=truck")
        t = next((x for x in r.tankers if x.code == a.code), None)
        if t is None:
            raise ToolError(f"truk {a.code} tidak ada di run {r.run_id}")
        latest = _latest_plan_entry(r, t.code)
        plan = {"version": latest[0], **latest[1].model_dump(mode="json")} if latest else None
        env.cite("explain", r.run_id, t.code)
        gates = [g.model_dump(mode="json") for g in r.gates if g.object_id == t.code]
        return {
            "run_id": r.run_id,
            "truck": t.model_dump(mode="json", exclude={"lab_results"}),
            "lab_results": t.lab_results,
            "wait_before_unload_min": _minutes(t.arrived_at, t.unload_start),
            "lab_turnaround_min": _minutes(t.lab_start, t.lab_end),
            "plan": plan,
            "unload_vs_plan_min": _minutes(latest[1].unload_start, t.unload_start)
            if latest
            else None,
            "gates": gates,
        }
    if a.kind == "holds":
        holds = [g for g in r.gates if g.decision != "pass"]
        env.cite("explain", r.run_id)
        return {
            "run_id": r.run_id,
            "total": len(holds),
            "by_gate": dict(Counter(g.gate for g in holds)),
            "items": [g.model_dump(mode="json") for g in holds[:LIST_LIMIT]],
            "truncated": len(holds) > LIST_LIMIT,
        }
    env.cite("explain", r.run_id)
    mc = r.monte_carlo
    return {
        "run_id": r.run_id,
        "config": r.config,
        "plan": None if r.plan is None else r.plan.model_dump(mode="json", exclude={"trucks"}),
        "planned_trucks": len(r.plan.trucks) if r.plan else 0,
        "replans": [
            {"version": rp.version, "at": _iso(rp.at), "trigger": rp.trigger, "status": rp.status, "trucks": rp.trucks}
            for rp in r.replans
        ],
        "monte_carlo": None if mc is None else {"samples": mc.samples, "chosen": mc.chosen, "candidates": [c.model_dump(mode="json") for c in mc.candidates]},
    }  # fmt: skip


def trace_batch(env: ToolEnv, a: TraceArgs) -> dict[str, Any]:
    r = env.result(a.run_id)
    by_code = {b.code: b for b in r.batches}
    if a.batch_code not in by_code:
        raise ToolError(f"batch {a.batch_code} tidak ada di run {r.run_id}")
    children: dict[str, list[str]] = {}
    for b in r.batches:
        for p in b.parents:
            children.setdefault(p, []).append(b.code)

    def walk(edges: Callable[[str], list[str]]) -> dict[str, int]:
        seen, queue = {a.batch_code: 0}, deque([a.batch_code])
        while queue:
            cur = queue.popleft()
            for nxt in edges(cur):
                if nxt in by_code and nxt not in seen:
                    seen[nxt] = seen[cur] + 1
                    queue.append(nxt)
        seen.pop(a.batch_code)
        return seen

    up = walk(lambda c: by_code[c].parents)
    down = walk(lambda c: children.get(c, []))
    codes = {a.batch_code, *up, *down}

    def node(c: str, depth: int) -> dict[str, Any]:
        b = by_code[c]
        return {
            "code": c,
            "type": b.type,
            "status": b.status,
            "volume_ton": b.volume_ton,
            "sku_code": b.sku_code,
            "depth": depth,
        }

    tanker_codes = sorted({by_code[c].tanker_code for c in codes if by_code[c].tanker_code})
    tankers = [t for t in r.tankers if t.code in tanker_codes]
    object_ids = codes | set(tanker_codes)
    env.cite("trace_batch", r.run_id, a.batch_code)
    return {
        "run_id": r.run_id,
        "batch": node(a.batch_code, 0),
        "upstream": sorted((node(c, d) for c, d in up.items()), key=lambda n: n["depth"])[:LIST_LIMIT],
        "downstream": sorted((node(c, d) for c, d in down.items()), key=lambda n: n["depth"])[:LIST_LIMIT],
        "tankers": [{"code": t.code, "farm_code": t.farm_code, "volume_ton": t.volume_ton, "outcome": t.outcome} for t in tankers],
        "transfers": [t.model_dump(mode="json") for t in r.transfers if t.batch_code in codes][:LIST_LIMIT],
        "gates": [g.model_dump(mode="json") for g in r.gates if g.object_id in object_ids][:LIST_LIMIT],
    }  # fmt: skip


class PredictTruckArgs(Args):
    run_id: int | None = Field(default=None, ge=1)
    code: str = Field(min_length=1, max_length=40, description="Kode truk")


def _ai(r: RunResult):
    if r.ai is None:
        raise ToolError(f"run {r.run_id} tidak punya prediksi AI (model tidak dimuat)")
    return r.ai


def predict_truck(env: ToolEnv, a: PredictTruckArgs) -> dict[str, Any]:
    r = env.result(a.run_id)
    t = next((t for t in _ai(r).trucks if t.code == a.code), None)
    if t is None:
        raise ToolError(f"truk {a.code} tidak ada di run {r.run_id}")
    env.cite("predict_truck", r.run_id, a.code)
    return {"run_id": r.run_id, "label": _ai(r).label, **t.model_dump(mode="json")}


def anomaly_status(env: ToolEnv, a: RunRef) -> dict[str, Any]:
    r = env.result(a.run_id)
    env.cite("anomaly_status", r.run_id)
    return {"run_id": r.run_id, "label": _ai(r).label, **_ai(r).anomaly.model_dump(mode="json")}


def list_assets(env: ToolEnv, a: RunRef) -> dict[str, Any]:
    r = env.result(a.run_id)
    env.cite("list_assets", r.run_id)
    ids = sorted(env.asset_ids(r.run_id))
    return {"run_id": r.run_id, "tanks": ids, "count": len(ids)}


def asset_activity(env: ToolEnv, a: AssetArgs) -> dict[str, Any]:
    r = env.result(a.run_id)
    moves = [t for t in r.transfers if a.asset_id in (t.from_asset, t.to_asset)]
    cips = [c for c in r.cips if c.asset_code == a.asset_id]
    env.cite("asset_activity", r.run_id, a.asset_id)
    return {
        "run_id": r.run_id,
        "asset_id": a.asset_id,
        "transfers": [t.model_dump(mode="json") for t in moves[:LIST_LIMIT]],
        "transfers_total": len(moves),
        "cips": [c.model_dump(mode="json") for c in cips[:LIST_LIMIT]],
        "cips_total": len(cips),
    }


TOOLS: dict[str, Tool] = {
    t.name: t
    for t in (
        Tool("get_state", "KPI, hasil truk dan status batch satu run selesai.", RunRef, READ_ROLES, get_state),
        Tool("compare_schedules", "Bandingkan KPI 2-4 run; selisih dan yang terbaik sudah dihitung.", CompareArgs, READ_ROLES, compare_schedules),
        Tool("explain", "Jelaskan satu truk, penahanan gate, atau rencana/replan/Monte Carlo suatu run.", ExplainArgs, READ_ROLES, explain),
        Tool("trace_batch", "Telusuri batch ke asal (truk, peternakan) dan turunan (FG).", TraceArgs, READ_ROLES, trace_batch),
        Tool("predict_truck", "Prediksi AI satu truk: keterlambatan, durasi lab, peluang lolos QC (data sintetis; hanya prediksi, gate tetap memutuskan).", PredictTruckArgs, READ_ROLES, predict_truck),
        Tool("anomaly_status", "Skor dan flag anomali pabrik dari model AI untuk satu run (data sintetis).", RunRef, READ_ROLES, anomaly_status),
        Tool("list_assets", "Daftar kode tangki yang ada di pabrik run ini. Pakai sebelum menyebut kode tangki.", RunRef, READ_ROLES, list_assets),
        Tool("asset_activity", "Transfer dan CIP satu tangki pada satu run. Kode tangki harus ada di list_assets.", AssetArgs, READ_ROLES, asset_activity),
    )
}  # fmt: skip
