"""
Master Configuration Loader and Validator.
Ensures every parameter in configs/master.yaml adheres to schema constraints
and detects all placeholder parameters.
Data Classification: DATA SINTETIS
Partner: [Nama Pabrik]
"""

from __future__ import annotations
import os
from pathlib import Path
from typing import List, Dict, Any, Optional
import yaml
from pydantic import BaseModel, Field, ConfigDict


class ParameterValue(BaseModel):
    value: Any
    placeholder: bool = False
    unit: Optional[str] = None
    description: Optional[str] = None


class TankerDistribution(BaseModel):
    distribution: str
    min_l: int
    max_l: int
    mean_l: int
    std_l: int
    placeholder: bool = True
    description: Optional[str] = None


class ReceivingConfig(BaseModel):
    n_bays: int
    bays: List[str]
    tankers_active_per_bay: int
    bay_flow_lph: ParameterValue
    bay_cip_min: ParameterValue
    slot_tolerance_min: ParameterValue
    tanker_volume_distribution: TankerDistribution


class LabConfig(BaseModel):
    n_channels: int
    channels: List[str]
    placeholder: bool = True
    default_duration_min: ParameterValue
    qc_pass_rate_default: ParameterValue


class StorageTankUnit(BaseModel):
    id: str
    capacity_l: float
    input_lph: float
    output_lph: float
    holding_max_h: float
    cip_min: int
    placeholder: bool = True


class StorageTanksConfig(BaseModel):
    count: int
    units: List[StorageTankUnit]


class ThermizerConfig(BaseModel):
    units: List[str]
    speed_lph: ParameterValue
    cip_min: ParameterValue


class SterilizerUnit(BaseModel):
    id: str
    speed_lph: float
    cip_min: int
    placeholder: bool = True


class SterilizerConfig(BaseModel):
    units: List[SterilizerUnit]


class AsepticTankUnit(BaseModel):
    id: str
    capacity_l: float
    input_lph: float
    output_lph: float
    min_level_l: float
    holding_max_h: float
    cip_min: int
    placeholder: bool = True


class AsepticTanksConfig(BaseModel):
    units: List[AsepticTankUnit]


class FillingLineUnit(BaseModel):
    id: str
    source_aseptic_tank: str
    speed_pack_per_h: int
    allowed_pack_sizes: List[str]
    allowed_skus: List[str]
    size_change_min: int
    paper_change_min: int
    variant_change_min: int
    cip_min: int
    placeholder: bool = True


class FillingLinesConfig(BaseModel):
    units: List[FillingLineUnit]


class SkuUnit(BaseModel):
    id: str
    name: str
    family: str
    flavour: str
    milk_usage_factor: float
    allowed_sizes: List[str]


class SkuMasterConfig(BaseModel):
    skus: List[SkuUnit]


class MasterConfig(BaseModel):
    """Root configuration model matching configs/master.yaml."""
    model_config = ConfigDict(extra="ignore")

    metadata: Dict[str, Any]
    plant_global: Dict[str, Any]
    receiving: ReceivingConfig
    lab: LabConfig
    degassing: Dict[str, Any]
    raw_milk_buffer_tanks: Dict[str, Any]
    thermizer: ThermizerConfig
    storage_tanks: StorageTanksConfig
    sterilizer: SterilizerConfig
    aseptic_tanks: AsepticTanksConfig
    filling_lines: FillingLinesConfig
    dedicated_pipes: Dict[str, Any]
    plant_derating: Dict[str, Any]
    maintenance_windows: Dict[str, Any]
    sku_master: SkuMasterConfig
    pack_sizes: Dict[str, int]
    changeover_rules: Dict[str, Any]
    cip_triggers: Dict[str, Any]
    optimizer: Dict[str, Any]

    def find_all_placeholders(self) -> List[Dict[str, Any]]:
        """Recursively scan configuration dictionary for placeholder: true markers."""
        placeholders = []

        def _scan(data: Any, path: str):
            if isinstance(data, dict):
                if data.get("placeholder") is True:
                    placeholders.append({
                        "path": path,
                        "value": data.get("value", data),
                        "unit": data.get("unit"),
                        "description": data.get("description")
                    })
                for k, v in data.items():
                    _scan(v, f"{path}.{k}" if path else k)
            elif isinstance(data, list):
                for i, item in enumerate(data):
                    _scan(item, f"{path}[{i}]")

        # Dump raw dict to scan
        raw_dict = self.model_dump()
        _scan(raw_dict, "")
        return placeholders


def load_master_config(config_path: Optional[str] = None) -> MasterConfig:
    """Load and validate the master configuration file."""
    if config_path is None:
        base_dir = Path(__file__).resolve().parent.parent.parent
        config_path = str(base_dir / "configs" / "master.yaml")

    if not os.path.exists(config_path):
        raise FileNotFoundError(f"Master config not found at: {config_path}")

    with open(config_path, "r", encoding="utf-8") as f:
        raw_data = yaml.safe_load(f)

    return MasterConfig.model_validate(raw_data)
