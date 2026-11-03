from dataclasses import replace

from app.generator import generate_day
from app.predictor import (
    HOLDOUT_SEED0,
    TRAIN_DAYS,
    TRAIN_SEED0,
    Predictor,
    get_predictor,
    history,
    metrics,
)


def test_beats_historical_baseline_on_holdout():
    m = metrics(30)
    for target, entry in m.items():
        for q in ("0.5", "0.8", "0.9"):
            assert entry["pinball"][q] < entry["pinball_baseline"][q], (target, q)
        assert entry["mae_p50"] < entry["mae_baseline"], target


def test_quantile_coverage_near_nominal():
    m = metrics(30)
    for target, entry in m.items():
        assert abs(entry["coverage"]["0.8"] - 0.8) < 0.07, target
        assert abs(entry["coverage"]["0.9"] - 0.9) < 0.07, target


def test_quantiles_are_monotone():
    specs = generate_day(HOLDOUT_SEED0 + 99, 450)
    for target in ("eta_delay", "lab_duration"):
        for f in get_predictor().forecast(target, specs):
            assert f.p50 <= f.p80 <= f.p90


def test_forecast_ignores_unknown_outcomes():
    """Fitur hanya boleh yang diketahui sebelum tiba: hasil nyata tidak boleh bocor."""
    specs = generate_day(HOLDOUT_SEED0 + 5, 320)
    tampered = [replace(s, arrival_min=s.arrival_min + 500, lab_duration_min=1.0) for s in specs]
    p = get_predictor()
    for target in ("eta_delay", "lab_duration"):
        assert p.forecast(target, specs) == p.forecast(target, tampered)


def test_training_is_deterministic_and_disjoint_from_holdout():
    assert TRAIN_SEED0 + TRAIN_DAYS < HOLDOUT_SEED0
    train = history(20, TRAIN_SEED0)
    specs = generate_day(HOLDOUT_SEED0, 320)
    a = Predictor(train).forecast("lab_duration", specs)
    b = Predictor(train).forecast("lab_duration", specs)
    assert a == b


def test_extended_tests_are_predicted_longer():
    specs = generate_day(HOLDOUT_SEED0 + 7, 450)
    f = get_predictor().forecast("lab_duration", specs)
    ext = [x.p80 for s, x in zip(specs, f, strict=True) if s.test_type == "extended"]
    std = [x.p80 for s, x in zip(specs, f, strict=True) if s.test_type == "standard"]
    assert ext and std and min(ext) > 0
    assert sum(ext) / len(ext) > sum(std) / len(std) + 15
