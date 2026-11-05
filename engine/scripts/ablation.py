"""Ablasi A/B/C/D pada seed dan skenario yang sama (PRD 10.7). Jalankan:

    uv run python -m scripts.ablation --volume 320 --seeds 4 --scenario all --time-limit 4

Keluaran: tabel Markdown per skenario (rata-rata lintas seed, dan jumlah seed di mana B/C/D lebih baik dari A;
seri dengan A dihitung tidak lebih baik). A = FIFO, B = CP-SAT durasi rata-rata, C = CP-SAT P80,
D = C + seleksi Monte Carlo + replan bergulir.
"""

import argparse
import statistics

from app.experiment import CONFIGS, simulate
from app.kpi import evaluate
from app.rolling import count_assignment_changes
from app.scenarios import SCENARIO_KEYS

METRICS = {
    "truck_wait_mean": lambda k, _s, _p: k.truck_wait_min.mean,
    "truck_wait_p90": lambda k, _s, _p: k.truck_wait_min.p90,
    "tank_dwell_mean": lambda k, _s, _p: k.tank_dwell_min.mean,
    "changeover_min": lambda k, _s, _p: k.changeover_min,
    "unscheduled_cip": lambda k, _s, _p: k.unscheduled_cip,
    "fg_ton": lambda k, _s, _p: k.fg_ton,
    "held_qa": lambda k, _s, _p: k.held_qa,
    "holding_violations": lambda k, _s, _p: k.holding_violations,
    "schedule_adherence": lambda k, _s, _p: k.schedule_adherence_pct,
    "solve_seconds": lambda _k, _s, p: None if p is None else p.solve_seconds,
    "replan_changes": lambda _k, s, p: _replan_changes(s, p),
}
HIGHER_IS_BETTER = {"fg_ton", "schedule_adherence"}


def _replan_changes(sim, initial_plan) -> float | None:
    if not sim.replans:
        return None
    prev = initial_plan
    total = 0
    for rp in sim.replans:
        if rp.status != "failed" and rp.plan is not None:
            total += count_assignment_changes(prev, rp.plan)
            prev = rp.plan
    return float(total)


def run(
    volume: float, seeds: int, extra_bad: int, time_limit: float, scenario: str
) -> dict[str, dict[str, list[float | None]]]:
    table: dict[str, dict[str, list[float | None]]] = {c: {m: [] for m in METRICS} for c in CONFIGS}
    for seed in range(1, seeds + 1):
        for config in CONFIGS:
            sim, plan = simulate(
                config, seed, volume, extra_bad, time_limit=time_limit, scenario=scenario
            )
            sim.run()
            k = evaluate(sim)
            for name, fn in METRICS.items():
                v = fn(k, sim, plan)
                table[config][name].append(None if v is None else float(v))
    return table


def _mean(xs: list[float | None]) -> str:
    vals = [x for x in xs if x is not None]
    return f"{statistics.mean(vals):.1f}" if vals else "-"


def render(table: dict[str, dict], seeds: int) -> str:
    others = [c for c in CONFIGS if c != "A"]
    head = " | ".join(f"{c} lebih baik dari A" for c in others)
    lines = [f"| KPI | {' | '.join(CONFIGS)} | {head} |"]
    lines.append("|---|" + "---|" * (len(CONFIGS) + len(others)))
    for name in METRICS:
        sign = -1 if name in HIGHER_IS_BETTER else 1

        def wins(c: str, name: str = name, sign: int = sign) -> str:
            pairs = list(zip(table[c][name], table["A"][name], strict=True))
            if any(a is None for _, a in pairs):  # A tidak punya rencana: tidak ada pembanding
                return "-"
            return f"{sum(sign * x < sign * a for x, a in pairs if x is not None)}/{seeds}"

        means = " | ".join(_mean(table[c][name]) for c in CONFIGS)
        lines.append(f"| {name} | {means} | " + " | ".join(wins(c) for c in others) + " |")
    return "\n".join(lines)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--volume", type=float, default=320)
    p.add_argument("--seeds", type=int, default=4)
    p.add_argument("--extra-bad", type=int, default=0)
    p.add_argument("--time-limit", type=float, default=4.0)
    p.add_argument("--scenario", default="normal", help="nama skenario atau 'all'")
    a = p.parse_args()
    print(
        f"volume={a.volume} t, extra_bad={a.extra_bad}, seeds=1..{a.seeds}, time_limit={a.time_limit}"
    )
    for sc in SCENARIO_KEYS if a.scenario == "all" else (a.scenario,):
        print(f"\n### {sc}\n")
        print(render(run(a.volume, a.seeds, a.extra_bad, a.time_limit, sc), a.seeds))
