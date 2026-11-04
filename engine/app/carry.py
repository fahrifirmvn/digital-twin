"""Operasi harian: keadaan yang terbawa dari satu hari ke hari berikutnya, ringkasan akhir hari,
dan kejadian acak per hari. Semuanya deterministik dari seed hari.

Satu hari selalu diselesaikan di dalam run-nya (tidak ada proses menggantung), jadi yang terbawa
adalah keadaan stabil: SKU terakhir tiap line (menentukan changeover), umur fouling sterilizer,
stok barang jadi, batch tertahan QA, dan truk yang tiba lewat batas hari."""

import random
from dataclasses import asdict, replace
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, Field

from app.generator import TankerSpec
from app.scenarios import Disturbance

if TYPE_CHECKING:
    from app.sim import TwinSimulation

DAY_MIN = 1440.0
FIRST_DAY = datetime.fromisoformat("2026-11-03")  # Hari 1 operasi
P_STER_DOWN = 0.30
P_TANK_DOWN = 0.20
P_BAD_MILK = 0.25


class CarryState(BaseModel):
    """Keadaan akhir hari D yang menjadi keadaan awal hari D+1. Versi 1."""

    version: int = 1
    day: int = Field(
        default=0, description="Hari yang menghasilkannya; 0 = belum ada hari berjalan"
    )
    line_sku: dict[str, str] = Field(default_factory=dict)
    fouling_min: dict[str, float] = Field(default_factory=dict)
    late_trucks: list[dict[str, Any]] = Field(
        default_factory=list,
        description="Truk yang tiba lewat batas hari, waktunya relatif hari berikut",
    )
    fg_stock_ton: float = 0.0
    qa_hold_ton: float = 0.0
    tank_cycles: dict[str, int] = Field(
        default_factory=dict,
        description="Siklus CIP tiap tangki sejak maintenance terakhir (meter servis)",
    )


def day_date(day: int) -> datetime:
    return FIRST_DAY + timedelta(days=day - 1)


def split_late(specs: list[TankerSpec]) -> tuple[list[TankerSpec], list[TankerSpec]]:
    """Truk yang tiba setelah batas hari ditunda ke hari berikut; sisanya dilayani hari ini."""
    today = [s for s in specs if s.arrival_min < DAY_MIN]
    late = [s for s in specs if s.arrival_min >= DAY_MIN]
    return today, late


def defer(spec: TankerSpec) -> dict[str, Any]:
    d = asdict(
        replace(
            spec,
            arrival_min=spec.arrival_min - DAY_MIN,
            scheduled_eta_min=spec.scheduled_eta_min - DAY_MIN,
            appears_min=0.0,
        )
    )
    return d


def inject_late(specs: list[TankerSpec], carry: CarryState) -> list[TankerSpec]:
    """Tambahkan truk tertunda dari kemarin; kodenya RT-T## agar tidak bentrok dengan hari ini."""
    taken = {s.plate for s in specs}
    out = list(specs)
    for i, d in enumerate(carry.late_trucks):
        plate = d.get("plate", "")
        out.append(
            TankerSpec(
                **{**d, "code": f"RT-T{i + 1:02d}", "plate": "" if plate in taken else plate}
            )
        )
    return sorted(out, key=lambda s: s.arrival_min)


def daily_incidents(
    seed: int,
) -> tuple[tuple[Disturbance, ...], int, tuple[tuple[float, str, str, str, float], ...]]:
    """Kejadian acak satu hari: (gangguan mesin, truk susu bermasalah tambahan, kejadian untuk dicatat).
    Kejadian = (menit, teks, jenis, kode aset, durasi)."""
    rng = random.Random(f"daily:{seed}")
    disturbances: list[Disturbance] = []
    notes: list[tuple[float, str, str, str, float]] = []
    r = rng.random()
    if r < P_STER_DOWN:
        k, start, dur = rng.randint(1, 5), rng.uniform(120, 1000), rng.uniform(45, 150)
        disturbances.append(Disturbance("ster_down", start, dur, asset=f"STE-{k}"))
        notes.append(
            (start, f"Sterilizer STE-{k} rusak {dur:.0f} menit", "machine", f"STE-{k}", dur)
        )
    elif r < P_STER_DOWN + P_TANK_DOWN:
        code = rng.choice(("TK-RAW-1", "TK-RAW-2", "TK-STO-1", "TK-STO-2"))
        start, dur = rng.uniform(120, 1000), rng.uniform(60, 180)
        disturbances.append(Disturbance("tank_down", start, dur, asset=code))
        notes.append((start, f"Tangki {code} perawatan darurat {dur:.0f} menit", "tank", code, dur))
    extra_bad = 1 if rng.random() < P_BAD_MILK else 0
    return tuple(disturbances), extra_bad, tuple(notes)


def _cleaned(sim: "TwinSimulation") -> list[str]:
    """Sterilizer yang mendekati batas fouling di akhir hari dibersihkan (CIP terjadwal) malam itu."""
    from app import wear

    return [
        r["asset_code"]
        for r in _fouling(sim)
        if r["run_min"] >= wear.NEAR * sim.cfg.fouling_max_min
    ]


def tank_cycles(sim: "TwinSimulation", carry_in: CarryState) -> dict[str, int]:
    """Meter servis tangki: tiap CIP menambah satu siklus; tangki yang selesai maintenance hari ini
    kembali ke nol (siklus CIP setelah maintenance di hari yang sama tetap dihitung)."""
    codes = [t.code for t in sim.raw.tanks + sim.storage.tanks]
    out: dict[str, int] = {}
    for code in codes:
        base = 0 if code in sim.serviced else carry_in.tank_cycles.get(code, 0)
        after = sum(
            1 for c in sim.cips if c.asset == code and c.start >= sim.serviced.get(code, 0.0)
        )
        out[code] = base + after
    return out


def carry_out(sim: "TwinSimulation", carry_in: CarryState, day: int) -> CarryState:
    cleaned = set(_cleaned(sim))
    fouling = {
        r["asset_code"]: 0.0 if r["asset_code"] in cleaned else r["run_min"] for r in _fouling(sim)
    }
    fgs = [b for b in sim.batches.values() if b.type == "fg"]
    held = sum(
        b.volume_ton
        for b in sim.batches.values()
        if b.type == "intermediate" and b.status == "held"
    )
    return CarryState(
        day=day,
        line_sku={code: s.code for code, s in sim.line_sku.items() if s is not None},
        fouling_min=fouling,
        tank_cycles=tank_cycles(sim, carry_in),
        late_trucks=[defer(s) for s in sim.deferred],
        fg_stock_ton=round(carry_in.fg_stock_ton + sum(b.volume_ton for b in fgs), 2),
        qa_hold_ton=round(carry_in.qa_hold_ton + held, 2),
    )


def _fouling(sim: "TwinSimulation") -> list[dict]:
    from app import wear

    return wear.fouling(sim)["sterilizers"]


def day_summary(sim: "TwinSimulation", carry_in: CarryState, day: int) -> dict[str, Any]:
    recs = list(sim.tankers.values())
    inters = [b for b in sim.batches.values() if b.type == "intermediate"]
    fgs = [b for b in sim.batches.values() if b.type == "fg"]
    received = sum(b.volume_ton for b in sim.batches.values() if b.type == "raw")
    rejected = sum(r.spec.volume_ton for r in recs if r.outcome in ("held_g1", "rejected_g2"))
    held = sum(b.volume_ton for b in inters if b.status == "held")
    processed = sum(b.volume_ton for b in inters if b.status != "held")
    released = sum(b.volume_ton for b in fgs)
    machine = [n[1] for n in sim.incident_notes]
    issues = list(machine)
    n_g1 = sum(1 for r in recs if r.outcome == "held_g1")
    n_g2 = sum(1 for r in recs if r.outcome == "rejected_g2")
    if n_g1:
        issues.append(f"{n_g1} truk ditahan di gerbang (G1)")
    if n_g2:
        issues.append(f"{n_g2} truk ditolak uji lab (G2)")
    if held > 0:
        issues.append(f"{held:.1f} ton ditahan QA")
    if sim.deferred:
        issues.append(f"{len(sim.deferred)} truk terlambat, dilayani besok")
    cleaned = _cleaned(sim)
    if cleaned:
        issues.append(f"CIP terjadwal malam ini: {', '.join(cleaned)}")
    n_late_in = len(carry_in.late_trucks)
    overtime = max(0.0, sim.t_end - DAY_MIN)
    if overtime > 0:
        issues.append(f"Produksi baru selesai pukul {sim.at(sim.t_end):%H:%M} hari berikutnya")
    return {
        "day": day,
        "date": sim.day0.date().isoformat(),
        "trucks": len(recs),
        "late_carried_in": n_late_in,
        "received_ton": round(received, 2),
        "rejected_ton": round(rejected, 2),
        "processed_ton": round(processed, 2),
        "released_ton": round(released, 2),
        "qa_hold_ton": round(held, 2),
        "stock_ton": round(carry_in.fg_stock_ton + released, 2),
        "overtime_min": round(overtime, 1),
        "issues": issues,
    }
