"""Seleksi rencana dengan Monte Carlo (PRD 10.2, konfigurasi D).

Tiap kandidat rencana (B, C kuantil 0.8, C kuantil 0.9) dijalankan di simulator pada sampel skenario
keterlambatan truk dan durasi uji lab. Sampel diambil dari residual terstandar model pada data kalibrasi yang
tidak dipakai melatih. Skor = 0.5 * rata-rata + 0.5 * CVaR80 dari biaya, jadi rencana yang jarang buruk
menang atas rencana yang bagus rata-rata tetapi rapuh. Hanya truk terumumkan yang dihasilkan sampel.
"""

import math
import random
from dataclasses import dataclass, replace
from functools import cache

from app.generator import TankerSpec
from app.kpi import evaluate
from app.plan import Plan
from app.plant import PlantConfig
from app.predictor import Predictor, _target, history
from app.scheduler import DUE_MIN, SchedulingError, make_plan
from app.sim import TwinSimulation

CALIB_SEED0 = 70_000
CALIB_DAYS = 30
HELD_QA_PENALTY = 500.0  # satu truk berakhir di QA hold dianggap setara 500 menit menunggu
CANDIDATES = (("B", "B", None), ("C80", "C", 0.8), ("C90", "C", 0.9))


@dataclass(frozen=True)
class Candidate:
    label: str
    config: str
    quantile: float | None
    status: str
    objective: float | None
    solve_seconds: float
    mean_cost: float
    cvar80_cost: float
    score: float


@dataclass(frozen=True)
class MonteCarlo:
    samples: int
    chosen: str
    candidates: list[Candidate]
    kpi_predicted: dict[str, dict[str, float]]


@cache
def calibration(predictor: Predictor) -> dict[str, list[float]]:
    """Residual terstandar z = (y - p50) / (p90 - p50 + 1) pada data yang tidak dipakai melatih."""
    calib = history(CALIB_DAYS, CALIB_SEED0)
    out = {}
    for target in ("eta_delay", "lab_duration"):
        fc = predictor.forecast(target, calib)
        out[target] = [
            (_target(target, s) - f.p50) / (f.p90 - f.p50 + 1.0)
            for s, f in zip(calib, fc, strict=True)
        ]
    return out


def sample_specs(
    specs: list[TankerSpec], predictor: Predictor, rng: random.Random
) -> list[TankerSpec]:
    """Satu skenario: tiap truk mendapat keterlambatan dan durasi lab baru dari residual terstandar."""
    cal = calibration(predictor)
    delay = predictor.forecast("eta_delay", specs)
    lab = predictor.forecast("lab_duration", specs)
    out = []
    for s, d, lb in zip(specs, delay, lab, strict=True):
        zd, zl = rng.choice(cal["eta_delay"]), rng.choice(cal["lab_duration"])
        arrival = max(0.0, s.scheduled_eta_min + d.p50 + zd * (d.p90 - d.p50 + 1.0))
        lab_min = min(240.0, max(25.0, lb.p50 + zl * (lb.p90 - lb.p50 + 1.0)))
        out.append(replace(s, arrival_min=arrival, lab_duration_min=lab_min))
    return sorted(out, key=lambda s: s.arrival_min)


def sample_cost(sim: TwinSimulation) -> float:
    """Biaya skalar satu hari: menunggu + 2 x dwell + changeover + keterlambatan + penalti QA hold."""
    cost = 0.0
    for r in sim.tankers.values():
        if r.unload_start is not None and r.arrived is not None:
            cost += r.unload_start - r.arrived
        if r.ster_start is not None and r.unload_end is not None:
            cost += 2 * (r.ster_start - r.unload_end)
        if r.outcome == "completed" and r.fill_end is not None and r.arrived is not None:
            cost += max(0.0, r.fill_end - (r.arrived + DUE_MIN))
        if r.outcome == "held_qa":
            cost += HELD_QA_PENALTY
    return cost + sum(m for _, m in sim.changeovers)


def _quantiles(xs: list[float]) -> dict[str, float]:
    s = sorted(xs)
    pick = lambda q: s[min(len(s) - 1, int(q * len(s)))]  # noqa: E731
    return {
        "mean": round(sum(s) / len(s), 2),
        "p10": round(pick(0.1), 2),
        "p90": round(pick(0.9), 2),
    }


def _score(costs: list[float]) -> tuple[float, float, float]:
    mean = sum(costs) / len(costs)
    k = max(1, math.ceil(0.2 * len(costs)))
    cvar = sum(sorted(costs)[-k:]) / k
    return mean, cvar, 0.5 * mean + 0.5 * cvar


def select_plan(
    specs: list[TankerSpec],
    cfg: PlantConfig,
    predictor: Predictor,
    seed: int,
    samples: int = 12,
    time_limit: float = 3.0,
) -> tuple[Plan, MonteCarlo]:
    """Pilih rencana terbaik dari kandidat. `specs` harus hanya truk yang sudah diumumkan."""
    rng = random.Random(f"mc:{seed}")
    scenarios = [sample_specs(specs, predictor, rng) for _ in range(samples)]
    plans: list[tuple[str, str, float | None, Plan]] = []
    for label, config, q in CANDIDATES:
        try:
            plans.append(
                (label, config, q, make_plan(specs, cfg, config, predictor, time_limit, q or 0.8))
            )
        except SchedulingError:
            continue
    if not plans:
        raise SchedulingError("tidak ada kandidat rencana yang layak")

    scored: list[Candidate] = []
    metrics: dict[str, dict[str, list[float]]] = {}
    for label, config, q, plan in plans:
        costs: list[float] = []
        m: dict[str, list[float]] = {k: [] for k in METRICS}
        for k, sc in enumerate(scenarios):
            sim = TwinSimulation(sc, cfg, seed=seed * 1000 + k, plan=plan).run()
            costs.append(sample_cost(sim))
            kpi = evaluate(sim)
            m["cost"].append(costs[-1])
            m["truck_wait_mean_min"].append(kpi.truck_wait_min.mean or 0.0)
            m["tank_dwell_mean_min"].append(kpi.tank_dwell_min.mean or 0.0)
            m["changeover_min"].append(kpi.changeover_min)
            m["fg_ton"].append(kpi.fg_ton)
            m["holding_violations"].append(float(kpi.holding_violations))
            m["schedule_adherence_pct"].append(kpi.schedule_adherence_pct or 0.0)
        metrics[label] = m
        mean, cvar, score = _score(costs)
        scored.append(
            Candidate(
                label,
                config,
                q,
                plan.status,
                plan.objective,
                plan.solve_seconds,
                round(mean, 1),
                round(cvar, 1),
                round(score, 1),
            )
        )
    best = min(scored, key=lambda c: (c.score, c.label))
    chosen = next(p for label, _, _, p in plans if label == best.label)
    chosen = replace(chosen, config="D")
    mc = MonteCarlo(
        samples=samples,
        chosen=best.label,
        candidates=scored,
        kpi_predicted={k: _quantiles(v) for k, v in metrics[best.label].items()},
    )
    return chosen, mc


METRICS = (
    "cost",
    "truck_wait_mean_min",
    "tank_dwell_mean_min",
    "changeover_min",
    "fg_ton",
    "holding_violations",
    "schedule_adherence_pct",
)
