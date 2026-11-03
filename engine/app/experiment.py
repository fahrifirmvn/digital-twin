"""Satu jalur untuk menjalankan konfigurasi A (FIFO), B, C, atau D pada hari dan skenario yang sama (PRD 10.7)."""

from collections.abc import Callable

import simpy

from app.carry import CarryState, daily_incidents, inject_late, split_late
from app.commands import Command, expand
from app.contracts.events import TwinEvent
from app.generator import generate_day
from app.mc import select_plan
from app.ml.service import active_predictor
from app.plan import Plan
from app.plant import PlantConfig
from app.rolling import Replanner
from app.scenarios import Disturbance, get_scenario
from app.scheduler import make_plan
from app.sim import TwinSimulation

CONFIGS = ("A", "B", "C", "D")


def simulate(
    config: str,
    seed: int,
    volume_ton: float,
    extra_bad: int = 0,
    run_id: int = 1,
    time_limit: float = 10.0,
    env: simpy.Environment | None = None,
    sink: Callable[[TwinEvent], None] | None = None,
    speed: float = 1.0,
    scenario: str = "normal",
    cfg: PlantConfig | None = None,
    commands: tuple[Command, ...] = (),
    day: int | None = None,
    carry: CarryState | None = None,
    date: str | None = None,
) -> tuple[TwinSimulation, Plan | None]:
    """Hari dan seed yang sama menghasilkan truk yang sama di semua konfigurasi.

    Perencana hanya melihat truk yang diumumkan. D = pilihan Monte Carlo + replan bergulir.
    `commands` (mode Simulasi) hanya menambah gangguan dan truk dadakan di atas hari dasar.
    `day` mengaktifkan operasi harian: kejadian acak per hari, truk tertunda ditunda ke besok,
    dan keadaan awal dari `carry` (hasil hari sebelumnya)."""
    if config not in CONFIGS:
        raise ValueError(f"config {config!r} tidak dikenal")
    sc = get_scenario(scenario)
    volume_ton, extra_bad = sc.apply(volume_ton, extra_bad)
    incidents: tuple[Disturbance, ...] = ()
    notes: tuple[tuple[float, str, str, str, float], ...] = ()
    deferred: tuple = ()
    if day is not None:
        carry = carry or CarryState()
        incidents, more_bad, notes = daily_incidents(seed)
        extra_bad += more_bad
    specs = generate_day(seed, volume_ton, extra_bad=extra_bad, surge=sc.surge)
    if day is not None and carry is not None:
        specs, late = split_late(specs)
        deferred = tuple(late)
        specs = inject_late(specs, carry)
    announced = [s for s in specs if s.announced]
    cfg = cfg or PlantConfig()
    commands, cmd_disturbances, cmd_specs = expand(commands, cfg, seed, specs)
    specs = specs + cmd_specs
    maintenance = tuple(
        Disturbance("ster_down", m.start_min, m.duration_min, asset=m.asset)
        for m in cfg.maintenance
    )
    predictor = active_predictor()
    plan, mc = None, None
    if config == "D":
        plan, mc = select_plan(announced, cfg, predictor, seed, time_limit=max(1.0, time_limit / 3))
    elif config != "A":
        plan = make_plan(announced, cfg, config, predictor, time_limit)
    sim = TwinSimulation(
        specs,
        cfg,
        seed=seed,
        run_id=run_id,
        env=env,
        sink=sink,
        speed=speed,
        plan=plan,
        disturbances=sc.disturbances + cmd_disturbances + maintenance + incidents,
        commands=commands,
        day=day,
        date=date,
        carry=carry,
        deferred=deferred,
        incident_notes=notes,
    )
    sim.mc = mc
    if config == "D":
        quantile = next(c.quantile for c in mc.candidates if c.label == mc.chosen) or 0.8
        Replanner(sim, cfg, predictor, quantile, time_limit=max(1.0, time_limit / 6))
    return sim, plan
