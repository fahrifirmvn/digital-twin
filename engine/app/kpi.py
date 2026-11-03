"""KPI Evaluator (PRD 3.1): fungsi murni atas hasil simulasi, sama untuk semua konfigurasi."""

import math
from dataclasses import asdict
from datetime import timedelta

from app.contracts.events import AssetStatus, AssetStatusChanged
from app.contracts.result import (
    AiOut,
    BatchOut,
    CandidateOut,
    CipOut,
    GateOut,
    Kpi,
    MonteCarloOut,
    PlanOut,
    ReplanOut,
    RunResult,
    Stat,
    TankerOut,
    TransferOut,
    TruckPlanOut,
)
from app.plan import Plan
from app.predictor import Forecast
from app.sim import DAY_START, TwinSimulation

ASSET_TYPES = {"BAY": "bay", "DEG": "degassing", "THM": "thermal", "SEP": "separator",
               "STE": "sterilizer", "LINE": "filling_line"}  # fmt: skip


def stat(values: list[float]) -> Stat:
    if not values:
        return Stat(n=0)
    s = sorted(values)
    p90 = s[max(0, math.ceil(0.9 * len(s)) - 1)]
    return Stat(n=len(s), mean=round(sum(s) / len(s), 2), p90=round(p90, 2), max=round(s[-1], 2))


def _unsafe(spec, th) -> bool:
    """Oracle independen dari Gate Engine, dipakai untuk menghitung false accept."""
    r = spec.lab_results
    lo, hi = th.acidity_range_pct
    return (
        spec.temp_c > th.max_arrival_temp_c
        or not spec.docs_ok
        or r["fat_pct"] < th.fat_min_pct
        or r["protein_pct"] < th.protein_min_pct
        or not lo <= r["acidity_pct"] <= hi
        or r["antibiotic_residue"] is not False
        or r["adulterant"] is not False
    )


def _utilization(sim: TwinSimulation, horizon: float) -> dict[str, float]:
    busy: dict[str, float] = {}
    since: dict[str, float] = {}
    for e in sim.events:
        p = e.payload
        if not isinstance(p, AssetStatusChanged):
            continue
        t = (e.sim_time - DAY_START).total_seconds() / 60
        if p.asset_code in since:
            busy[p.asset_code] = busy.get(p.asset_code, 0.0) + t - since.pop(p.asset_code)
        if p.status == AssetStatus.IN_USE:
            since[p.asset_code] = t
    for code, t0 in since.items():
        busy[code] = busy.get(code, 0.0) + horizon - t0

    groups: dict[str, list[str]] = {}
    for e in sim.events:
        p = e.payload
        if isinstance(p, AssetStatusChanged):
            kind = ASSET_TYPES.get(p.asset_code.split("-")[0])
            if kind:
                group = groups.setdefault(kind, [])
                if p.asset_code not in group:
                    group.append(p.asset_code)
    if horizon <= 0:
        return {k: 0.0 for k in groups}
    return {
        kind: round(100 * sum(busy.get(c, 0.0) for c in codes) / (len(codes) * horizon), 1)
        for kind, codes in groups.items()
    }


def _trace_complete(sim: TwinSimulation, code: str) -> bool:
    """FG lot lengkap bila setiap jalur induk berakhir di batch raw milik tanker yang dikenal."""
    b = sim.batches.get(code)
    if b is None:
        return False
    if b.type == "raw":
        return b.tanker in sim.tankers
    return bool(b.parents) and all(_trace_complete(sim, p) for p in b.parents)


def adherence(sim: TwinSimulation) -> float | None:
    """% truk selesai filling dalam toleransi slot (bawaan +-30 menit) dari rencana yang berlaku saat bongkar dimulai.
    None bila tidak ada rencana (baseline A)."""
    if not sim.plan_log:
        return None
    hits, total = 0, 0
    for r in sim.tankers.values():
        if r.outcome != "completed" or r.unload_start is None or r.fill_end is None:
            continue
        version = [p for at, _, p in sim.plan_log if at <= r.unload_start][-1]
        tp = version.trucks.get(r.spec.code)
        if tp is None:
            continue
        total += 1
        hits += abs(r.fill_end - tp.fill_end) <= sim.cfg.slot_tolerance_min
    return round(100 * hits / total, 1) if total else None


def evaluate(sim: TwinSimulation) -> Kpi:
    recs = list(sim.tankers.values())
    th = sim.cfg.thresholds
    end = float(sim.t_end)

    truck_wait = [r.unload_start - r.arrived for r in recs if r.unload_start is not None]
    lab_wait = [r.lab_end - r.arrived for r in recs if r.lab_end is not None]
    dwell = [r.ster_start - r.unload_end for r in recs if r.ster_start is not None]

    inters = [b for b in sim.batches.values() if b.type == "intermediate"]
    affected = [b for b in inters if b.changeover or b.status == "held"]
    fgs = [b for b in sim.batches.values() if b.type == "fg"]
    holds: dict[str, int] = {}
    for g in sim.gate_log:
        if g.decision == "hold":
            holds[g.gate] = holds.get(g.gate, 0) + 1

    return Kpi(
        truck_wait_min=stat(truck_wait),
        lab_wait_min=stat(lab_wait),
        tank_dwell_min=stat(dwell),
        unscheduled_cip=sum(1 for c in sim.cips if not c.scheduled),
        utilization_pct=_utilization(sim, end),
        packaging_reject_pct=round(100 * len(affected) / len(inters), 1) if inters else 0.0,
        false_accept=sum(1 for r in recs if r.outcome == "completed" and _unsafe(r.spec, th)),
        holding_violations=sum(1 for d in dwell if d > th.holding_max_min),
        trace_coverage_pct=(
            round(100 * sum(_trace_complete(sim, b.code) for b in fgs) / len(fgs), 1)
            if fgs
            else 100.0
        ),
        trucks=len(recs),
        completed=sum(1 for r in recs if r.outcome == "completed"),
        held_g1=sum(1 for r in recs if r.outcome == "held_g1"),
        rejected_g2=sum(1 for r in recs if r.outcome == "rejected_g2"),
        held_qa=sum(1 for r in recs if r.outcome == "held_qa"),
        raw_ton=round(sum(b.volume_ton for b in sim.batches.values() if b.type == "raw"), 2),
        fg_ton=round(sum(b.volume_ton for b in fgs), 2),
        changeover_count=len(sim.changeovers),
        changeover_min=round(sum(m for _, m in sim.changeovers), 1),
        gate_holds=holds,
        makespan_min=round(end, 1),
        schedule_adherence_pct=adherence(sim),
    )


def _dt(minutes: float | None):
    return None if minutes is None else DAY_START + timedelta(minutes=minutes)


def _plan_out(plan: Plan) -> PlanOut:
    return PlanOut(
        config=plan.config,  # type: ignore[arg-type]
        status=plan.status,
        objective=plan.objective,
        solve_seconds=plan.solve_seconds,
        quantile=plan.quantile,
        weights=plan.weights,
        trucks=[
            TruckPlanOut(
                code=t.code,
                analyst=t.analyst,
                lab_start=_dt(t.lab_start),
                bay=t.bay,
                unload_start=_dt(t.unload_start),
                sterilizer=t.sterilizer,
                ster_start=_dt(t.ster_start),
                line=t.line,
                fill_start=_dt(t.fill_start),
                fill_end=_dt(t.fill_end),
            )
            for t in plan.trucks.values()
        ],
    )


def build_result(
    sim: TwinSimulation,
    params: dict[str, float | int],
    seed: int,
    config: str = "A",
    plan: Plan | None = None,
    eta_forecast: dict[str, Forecast] | None = None,
    scenario: str = "normal",
    ai: AiOut | None = None,
) -> RunResult:
    """eta_forecast: kode truk -> prediksi keterlambatan (menit) terhadap ETA terjadwal."""
    eta_forecast = eta_forecast or {}

    def eta(code: str, q: float):
        f = eta_forecast.get(code)
        return None if f is None else _dt(sim.tankers[code].spec.scheduled_eta_min + f.at(q))

    return RunResult(
        run_id=sim.run_id,
        seed=seed,
        config=config,  # type: ignore[arg-type]
        scenario=scenario,
        params=params,
        sim_start=DAY_START,
        sim_end=_dt(sim.t_end),
        kpi=evaluate(sim),
        plan=_plan_out(plan) if plan else None,
        replans=[
            ReplanOut(
                version=r.version,
                at=_dt(r.at),
                trigger=r.trigger,
                status=r.status,
                trucks=r.trucks,
                objective=r.objective,
                solve_seconds=r.solve_seconds,
                plan=_plan_out(r.plan) if r.plan else None,
            )
            for r in sim.replans
        ],
        ai=ai,
        monte_carlo=(
            MonteCarloOut(
                samples=sim.mc.samples,
                chosen=sim.mc.chosen,
                candidates=[CandidateOut(**asdict(c)) for c in sim.mc.candidates],
                kpi_predicted=sim.mc.kpi_predicted,
            )
            if sim.mc
            else None
        ),
        tankers=[
            TankerOut(
                code=r.spec.code,
                farm_code=r.spec.farm_code,
                volume_ton=r.spec.volume_ton,
                temp_c=r.spec.temp_c,
                scheduled_eta=_dt(r.spec.scheduled_eta_min),
                status=r.status.value,
                outcome=r.outcome,
                arrived_at=_dt(r.arrived),
                lab_start=_dt(r.lab_start),
                lab_end=_dt(r.lab_end),
                released_at=_dt(r.released),
                unload_start=_dt(r.unload_start),
                unload_end=_dt(r.unload_end),
                analyst=r.analyst,
                lab_results=r.spec.lab_results,
                eta_p50=eta(r.spec.code, 0.5),
                eta_p80=eta(r.spec.code, 0.8),
                eta_p90=eta(r.spec.code, 0.9),
            )
            for r in sim.tankers.values()
        ],
        batches=[
            BatchOut(
                code=b.code,
                type=b.type,
                volume_ton=b.volume_ton,
                parents=b.parents,
                tanker_code=b.tanker,
                sku_code=b.sku,
                status=b.status,
            )
            for b in sim.batches.values()
        ],
        transfers=[
            TransferOut(
                from_asset=t.from_asset,
                to_asset=t.to_asset,
                batch_code=t.batch,
                volume_ton=t.volume_ton,
                occurred_at=_dt(t.t),
            )
            for t in sim.transfers
        ],
        gates=[
            GateOut(
                gate=g.gate,
                object_type=g.object_type,
                object_id=g.object_id,
                decision=g.decision,
                reason=g.reason,
                decided_at=_dt(g.t),
            )
            for g in sim.gate_log
        ],
        cips=[
            CipOut(
                asset_code=c.asset,
                started_at=_dt(c.start),
                finished_at=_dt(c.end),
                is_scheduled=c.scheduled,
            )
            for c in sim.cips
        ],
        events=sim.events,
    )
