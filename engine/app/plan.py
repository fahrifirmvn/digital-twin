"""Rencana jadwal: urutan dan preferensi aset per truk. Waktu rencana dipakai sebagai kunci prioritas dan
sebagai pembanding ketepatan; simulator tetap menjalankan dispatch sesuai kondisi nyata."""

from dataclasses import dataclass, field


@dataclass(frozen=True)
class TruckPlan:
    code: str
    analyst: str
    lab_start: float
    bay: str
    unload_start: float
    sterilizer: int
    ster_start: float
    line: str
    fill_start: float
    fill_end: float


@dataclass
class Plan:
    config: str  # B atau C (A = FIFO, tanpa rencana)
    trucks: dict[str, TruckPlan]
    status: str = "optimal"  # optimal, feasible
    objective: float | None = None
    solve_seconds: float = 0.0
    quantile: float | None = None  # kuantil durasi yang dipakai solver, None = rata-rata
    weights: dict[str, float] = field(default_factory=dict)
