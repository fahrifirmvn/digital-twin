import threading
from dataclasses import dataclass, field

import simpy.rt

from app.carry import CarryState
from app.commands import Command
from app.contracts.result import RunFailure, RunResult
from app.experiment import CONFIGS, simulate
from app.kpi import build_result
from app.ml.service import active_predictor, build_ai
from app.plan import Plan
from app.plant import PlantConfig
from app.relay import Relay
from app.scenarios import get_scenario
from app.sim import TwinSimulation


class DuplicateRunError(Exception):
    pass


@dataclass
class Run:
    id: int
    seed: int
    volume_ton: float
    extra_bad: int = 0
    config: str = "A"
    scenario: str = "normal"
    speed: float | None = None
    plant: PlantConfig | None = None  # None = pabrik bawaan
    commands: tuple[Command, ...] = ()  # perintah mode Simulasi
    day: int | None = None  # nomor hari operasi
    carry: CarryState | None = None
    date: str | None = None
    status: str = "running"  # running, finished, failed
    error: str | None = None
    delivered: bool = False  # hasil sudah diterima Laravel
    sim: TwinSimulation | None = None  # baru terisi setelah rencana (B/C) selesai dihitung
    plan: Plan | None = None
    result: RunResult | None = None
    thread: threading.Thread | None = field(default=None, repr=False)


class RunManager:
    def __init__(self, relay: Relay | None = None):
        self.relay = relay
        self._runs: dict[int, Run] = {}
        self._lock = threading.Lock()

    def get(self, run_id: int) -> Run | None:
        return self._runs.get(run_id)

    def start(
        self,
        run_id: int,
        seed: int,
        volume_ton: float,
        extra_bad: int = 0,
        speed: float | None = None,
        config: str = "A",
        scenario: str = "normal",
        plant: PlantConfig | None = None,
        commands: tuple[Command, ...] = (),
        day: int | None = None,
        carry: CarryState | None = None,
        date: str | None = None,
    ) -> Run:
        """run_id dialokasikan Laravel. speed = menit simulasi per detik nyata, None = secepat mungkin.

        config B/C/D: jadwal dihitung CP-SAT di thread run sebelum simulasi berjalan.
        """
        if config not in CONFIGS:
            raise ValueError(f"config {config!r} tidak dikenal")
        get_scenario(scenario)  # ValueError bila tidak dikenal
        with self._lock:
            if run_id in self._runs:
                raise DuplicateRunError(run_id)
            run = Run(run_id, seed, volume_ton, extra_bad, config, scenario)
            self._runs[run_id] = run
        run.speed = speed
        run.plant = plant
        run.commands = commands
        run.day, run.carry, run.date = day, carry, date
        run.thread = threading.Thread(target=self._execute, args=(run,), daemon=True)
        run.thread.start()
        return run

    def _execute(self, run: Run) -> None:
        try:
            speed = run.speed
            env = simpy.rt.RealtimeEnvironment(factor=1 / speed, strict=False) if speed else None
            run.sim, run.plan = simulate(
                run.config,
                run.seed,
                run.volume_ton,
                run.extra_bad,
                run_id=run.id,
                env=env,
                sink=self.relay.publish if self.relay else None,
                speed=speed or 0.0,
                scenario=run.scenario,
                cfg=run.plant,
                commands=run.commands,
                day=run.day,
                carry=run.carry,
                date=run.date,
            )
            run.sim.run()
            # Prediksi ETA hanya untuk truk yang diumumkan; truk dadakan tidak punya jadwal.
            specs = [r.spec for r in run.sim.tankers.values() if r.spec.announced]
            delay = active_predictor().forecast("eta_delay", specs)
            volume, extra_bad = get_scenario(run.scenario).apply(run.volume_ton, run.extra_bad)
            run.result = build_result(
                run.sim,
                {"volume_ton": volume, "extra_bad": extra_bad},
                run.seed,
                config=run.config,
                plan=run.plan,
                eta_forecast={s.code: f for s, f in zip(specs, delay, strict=True)},
                scenario=run.scenario,
                ai=build_ai(run.sim),
            )
            run.status = "finished"
            if self.relay:
                run.delivered = self.relay.send_result(run.id, run.result.model_dump_json())
        except Exception as exc:  # noqa: BLE001 - status run harus selalu terisi
            run.status, run.error = "failed", repr(exc)
            if self.relay:
                failure = RunFailure(run_id=run.id, error=run.error)
                self.relay.send_result(run.id, failure.model_dump_json())
