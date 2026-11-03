"""Layanan inferensi model Decision Core (data SINTETIS): ETA, durasi lab, peluang lolos QC, anomali.

ML hanya memprediksi. Gate dan CP-SAT tetap yang memutuskan. Artefak joblib adalah pickle, jadi
checksum SHA-256 diperiksa sebelum dimuat; selisih berarti model tidak dipakai (hasil tanpa `ai`).
"""

import hashlib
import json
import logging
import statistics
import sys
import threading
import types
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd

from app.config import settings
from app.contracts.result import AiAnomalyOut, AiOut, AiTruckOut
from app.generator import TankerSpec
from app.ml import models as ml_models
from app.predictor import Forecast, Predictor, _target, get_predictor, pinball

log = logging.getLogger("lactos.ai")

REGISTRY = Path(__file__).resolve().parents[2] / "models" / "registry"
LABEL = "DATA SINTETIS"
FARMS = [f"FARM-0{i}" for i in range(1, 6)]
MODEL_NAMES = (
    "eta_lgbm_quantile",
    "lab_lgbm_quantile",
    "qc_release_calibrated",
    "plant_anomaly_detector",
)
QUANTILES = (0.5, 0.8, 0.9)
_lock = threading.Lock()


class AiUnavailable(RuntimeError):
    pass


def map_farm(code: str) -> str | None:
    """FRM-0n (pabrik ini, 8 peternakan) -> FARM-0m (paket, 5 peternakan) dengan modulo."""
    digits = "".join(c for c in code if c.isdigit())
    if not digits:
        return None
    return FARMS[(int(digits) - 1) % len(FARMS)]


def _rush_morning(m: float) -> int:
    return int(60 <= m % 1440 <= 180)


def _rush_evening(m: float) -> int:
    return int(600 <= m % 1440 <= 720)


def _shift_boundary(m: float) -> int:
    return int(any(abs(m % 1440 - p) <= 20 for p in (0, 480, 960)))


@contextmanager
def _pickle_shim() -> Iterator[None]:
    """Artefak merujuk `src.predict.models`; modul itu dipasang sementara hanya selama memuat."""
    names = ("src", "src.predict", "src.predict.models")
    saved = {n: sys.modules.get(n) for n in names}
    sys.modules["src"] = types.ModuleType("src")
    sys.modules["src.predict"] = types.ModuleType("src.predict")
    sys.modules["src.predict.models"] = ml_models
    try:
        yield
    finally:
        for n, mod in saved.items():
            if mod is None:
                sys.modules.pop(n, None)
            else:
                sys.modules[n] = mod


def _verify(registry: Path) -> None:
    sums = registry / "SHA256SUMS"
    if not sums.exists():
        raise AiUnavailable("SHA256SUMS tidak ada")
    expected = dict(line.split()[::-1] for line in sums.read_text().splitlines() if line.strip())
    for name in MODEL_NAMES:
        f = f"{name}.joblib"
        path = registry / f
        if f not in expected or not path.exists():
            raise AiUnavailable(f"artefak {f} tidak terdaftar")
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected[f]:
            raise AiUnavailable(f"checksum {f} tidak cocok")


@dataclass(frozen=True)
class TruckInput:
    code: str
    farm_code: str
    volume_ton: float
    scheduled_eta_min: float
    sampling_min: float  # menit sampling lab (tiba); sebelum tiba pakai ETA terjadwal


class AiModels:
    def __init__(self, registry: Path = REGISTRY):
        _verify(registry)
        with _pickle_shim():
            loaded = {n: joblib.load(registry / f"{n}.joblib") for n in MODEL_NAMES}
        self.eta: ml_models.LightGBMQuantilePredictor = loaded["eta_lgbm_quantile"]
        self.lab: ml_models.LightGBMQuantilePredictor = loaded["lab_lgbm_quantile"]
        self.qc: ml_models.CalibratedQCClassifier = loaded["qc_release_calibrated"]
        self.anomaly: ml_models.PlantAnomalyDetector = loaded["plant_anomaly_detector"]
        self.meta = {n: json.loads((registry / f"{n}.meta.json").read_text()) for n in MODEL_NAMES}

    @staticmethod
    def _farm(rows: list[TruckInput]) -> pd.Categorical:
        return pd.Categorical([map_farm(r.farm_code) for r in rows], categories=FARMS)

    def typical_transit(self, rows: list[TruckInput]) -> np.ndarray:
        fb = self.eta.fallback
        return np.array(
            [fb.group_medians.get(map_farm(r.farm_code), fb.global_median) for r in rows],
            dtype=float,
        )

    def transit(self, rows: list[TruckInput]) -> dict[str, np.ndarray]:
        dep = np.array([r.scheduled_eta_min for r in rows]) - self.typical_transit(rows)
        x = pd.DataFrame(
            {
                "farm_id": self._farm(rows),
                "departure_hour": [int(d // 60) % 24 for d in dep],
                "planned_slot_hour": [int(r.scheduled_eta_min // 60) % 24 for r in rows],
                "is_morning_rush": [_rush_morning(d) for d in dep],
                "is_evening_rush": [_rush_evening(d) for d in dep],
                "volume_l": [r.volume_ton * 1000 for r in rows],
                "day_of_week": 0,
            }
        )
        return self.eta.predict(x)

    def lab_minutes(self, rows: list[TruckInput]) -> dict[str, np.ndarray]:
        x = pd.DataFrame(
            {
                "farm_id": self._farm(rows),
                "sampling_hour": [int(r.sampling_min // 60) % 24 for r in rows],
                "is_shift_boundary": [_shift_boundary(r.sampling_min) for r in rows],
                "day_of_week": 0,
            }
        )
        return self.lab.predict(x)

    def qc_release(self, rows: list[TruckInput]) -> np.ndarray:
        x = pd.DataFrame(
            {
                "farm_id": self._farm(rows),
                "sampling_hour": [int(r.sampling_min // 60) % 24 for r in rows],
                "day_of_week": 0,
                "volume_l": [r.volume_ton * 1000 for r in rows],
            }
        )
        return self.qc.predict_proba(x)

    def cards(self) -> list[dict[str, Any]]:
        return [
            {
                "name": n,
                "created_at": m.get("created_at"),
                "data_hash": m.get("data_hash"),
                "features": m.get("features"),
                "metrics": m.get("metrics"),
                "label": LABEL,
            }
            for n, m in self.meta.items()
        ]


@cache
def _load() -> AiModels | None:
    try:
        return AiModels()
    except Exception as exc:  # noqa: BLE001 - AI opsional; sistem inti tetap jalan tanpanya
        log.warning("Model AI tidak dimuat: %r", exc)
        return None


def get_ai() -> AiModels | None:
    with _lock:
        return _load()


def _inputs(specs: list[TankerSpec], arrived: dict[str, float] | None = None) -> list[TruckInput]:
    arrived = arrived or {}
    return [
        TruckInput(
            s.code,
            s.farm_code,
            s.volume_ton,
            s.scheduled_eta_min,
            arrived.get(s.code, s.scheduled_eta_min),
        )
        for s in specs
    ]


class CorePredictor:
    """Antarmuka sama dengan `Predictor` (forecast/mean/evaluate) agar scheduler, MC dan rolling
    tidak berubah. Keterlambatan = transit prediksi - transit tipikal peternakan itu (median
    paket); durasi lab langsung dari model lab. Model dilatih pada generator berbeda (sintetis)."""

    def __init__(self, ai: AiModels, base: Predictor | None = None):
        self.ai = ai
        self.base = base or get_predictor()
        self.mean = dict(self.base.mean)

    def forecast(self, target: str, specs: list[TankerSpec]) -> list[Forecast]:
        if not specs:
            return []
        rows = _inputs(specs)
        if target == "eta_delay":
            q = self.ai.transit(rows)
            typical = self.ai.typical_transit(rows)
            cols = np.column_stack([q["p50"], q["p80"], q["p90"]]) - typical[:, None]
        else:
            q = self.ai.lab_minutes(rows)
            cols = np.column_stack([q["p50"], q["p80"], q["p90"]])
        cols = np.maximum.accumulate(cols, axis=1)
        return [Forecast(*map(float, row)) for row in cols]

    def evaluate(self, specs: list[TankerSpec]) -> dict:
        report: dict = {}
        for target in ("eta_delay", "lab_duration"):
            y = np.array([_target(target, s) for s in specs])
            raw = np.array([[f.p50, f.p80, f.p90] for f in self.forecast(target, specs)])
            base = self.base.baseline[target]
            report[target] = {
                "n": len(specs),
                "pinball": {
                    str(q): round(pinball(y, raw[:, i], q), 3) for i, q in enumerate(QUANTILES)
                },
                "pinball_baseline": {
                    str(q): round(pinball(y, np.full_like(y, base[q]), q), 3) for q in QUANTILES
                },
                "coverage": {
                    str(q): round(float(np.mean(y <= raw[:, i])), 3)
                    for i, q in enumerate(QUANTILES)
                },
                "mae_p50": round(float(np.mean(np.abs(y - raw[:, 0]))), 2),
                "mae_baseline": round(float(np.mean(np.abs(y - base[0.5]))), 2),
            }
        return report


def anomaly_signals(sim) -> dict[str, float]:
    """Sinyal anomali dari keadaan akhir simulasi: residual neraca (L), umur batch tertua di
    tangki (jam) dan simpangan laju bongkar terbesar terhadap median (%)."""
    from app import balance

    residual_l = abs(balance.compute(sim)["in_process_ton"]) * 1000
    recs = list(sim.tankers.values())
    ages = [(r.ster_start - r.unload_end) / 60 for r in recs if r.ster_start and r.unload_end]
    rates = [
        r.spec.volume_ton * 1000 / ((r.unload_end - r.unload_start) / 60)
        for r in recs
        if r.unload_start is not None and r.unload_end is not None and r.unload_end > r.unload_start
    ]
    dev = 0.0
    if len(rates) > 1:
        med = statistics.median(rates)
        dev = max(abs(v - med) / med * 100 for v in rates)
    return {
        "balance_residual_l": round(residual_l, 2),
        "batch_age_h": round(max(ages, default=0.0), 2),
        "flow_deviation_pct": round(dev, 2),
    }


def build_ai(sim) -> AiOut | None:
    """Prediksi AI untuk hasil run (None bila model tidak tersedia)."""
    ai = get_ai()
    if ai is None or not sim.tankers:
        return None
    recs = list(sim.tankers.values())
    rows = _inputs([r.spec for r in recs], {r.spec.code: r.arrived for r in recs if r.arrived})
    tr, lab, qc = ai.transit(rows), ai.lab_minutes(rows), ai.qc_release(rows)
    typical = ai.typical_transit(rows)
    trucks = [
        AiTruckOut(
            code=r.code,
            transit_p50_min=round(float(tr["p50"][i]), 2),
            transit_p80_min=round(float(tr["p80"][i]), 2),
            transit_p90_min=round(float(tr["p90"][i]), 2),
            delay_p50_min=round(float(tr["p50"][i] - typical[i]), 2),
            delay_p80_min=round(float(tr["p80"][i] - typical[i]), 2),
            delay_p90_min=round(float(tr["p90"][i] - typical[i]), 2),
            lab_p50_min=round(float(lab["p50"][i]), 2),
            lab_p90_min=round(float(lab["p90"][i]), 2),
            qc_release_prob=round(min(1.0, max(0.0, float(qc[i]))), 4),
        )
        for i, r in enumerate(rows)
    ]
    sig = anomaly_signals(sim)
    scored = ai.anomaly.score_event(**sig)
    return AiOut(
        label=LABEL,
        models={n: str(m.get("data_hash")) for n, m in ai.meta.items()},
        trucks=trucks,
        anomaly=AiAnomalyOut(
            risk_score=round(scored["risk_score"], 4),
            is_anomaly=scored["is_anomaly"],
            flags=scored["flags"],
            **sig,
        ),
    )


@cache
def _core_predictor() -> CorePredictor | None:
    ai = get_ai()
    return CorePredictor(ai) if ai else None


def active_predictor() -> Predictor | CorePredictor:
    """Prediktor yang dipakai scheduler/MC/rolling: `ENGINE_PREDICTOR`, dengan jatuh ke builtin
    bila model Decision Core tidak termuat."""
    if settings.predictor == "core":
        with _lock:
            g = _core_predictor()
        if g is not None:
            return g
    return get_predictor()
