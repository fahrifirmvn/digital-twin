"""Rencana jadwal: urutan dan preferensi aset per truk. Waktu rencana dipakai sebagai kunci prioritas dan
sebagai pembanding ketepatan; simulator tetap menjalankan dispatch sesuai kondisi nyata."""

from dataclasses import dataclass, field
from typing import Any


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
    status: str = "optimal"  # optimal, feasible, heuristic
    objective: float | None = None
    solve_seconds: float = 0.0
    quantile: float | None = None  # kuantil durasi yang dipakai solver, None = rata-rata
    weights: dict[str, float] = field(default_factory=dict)
    diagnostics: dict[str, Any] = field(default_factory=dict)


def explain_truck_binding(
    tp: TruckPlan,
    prev_bay_truck: str | None = None,
    prev_line_truck: str | None = None,
    same_sku_on_line: bool = False,
    holding_slack_min: float | None = None,
) -> str:
    """Identifikasi pembatas aktif (binding constraint) utama yang menentukan jadwal sebuah truk."""
    reasons: list[str] = []
    if holding_slack_min is not None and holding_slack_min <= 45:
        reasons.append(f"jaga batas holding G4 (+{round(holding_slack_min)} mnt)")
    if prev_bay_truck:
        reasons.append(f"antre {tp.bay} setelah {prev_bay_truck}")
    else:
        reasons.append(f"langsung masuk {tp.bay} pasca-rilis G2")
    if prev_line_truck:
        if same_sku_on_line:
            reasons.append(f"kampanye SKU sama di {tp.line} (0 mnt changeover)")
        else:
            reasons.append(f"urutan {tp.line} setelah {prev_line_truck}")
    return " · ".join(reasons)
