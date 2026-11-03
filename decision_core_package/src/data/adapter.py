"""
Data Adapter Interface.
Allows seamless swap between synthetic event logs and future real CSVs without code changes.
Data Classification: DATA SINTETIS
Partner: [Nama Pabrik]
"""

from __future__ import annotations
import abc
import os
from pathlib import Path
from typing import List, Dict, Any, Type, TypeVar
import pandas as pd
from pydantic import BaseModel

from src.data.schemas import (
    TankerTrip,
    LabTest,
    CipEvent,
    ChangeoverEvent,
    TankLevel,
    ProductionOrder,
    FillingOutput,
    AssetMaster,
    MaintenanceWindow,
)

T = TypeVar("T", bound=BaseModel)


class BaseDataAdapter(abc.ABC):
    """Abstract interface for ingesting and serializing operational data."""

    @abc.abstractmethod
    def load_tanker_trips(self) -> List[TankerTrip]:
        pass

    @abc.abstractmethod
    def load_lab_tests(self) -> List[LabTest]:
        pass

    @abc.abstractmethod
    def load_cip_events(self) -> List[CipEvent]:
        pass

    @abc.abstractmethod
    def load_changeover_events(self) -> List[ChangeoverEvent]:
        pass

    @abc.abstractmethod
    def load_tank_levels(self) -> List[TankLevel]:
        pass

    @abc.abstractmethod
    def load_production_orders(self) -> List[ProductionOrder]:
        pass

    @abc.abstractmethod
    def load_filling_outputs(self) -> List[FillingOutput]:
        pass


class CsvDataAdapter(BaseDataAdapter):
    """CSV-backed Data Adapter reading from/writing to directory of CSV files."""

    def __init__(self, data_dir: str):
        self.data_dir = Path(data_dir)

    def _load_csv_as_models(self, filename: str, model_cls: Type[T]) -> List[T]:
        file_path = self.data_dir / filename
        if not file_path.exists():
            return []
        df = pd.read_csv(file_path)
        records = df.to_dict(orient="records")
        cleaned_records = []
        for rec in records:
            clean_rec = {k: (None if pd.isna(v) else v) for k, v in rec.items()}
            cleaned_records.append(model_cls.model_validate(clean_rec))
        return cleaned_records

    def _save_models_to_csv(self, filename: str, models: List[BaseModel]):
        self.data_dir.mkdir(parents=True, exist_ok=True)
        file_path = self.data_dir / filename
        records = [m.model_dump() for m in models]
        df = pd.DataFrame(records)
        df.to_csv(file_path, index=False)

    def load_tanker_trips(self) -> List[TankerTrip]:
        return self._load_csv_as_models("tanker_trips.csv", TankerTrip)

    def save_tanker_trips(self, trips: List[TankerTrip]):
        self._save_models_to_csv("tanker_trips.csv", trips)

    def load_lab_tests(self) -> List[LabTest]:
        return self._load_csv_as_models("lab_tests.csv", LabTest)

    def save_lab_tests(self, tests: List[LabTest]):
        self._save_models_to_csv("lab_tests.csv", tests)

    def load_cip_events(self) -> List[CipEvent]:
        return self._load_csv_as_models("cip_events.csv", CipEvent)

    def save_cip_events(self, events: List[CipEvent]):
        self._save_models_to_csv("cip_events.csv", events)

    def load_changeover_events(self) -> List[ChangeoverEvent]:
        return self._load_csv_as_models("changeover_events.csv", ChangeoverEvent)

    def save_changeover_events(self, events: List[ChangeoverEvent]):
        self._save_models_to_csv("changeover_events.csv", events)

    def load_tank_levels(self) -> List[TankLevel]:
        return self._load_csv_as_models("tank_levels.csv", TankLevel)

    def save_tank_levels(self, levels: List[TankLevel]):
        self._save_models_to_csv("tank_levels.csv", levels)

    def load_production_orders(self) -> List[ProductionOrder]:
        return self._load_csv_as_models("production_orders.csv", ProductionOrder)

    def save_production_orders(self, orders: List[ProductionOrder]):
        self._save_models_to_csv("production_orders.csv", orders)

    def load_filling_outputs(self) -> List[FillingOutput]:
        return self._load_csv_as_models("filling_output.csv", FillingOutput)

    def save_filling_outputs(self, outputs: List[FillingOutput]):
        self._save_models_to_csv("filling_output.csv", outputs)
