"""
Model Training, Cross-Validation, Baseline Comparison, Robustness Testing, and Model Serialization.
Data Classification: DATA SINTETIS
Partner: [Nama Pabrik]
"""

from __future__ import annotations
import os
import json
from pathlib import Path
from typing import Dict, Any, Tuple
import numpy as np
import pandas as pd
from sklearn.metrics import mean_absolute_error, brier_score_loss, roc_auc_score

from src.data.config_loader import load_master_config
from src.predict.features import FeatureExtractor
from src.predict.models import (
    BaselineMedianPredictor,
    LightGBMQuantilePredictor,
    CalibratedQCClassifier,
    PlantAnomalyDetector,
)
from src.predict.metrics import (
    pinball_loss,
    empirical_coverage,
    expected_calibration_error,
    calculate_bootstrap_ci,
)
from src.predict.registry import ModelRegistry


def run_phase2_training(
    data_dir: str = "data/synthetic_90d",
    registry_dir: str = "models/registry",
    report_file: str = "reports/eval_phase2.json",
    seed: int = 42
) -> Dict[str, Any]:
    """Execute complete Phase 2 model training and evaluation suite."""
    np.random.seed(seed)
    registry = ModelRegistry(registry_dir)

    trips_path = os.path.join(data_dir, "tanker_trips.csv")
    labs_path = os.path.join(data_dir, "lab_tests.csv")
    balances_path = os.path.join(data_dir, "daily_volume_balance.csv")

    df_trips = pd.read_csv(trips_path)
    df_labs = pd.read_csv(labs_path)
    df_balances = pd.read_csv(balances_path)

    # ==========================================
    # 1. Target T1: Transit Duration (ETA)
    # ==========================================
    X_eta, y_eta = FeatureExtractor.prepare_eta_features(df_trips)

    # Time-based split: Train (d <= 54), Val (55 <= d <= 72), Test (d >= 73)
    train_mask = X_eta["day_index"] <= 54
    val_mask = (X_eta["day_index"] >= 55) & (X_eta["day_index"] <= 72)
    test_mask = X_eta["day_index"] >= 73

    X_eta_train, y_eta_train = X_eta[train_mask], y_eta[train_mask]
    X_eta_val, y_eta_val = X_eta[val_mask], y_eta[val_mask]
    X_eta_test, y_eta_test = X_eta[test_mask], y_eta[test_mask]

    # Baseline: Group median by farm_id
    base_eta = BaselineMedianPredictor(group_col="farm_id").fit(X_eta_train, y_eta_train)
    pred_base_eta = base_eta.predict(X_eta_test)

    # LightGBM Quantile Regressor
    lgbm_eta = LightGBMQuantilePredictor(alphas=[0.5, 0.8, 0.9], seed=seed)
    lgbm_eta.fit(X_eta_train, y_eta_train, categorical_features=["farm_id"])
    pred_lgbm_eta = lgbm_eta.predict(X_eta_test)

    # Metrics for T1
    mae_base_eta = float(mean_absolute_error(y_eta_test, pred_base_eta))
    mae_lgbm_eta = float(mean_absolute_error(y_eta_test, pred_lgbm_eta["p50"]))

    pinball_05 = pinball_loss(y_eta_test.values, pred_lgbm_eta["p50"], 0.5)
    pinball_08 = pinball_loss(y_eta_test.values, pred_lgbm_eta["p80"], 0.8)
    pinball_09 = pinball_loss(y_eta_test.values, pred_lgbm_eta["p90"], 0.9)

    coverage_p80 = empirical_coverage(y_eta_test.values, pred_lgbm_eta["p80"])
    coverage_p90 = empirical_coverage(y_eta_test.values, pred_lgbm_eta["p90"])
    interval_width = float(np.mean(pred_lgbm_eta["p80"] - pred_lgbm_eta["p50"]))

    bootstrap_eta = calculate_bootstrap_ci(
        mean_absolute_error, y_eta_test.values, pred_lgbm_eta["p50"], pred_base_eta
    )

    t1_metrics = {
        "baseline_mae": mae_base_eta,
        "lgbm_p50_mae": mae_lgbm_eta,
        "pinball_0.5": pinball_05,
        "pinball_0.8": pinball_08,
        "pinball_0.9": pinball_09,
        "coverage_p80": coverage_p80,
        "coverage_p90": coverage_p90,
        "coverage_p80_target_met": abs(coverage_p80 - 0.80) <= 0.05,
        "coverage_p90_target_met": abs(coverage_p90 - 0.90) <= 0.05,
        "mean_interval_width_minutes": interval_width,
        "bootstrap_improvement": bootstrap_eta,
        "lgbm_beats_baseline": bool(mae_lgbm_eta < mae_base_eta)
    }

    # Save T1 Model
    registry.save_model(
        model_name="eta_lgbm_quantile",
        model_obj=lgbm_eta,
        features=lgbm_eta.feature_names,
        metrics=t1_metrics,
        training_data_path=trips_path,
        seed=seed
    )

    # ==========================================
    # 2. Target T2: Lab Duration
    # ==========================================
    X_lab, y_lab = FeatureExtractor.prepare_lab_features(df_labs)

    train_mask_lab = X_lab["day_index"] <= 54
    val_mask_lab = (X_lab["day_index"] >= 55) & (X_lab["day_index"] <= 72)
    test_mask_lab = X_lab["day_index"] >= 73

    X_lab_train, y_lab_train = X_lab[train_mask_lab], y_lab[train_mask_lab]
    X_lab_test, y_lab_test = X_lab[test_mask_lab], y_lab[test_mask_lab]

    base_lab = BaselineMedianPredictor(group_col="sampling_hour").fit(X_lab_train, y_lab_train)
    pred_base_lab = base_lab.predict(X_lab_test)

    lgbm_lab = LightGBMQuantilePredictor(alphas=[0.5, 0.8, 0.9], seed=seed)
    lgbm_lab.fit(X_lab_train, y_lab_train, categorical_features=["farm_id"])
    pred_lgbm_lab = lgbm_lab.predict(X_lab_test)

    mae_base_lab = float(mean_absolute_error(y_lab_test, pred_base_lab))
    mae_lgbm_lab = float(mean_absolute_error(y_lab_test, pred_lgbm_lab["p50"]))

    coverage_p80_lab = empirical_coverage(y_lab_test.values, pred_lgbm_lab["p80"])
    coverage_p90_lab = empirical_coverage(y_lab_test.values, pred_lgbm_lab["p90"])

    bootstrap_lab = calculate_bootstrap_ci(
        mean_absolute_error, y_lab_test.values, pred_lgbm_lab["p50"], pred_base_lab
    )

    t2_metrics = {
        "baseline_mae": mae_base_lab,
        "lgbm_p50_mae": mae_lgbm_lab,
        "pinball_0.5": pinball_loss(y_lab_test.values, pred_lgbm_lab["p50"], 0.5),
        "pinball_0.8": pinball_loss(y_lab_test.values, pred_lgbm_lab["p80"], 0.8),
        "pinball_0.9": pinball_loss(y_lab_test.values, pred_lgbm_lab["p90"], 0.9),
        "coverage_p80": coverage_p80_lab,
        "coverage_p90": coverage_p90_lab,
        "coverage_p80_target_met": abs(coverage_p80_lab - 0.80) <= 0.05,
        "coverage_p90_target_met": abs(coverage_p90_lab - 0.90) <= 0.05,
        "bootstrap_improvement": bootstrap_lab,
        "lgbm_beats_baseline": bool(mae_lgbm_lab <= mae_base_lab)
    }

    # Save T2 Model
    registry.save_model(
        model_name="lab_lgbm_quantile",
        model_obj=lgbm_lab,
        features=lgbm_lab.feature_names,
        metrics=t2_metrics,
        training_data_path=labs_path,
        seed=seed
    )

    # ==========================================
    # 3. Target T3: Probability of Released (Calibrated Classifier)
    # ==========================================
    X_qc, y_qc = FeatureExtractor.prepare_qc_release_features(df_labs, df_trips)

    X_qc_train, y_qc_train = X_qc[train_mask_lab], y_qc[train_mask_lab]
    X_qc_val, y_qc_val = X_qc[val_mask_lab], y_qc[val_mask_lab]
    X_qc_test, y_qc_test = X_qc[test_mask_lab], y_qc[test_mask_lab]

    qc_clf = CalibratedQCClassifier(method="isotonic", seed=seed)
    qc_clf.fit(X_qc_train, y_qc_train, X_qc_val, y_qc_val)
    prob_qc_test = qc_clf.predict_proba(X_qc_test)

    # Prior baseline (mean pass rate)
    prior_prob = np.full(len(y_qc_test), float(y_qc_train.mean()))
    brier_baseline = float(brier_score_loss(y_qc_test, prior_prob))
    brier_model = float(brier_score_loss(y_qc_test, prob_qc_test))
    ece_model = expected_calibration_error(y_qc_test.values, prob_qc_test)
    auc_score = float(roc_auc_score(y_qc_test, prob_qc_test))

    t3_metrics = {
        "brier_baseline": brier_baseline,
        "brier_model": brier_model,
        "ece": ece_model,
        "auc_roc": auc_score,
        "brier_improvement_pct": float((brier_baseline - brier_model) / brier_baseline * 100),
        "calibration_status": "CALIBRATED_ISOTONIC"
    }

    # Save T3 Model
    registry.save_model(
        model_name="qc_release_calibrated",
        model_obj=qc_clf,
        features=qc_clf.feature_names,
        metrics=t3_metrics,
        training_data_path=labs_path,
        seed=seed
    )

    # ==========================================
    # 4. Target T5: Changeover Residual Note
    # ==========================================
    t5_status = {
        "status": "SKIPPED_PER_SPEC",
        "reason": "Changeover durations follow deterministic SOP standards (VARIANT: 90m, SIZE: 60m, PAPER: 20m) without material continuous variance in plant standard practice."
    }

    # ==========================================
    # 5. Target T6: Plant Anomaly Detector
    # ==========================================
    # Synthesize small operational telemetry signals for fitting normal envelope
    df_signals = pd.DataFrame({
        "balance_residual_l": df_balances["balance_diff_l"],
        "batch_age_h": np.random.uniform(2.0, 24.0, len(df_balances)),
        "flow_deviation_pct": np.random.normal(0.0, 3.0, len(df_balances))
    })

    anomaly_detector = PlantAnomalyDetector(seed=seed).fit(df_signals)

    # Test detection on synthetic normal vs synthetic anomaly
    normal_score = anomaly_detector.score_event(balance_residual_l=0.0, batch_age_h=12.0, flow_deviation_pct=2.0)
    anomaly_score = anomaly_detector.score_event(balance_residual_l=50.0, batch_age_h=52.0, flow_deviation_pct=25.0)

    t6_metrics = {
        "fitted": True,
        "normal_test_risk": normal_score["risk_score"],
        "anomaly_test_risk": anomaly_score["risk_score"],
        "detected_anomaly_flags": anomaly_score["flags"]
    }

    registry.save_model(
        model_name="plant_anomaly_detector",
        model_obj=anomaly_detector,
        features=["balance_residual_l", "batch_age_h", "flow_deviation_pct"],
        metrics=t6_metrics,
        training_data_path=balances_path,
        seed=seed
    )

    # ==========================================
    # 6. Robustness Test (Shifted Generator Parameters)
    # ==========================================
    # Shifted test: test data with +25% transit delay to evaluate coverage retention
    y_eta_test_shifted = y_eta_test * 1.25
    shifted_coverage_p80 = empirical_coverage(y_eta_test_shifted.values, pred_lgbm_eta["p80"])
    shifted_coverage_p90 = empirical_coverage(y_eta_test_shifted.values, pred_lgbm_eta["p90"])

    robustness_results = {
        "shift_description": "Simulated traffic storm with +25% transit duration",
        "standard_coverage_p80": coverage_p80,
        "shifted_coverage_p80": shifted_coverage_p80,
        "standard_coverage_p90": coverage_p90,
        "shifted_coverage_p90": shifted_coverage_p90,
        "recommendation": "Use P90 rather than P80 during severe weather or traffic advisory windows"
    }

    # ==========================================
    # Compile Full Phase 2 Report
    # ==========================================
    report = {
        "metadata": {
            "data_classification": "DATA SINTETIS",
            "partner": "[Nama Pabrik]",
            "train_days": 54,
            "val_days": 18,
            "test_days": 18,
            "seed": seed
        },
        "T1_ETA": t1_metrics,
        "T2_Lab_Duration": t2_metrics,
        "T3_QC_Release": t3_metrics,
        "T5_Changeover_Residual": t5_status,
        "T6_Anomaly_Detection": t6_metrics,
        "Robustness_Test": robustness_results
    }

    os.makedirs(os.path.dirname(report_file), exist_ok=True)
    with open(report_file, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    return report


if __name__ == "__main__":
    rep = run_phase2_training()
    print("Phase 2 training complete! Summary:")
    print(json.dumps(rep, indent=2))
