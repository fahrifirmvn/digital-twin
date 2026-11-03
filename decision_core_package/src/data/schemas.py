"""
Data Contracts and Pydantic Schemas for LactaTwin Decision Core.
Data Classification: DATA SINTETIS
Partner: [Nama Pabrik]
"""

from __future__ import annotations
from enum import Enum
from typing import List, Dict, Optional, Any, Union
from pydantic import BaseModel, Field, ConfigDict


# ==========================================
# Enums
# ==========================================

class QCStatus(str, Enum):
    PENDING = "PENDING"
    RELEASED = "RELEASED"
    REJECTED = "REJECTED"


class TankState(str, Enum):
    EMPTY = "EMPTY"
    FILLING = "FILLING"
    HOLDING = "HOLDING"
    EMPTYING = "EMPTYING"
    CIP = "CIP"
    DIRTY = "DIRTY"


class ChangeoverType(str, Enum):
    VARIANT = "VARIANT"
    SIZE = "SIZE"
    PAPER = "PAPER"
    NONE = "NONE"


class MarketVariant(str, Enum):
    LOCAL = "LOCAL"
    EXP = "EXP"


class OrderStatus(str, Enum):
    PLANNED = "PLANNED"
    IN_PROGRESS = "IN_PROGRESS"
    COMPLETED = "COMPLETED"
    DELAYED = "DELAYED"
    CANCELLED = "CANCELLED"


# ==========================================
# Core Data Contracts (For Real & Synthetic Data)
# ==========================================

class TankerTrip(BaseModel):
    """Data contract for road tanker arrivals and unloading events."""
    model_config = ConfigDict(extra="ignore")

    trip_id: str = Field(..., description="Unique trip identifier (e.g. TR-20261101-001)")
    farm_id: str = Field(..., description="Source farm ID (e.g. FARM-A, FARM-B)")
    planned_slot_minute: int = Field(..., ge=0, description="Scheduled receiving slot in minutes from 06:00")
    volume_l: float = Field(..., gt=0, description="Measured or declared milk volume in Liters")
    departure_time_minute: Optional[int] = Field(None, ge=0, description="Time tanker departed farm")
    gate_arrival_time_minute: Optional[int] = Field(None, ge=0, description="Realized or predicted gate arrival")
    sampling_time_minute: Optional[int] = Field(None, ge=0, description="Sampling timestamp")
    lab_release_time_minute: Optional[int] = Field(None, ge=0, description="QC result released timestamp")
    qc_status: QCStatus = Field(default=QCStatus.PENDING, description="QC test result")
    assigned_bay: Optional[str] = Field(None, description="Receiving bay ID (UB-01..UB-04)")
    unload_start_minute: Optional[int] = Field(None, ge=0, description="Actual unloading start")
    unload_end_minute: Optional[int] = Field(None, ge=0, description="Actual unloading end")
    destination_tank_id: Optional[str] = Field(None, description="Target storage tank ID (SFP-01..SFP-15)")
    notes: Optional[str] = Field(default=None)


class LabTest(BaseModel):
    """Data contract for milk quality laboratory tests."""
    model_config = ConfigDict(extra="ignore")

    test_id: str = Field(..., description="Unique lab sample test ID")
    trip_id: str = Field(..., description="Associated tanker trip ID")
    farm_id: str = Field(..., description="Source farm ID")
    channel_id: str = Field(..., description="Lab channel or analyst station ID")
    sampling_time_minute: int = Field(..., ge=0)
    test_start_minute: int = Field(..., ge=0)
    test_end_minute: int = Field(..., ge=0)
    test_duration_min: int = Field(..., ge=1)
    result_released: bool = Field(..., description="True if passes all QC release gates")
    fat_pct: Optional[float] = Field(None, ge=0.0, le=10.0)
    protein_pct: Optional[float] = Field(None, ge=0.0, le=10.0)
    acidity_sh: Optional[float] = Field(None, ge=0.0)
    antibiotic_negative: bool = Field(default=True)


class CipEvent(BaseModel):
    """Data contract for asset Cleaning In Place (CIP) operations."""
    model_config = ConfigDict(extra="ignore")

    event_id: str = Field(..., description="Unique CIP event ID")
    asset_id: str = Field(..., description="Cleaned asset ID (e.g. SFP-01, UB-01, FL-01)")
    asset_type: str = Field(..., description="Asset category (Bay, StorageTank, Line, etc.)")
    trigger: str = Field(..., description="Reason for CIP (FLAVOUR, EMPTY_TANK, END_PRODUCTION, etc.)")
    start_time_minute: int = Field(..., ge=0)
    duration_min: int = Field(..., ge=1)
    end_time_minute: int = Field(..., ge=0)
    clean_status: bool = Field(default=True, description="Clean status verified after cycle")


class ChangeoverEvent(BaseModel):
    """Data contract for packaging line changeover events."""
    model_config = ConfigDict(extra="ignore")

    event_id: str = Field(..., description="Unique changeover event ID")
    line_id: str = Field(..., description="Filling line ID (FL-01..FL-10)")
    from_sku_id: str = Field(..., description="Previous finished or liquid SKU")
    to_sku_id: str = Field(..., description="Next finished or liquid SKU")
    changeover_type: ChangeoverType = Field(...)
    start_time_minute: int = Field(..., ge=0)
    duration_min: int = Field(..., ge=0)
    end_time_minute: int = Field(..., ge=0)


class TankLevel(BaseModel):
    """Data contract for tank inventory telemetry."""
    model_config = ConfigDict(extra="ignore")

    timestamp_minute: int = Field(..., ge=0)
    tank_id: str = Field(..., description="Storage or buffer tank ID")
    current_volume_l: float = Field(..., ge=0.0)
    usable_capacity_l: float = Field(..., gt=0.0)
    current_lot_id: Optional[str] = Field(None)
    oldest_batch_age_hours: float = Field(default=0.0, ge=0.0)
    state: TankState = Field(default=TankState.EMPTY)


class ProductionOrder(BaseModel):
    """Data contract for dynamic production work orders."""
    model_config = ConfigDict(extra="ignore")

    order_id: str = Field(..., description="Work order number")
    sku_id: str = Field(..., description="Liquid SKU ID (e.g. ESL-FC, UHT-CH)")
    finished_sku_id: Optional[str] = Field(None, description="Full finished SKU code")
    pack_size_code: str = Field(..., description="Pack size code (LARGE_A, LARGE_B, etc.)")
    market_variant: MarketVariant = Field(default=MarketVariant.LOCAL)
    target_volume_l: float = Field(..., gt=0.0)
    due_time_minute: int = Field(..., ge=0, description="Delivery due time from 06:00")
    earliest_start_minute: int = Field(default=0, ge=0)
    priority: int = Field(default=1, ge=1, le=5)
    status: OrderStatus = Field(default=OrderStatus.PLANNED)


class FillingOutput(BaseModel):
    """Data contract for finished packaging line outputs."""
    model_config = ConfigDict(extra="ignore")

    output_id: str = Field(..., description="Run batch output ID")
    order_id: str = Field(...)
    line_id: str = Field(..., description="Filling line ID (FL-01..FL-10)")
    sku_id: str = Field(...)
    pack_size_ml: int = Field(..., gt=0)
    start_time_minute: int = Field(..., ge=0)
    end_time_minute: int = Field(..., ge=0)
    pack_count: int = Field(..., ge=0)
    good_packs: int = Field(..., ge=0)
    reject_packs: int = Field(default=0, ge=0)
    liquid_consumed_l: float = Field(..., ge=0.0)


class AssetMaster(BaseModel):
    """Data contract for physical asset master attributes."""
    model_config = ConfigDict(extra="ignore")

    asset_id: str = Field(...)
    asset_type: str = Field(...)
    node_role: str = Field(...)
    capacity_l: Optional[float] = Field(None)
    input_flow_lph: Optional[float] = Field(None)
    output_flow_lph: Optional[float] = Field(None)
    process_speed_lph: Optional[float] = Field(None)
    holding_time_limit_hours: Optional[float] = Field(None)
    cip_duration_minutes: Optional[int] = Field(None)
    speed_packph: Optional[int] = Field(None)


class MaintenanceWindow(BaseModel):
    """Data contract for scheduled asset maintenance windows."""
    model_config = ConfigDict(extra="ignore")

    window_id: str = Field(...)
    asset_id: str = Field(...)
    start_minute: int = Field(..., ge=0)
    end_minute: int = Field(..., ge=0)
    duration_min: int = Field(..., gt=0)
    description: Optional[str] = Field(None)


# ==========================================
# Decision & Schedule Output Schemas
# ==========================================

class TankerDecision(BaseModel):
    """Scheduled decisions for a single road tanker."""
    trip_id: str
    farm_id: str
    volume_l: float
    planned_slot_minute: int
    predicted_arrival_p50: int
    predicted_arrival_p80: int
    predicted_lab_duration: int
    p_release: float
    assigned_bay: str
    assigned_tank: str
    scheduled_unload_start: int
    scheduled_unload_end: int
    waiting_time_minutes: int
    is_split: bool = False
    secondary_tank: Optional[str] = None
    secondary_volume_l: Optional[float] = None
    reasons: Dict[str, Any] = Field(default_factory=dict)


class ScheduleResult(BaseModel):
    """Top-level schedule result generated by CP-SAT solver."""
    model_config = ConfigDict(extra="ignore")

    schedule_id: str
    timestamp: str
    status: str # OPTIMAL, FEASIBLE, INFEASIBLE
    wall_time_seconds: float
    objective_value: Optional[float] = None
    tanker_decisions: List[TankerDecision] = Field(default_factory=list)
    cip_decisions: List[Dict[str, Any]] = Field(default_factory=list)
    production_decisions: List[Dict[str, Any]] = Field(default_factory=list)
    kpis: Dict[str, Any] = Field(default_factory=dict)
    violations: List[str] = Field(default_factory=list)
    infeasibility_reasons: List[str] = Field(default_factory=list)
    label: str = "DATA SINTETIS"


class OrderFeasibilityVerdict(BaseModel):
    """Feasibility outcome and schedule parameters for a production order."""
    model_config = ConfigDict(extra="ignore")

    order_id: str
    sku_id: str
    target_volume_l: float
    due_time_minute: int
    dapat_dipenuhi: bool
    assigned_line: Optional[str] = None
    scheduled_start_minute: Optional[int] = None
    scheduled_end_minute: Optional[int] = None
    lateness_minutes: int = 0
    changeover_from_previous_min: int = 0
    limiting_cause: Optional[str] = None # INSUFFICIENT_RAW_MATERIAL, INSUFFICIENT_FILLER_CAPACITY, INELIGIBLE_LINE_SKU, MAINTENANCE_BLOCK, EXCESSIVE_CHANGEOVER
    details: Dict[str, Any] = Field(default_factory=dict)
    label: str = "DATA SINTETIS"


class ProductionScheduleResult(BaseModel):
    """Comprehensive production schedule result containing order verdicts and KPIs."""
    model_config = ConfigDict(extra="ignore")

    schedule_id: str
    status: str
    wall_time_seconds: float
    total_orders: int
    fulfilled_orders: int
    unfulfilled_orders: int
    total_volume_requested_l: float
    total_volume_fulfilled_l: float
    order_verdicts: List[OrderFeasibilityVerdict]
    objective_value: Optional[float] = None
    label: str = "DATA SINTETIS"
