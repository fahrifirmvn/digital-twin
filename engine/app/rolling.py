"""Re-optimization bergulir (PRD 10.2): rencana disusun ulang dari keadaan simulasi yang sedang berjalan.

Pemicu: periodik (tiap `period` menit), truk dadakan yang baru tiba, dan aset mati. Tahap yang sudah mulai
dikunci. Truk yang belum tiba hanya dikenal lewat ETA terjadwal dan prediksi Predictor, tidak pernah lewat
`arrival_min` sebenarnya (tanpa kebocoran masa depan). Bila solver tidak menemukan solusi, rencana lama
dipertahankan dan kegagalan dicatat.
"""

import math
from collections.abc import Generator
from dataclasses import dataclass, replace
from typing import Any

import simpy

from app.contracts.events import ScheduleReplanned
from app.plan import Plan
from app.plant import PlantConfig
from app.predictor import Predictor
from app.scheduler import Frozen, Job, Pin, SchedulingError, solve
from app.sim import SKU_BY_CODE, TankerRecord, TwinSimulation


@dataclass(frozen=True)
class Replan:
    version: int
    at: float
    trigger: str
    status: str  # optimal, feasible, failed
    trucks: int
    objective: float | None
    solve_seconds: float
    plan: Plan | None  # hanya truk yang direncanakan ulang


def _idx(code: str | None) -> int:
    return int(code.split("-")[1]) - 1 if code else 0


def _pin(rec: TankerRecord) -> Pin:
    f = math.floor
    return Pin(
        lab=(f(rec.lab_start), _idx(rec.analyst)) if rec.lab_start is not None else None,
        unl=(f(rec.unload_start), _idx(rec.bay)) if rec.unload_start is not None else None,
        prc=f(rec.proc_start) if rec.proc_start is not None else None,
        ste=(f(rec.ster_start), _idx(rec.sterilizer)) if rec.ster_start is not None else None,
        fil=(f(rec.fill_start), _idx(rec.line))
        if rec.line and rec.fill_start is not None
        else None,
    )


def build_state(
    sim: TwinSimulation, predictor: Predictor, quantile: float
) -> tuple[list[Job], Frozen]:
    """Keadaan saat ini sebagai daftar job dan kunci. Truk selesai atau ditolak tidak ikut."""
    now = math.ceil(sim.env.now)
    live = [
        r
        for r in sim.tankers.values()
        if r.outcome == "in_progress" and (r.arrived is not None or r.spec.announced)
    ]
    specs = [r.spec for r in live]
    delay = predictor.forecast("eta_delay", specs)
    lab = predictor.forecast("lab_duration", specs)
    jobs, pins = [], {}
    for r, dly, lb in zip(live, delay, lab, strict=True):
        s = r.spec
        if r.arrived is not None:
            arrival = math.floor(r.arrived)
        else:
            arrival = max(now, round(s.scheduled_eta_min + dly.p50))
        lab_d = max(1, math.ceil(lb.at(quantile)))
        if r.lab_end is not None:
            lab_d = max(1, math.floor(r.lab_end - (r.lab_start or 0.0)))
        elif r.lab_start is not None:
            lab_d = max(lab_d, math.floor(sim.env.now - r.lab_start) + 1)
        jobs.append(Job(s.code, s.volume_ton, arrival, lab_d, SKU_BY_CODE[s.sku_code]))
        pins[s.code] = _pin(r)
    downtimes = tuple(
        (_idx(d.asset), math.floor(d.start), math.ceil(d.end))
        for d in sim.downtimes
        if d.end > sim.env.now
    )
    line_sku = {_idx(code): sku for code, sku in sim.line_sku.items() if sku is not None}
    frozen = Frozen(now, pins, downtimes, line_sku, sim.plan)
    return jobs, frozen


class Replanner:
    def __init__(
        self,
        sim: TwinSimulation,
        cfg: PlantConfig,
        predictor: Predictor,
        quantile: float = 0.8,
        time_limit: float = 1.5,
        period: float = 120.0,
        min_gap: float = 20.0,
        tick: float = 10.0,
    ):
        self.sim, self.cfg, self.predictor = sim, cfg, predictor
        self.quantile, self.time_limit = quantile, time_limit
        self.period, self.min_gap, self.tick = period, min_gap, tick
        self.records: list[Replan] = sim.replans
        self.last = 0.0
        sim.rolling = True
        sim.env.process(self._run())
        sim.env.process(self._ticker())

    def _ticker(self) -> Generator[simpy.Event, Any, None]:
        """Pemicu periodik. Melangkah kecil agar proses berhenti cepat setelah semua truk selesai."""
        while not self.sim.all_done():
            yield self.sim.env.timeout(self.tick)
            if self.sim.env.now - self.last >= self.period:
                self.sim.signal("periodic")

    def _run(self) -> Generator[simpy.Event, Any, None]:
        sim = self.sim
        while True:
            trigger = yield sim.replan_signal
            if sim.all_done():
                return
            gap = self.min_gap - (sim.env.now - self.last)
            if gap > 0:  # pemicu yang berdekatan digabung jadi satu replan
                yield sim.env.timeout(gap)
            if sim.all_done():
                return
            self._replan(trigger)

    def _solve(self, jobs: list[Job], frozen: Frozen, time_limit: float) -> Plan:
        plan = self.sim.plan
        return solve(
            jobs,
            self.cfg,
            plan.config if plan else "D",
            plan.weights if plan else None,
            time_limit,
            self.quantile,
            frozen,
        )

    def _replan(self, trigger: str) -> None:
        sim = self.sim
        self.last = sim.env.now
        jobs, frozen = build_state(sim, self.predictor, self.quantile)
        if not jobs:
            return
        version = len(self.records) + 2
        try:
            try:
                new = self._solve(jobs, frozen, self.time_limit)
            except SchedulingError:  # sekali lagi dengan waktu lebih panjang
                new = self._solve(jobs, frozen, self.time_limit * 3)
        except SchedulingError:
            self.records.append(
                Replan(version, sim.env.now, trigger, "failed", len(jobs), None, 0.0, None)
            )
            sim.emit(
                ScheduleReplanned(
                    version=version, trigger=trigger, status="failed", trucks=len(jobs)
                )
            )
            return
        assert sim.plan is not None
        sim.plan = replace(new, trucks={**sim.plan.trucks, **new.trucks})
        sim.plan_log.append((sim.env.now, trigger, sim.plan))
        self.records.append(
            Replan(
                version,
                sim.env.now,
                trigger,
                new.status,
                len(jobs),
                new.objective,
                new.solve_seconds,
                new,
            )
        )
        sim.emit(
            ScheduleReplanned(
                version=version,
                trigger=trigger,
                status=new.status,
                objective=new.objective,
                trucks=len(jobs),
            )
        )
