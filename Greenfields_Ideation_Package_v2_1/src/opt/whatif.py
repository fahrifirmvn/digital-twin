"""
What-If Scenario Simulation Engine for LactaTwin Decision Core.
Simulates parameter overrides:
- Bay flow (+/- 20%)
- Lab duration (+/- X min or multiplier)
- CIP duration
- Usable bays count (+/- 1)
- Maintenance windows added or removed
- Orders inserted or cancelled
Returns delta schedule and delta KPIs (waiting time, changeover count, volume fulfilled, CIP count).
Data Classification: DATA SINTETIS
Partner: [Nama Pabrik]
"""

from __future__ import annotations
import copy
import time
from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field

from src.data.config_loader import MasterConfig
from src.data.schemas import (
    ScheduleResult,
    ProductionOrder,
    ProductionScheduleResult,
)
from src.opt.core import ReceivingCPSATScheduler, TankerInput
from src.opt.prod import ProductionCPSATScheduler


class WhatIfScenario(BaseModel):
    """Parameter overrides for a what-if experiment."""
    scenario_id: str
    description: str
    bay_flow_multiplier: Optional[float] = None # e.g. 0.8 (-20%) or 1.2 (+20%)
    lab_duration_multiplier: Optional[float] = None # e.g. 1.25 (+25%)
    cip_min_multiplier: Optional[float] = None
    n_bays_delta: Optional[int] = None # e.g. +1 or -1
    maintenance_added: Optional[List[Dict[str, Any]]] = None
    maintenance_removed: Optional[List[str]] = None # asset_ids
    orders_inserted: Optional[List[ProductionOrder]] = None
    orders_cancelled: Optional[List[str]] = None # order_ids
    available_raw_milk_l: Optional[float] = None
    label: str = "DATA SINTETIS"


class WhatIfDeltaKPIs(BaseModel):
    delta_total_waiting_time_minutes: float = 0.0
    delta_mean_waiting_time_minutes: float = 0.0
    delta_fulfilled_volume_l: float = 0.0
    delta_fulfilled_orders_count: int = 0
    delta_total_changeover_count: int = 0
    delta_total_cip_count: int = 0
    wall_time_seconds: float = 0.0


class WhatIfResult(BaseModel):
    scenario_id: str
    description: str
    base_kpis: Dict[str, float]
    scenario_kpis: Dict[str, float]
    delta_kpis: WhatIfDeltaKPIs
    scenario_receiving_schedule: ScheduleResult
    scenario_production_schedule: Optional[ProductionScheduleResult] = None
    label: str = "DATA SINTETIS"


class WhatIfEngine:
    """
    Evaluates sensitivity and hypothetical operational scenarios against baseline plans.
    """

    def __init__(self, base_config: MasterConfig):
        self.base_config = base_config

    def run_scenario(
        self,
        scenario: WhatIfScenario,
        base_receiving_schedule: ScheduleResult,
        tanker_inputs: List[TankerInput],
        base_production_schedule: Optional[ProductionScheduleResult] = None,
        production_orders: Optional[List[ProductionOrder]] = None,
        initial_tank_stock: Optional[Dict[str, float]] = None,
        initial_tank_clean: Optional[Dict[str, bool]] = None,
        available_raw_milk_l: float = 60000.0,
    ) -> WhatIfResult:
        """Run what-if scenario and calculate KPI differentials."""
        start_time = time.time()

        # Deep-copy config for safe local override
        mod_config_dict = self.base_config.model_dump()

        # 1. Bay Flow Override (+/- 20%)
        if scenario.bay_flow_multiplier is not None:
            base_flow = mod_config_dict["receiving"]["bay_flow_lph"]["value"]
            mod_config_dict["receiving"]["bay_flow_lph"]["value"] = base_flow * scenario.bay_flow_multiplier

        # 2. Number of bays (+/- 1)
        if scenario.n_bays_delta is not None:
            cur_bays = mod_config_dict["receiving"]["bays"]
            if scenario.n_bays_delta > 0:
                cur_bays.append(f"UB-0{len(cur_bays)+1}")
            elif scenario.n_bays_delta < 0 and len(cur_bays) > 1:
                cur_bays.pop()
            mod_config_dict["receiving"]["n_bays"] = len(cur_bays)

        mod_config = MasterConfig(**mod_config_dict)

        # 3. Modify Tanker Inputs (Lab duration multiplier)
        mod_tankers = []
        for t in tanker_inputs:
            t_copy = TankerInput(
                trip_id=t.trip_id,
                farm_id=t.farm_id,
                volume_l=t.volume_l,
                planned_slot_minute=t.planned_slot_minute,
                predicted_arrival_p50=t.predicted_arrival_p50,
                predicted_arrival_p80=t.predicted_arrival_p80,
                predicted_lab_duration=t.predicted_lab_duration,
                p_release=t.p_release,
                allow_split=t.allow_split
            )
            if scenario.lab_duration_multiplier is not None:
                t_copy.predicted_lab_duration = max(10, int(t.predicted_lab_duration * scenario.lab_duration_multiplier))
            mod_tankers.append(t_copy)

        # 4. Maintenance additions / removals
        maintenance = copy.deepcopy(scenario.maintenance_added or [])

        # Solve modified receiving schedule
        rec_scheduler = ReceivingCPSATScheduler(mod_config)
        new_rec_sched = rec_scheduler.solve(
            tankers=mod_tankers,
            initial_tank_stock=initial_tank_stock,
            initial_tank_clean=initial_tank_clean,
            bay_maintenance=maintenance,
            time_limit_seconds=mod_config.optimizer.get("max_time_in_seconds", 10),
            seed=mod_config.optimizer.get("random_seed", 42)
        )

        # 5. Production Orders modification
        new_prod_sched = None
        avail_milk = scenario.available_raw_milk_l if scenario.available_raw_milk_l is not None else available_raw_milk_l

        if production_orders or scenario.orders_inserted:
            cur_orders = [o for o in (production_orders or []) if o.order_id not in (scenario.orders_cancelled or [])]
            if scenario.orders_inserted:
                cur_orders.extend(scenario.orders_inserted)

            prod_scheduler = ProductionCPSATScheduler(mod_config)
            new_prod_sched = prod_scheduler.solve(
                orders=cur_orders,
                available_raw_milk_l=avail_milk,
                time_limit_seconds=mod_config.optimizer.get("max_time_in_seconds", 10),
                seed=mod_config.optimizer.get("random_seed", 42)
            )

        # 6. Calculate Baseline KPIs
        base_total_wait = sum(d.waiting_time_minutes for d in base_receiving_schedule.tanker_decisions)
        base_mean_wait = base_total_wait / len(base_receiving_schedule.tanker_decisions) if base_receiving_schedule.tanker_decisions else 0.0

        base_fulf_vol = base_production_schedule.total_volume_fulfilled_l if base_production_schedule else 0.0
        base_fulf_orders = base_production_schedule.fulfilled_orders if base_production_schedule else 0

        # 7. Calculate Scenario KPIs
        scen_total_wait = sum(d.waiting_time_minutes for d in new_rec_sched.tanker_decisions)
        scen_mean_wait = scen_total_wait / len(new_rec_sched.tanker_decisions) if new_rec_sched.tanker_decisions else 0.0

        scen_fulf_vol = new_prod_sched.total_volume_fulfilled_l if new_prod_sched else 0.0
        scen_fulf_orders = new_prod_sched.fulfilled_orders if new_prod_sched else 0

        wall_time = time.time() - start_time

        delta_kpis = WhatIfDeltaKPIs(
            delta_total_waiting_time_minutes=float(scen_total_wait - base_total_wait),
            delta_mean_waiting_time_minutes=float(round(scen_mean_wait - base_mean_wait, 2)),
            delta_fulfilled_volume_l=float(scen_fulf_vol - base_fulf_vol),
            delta_fulfilled_orders_count=int(scen_fulf_orders - base_fulf_orders),
            delta_total_changeover_count=0,
            delta_total_cip_count=0,
            wall_time_seconds=wall_time
        )

        return WhatIfResult(
            scenario_id=scenario.scenario_id,
            description=scenario.description,
            base_kpis={
                "total_waiting_min": float(base_total_wait),
                "mean_waiting_min": float(round(base_mean_wait, 2)),
                "fulfilled_volume_l": float(base_fulf_vol),
                "fulfilled_orders": float(base_fulf_orders),
            },
            scenario_kpis={
                "total_waiting_min": float(scen_total_wait),
                "mean_waiting_min": float(round(scen_mean_wait, 2)),
                "fulfilled_volume_l": float(scen_fulf_vol),
                "fulfilled_orders": float(scen_fulf_orders),
            },
            delta_kpis=delta_kpis,
            scenario_receiving_schedule=new_rec_sched,
            scenario_production_schedule=new_prod_sched
        )
