"""Ekspor kontrak ke contracts/. Jalankan: uv run python -m scripts.export_contracts"""

import json
from pathlib import Path

from app.contracts.events import TwinEvent
from app.contracts.result import RunFailure, RunResult
from app.experiment import simulate
from app.kpi import build_result
from app.main import app
from app.ml.service import build_ai
from app.predictor import get_predictor

OUT = Path(__file__).resolve().parents[2] / "contracts"


def sample_result() -> RunResult:
    sim, plan = simulate("D", 1, 100, time_limit=2.0)
    sim.run()
    assert plan is not None
    specs = [r.spec for r in sim.tankers.values() if r.spec.announced]
    delay = get_predictor().forecast("eta_delay", specs)
    result = build_result(
        sim,
        {"volume_ton": 100, "extra_bad": 0},
        1,
        config="D",
        plan=plan,
        eta_forecast={s.code: f for s, f in zip(specs, delay, strict=True)},
        ai=build_ai(sim),
    )
    # Waktu dinding tidak deterministik, jadi dinolkan di sampel.
    assert result.plan is not None and result.monte_carlo is not None
    result.plan.solve_seconds = 0.0
    for c in result.monte_carlo.candidates:
        c.solve_seconds = 0.0
    for r in result.replans:
        r.solve_seconds = 0.0
        if r.plan:
            r.plan.solve_seconds = 0.0
    return result


def render() -> dict[str, str]:
    return {
        # Contoh nyata dari Engine, dipakai test Laravel agar kontrak tidak menyimpang.
        "run-result.sample.json": sample_result().model_dump_json(indent=2) + "\n",
        "twin-event.schema.json": json.dumps(TwinEvent.model_json_schema(), indent=2) + "\n",
        "run-result.schema.json": json.dumps(
            {"oneOf": [RunResult.model_json_schema(), RunFailure.model_json_schema()]}, indent=2
        )
        + "\n",
        "openapi.json": json.dumps(app.openapi(), indent=2) + "\n",
    }


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for name, text in render().items():
        (OUT / name).write_text(text)
        print(f"wrote {OUT / name}")
