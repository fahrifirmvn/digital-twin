import threading
import time
from dataclasses import dataclass, field
from typing import Any

import simpy.rt

from app.carry import CarryState
from app.commands import MAX_COMMANDS, Command
from app.contracts.events import SimClock
from app.contracts.result import RunFailure, RunResult
from app.experiment import CONFIGS, simulate
from app.kpi import build_result
from app.live import LiveEnvironment
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
    live: bool = False
    receipts: dict[str, dict[str, Any]] = field(default_factory=dict)


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
        live: bool = False,
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
        run.live = live
        run.plant = plant
        run.commands = commands
        run.day, run.carry, run.date = day, carry, date
        run.thread = threading.Thread(target=self._execute, args=(run,), daemon=True)
        run.thread.start()
        return run

    def control(self, run: Run, action: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not run.live or not run.sim or not isinstance(run.sim.env, LiveEnvironment):
            raise ValueError("Run belum siap menerima perintah live.")
        sim = run.sim
        env = sim.env
        if action in {"maintenance", "qa"}:
            with env.lock:
                receipt = run.receipts.get(str(payload["request_id"]))
                if receipt:
                    fingerprint = {k: v for k, v in payload.items() if k != "request_id"}
                    if action == "qa":
                        fingerprint["control"] = "qa"
                    if receipt["input"] != fingerprint:
                        raise ValueError("ID perintah sudah digunakan dengan isi berbeda.")
                    return receipt["result"]

        def apply() -> dict[str, Any]:
            if run.status != "running":
                raise ValueError("Hari sudah selesai.")
            if action == "speed":
                env.speed = float(payload["speed"])
                run.speed = env.speed
                sim.speed = env.speed
                sim.emit(SimClock(speed=env.speed, paused=False))
                return {"minute": float(env.now), "speed": env.speed}
            if action == "qa":
                key = str(payload["request_id"])
                fingerprint = {k: v for k, v in payload.items() if k != "request_id"} | {
                    "control": "qa"
                }
                if key in run.receipts:
                    if run.receipts[key]["input"] != fingerprint:
                        raise ValueError("ID perintah sudah digunakan dengan isi berbeda.")
                    return run.receipts[key]["result"]
                result = sim.qa_control(payload)
                run.receipts[key] = {"input": fingerprint, "result": result}
                return result
            if action != "maintenance":
                raise ValueError("Perintah live tidak dikenal.")
            request_id = str(payload["request_id"])
            fingerprint = {k: v for k, v in payload.items() if k != "request_id"}
            if request_id in run.receipts:
                receipt = run.receipts[request_id]
                if receipt["input"] != fingerprint:
                    raise ValueError("ID perintah sudah digunakan dengan isi berbeda.")
                return receipt["result"]
            minute = payload.get("start_min")
            minute = float(env.now) if minute is None else float(minute)
            if minute < env.now or minute >= 1440:
                raise ValueError("Waktu maintenance harus sekarang atau di masa depan hari aktif.")
            cmd = Command(
                minute,
                "tank_down",
                payload["actor"],
                payload["reason"],
                asset=payload["asset"],
                duration_min=payload["duration_min"],
                request_id=request_id,
            ).normalized(sim.cfg)
            assert cmd.asset is not None and cmd.duration_min is not None
            if len(run.commands) >= MAX_COMMANDS:
                raise ValueError("Batas perintah hari ini tercapai.")
            pool = sim.raw if cmd.asset.startswith("TK-RAW") else sim.storage
            tank = next(t for t in pool.tanks if t.code == cmd.asset)
            if tank.down:
                raise ValueError("Tangki sudah menunggu atau menjalani maintenance.")
            for existing in run.commands:
                if (
                    existing.asset == cmd.asset
                    and existing.minute < minute + cmd.duration_min
                    and minute < existing.minute + (existing.duration_min or 0)
                ):
                    raise ValueError("Jadwal maintenance tangki bertumpuk.")
            run.commands += (cmd,)
            sim.commands += (cmd,)
            sim.env.process(sim._command(len(run.commands), cmd))
            sim.env.process(pool.maintain(cmd.asset, cmd.minute, cmd.duration_min, request_id))
            result = {
                "request_id": request_id,
                "status": "accepted",
                "start_min": minute,
                "minute": float(env.now),
                "speed": env.speed,
                "command_id": len(run.commands),
            }
            run.receipts[request_id] = {"input": fingerprint, "result": result}
            return result

        return env.submit(apply)

    def snapshot(self, run: Run, after: int = -1) -> dict[str, Any]:
        if run.live and not run.sim and run.status == "running":
            return {
                "minute": 0.0,
                "speed": run.speed or 1,
                "preparing": True,
                "status": run.status,
                "events": [],
            }
        if not run.live or not run.sim or not isinstance(run.sim.env, LiveEnvironment):
            raise ValueError("Run bukan operasi live atau persiapan Engine gagal.")
        with run.sim.env.lock:
            return {
                "minute": float(run.sim.env.now),
                "speed": run.sim.env.speed,
                "status": run.status,
                "events": [e.model_dump(mode="json") for e in run.sim.events if e.seq > after],
            }

    def _heartbeat(self, run: Run):
        assert run.sim is not None
        while run.sim.env.now < 1440:
            yield run.sim.env.timeout(min(1, 1440 - run.sim.env.now))
            run.sim.emit(SimClock(speed=run.speed or 1, paused=False))

    def close(self) -> None:
        for run in self._runs.values():
            if run.sim and isinstance(run.sim.env, LiveEnvironment):
                run.sim.env.close()
            if run.live and run.thread:
                run.thread.join(timeout=1)

    def _execute(self, run: Run) -> None:
        try:
            speed = run.speed
            env = (
                LiveEnvironment(speed or 1)
                if run.live
                else (
                    simpy.rt.RealtimeEnvironment(factor=1 / speed, strict=False) if speed else None
                )
            )
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
            if run.live:
                assert isinstance(env, LiveEnvironment)
                env.anchor = time.monotonic()
                run.sim.env.process(self._heartbeat(run))
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
            if isinstance(env, LiveEnvironment):
                env.close()
            if self.relay:
                run.delivered = self.relay.send_result(run.id, run.result.model_dump_json())
        except Exception as exc:  # noqa: BLE001 - status run harus selalu terisi
            run.status, run.error = "failed", repr(exc)
            if self.relay:
                failure = RunFailure(run_id=run.id, error=run.error)
                self.relay.send_result(run.id, failure.model_dump_json())
        finally:
            if run.sim and isinstance(run.sim.env, LiveEnvironment):
                run.sim.env.close()
