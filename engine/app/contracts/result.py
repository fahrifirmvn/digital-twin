"""Kontrak hasil run: dikirim Engine ke Laravel saat run selesai (PRD 8.1, 3.1). Sumber tunggal."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.contracts.events import TwinEvent


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Stat(Strict):
    n: int
    mean: float | None = None
    p90: float | None = None
    max: float | None = None


class Kpi(Strict):
    """Definisi KPI mengikuti PRD 3.1. Satuan menit kecuali dinyatakan lain."""

    truck_wait_min: Stat = Field(description="Tiba sampai mulai bongkar")
    lab_wait_min: Stat = Field(description="Tiba (sampling) sampai hasil uji dirilis")
    tank_dwell_min: Stat = Field(description="Selesai bongkar sampai mulai sterilisasi")
    unscheduled_cip: int
    utilization_pct: dict[str, float] = Field(description="Persen waktu in_use per tipe aset")
    packaging_reject_pct: float = Field(
        description="Persen batch intermediate terdampak changeover atau ditahan QA"
    )
    schedule_adherence_pct: float | None = Field(
        default=None,
        description="Persen truk selesai filling dalam +-30 menit dari rencana yang berlaku saat bongkar "
        "dimulai. Null untuk baseline tanpa rencana (A)",
    )
    false_accept: int = Field(description="Tanker tidak layak yang lolos sampai selesai")
    holding_violations: int = Field(description="Batch diproses melewati holding time")
    trace_coverage_pct: float = Field(description="FG lot dengan rantai lengkap sampai tanker")
    trucks: int
    completed: int
    held_g1: int
    rejected_g2: int
    held_qa: int
    raw_ton: float
    fg_ton: float
    changeover_count: int
    changeover_min: float
    gate_holds: dict[str, int]
    makespan_min: float


class TankerOut(Strict):
    code: str
    farm_code: str
    volume_ton: float
    temp_c: float
    scheduled_eta: datetime
    status: str
    outcome: str
    arrived_at: datetime | None
    lab_start: datetime | None
    lab_end: datetime | None
    released_at: datetime | None
    unload_start: datetime | None
    unload_end: datetime | None
    analyst: str | None
    lab_results: dict[str, float | bool]
    eta_p50: datetime | None = Field(default=None, description="Prediksi kedatangan (kuantil)")
    eta_p80: datetime | None = None
    eta_p90: datetime | None = None


class AiTruckOut(Strict):
    """Prediksi model AI per truk (ML hanya memprediksi; gate dan CP-SAT tetap memutuskan)."""

    code: str
    transit_p50_min: float = Field(description="Durasi transit peternakan -> gerbang")
    transit_p80_min: float
    transit_p90_min: float
    delay_p50_min: float = Field(
        description="Transit prediksi dikurangi transit tipikal peternakan"
    )
    delay_p80_min: float
    delay_p90_min: float
    lab_p50_min: float
    lab_p90_min: float
    qc_release_prob: float = Field(ge=0, le=1, description="Peluang lolos QC (terkalibrasi)")


class AiAnomalyOut(Strict):
    risk_score: float = Field(ge=0, le=1)
    is_anomaly: bool
    flags: list[str]
    balance_residual_l: float
    batch_age_h: float
    flow_deviation_pct: float


class AiOut(Strict):
    label: str = Field(description="Selalu DATA SINTETIS")
    models: dict[str, str] = Field(description="Nama model -> hash data latih")
    trucks: list[AiTruckOut]
    anomaly: AiAnomalyOut


class TruckPlanOut(Strict):
    code: str
    analyst: str
    lab_start: datetime
    bay: str
    unload_start: datetime
    sterilizer: int
    ster_start: datetime
    line: str
    fill_start: datetime
    fill_end: datetime


class PlanOut(Strict):
    """Jadwal yang dihitung scheduler (konfigurasi B, C, atau D)."""

    config: Literal["B", "C", "D"]
    status: str = Field(description="optimal, feasible, atau heuristic (fallback tanpa solver)")
    objective: float | None
    solve_seconds: float
    quantile: float | None = Field(description="Kuantil durasi yang dipakai; null = rata-rata")
    weights: dict[str, float]
    trucks: list[TruckPlanOut]


class ReplanOut(Strict):
    """Satu kali re-optimization bergulir (konfigurasi D). `plan` hanya berisi truk yang direncanakan ulang."""

    version: int = Field(ge=2)
    at: datetime
    trigger: str
    status: str = Field(description="optimal, feasible, atau failed (rencana lama dipertahankan)")
    trucks: int
    objective: float | None
    solve_seconds: float
    plan: PlanOut | None


class CandidateOut(Strict):
    label: str
    config: Literal["B", "C"]
    quantile: float | None
    status: str
    objective: float | None
    solve_seconds: float
    mean_cost: float
    cvar80_cost: float
    score: float


class MonteCarloOut(Strict):
    """Seleksi rencana D: kandidat dievaluasi pada sampel skenario, prediksi KPI dari kandidat terpilih."""

    samples: int
    chosen: str
    candidates: list[CandidateOut]
    kpi_predicted: dict[str, dict[str, float]] = Field(description="mean, p10, p90 per metrik")


class BatchOut(Strict):
    code: str
    type: str
    volume_ton: float
    parents: list[str]
    tanker_code: str | None
    sku_code: str | None
    status: str


class TransferOut(Strict):
    from_asset: str
    to_asset: str
    batch_code: str
    volume_ton: float
    occurred_at: datetime


class GateOut(Strict):
    gate: str
    object_type: str
    object_id: str
    decision: str
    reason: str | None
    decided_at: datetime


class CipOut(Strict):
    asset_code: str
    started_at: datetime
    finished_at: datetime
    is_scheduled: bool


class RunResult(Strict):
    status: Literal["finished"] = "finished"
    run_id: int
    seed: int
    config: Literal["A", "B", "C", "D"] = "A"
    scenario: str = "normal"
    params: dict[str, float | int]
    sim_start: datetime
    sim_end: datetime
    kpi: Kpi
    plan: PlanOut | None = Field(default=None, description="Rencana awal (versi 1)")
    replans: list[ReplanOut] = Field(default_factory=list)
    monte_carlo: MonteCarloOut | None = None
    ai: AiOut | None = Field(
        default=None, description="Prediksi model AI; null bila model tidak dimuat"
    )
    tankers: list[TankerOut]
    batches: list[BatchOut]
    transfers: list[TransferOut]
    gates: list[GateOut]
    cips: list[CipOut]
    events: list[TwinEvent]


class RunFailure(Strict):
    status: Literal["failed"] = "failed"
    run_id: int
    error: str
