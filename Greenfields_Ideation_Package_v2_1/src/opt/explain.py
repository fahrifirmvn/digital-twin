"""
Schedule Explainability and Root Cause Diagnostic Engine.
Produces structured JSON explanations for:
1. Tanker bay & slot assignment rationale.
2. Binding physical constraints.
3. Slack analysis (tankers & packaging lines).
4. Minimal conflict sets for unfulfilled or late work orders.
Data Classification: DATA SINTETIS
Partner: [Nama Pabrik]
"""

from __future__ import annotations
import time
from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field

from src.data.schemas import (
    ScheduleResult,
    TankerDecision,
    OrderFeasibilityVerdict,
    ProductionScheduleResult,
    ProductionOrder,
)
from src.data.config_loader import MasterConfig


class TankerRationale(BaseModel):
    trip_id: str
    farm_id: str
    assigned_bay: str
    assigned_tank: str
    scheduled_unload_start: int
    scheduled_unload_end: int
    waiting_time_minutes: int
    reasons: List[str] = Field(default_factory=list)


class BindingConstraint(BaseModel):
    constraint_name: str
    asset_id: str
    time_window: str
    impact_description: str
    severity: str = "BINDING"


class SlackMetric(BaseModel):
    entity_id: str
    entity_type: str # TANKER or LINE
    slack_minutes: float
    idle_pct: float = 0.0
    bottleneck_risk: str = "LOW" # LOW, MEDIUM, HIGH


class ConflictSet(BaseModel):
    order_id: str
    sku_id: str
    conflict_type: str # INSUFFICIENT_RAW_MATERIAL, INSUFFICIENT_FILLER_CAPACITY, INELIGIBLE_LINE_SKU, MAINTENANCE_BLOCK, CIP_OVERRUN
    limiting_resource: str
    slack_shortfall_minutes: int = 0
    contributing_factors: List[str] = Field(default_factory=list)
    suggested_action: str


class ScheduleExplanation(BaseModel):
    schedule_id: str
    timestamp: str
    total_tankers: int
    tanker_rationales: List[TankerRationale] = Field(default_factory=list)
    binding_constraints: List[BindingConstraint] = Field(default_factory=list)
    slacks: List[SlackMetric] = Field(default_factory=list)
    minimal_conflict_sets: List[ConflictSet] = Field(default_factory=list)
    label: str = "DATA SINTETIS"


class ScheduleExplainer:
    """
    Generates structured, auditable explanations and minimal conflict diagnostics.
    """

    def __init__(self, config: MasterConfig):
        self.config = config

    def explain(
        self,
        schedule_id: Optional[str] = None,
        receiving_schedule: Optional[ScheduleResult] = None,
        production_schedule: Optional[ProductionScheduleResult] = None,
        orders: Optional[List[ProductionOrder]] = None,
        available_raw_milk_l: float = 50000.0,
    ) -> ScheduleExplanation:
        """Construct full JSON explanation report."""
        sched_id = schedule_id or (
            receiving_schedule.schedule_id if receiving_schedule
            else (production_schedule.schedule_id if production_schedule else f"EXP-{int(time.time())}")
        )

        rationales: List[TankerRationale] = []
        binding_constraints: List[BindingConstraint] = []
        slacks: List[SlackMetric] = []
        conflicts: List[ConflictSet] = []

        # 1. Tanker Rationales & Binding Receiving Constraints
        if receiving_schedule:
            # Sort decisions by start time to detect consecutive tight turnarounds
            sorted_decisions = sorted(receiving_schedule.tanker_decisions, key=lambda d: d.scheduled_unload_start)
            bay_last_end: Dict[str, int] = {}

            for d in sorted_decisions:
                reasons = []
                earliest_possible = d.predicted_arrival_p50 + d.predicted_lab_duration

                if d.scheduled_unload_start == earliest_possible:
                    reasons.append(f"Optimal zero-queue dispatch: Started immediately at t={d.scheduled_unload_start}m upon QC release.")
                    binding_constraints.append(BindingConstraint(
                        constraint_name="LAB_RELEASE_GATE",
                        asset_id=d.trip_id,
                        time_window=f"t={d.scheduled_unload_start}m",
                        impact_description=f"Tanker {d.trip_id} unload constrained by lab testing completion."
                    ))
                else:
                    queue_delay = d.scheduled_unload_start - earliest_possible
                    reasons.append(f"Bay buffering: Queued {queue_delay}m waiting for {d.assigned_bay} clearance.")

                reasons.append(f"Assigned to {d.assigned_tank} based on available lot headspace and clean status.")

                # Check if bay turnaround was tight (0 min slack)
                if d.assigned_bay in bay_last_end and bay_last_end[d.assigned_bay] == d.scheduled_unload_start:
                    binding_constraints.append(BindingConstraint(
                        constraint_name="BAY_CAPACITY_BOUND",
                        asset_id=d.assigned_bay,
                        time_window=f"t={d.scheduled_unload_start}m",
                        impact_description=f"Bay {d.assigned_bay} reached 100% capacity back-to-back without idle buffer."
                    ))

                bay_last_end[d.assigned_bay] = d.scheduled_unload_end

                rationales.append(TankerRationale(
                    trip_id=d.trip_id,
                    farm_id=d.farm_id,
                    assigned_bay=d.assigned_bay,
                    assigned_tank=d.assigned_tank,
                    scheduled_unload_start=d.scheduled_unload_start,
                    scheduled_unload_end=d.scheduled_unload_end,
                    waiting_time_minutes=d.waiting_time_minutes,
                    reasons=reasons
                ))

                # Slack metric for tanker
                slacks.append(SlackMetric(
                    entity_id=d.trip_id,
                    entity_type="TANKER",
                    slack_minutes=max(0, d.scheduled_unload_start - d.planned_slot_minute),
                    bottleneck_risk="HIGH" if d.waiting_time_minutes > 30 else ("MEDIUM" if d.waiting_time_minutes > 15 else "LOW")
                ))

        # 2. Production Lines & Order Conflict Sets
        if production_schedule:
            orders_map = {o.order_id: o for o in (orders or [])}

            for verdict in production_schedule.order_verdicts:
                ord_item = orders_map.get(verdict.order_id)
                if not verdict.dapat_dipenuhi or verdict.lateness_minutes > 0:
                    c_type = verdict.limiting_cause or "INSUFFICIENT_FILLER_CAPACITY"
                    limiting_res = "FILLING_LINES"
                    factors = []
                    action = "Adjust schedule parameters"

                    if c_type == "INSUFFICIENT_RAW_MATERIAL":
                        limiting_res = "RAW_MILK_STORAGE"
                        factors.append(f"Available milk ({available_raw_milk_l:.0f}L) lower than order demand ({verdict.target_volume_l:.0f}L).")
                        action = "Expedite incoming road tankers or reduce batch volume."
                    elif c_type == "INELIGIBLE_LINE_SKU":
                        limiting_res = "LINE_MATRIX"
                        factors.append(f"No packaging line is qualified for SKU {verdict.sku_id}.")
                        action = "Re-route to partner facility or configure changeover parts."
                    elif c_type == "INSUFFICIENT_FILLER_CAPACITY":
                        limiting_res = verdict.assigned_line or "ALL_PACKAGING_LINES"
                        factors.append(f"Order due time {verdict.due_time_minute}m violates minimum line processing duration.")
                        action = "Negotiate extended delivery window with PPIC."

                    conflicts.append(ConflictSet(
                        order_id=verdict.order_id,
                        sku_id=verdict.sku_id,
                        conflict_type=c_type,
                        limiting_resource=limiting_res,
                        slack_shortfall_minutes=verdict.lateness_minutes,
                        contributing_factors=factors,
                        suggested_action=action
                    ))

            # Slacks on filling lines
            line_busy_times: Dict[str, int] = {l.id: 0 for l in self.config.filling_lines.units}
            for verdict in production_schedule.order_verdicts:
                if verdict.assigned_line and verdict.scheduled_start_minute is not None and verdict.scheduled_end_minute is not None:
                    dur = verdict.scheduled_end_minute - verdict.scheduled_start_minute
                    line_busy_times[verdict.assigned_line] += dur

            for line_id, busy_m in line_busy_times.items():
                horizon_m = self.config.plant_global.get("horizon_minutes", 1440)
                idle_m = max(0, horizon_m - busy_m)
                slacks.append(SlackMetric(
                    entity_id=line_id,
                    entity_type="LINE",
                    slack_minutes=float(idle_m),
                    idle_pct=round((idle_m / horizon_m) * 100, 1),
                    bottleneck_risk="HIGH" if idle_m < 120 else "LOW"
                ))

        return ScheduleExplanation(
            schedule_id=sched_id,
            timestamp=time.strftime("%Y-%m-%d %H:%M:%S"),
            total_tankers=len(rationales),
            tanker_rationales=rationales,
            binding_constraints=binding_constraints,
            slacks=slacks,
            minimal_conflict_sets=conflicts
        )
