"""Kelas model dari paket Greenfields (LactaTwin Decision Core), disalin agar artefak joblib bisa dimuat.

Atribut harus tetap sama dengan versi paket karena artefak di-pickle dengan kelas ini. Hanya inferensi
yang dipakai di sini; pelatihan tetap di paket asal. Data: DATA SINTETIS.
"""

import math
from typing import Any

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import IsolationForest


class BaselineMedianPredictor:
    def __init__(self, group_col: str = "farm_id"):
        self.group_col = group_col
        self.global_median: float = 0.0
        self.group_medians: dict[Any, float] = {}

    def predict(self, x: pd.DataFrame) -> np.ndarray:
        return np.array(
            [self.group_medians.get(v, self.global_median) for v in x[self.group_col]], dtype=float
        )


class LightGBMQuantilePredictor:
    def __init__(self, alphas: list[float] | None = None, seed: int = 42):
        self.alphas = alphas or [0.5, 0.8, 0.9]
        self.seed = seed
        self.models: dict[float, lgb.LGBMRegressor] = {}
        self.feature_names: list[str] = []
        self.fallback = BaselineMedianPredictor(group_col="farm_id")

    def predict(self, x: pd.DataFrame) -> dict[str, np.ndarray]:
        """P50, P80, P90 dengan kuantil tidak saling menyilang."""
        inp = x[self.feature_names]
        p50, p80, p90 = (self.models[a].predict(inp) for a in (0.5, 0.8, 0.9))
        p80 = np.maximum(p80, p50)
        return {"p50": p50, "p80": p80, "p90": np.maximum(p90, p80)}


class CalibratedQCClassifier:
    def __init__(self, method: str = "isotonic", seed: int = 42):
        self.method = method
        self.seed = seed
        self.base_model: lgb.LGBMClassifier | None = None
        self.calibrated_model: CalibratedClassifierCV | None = None
        self.feature_names: list[str] = []
        self.prior_release_rate: float = 0.96

    def predict_proba(self, x: pd.DataFrame) -> np.ndarray:
        """P(lolos QC)."""
        return self.calibrated_model.predict_proba(x[self.feature_names])[:, 1]


class PlantAnomalyDetector:
    def __init__(self, seed: int = 42):
        self.seed = seed
        self.isolation_forest = IsolationForest(
            n_estimators=100, contamination=0.03, random_state=seed
        )
        self.is_fitted = False

    def score_event(
        self, balance_residual_l: float, batch_age_h: float, flow_deviation_pct: float
    ) -> dict:
        flags = []
        if abs(balance_residual_l) > 10.0:
            flags.append("MASS_BALANCE_RESIDUAL_HIGH")
        if batch_age_h > 48.0:
            flags.append("HOLDING_TIME_EXCEEDED")
        if abs(flow_deviation_pct) > 20.0:
            flags.append("FLOW_RATE_ANOMALY")
        if self.is_fitted:
            feats = pd.DataFrame(
                [[balance_residual_l, batch_age_h, flow_deviation_pct]],
                columns=["balance_residual_l", "batch_age_h", "flow_deviation_pct"],
            )
            raw = -float(self.isolation_forest.decision_function(feats)[0])
            risk = 1.0 / (1.0 + math.exp(-raw * 4))
        else:
            risk = 0.8 if flags else 0.05
        return {"risk_score": risk, "is_anomaly": risk > 0.6 or bool(flags), "flags": flags}
