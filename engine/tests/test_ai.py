import shutil
import sys

import numpy as np
import pytest

from app.experiment import simulate
from app.generator import generate_day
from app.kpi import build_result
from app.ml import service
from app.ml.service import (
    AiModels,
    AiUnavailable,
    GreenfieldsPredictor,
    TruckInput,
    active_predictor,
    anomaly_signals,
    build_ai,
    get_ai,
    map_farm,
)
from app.predictor import Predictor


@pytest.fixture(scope="module")
def ai() -> AiModels:
    models = get_ai()
    assert models is not None
    return models


def _rows(n: int = 8) -> list[TruckInput]:
    return [
        TruckInput(f"T{i}", f"FRM-0{i % 8 + 1}", 8 + i, 120 + 90 * i, 120 + 90 * i)
        for i in range(n)
    ]


def test_map_farm_modulo():
    assert [map_farm(f"FRM-0{i}") for i in (1, 5, 6, 8)] == [
        "FARM-01",
        "FARM-05",
        "FARM-01",
        "FARM-03",
    ]
    assert map_farm("XYZ") is None


def test_shim_tidak_bocor():
    get_ai()
    assert "src" not in sys.modules and "src.predict.models" not in sys.modules


def test_kuantil_tidak_menyilang(ai):
    for out in (ai.transit(_rows(24)), ai.lab_minutes(_rows(24))):
        assert np.all(out["p50"] <= out["p80"]) and np.all(out["p80"] <= out["p90"])


def test_qc_prob_valid(ai):
    p = ai.qc_release(_rows(12))
    assert np.all((p >= 0) & (p <= 1))


def test_peternakan_tak_dikenal_tetap_diprediksi(ai):
    rows = [TruckInput("T", "???", 10, 300, 300)]
    assert len(ai.transit(rows)["p50"]) == 1 and len(ai.qc_release(rows)) == 1


def test_checksum_tidak_cocok_menolak(tmp_path):
    for f in service.REGISTRY.iterdir():
        shutil.copy(f, tmp_path / f.name)
    (tmp_path / "eta_lgbm_quantile.joblib").write_bytes(b"rusak")
    with pytest.raises(AiUnavailable):
        AiModels(tmp_path)


def test_greenfields_predictor_antarmuka_sama(ai):
    g = GreenfieldsPredictor(ai)
    specs = generate_day(1, 100)[:6]
    for target in ("eta_delay", "lab_duration"):
        fc = g.forecast(target, specs)
        assert len(fc) == len(specs) and all(f.p50 <= f.p80 <= f.p90 for f in fc)
    assert g.forecast("eta_delay", []) == []
    assert {"eta_delay", "lab_duration"} <= set(g.mean)
    assert set(g.evaluate(specs)) == {"eta_delay", "lab_duration"}


def test_active_predictor_default_builtin():
    assert isinstance(active_predictor(), Predictor)


def test_run_result_membawa_ai():
    sim, _ = simulate("A", 1, 100)
    sim.run()
    out = build_ai(sim)
    assert out is not None and out.label == "DATA SINTETIS"
    assert {t.code for t in out.trucks} == set(sim.tankers)
    assert set(anomaly_signals(sim)) == {"balance_residual_l", "batch_age_h", "flow_deviation_pct"}
    result = build_result(sim, {"volume_ton": 100, "extra_bad": 0}, 1, ai=out)
    assert result.ai is not None and result.model_dump_json()
