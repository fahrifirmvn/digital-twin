"""
Model Registry and Runtime Inference Service.
Manages versioning, metadata JSON, fallback mechanisms, and drift (PSI) logging.
Data Classification: DATA SINTETIS
Partner: [Nama Pabrik]
"""

from __future__ import annotations
import os
import json
import hashlib
from pathlib import Path
from datetime import datetime
from typing import Dict, Any, Optional, List
import joblib
import numpy as np
import pandas as pd

from src.predict.metrics import compute_psi


class ModelRegistry:
    """Manages saving, loading, metadata recording, and serving of trained models."""

    def __init__(self, registry_dir: str = "models/registry"):
        self.registry_dir = Path(registry_dir)
        self.registry_dir.mkdir(parents=True, exist_ok=True)

    def save_model(
        self,
        model_name: str,
        model_obj: Any,
        features: List[str],
        metrics: Dict[str, Any],
        training_data_path: str,
        seed: int = 42,
        extra_metadata: Optional[Dict[str, Any]] = None
    ) -> str:
        """Save serialized model artifact and metadata JSON."""
        model_file = self.registry_dir / f"{model_name}.joblib"
        meta_file = self.registry_dir / f"{model_name}.meta.json"

        # Serialize model
        joblib.dump(model_obj, model_file)

        # Compute data hash if file exists
        data_hash = "N/A"
        if os.path.exists(training_data_path):
            with open(training_data_path, "rb") as f:
                data_hash = hashlib.sha256(f.read()).hexdigest()[:16]

        metadata = {
            "model_name": model_name,
            "created_at": datetime.now().isoformat(),
            "data_classification": "DATA SINTETIS",
            "partner": "[Nama Pabrik]",
            "seed": seed,
            "data_hash": data_hash,
            "features": features,
            "metrics": metrics,
            "extra": extra_metadata or {}
        }

        with open(meta_file, "w", encoding="utf-8") as f:
            json.dump(metadata, f, indent=2)

        return str(model_file)

    def load_model(self, model_name: str) -> Tuple[Any, Dict[str, Any]]:
        """Load serialized model and its metadata."""
        model_file = self.registry_dir / f"{model_name}.joblib"
        meta_file = self.registry_dir / f"{model_name}.meta.json"

        if not model_file.exists():
            raise FileNotFoundError(f"Model {model_name} not found at {model_file}")

        model_obj = joblib.load(model_file)
        metadata = {}
        if meta_file.exists():
            with open(meta_file, "r", encoding="utf-8") as f:
                metadata = json.load(f)

        return model_obj, metadata


class ModelInferenceService:
    """Production-grade inference interface with automatic fallback and drift detection."""

    def __init__(self, registry: Optional[ModelRegistry] = None):
        self.registry = registry or ModelRegistry()
        self.eta_model, self.eta_meta = self.registry.load_model("eta_lgbm_quantile")
        self.lab_model, self.lab_meta = self.registry.load_model("lab_lgbm_quantile")
        self.qc_model, self.qc_meta = self.registry.load_model("qc_release_calibrated")

        # Reference distributions for drift tracking (PSI)
        self.eta_ref_features: Optional[np.ndarray] = None

    def set_reference_distributions(self, train_features: np.ndarray):
        """Set training baseline feature distributions for PSI drift calculations."""
        self.eta_ref_features = train_features

    def predict_eta(self, input_df: pd.DataFrame) -> Dict[str, Any]:
        """Predict transit duration quantiles (P50, P80, P90) with unseen category fallback."""
        try:
            preds = self.eta_model.predict(input_df)
            p50 = preds["p50"]
            p80 = preds["p80"]
            p90 = preds["p90"]
        except Exception:
            # Fallback to group median
            p50 = self.eta_model.fallback.predict(input_df)
            p80 = p50 * 1.25 # conservative scale
            p90 = p50 * 1.40

        # Check drift if reference set
        drift_status = "NORMAL"
        psi_score = 0.0
        if self.eta_ref_features is not None and len(input_df) > 10:
            if "volume_l" in input_df.columns:
                psi_score = compute_psi(input_df["volume_l"].values, self.eta_ref_features)
                if psi_score >= 0.25:
                    drift_status = "SIGNIFICANT_DRIFT"
                elif psi_score >= 0.10:
                    drift_status = "MODERATE_DRIFT"

        return {
            "p50_minutes": p50,
            "p80_minutes": p80,
            "p90_minutes": p90,
            "drift_status": drift_status,
            "psi_score": psi_score,
            "label": "DATA SINTETIS"
        }

    def predict_lab_duration(self, input_df: pd.DataFrame) -> Dict[str, Any]:
        """Predict lab testing duration quantiles."""
        try:
            preds = self.lab_model.predict(input_df)
            p50 = preds["p50"]
            p80 = preds["p80"]
            p90 = preds["p90"]
        except Exception:
            p50 = self.lab_model.fallback.predict(input_df)
            p80 = p50 * 1.20
            p90 = p50 * 1.35

        return {
            "p50_minutes": p50,
            "p80_minutes": p80,
            "p90_minutes": p90,
            "label": "DATA SINTETIS"
        }

    def predict_qc_release_probability(self, input_df: pd.DataFrame) -> np.ndarray:
        """Predict calibrated probability of QC release."""
        try:
            return self.qc_model.predict_proba(input_df)
        except Exception:
            # Fallback to prior rate
            return np.full(len(input_df), self.qc_model.prior_release_rate)
