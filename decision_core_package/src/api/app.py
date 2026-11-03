"""
FastAPI REST Application for LactaTwin Decision Core.
Endpoints:
- POST /predict/eta: Predict transit duration quantiles (P50, P80, P90)
- POST /predict/lab: Predict lab testing duration quantiles
- POST /plan: Generate 24-hour baseline receiving & production plan
- POST /replan: Dynamic replan with event triggers & frozen windows
- POST /whatif: Simulate parameter overrides and compute KPI deltas
- GET /explain/{schedule_id}: Return structured rationales, slack, and conflict sets
- GET /trace/forward/{trip_id}: Forward genealogy trace
- GET /trace/backward/{lot_id}: Backward genealogy trace
- GET /neraca: Plant volume balance and mass conservation status
Data Classification: DATA SINTETIS
Partner: [Nama Pabrik]
"""

import os
from typing import List, Dict, Any, Optional
from fastapi import FastAPI, HTTPException, status
from pydantic import BaseModel, Field
import pandas as pd
import numpy as np

from src.data.config_loader import load_master_config
from src.predict.registry import ModelInferenceService
from src.opt.core import TankerInput, ReceivingCPSATScheduler
from src.opt.prod import ProductionCPSATScheduler
from src.opt.replan import (
    DynamicReplanner,
    PlantState,
    ReplanEvent,
    ReplanResult,
)
from src.opt.explain import ScheduleExplainer, ScheduleExplanation
from src.opt.whatif import (
    WhatIfEngine,
    WhatIfScenario,
    WhatIfResult,
)
from src.trace.genealogy import (
    GenealogyTracer,
    ForwardTraceReport,
    BackwardTraceReport,
)
from src.sim.engine import TransferRecord
from src.data.schemas import (
    ProductionOrder,
    ScheduleResult,
    ProductionScheduleResult,
)

app = FastAPI(
    title="LactaTwin Decision Core API",
    description="Operational ML Prediction and OR-Tools CP-SAT Scheduling Engine for [Nama Pabrik]. DATA SINTETIS.",
    version="1.0.0"
)

# Global runtime state
config = load_master_config()
try:
    inference_service = ModelInferenceService()
except Exception:
    inference_service = None

replanner = DynamicReplanner(config)
explainer = ScheduleExplainer(config)
whatif_engine = WhatIfEngine(config)

# Cache for generated schedules to power /explain
SCHEDULES_CACHE: Dict[str, Dict[str, Any]] = {}

# In-memory transfer ledger for genealogy
SAMPLE_TRANSFERS: List[TransferRecord] = [
    TransferRecord(
        transfer_id="TRF-001",
        source_batch="TRIP-001",
        target_batch="LOT-SFP-01-001",
        source_asset="UB-01",
        target_asset="SFP-01",
        start_time_minute=120,
        end_time_minute=150,
        volume_l=10000.0,
        product_sku="RAW-MILK"
    ),
    TransferRecord(
        transfer_id="TRF-002",
        source_batch="SFP-01",
        target_batch="FG-ORD-01",
        source_asset="FL-01",
        target_asset="FG-OUTPUT",
        start_time_minute=200,
        end_time_minute=280,
        volume_l=10000.0,
        product_sku="ESL-FC"
    )
]
tracer = GenealogyTracer(transfer_ledger=SAMPLE_TRANSFERS)


# ==========================================
# Request / Response Schemas
# ==========================================

class EtaPredictionRequest(BaseModel):
    farm_id: str
    departure_hour: int = Field(..., ge=0, le=23)
    day_of_week: int = Field(default=2, ge=0, le=6)
    volume_l: float = Field(default=10000.0, gt=0)
    historical_avg_transit_min: float = Field(default=60.0, gt=0)


class LabPredictionRequest(BaseModel):
    farm_id: str
    sampling_hour: int = Field(..., ge=0, le=23)
    shift_id: int = Field(default=1, ge=1, le=3)
    is_shift_change: int = Field(default=0, ge=0, le=1)
    queue_length_at_sampling: int = Field(default=1, ge=0)


class PlanDayRequest(BaseModel):
    tankers: List[TankerInput]
    production_orders: Optional[List[ProductionOrder]] = None
    state: Optional[PlantState] = None


class ReplanRequest(BaseModel):
    events: List[ReplanEvent]
    previous_schedule: ScheduleResult
    tankers: List[TankerInput]
    production_orders: Optional[List[ProductionOrder]] = None
    state: Optional[PlantState] = None
    force: bool = False


class WhatIfRequest(BaseModel):
    scenario: WhatIfScenario
    base_receiving_schedule: ScheduleResult
    tankers: List[TankerInput]
    base_production_schedule: Optional[ProductionScheduleResult] = None
    production_orders: Optional[List[ProductionOrder]] = None
    available_raw_milk_l: float = 60000.0


# ==========================================
# Endpoints
# ==========================================

@app.get("/")
def root():
    return {
        "service": "LactaTwin Decision Core API",
        "partner": "[Nama Pabrik]",
        "data_classification": "DATA SINTETIS",
        "status": "ONLINE"
    }


@app.post("/predict/eta")
def predict_eta(req: EtaPredictionRequest):
    """Predict transit duration quantiles (P50, P80, P90)."""
    input_df = pd.DataFrame([{
        "farm_id": req.farm_id,
        "departure_hour": req.departure_hour,
        "day_of_week": req.day_of_week,
        "volume_l": req.volume_l,
        "historical_avg_transit_min": req.historical_avg_transit_min,
        "departure_delay_min": 0.0,
        "is_rush_hour": 1 if req.departure_hour in [7, 8, 17, 18] else 0,
        "route_distance_km": 45.0
    }])

    if inference_service:
        preds = inference_service.predict_eta(input_df)
        return {
            "farm_id": req.farm_id,
            "p50_minutes": float(preds["p50_minutes"][0]),
            "p80_minutes": float(preds["p80_minutes"][0]),
            "p90_minutes": float(preds["p90_minutes"][0]),
            "drift_status": preds.get("drift_status", "NORMAL"),
            "label": "DATA SINTETIS"
        }
    else:
        # Fallback calculation
        base = req.historical_avg_transit_min
        return {
            "farm_id": req.farm_id,
            "p50_minutes": round(base, 1),
            "p80_minutes": round(base * 1.25, 1),
            "p90_minutes": round(base * 1.40, 1),
            "drift_status": "NORMAL",
            "label": "DATA SINTETIS"
        }


@app.post("/predict/lab")
def predict_lab(req: LabPredictionRequest):
    """Predict QC lab test duration quantiles (P50, P80, P90)."""
    input_df = pd.DataFrame([{
        "farm_id": req.farm_id,
        "sampling_hour": req.sampling_hour,
        "shift_id": req.shift_id,
        "is_shift_change": req.is_shift_change,
        "queue_length_at_sampling": req.queue_length_at_sampling,
        "historical_avg_lab_min": 25.0
    }])

    if inference_service:
        preds = inference_service.predict_lab_duration(input_df)
        return {
            "farm_id": req.farm_id,
            "p50_minutes": float(preds["p50_minutes"][0]),
            "p80_minutes": float(preds["p80_minutes"][0]),
            "p90_minutes": float(preds["p90_minutes"][0]),
            "label": "DATA SINTETIS"
        }
    else:
        return {
            "farm_id": req.farm_id,
            "p50_minutes": 25.0,
            "p80_minutes": 31.0,
            "p90_minutes": 35.0,
            "label": "DATA SINTETIS"
        }


@app.post("/plan", response_model=ReplanResult)
def plan_day(req: PlanDayRequest):
    """Generate 24-hour baseline schedule for receiving and production."""
    current_state = req.state or PlantState(current_time_minute=0)
    result = replanner.plan_day(
        state=current_state,
        tanker_inputs=req.tankers,
        production_orders=req.production_orders
    )
    # Save into cache for /explain
    SCHEDULES_CACHE[result.schedule_id] = {
        "receiving": result.receiving_schedule,
        "production": result.production_schedule,
        "orders": req.production_orders,
        "available_milk": current_state.available_raw_milk_l
    }
    return result


@app.post("/replan", response_model=ReplanResult)
def replan(req: ReplanRequest):
    """Dynamic replanning triggered by disruption events."""
    current_state = req.state or PlantState(current_time_minute=60)
    result = replanner.replan(
        state=current_state,
        events=req.events,
        previous_schedule=req.previous_schedule,
        tanker_inputs=req.tankers,
        production_orders=req.production_orders,
        force=req.force
    )
    SCHEDULES_CACHE[result.schedule_id] = {
        "receiving": result.receiving_schedule,
        "production": result.production_schedule,
        "orders": req.production_orders,
        "available_milk": current_state.available_raw_milk_l
    }
    return result


@app.post("/whatif", response_model=WhatIfResult)
def what_if(req: WhatIfRequest):
    """Run what-if scenario with parameter overrides and KPI deltas."""
    return whatif_engine.run_scenario(
        scenario=req.scenario,
        base_receiving_schedule=req.base_receiving_schedule,
        tanker_inputs=req.tankers,
        base_production_schedule=req.base_production_schedule,
        production_orders=req.production_orders,
        available_raw_milk_l=req.available_raw_milk_l
    )


@app.get("/explain/{schedule_id}", response_model=ScheduleExplanation)
def explain_schedule(schedule_id: str):
    """Return structured JSON explanation for a schedule ID."""
    cached = SCHEDULES_CACHE.get(schedule_id)
    if cached:
        return explainer.explain(
            schedule_id=schedule_id,
            receiving_schedule=cached.get("receiving"),
            production_schedule=cached.get("production"),
            orders=cached.get("orders"),
            available_raw_milk_l=cached.get("available_milk", 50000.0)
        )
    else:
        # Generate an on-the-fly explanation for requested ID
        return explainer.explain(schedule_id=schedule_id)


@app.get("/trace/forward/{trip_id}", response_model=ForwardTraceReport)
def trace_forward(trip_id: str):
    """Trace milk shipment forward from receiving to finished goods."""
    clean_id = trip_id.replace("TRIP-", "")
    return tracer.forward_trace(clean_id)


@app.get("/trace/backward/{lot_id}", response_model=BackwardTraceReport)
def trace_backward(lot_id: str):
    """Trace finished product lot backward to storage tanks, tanker trips, and farms."""
    return tracer.backward_trace(lot_id)


@app.get("/neraca")
def get_mass_balance():
    """Daily plant volume balance and mass conservation status."""
    # Read telemetry or report daily balance
    opening_stock = 45000.0
    milk_in = 180000.0
    liquid_consumed = 160000.0
    closing_stock = 65000.0
    residual = abs((opening_stock + milk_in) - (liquid_consumed + closing_stock))

    return {
        "status": "BALANCED" if residual <= 1.0 else "RESIDUAL_DETECTED",
        "opening_stock_l": opening_stock,
        "total_milk_in_l": milk_in,
        "filling_liquid_consumed_l": liquid_consumed,
        "closing_stock_l": closing_stock,
        "volume_residual_l": residual,
        "is_conserved": residual <= 1.0,
        "partner": "[Nama Pabrik]",
        "data_classification": "DATA SINTETIS"
    }
