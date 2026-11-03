"""Predictor kuantil (PRD 10.1): LightGBM objective quantile untuk keterlambatan truk dan durasi uji lab.

Dilatih pada riwayat sintetis dari generator, jadi hasil hanya memvalidasi pipeline di bawah asumsi
generator (PRD 10.8). Hanya fitur yang diketahui sebelum truk tiba yang boleh dipakai.
"""

import threading
from dataclasses import dataclass
from functools import cache

import lightgbm as lgb
import numpy as np

from app.generator import TankerSpec, clock_minute, generate_day, is_rush, is_shift_change

QUANTILES = (0.5, 0.8, 0.9)
TARGETS = ("eta_delay", "lab_duration")
TRAIN_DAYS = 120
TRAIN_SEED0 = 1000
HOLDOUT_SEED0 = 50_000


@dataclass(frozen=True)
class Forecast:
    p50: float
    p80: float
    p90: float

    def at(self, q: float) -> float:
        return {0.5: self.p50, 0.8: self.p80, 0.9: self.p90}[q]


def _features(target: str, s: TankerSpec) -> list[float]:
    hour = clock_minute(s.scheduled_eta_min) / 60
    if target == "eta_delay":
        return [s.farm_distance_km, hour, float(is_rush(s.scheduled_eta_min)), s.volume_ton]
    return [
        float(s.test_type == "extended"),
        hour,
        float(is_shift_change(s.scheduled_eta_min)),
        s.volume_ton,
    ]


def _target(target: str, s: TankerSpec) -> float:
    return s.arrival_min - s.scheduled_eta_min if target == "eta_delay" else s.lab_duration_min


def history(n_days: int, seed0: int) -> list[TankerSpec]:
    """Riwayat operasional sintetis dengan volume harian bervariasi."""
    out: list[TankerSpec] = []
    for d in range(n_days):
        volume = 250.0 + (d * 37 % 7) * 30.0  # 250 sampai 430 ton
        out.extend(generate_day(seed0 + d, volume))
    return out


def pinball(y: np.ndarray, pred: np.ndarray, q: float) -> float:
    d = y - pred
    return float(np.mean(np.maximum(q * d, (q - 1) * d)))


class Predictor:
    def __init__(self, train: list[TankerSpec]):
        self.models: dict[str, dict[float, lgb.Booster]] = {}
        self.baseline: dict[str, dict[float, float]] = {}
        self.mean: dict[str, float] = {}
        for target in TARGETS:
            x = np.array([_features(target, s) for s in train])
            y = np.array([_target(target, s) for s in train])
            self.mean[target] = float(np.mean(y))
            self.baseline[target] = {q: float(np.quantile(y, q)) for q in QUANTILES}
            self.models[target] = {
                q: lgb.train(
                    {
                        "objective": "quantile",
                        "alpha": q,
                        "learning_rate": 0.05,
                        "num_leaves": 8,
                        "min_data_in_leaf": 25,
                        "feature_fraction": 1.0,
                        "num_threads": 1,
                        "deterministic": True,
                        "force_row_wise": True,
                        "seed": 7,
                        "verbose": -1,
                    },
                    lgb.Dataset(x, label=y),
                    num_boost_round=150,
                )
                for q in QUANTILES
            }

    def _raw(self, target: str, specs: list[TankerSpec]) -> np.ndarray:
        x = np.array([_features(target, s) for s in specs])
        cols = np.column_stack([self.models[target][q].predict(x) for q in QUANTILES])
        return np.maximum.accumulate(cols, axis=1)  # cegah kuantil saling menyilang

    def forecast(self, target: str, specs: list[TankerSpec]) -> list[Forecast]:
        return [Forecast(*map(float, row)) for row in self._raw(target, specs)]

    def evaluate(self, specs: list[TankerSpec]) -> dict:
        """Pinball loss, MAE P50, dan coverage di data uji, dibandingkan kuantil riwayat global."""
        report: dict = {}
        for target in TARGETS:
            y = np.array([_target(target, s) for s in specs])
            raw = self._raw(target, specs)
            entry: dict = {"n": len(specs), "pinball": {}, "pinball_baseline": {}, "coverage": {}}
            for i, q in enumerate(QUANTILES):
                entry["pinball"][str(q)] = round(pinball(y, raw[:, i], q), 3)
                entry["pinball_baseline"][str(q)] = round(
                    pinball(y, np.full_like(y, self.baseline[target][q]), q), 3
                )
                entry["coverage"][str(q)] = round(float(np.mean(y <= raw[:, i])), 3)
            entry["mae_p50"] = round(float(np.mean(np.abs(y - raw[:, 0]))), 2)
            entry["mae_baseline"] = round(float(np.mean(np.abs(y - self.baseline[target][0.5]))), 2)
            report[target] = entry
        return report


_lock = threading.Lock()


@cache
def _build() -> Predictor:
    return Predictor(history(TRAIN_DAYS, TRAIN_SEED0))


def get_predictor() -> Predictor:
    with _lock:
        return _build()


def metrics(n_days: int = 30) -> dict:
    """Metrik pada hari-hari yang tidak dipakai melatih."""
    return get_predictor().evaluate(history(n_days, HOLDOUT_SEED0))
