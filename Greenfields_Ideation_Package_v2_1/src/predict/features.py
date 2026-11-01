"""
Feature Engineering for Predictive Models (T1: ETA, T2: Lab Duration, T3: QC Release).
STRICT RULE: No feature leakage — only data known at prediction timestamp is used.
Data Classification: DATA SINTETIS
Partner: [Nama Pabrik]
"""

from __future__ import annotations
import math
from typing import Dict, Any, List, Tuple
import numpy as np
import pandas as pd


def extract_day_index_from_trip_id(trip_id: str) -> int:
    """Extract day number from trip ID format TR-D001-001."""
    try:
        parts = trip_id.split("-")
        if len(parts) >= 2 and parts[1].startswith("D"):
            return int(parts[1][1:])
    except Exception:
        pass
    return 1


def is_morning_rush_hour(minute_of_day: int) -> int:
    """Return 1 if minute is in morning rush (07:00-09:00 / t=60..180m), else 0."""
    return 1 if 60 <= (minute_of_day % 1440) <= 180 else 0


def is_evening_rush_hour(minute_of_day: int) -> int:
    """Return 1 if minute is in evening rush (16:00-18:00 / t=600..720m), else 0."""
    return 1 if 600 <= (minute_of_day % 1440) <= 720 else 0


def is_shift_boundary(minute_of_day: int) -> int:
    """Return 1 if within 20 min of shift handovers (06:00=0, 14:00=480, 22:00=960)."""
    m = minute_of_day % 1440
    for sp in [0, 480, 960]:
        if abs(m - sp) <= 20:
            return 1
    return 0


class FeatureExtractor:
    """Transforms raw trip and lab logs into clean, leak-free feature vectors."""

    @staticmethod
    def prepare_eta_features(df_trips: pd.DataFrame) -> Tuple[pd.DataFrame, pd.Series]:
        """
        Target T1: Transit duration in minutes (gate_arrival - departure).
        Features available at departure time:
        - farm_id (encoded)
        - departure_hour
        - planned_slot_hour
        - is_morning_rush
        - is_evening_rush
        - volume_l
        - day_of_week
        """
        df = df_trips.copy()
        # Filter valid trips with arrival time
        df = df.dropna(subset=["gate_arrival_time_minute", "departure_time_minute"])

        # Target: Transit minutes
        y = df["gate_arrival_time_minute"] - df["departure_time_minute"]

        features = pd.DataFrame(index=df.index)
        features["farm_id"] = df["farm_id"].astype("category")
        features["departure_hour"] = (df["departure_time_minute"] // 60) % 24
        features["planned_slot_hour"] = (df["planned_slot_minute"] // 60) % 24
        features["is_morning_rush"] = df["departure_time_minute"].apply(is_morning_rush_hour)
        features["is_evening_rush"] = df["departure_time_minute"].apply(is_evening_rush_hour)
        features["volume_l"] = df["volume_l"]

        # Day index for time-based train/val/test split
        features["day_index"] = df["trip_id"].apply(extract_day_index_from_trip_id)
        features["day_of_week"] = (features["day_index"] % 7)

        return features, y

    @staticmethod
    def prepare_lab_features(df_labs: pd.DataFrame) -> Tuple[pd.DataFrame, pd.Series]:
        """
        Target T2: Lab duration in minutes (sampling to test result).
        Features available at sampling time:
        - farm_id (encoded)
        - sampling_hour
        - is_shift_boundary
        - day_of_week
        """
        df = df_labs.copy()
        df = df.dropna(subset=["test_duration_min"])

        y = df["test_duration_min"]

        features = pd.DataFrame(index=df.index)
        features["farm_id"] = df["farm_id"].astype("category")
        features["sampling_hour"] = (df["sampling_time_minute"] // 60) % 24
        features["is_shift_boundary"] = df["sampling_time_minute"].apply(is_shift_boundary)

        features["day_index"] = df["trip_id"].apply(extract_day_index_from_trip_id)
        features["day_of_week"] = (features["day_index"] % 7)

        return features, y

    @staticmethod
    def prepare_qc_release_features(df_labs: pd.DataFrame, df_trips: Optional[pd.DataFrame] = None) -> Tuple[pd.DataFrame, pd.Series]:
        """
        Target T3: Probability of Released (Binary: 1=RELEASED, 0=REJECTED).
        Features known at or before test completion.
        """
        df = df_labs.copy()
        y = df["result_released"].astype(int)

        features = pd.DataFrame(index=df.index)
        features["farm_id"] = df["farm_id"].astype("category")
        features["sampling_hour"] = (df["sampling_time_minute"] // 60) % 24
        features["day_index"] = df["trip_id"].apply(extract_day_index_from_trip_id)
        features["day_of_week"] = (features["day_index"] % 7)

        if df_trips is not None:
            trip_map = df_trips.set_index("trip_id")["volume_l"].to_dict()
            features["volume_l"] = df["trip_id"].map(trip_map).fillna(10000.0)
        else:
            features["volume_l"] = 10000.0

        return features, y
