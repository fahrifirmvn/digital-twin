"""
Evaluation Metrics, Calibration Checks, and Statistical Bootstrap.
Data Classification: DATA SINTETIS
Partner: [Nama Pabrik]
"""

from __future__ import annotations
import math
from typing import Dict, Any, Tuple, List
import numpy as np
from sklearn.metrics import mean_absolute_error, brier_score_loss, roc_auc_score


def pinball_loss(y_true: np.ndarray, y_pred: np.ndarray, alpha: float) -> float:
    """Calculate quantile pinball loss for quantile alpha."""
    err = y_true - y_pred
    return float(np.mean(np.maximum(alpha * err, (alpha - 1.0) * err)))


def empirical_coverage(y_true: np.ndarray, y_pred_upper: np.ndarray) -> float:
    """Calculate percentage of observations bounded by upper quantile (y_true <= y_pred)."""
    return float(np.mean(y_true <= y_pred_upper))


def expected_calibration_error(y_true: np.ndarray, y_prob: np.ndarray, n_bins: int = 10) -> float:
    """Compute Expected Calibration Error (ECE) for probabilistic classifier."""
    bin_boundaries = np.linspace(0, 1, n_bins + 1)
    ece = 0.0
    n = len(y_true)

    for i in range(n_bins):
        bin_lower = bin_boundaries[i]
        bin_upper = bin_boundaries[i + 1]

        in_bin = (y_prob > bin_lower) & (y_prob <= bin_upper) if i > 0 else (y_prob >= bin_lower) & (y_prob <= bin_upper)
        prop_in_bin = np.mean(in_bin)

        if prop_in_bin > 0:
            accuracy_in_bin = np.mean(y_true[in_bin])
            avg_confidence_in_bin = np.mean(y_prob[in_bin])
            ece += np.abs(avg_confidence_in_bin - accuracy_in_bin) * prop_in_bin

    return float(ece)


def calculate_bootstrap_ci(
    metric_func,
    y_true: np.ndarray,
    pred_model: np.ndarray,
    pred_baseline: np.ndarray,
    n_bootstraps: int = 500,
    alpha: float = 0.05,
    seed: int = 42
) -> Dict[str, float]:
    """
    Compute 95% Bootstrap Confidence Interval for (baseline_error - model_error).
    Positive improvement means model outperforms baseline.
    """
    rng = np.random.default_rng(seed)
    n = len(y_true)
    diffs = []

    for _ in range(n_bootstraps):
        idx = rng.choice(n, size=n, replace=True)
        base_val = metric_func(y_true[idx], pred_baseline[idx])
        model_val = metric_func(y_true[idx], pred_model[idx])
        diffs.append(base_val - model_val)

    lower = float(np.percentile(diffs, 100 * (alpha / 2)))
    upper = float(np.percentile(diffs, 100 * (1 - alpha / 2)))
    mean_diff = float(np.mean(diffs))

    return {
        "mean_improvement": mean_diff,
        "ci_lower_95": lower,
        "ci_upper_95": upper,
        "significantly_better": bool(lower > 0)
    }


def compute_psi(actual: np.ndarray, expected: np.ndarray, num_buckets: int = 10) -> float:
    """
    Compute Population Stability Index (PSI) to measure distribution drift.
    PSI < 0.1: No significant shift
    0.1 <= PSI < 0.25: Moderate shift
    PSI >= 0.25: Significant drift
    """
    # Create quantile buckets based on expected (training) distribution
    percentiles = np.linspace(0, 100, num_buckets + 1)
    bucket_bounds = np.percentile(expected, percentiles)
    bucket_bounds[0] = -np.inf
    bucket_bounds[-1] = np.inf

    expected_counts, _ = np.histogram(expected, bins=bucket_bounds)
    actual_counts, _ = np.histogram(actual, bins=bucket_bounds)

    # Add small epsilon to avoid div by zero
    eps = 1e-4
    expected_pct = (expected_counts + eps) / (len(expected) + eps * num_buckets)
    actual_pct = (actual_counts + eps) / (len(actual) + eps * num_buckets)

    psi_val = np.sum((actual_pct - expected_pct) * np.log(actual_pct / expected_pct))
    return float(psi_val)
