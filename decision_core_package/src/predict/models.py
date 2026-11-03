"""
Model Architectures: LightGBM Quantile Regressors, Calibrated Classifiers, Baselines, and Anomaly Detection.
Data Classification: DATA SINTETIS
Partner: [Nama Pabrik]
"""

from __future__ import annotations
import math
from typing import Dict, Any, List, Optional, Tuple, Union
import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import IsolationForest


class BaselineMedianPredictor:
    """Predicts global median or group median by farm/hour bucket."""

    def __init__(self, group_col: str = "farm_id"):
        self.group_col = group_col
        self.global_median: float = 0.0
        self.group_medians: Dict[Any, float] = {}

    def fit(self, X: pd.DataFrame, y: pd.Series):
        self.global_median = float(y.median())
        df = X.copy()
        df["_target"] = y
        self.group_medians = df.groupby(self.group_col, observed=False)["_target"].median().to_dict()
        return self

    def predict(self, X: pd.DataFrame) -> np.ndarray:
        preds = []
        for val in X[self.group_col]:
            preds.append(self.group_medians.get(val, self.global_median))
        return np.array(preds, dtype=float)


class LightGBMQuantilePredictor:
    """
    LightGBM Quantile Regressor predicting P50, P80, and P90 with Quantile-Crossing Fix.
    """

    def __init__(self, alphas: List[float] = [0.5, 0.8, 0.9], seed: int = 42):
        self.alphas = alphas
        self.seed = seed
        self.models: Dict[float, lgb.LGBMRegressor] = {}
        self.feature_names: List[str] = []
        self.fallback = BaselineMedianPredictor(group_col="farm_id")

    def fit(self, X: pd.DataFrame, y: pd.Series, categorical_features: Optional[List[str]] = None):
        self.feature_names = [col for col in X.columns if col not in ["day_index"]]
        X_train = X[self.feature_names].copy()

        # Fit fallback baseline
        self.fallback.fit(X, y)

        # Train one regressor per quantile
        for alpha in self.alphas:
            model = lgb.LGBMRegressor(
                objective="quantile",
                alpha=alpha,
                n_estimators=100,
                learning_rate=0.05,
                num_leaves=31,
                random_state=self.seed,
                verbose=-1
            )
            model.fit(
                X_train,
                y,
                categorical_feature=categorical_features if categorical_features else "auto"
            )
            self.models[alpha] = model

        return self

    def predict(self, X: pd.DataFrame) -> Dict[str, np.ndarray]:
        """
        Predict P50, P80, P90 and enforce quantile non-crossing:
        P50 <= P80 <= P90.
        """
        X_input = X[self.feature_names].copy()
        raw_preds = {
            alpha: self.models[alpha].predict(X_input)
            for alpha in self.alphas
        }

        p50 = raw_preds[0.5]
        p80 = raw_preds[0.8]
        p90 = raw_preds[0.9]

        # Quantile-crossing fix
        p80_fixed = np.maximum(p80, p50)
        p90_fixed = np.maximum(p90, p80_fixed)

        return {
            "p50": p50,
            "p80": p80_fixed,
            "p90": p90_fixed,
            "p80_raw": p80,
            "p90_raw": p90,
        }


class CalibratedQCClassifier:
    """LightGBM Classifier predicting QC Release probability with probability calibration."""

    def __init__(self, method: str = "isotonic", seed: int = 42):
        self.method = method
        self.seed = seed
        self.base_model: Optional[lgb.LGBMClassifier] = None
        self.calibrated_model: Optional[CalibratedClassifierCV] = None
        self.feature_names: List[str] = []
        self.prior_release_rate: float = 0.96

    def fit(self, X_train: pd.DataFrame, y_train: pd.Series, X_val: pd.DataFrame, y_val: pd.Series):
        self.feature_names = [col for col in X_train.columns if col not in ["day_index"]]
        self.prior_release_rate = float(y_train.mean())

        X_tr = X_train[self.feature_names].copy()
        X_v = X_val[self.feature_names].copy()

        # Train base LightGBM classifier
        self.base_model = lgb.LGBMClassifier(
            objective="binary",
            n_estimators=100,
            learning_rate=0.05,
            num_leaves=15,
            random_state=self.seed,
            verbose=-1
        )
        self.base_model.fit(X_tr, y_train)

        # Calibrate using cross-validation (cv=5) on train set
        self.calibrated_model = CalibratedClassifierCV(
            estimator=self.base_model,
            method=self.method,
            cv=5
        )
        self.calibrated_model.fit(X_tr, y_train)
        return self

    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        """Returns array of P(result_released=True)."""
        X_input = X[self.feature_names].copy()
        probs = self.calibrated_model.predict_proba(X_input)
        return probs[:, 1]


class PlantAnomalyDetector:
    """
    T6: Multi-signal anomaly detector for volume-balance residual,
    holding-time limit breaches, and flow rate deviations.
    """

    def __init__(self, seed: int = 42):
        self.seed = seed
        self.isolation_forest = IsolationForest(
            n_estimators=100,
            contamination=0.03,
            random_state=seed
        )
        self.is_fitted = False

    def fit(self, df_signals: pd.DataFrame):
        """Fit isolation forest on normal operating residuals."""
        features = df_signals[["balance_residual_l", "batch_age_h", "flow_deviation_pct"]].fillna(0.0)
        self.isolation_forest.fit(features)
        self.is_fitted = True
        return self

    def score_event(
        self,
        balance_residual_l: float,
        batch_age_h: float,
        flow_deviation_pct: float
    ) -> Dict[str, Any]:
        """Compute anomaly score and deterministic rule flags."""
        flags = []
        if abs(balance_residual_l) > 10.0:
            flags.append("MASS_BALANCE_RESIDUAL_HIGH")
        if batch_age_h > 48.0:
            flags.append("HOLDING_TIME_EXCEEDED")
        if abs(flow_deviation_pct) > 20.0:
            flags.append("FLOW_RATE_ANOMALY")

        features = np.array([[balance_residual_l, batch_age_h, flow_deviation_pct]])
        if self.is_fitted:
            # -1 for anomaly, 1 for normal; convert to 0..1 risk score
            raw_score = -float(self.isolation_forest.decision_function(features)[0])
            risk_score = float(1.0 / (1.0 + math.exp(-raw_score * 4)))
        else:
            risk_score = 0.8 if flags else 0.05

        return {
            "risk_score": risk_score,
            "is_anomaly": bool(risk_score > 0.6 or len(flags) > 0),
            "flags": flags,
            "label": "DATA SINTETIS"
        }
