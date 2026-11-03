"""
Unit and Integration Tests for Phase 2: Predictive Models, Quantile Crossing Fix, Calibration, and Registry.
Acceptance Criteria:
1. Features have zero future leakage.
2. Quantile crossing fix strictly guarantees P50 <= P80 <= P90.
3. Model registry serializes and loads artifacts with metadata.
4. Fallback mechanism handles unseen categories cleanly.
5. Anomaly detector accurately scores and flags anomalies.
Data Classification: DATA SINTETIS
Partner: [Nama Pabrik]
"""

import os
import json
from pathlib import Path
import pytest
import numpy as np
import pandas as pd

from src.data.config_loader import load_master_config
from src.predict.features import FeatureExtractor
from src.predict.models import LightGBMQuantilePredictor, PlantAnomalyDetector
from src.predict.metrics import pinball_loss, empirical_coverage, compute_psi
from src.predict.registry import ModelRegistry, ModelInferenceService


@pytest.fixture
def trips_df():
    data_path = Path(__file__).resolve().parent.parent / "data" / "synthetic_90d" / "tanker_trips.csv"
    assert data_path.exists(), "Synthetic dataset not found!"
    return pd.read_csv(data_path)


@pytest.fixture
def labs_df():
    data_path = Path(__file__).resolve().parent.parent / "data" / "synthetic_90d" / "lab_tests.csv"
    assert data_path.exists(), "Synthetic lab dataset not found!"
    return pd.read_csv(data_path)


def test_feature_extraction_no_leakage(trips_df):
    """Verify that features contain only information known prior to gate arrival."""
    X, y = FeatureExtractor.prepare_eta_features(trips_df)

    # Must NOT contain actual gate arrival or lab release in features
    forbidden_cols = ["gate_arrival_time_minute", "lab_release_time_minute", "qc_status", "unload_start_minute"]
    for col in forbidden_cols:
        assert col not in X.columns, f"Feature leakage detected! Column {col} is in X"

    assert len(X) == len(y)
    assert len(X) > 1000


def test_quantile_non_crossing_guarantee(trips_df):
    """Verify that quantile predictions satisfy P50 <= P80 <= P90 on every prediction."""
    registry = ModelRegistry("models/registry")
    model, _ = registry.load_model("eta_lgbm_quantile")

    X, _ = FeatureExtractor.prepare_eta_features(trips_df.iloc[:200])
    preds = model.predict(X)

    p50 = preds["p50"]
    p80 = preds["p80"]
    p90 = preds["p90"]

    # Quantile crossing check: P50 <= P80 and P80 <= P90
    assert np.all(p50 <= p80 + 1e-6), "Quantile crossing: P50 > P80 found!"
    assert np.all(p80 <= p90 + 1e-6), "Quantile crossing: P80 > P90 found!"


def test_model_registry_metadata():
    """Verify that saved models in registry carry DATA SINTETIS label, seed, and data hash."""
    registry = ModelRegistry("models/registry")
    meta_path = Path("models/registry/eta_lgbm_quantile.meta.json")
    assert meta_path.exists()

    with open(meta_path, "r", encoding="utf-8") as f:
        meta = json.load(f)

    assert meta["data_classification"] == "DATA SINTETIS"
    assert meta["partner"] == "[Nama Pabrik]"
    assert meta["seed"] == 42
    assert "p50_mae" in str(meta["metrics"])


def test_inference_service_unseen_category_fallback():
    """Verify inference service gracefully handles unseen farms without crashing."""
    service = ModelInferenceService()

    # Create synthetic query with unknown farm
    test_input = pd.DataFrame([{
        "farm_id": "FARM-UNKNOWN-99",
        "departure_hour": 8,
        "planned_slot_hour": 9,
        "is_morning_rush": 1,
        "is_evening_rush": 0,
        "volume_l": 10500.0,
        "day_of_week": 2
    }])

    res = service.predict_eta(test_input)
    assert "p50_minutes" in res
    assert "p80_minutes" in res
    assert res["p50_minutes"][0] > 0
    assert res["p80_minutes"][0] >= res["p50_minutes"][0]


def test_psi_drift_detection():
    """Verify Population Stability Index correctly identifies identical vs shifted distributions."""
    rng = np.random.default_rng(42)
    expected = rng.normal(10000, 1000, size=500)
    actual_normal = rng.normal(10000, 1000, size=500)
    actual_drifted = rng.normal(15000, 2000, size=500)

    psi_normal = compute_psi(actual_normal, expected)
    psi_drifted = compute_psi(actual_drifted, expected)

    assert psi_normal < 0.10, f"Expected low PSI on normal distribution, got {psi_normal}"
    assert psi_drifted > 0.25, f"Expected high PSI on shifted distribution, got {psi_drifted}"


def test_anomaly_detector_scoring():
    """Verify anomaly detector flags severe volume balance and holding time violations."""
    registry = ModelRegistry("models/registry")
    detector, _ = registry.load_model("plant_anomaly_detector")

    normal_res = detector.score_event(balance_residual_l=0.0, batch_age_h=10.0, flow_deviation_pct=2.0)
    assert normal_res["is_anomaly"] is False
    assert len(normal_res["flags"]) == 0

    anomaly_res = detector.score_event(balance_residual_l=250.0, batch_age_h=55.0, flow_deviation_pct=35.0)
    assert anomaly_res["is_anomaly"] is True
    assert "MASS_BALANCE_RESIDUAL_HIGH" in anomaly_res["flags"]
    assert "HOLDING_TIME_EXCEEDED" in anomaly_res["flags"]
