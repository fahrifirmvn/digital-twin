"""
CP-SAT Receiving Core Scheduler.
Mathematical optimization model using OR-Tools CP-SAT for dairy plant receiving operations.
Hard Rules: R1 (CP-SAT decides), R2 (Configs only), R5 (Deterministic seed).
Data Classification: DATA SINTETIS
Partner: [Nama Pabrik]
"""

from __future__ import annotations
import math
import time
from typing import List, Dict, Any, Optional, Tuple, Union
from dataclasses import dataclass
import numpy as np
from ortools.sat.python import cp_model

from src.data.config_loader import MasterConfig
from src.data.schemas import (
    TankerDecision,
    ScheduleResult,
    QCStatus,
)


@dataclass
class TankerInput:
    trip_id: str
    farm_id: str
    volume_l: float
    planned_slot_minute: int
    predicted_arrival_p50: int
    predicted_arrival_p80: int
    predicted_lab_duration: int
    p_release: float = 0.96
    allow_split: bool = False


class ReceivingCPSATScheduler:
    """
    CP-SAT Optimization model for scheduling tanker receiving bays and storage tanks.
    Uses snake_case API of OR-Tools 9.15+.
    """

    def __init__(self, config: MasterConfig, tank_method: str = "reservoir"):
        self.config = config
        self.tank_method = tank_method # 'reservoir' or 'linear_sum'
        self.horizon_minutes = self.config.plant_global.get("horizon_minutes", 1440) + self.config.plant_global.get("carryover_minutes", 360)
        self.volume_unit_l = self.config.plant_global.get("volume_unit_l", 100)
        self.bay_flow_lph = self.config.receiving.bay_flow_lph.value
        self.slot_tolerance = self.config.receiving.slot_tolerance_min.value

    def solve(
        self,
        tankers: List[TankerInput],
        initial_tank_stock: Optional[Dict[str, float]] = None,
        initial_tank_clean: Optional[Dict[str, bool]] = None,
        bay_maintenance: Optional[List[Dict[str, Any]]] = None,
        previous_schedule: Optional[Dict[str, int]] = None,
        time_limit_seconds: Optional[float] = None,
        num_workers: int = 1,
        seed: int = 42
    ) -> ScheduleResult:
        """Formulate and solve the CP-SAT receiving problem."""
        start_wall_time = time.time()
        model = cp_model.CpModel()

        n_tankers = len(tankers)
        bays = self.config.receiving.bays
        n_bays = len(bays)
        tanks = [t.id for t in self.config.storage_tanks.units]
        n_tanks = len(tanks)
        tank_capacities = {t.id: int(t.capacity_l / self.volume_unit_l) for t in self.config.storage_tanks.units}

        initial_stock = initial_tank_stock or {}
        initial_clean = initial_tank_clean or {t: True for t in tanks}

        # -------------------------------------------------------------
        # 1. Variables
        # -------------------------------------------------------------
        start_vars: Dict[int, cp_model.IntVar] = {}
        end_vars: Dict[int, cp_model.IntVar] = {}
        wait_vars: Dict[int, cp_model.IntVar] = {}
        bay_presence: Dict[Tuple[int, int], cp_model.IntVar] = {}
        bay_intervals: Dict[Tuple[int, int], cp_model.IntervalVar] = {}
        tank_presence: Dict[Tuple[int, int], cp_model.IntVar] = {}
        durations: Dict[int, int] = {}
        earliest_releases: Dict[int, int] = {}

        for i, t in enumerate(tankers):
            # Volume in discretized units
            vol_units = max(1, int(round(t.volume_l / self.volume_unit_l)))

            # Duration in minutes
            dur_min = max(10, math.ceil((t.volume_l / self.bay_flow_lph) * 60))
            durations[i] = dur_min

            # Earliest release time = arrival (P50) + lab duration (P80)
            earliest_rel = t.predicted_arrival_p50 + t.predicted_lab_duration
            earliest_releases[i] = earliest_rel

            # Start and End variables
            start_vars[i] = model.new_int_var(earliest_rel, self.horizon_minutes, f"start_{i}")
            end_vars[i] = model.new_int_var(earliest_rel + dur_min, self.horizon_minutes + dur_min, f"end_{i}")
            model.add(end_vars[i] == start_vars[i] + dur_min)

            # Waiting time = start - arrival_p50
            wait_vars[i] = model.new_int_var(0, self.horizon_minutes, f"wait_{i}")
            model.add(wait_vars[i] == start_vars[i] - t.predicted_arrival_p50)

            # Bay assignment (one-hot)
            b_vars = []
            for b_idx in range(n_bays):
                bv = model.new_bool_var(f"bay_{i}_{b_idx}")
                bay_presence[(i, b_idx)] = bv
                b_vars.append(bv)
                # Optional interval for bay no-overlap
                bay_intervals[(i, b_idx)] = model.new_optional_interval_var(
                    start_vars[i], dur_min, end_vars[i], bv, f"bay_interval_{i}_{b_idx}"
                )
            model.add_exactly_one(b_vars)

            # Tank assignment
            t_vars = []
            for t_idx in range(n_tanks):
                tv = model.new_bool_var(f"tank_{i}_{t_idx}")
                tank_presence[(i, t_idx)] = tv
                t_vars.append(tv)

            if t.allow_split:
                model.add(sum(t_vars) >= 1)
                model.add(sum(t_vars) <= 2)
            else:
                model.add_exactly_one(t_vars)

        # -------------------------------------------------------------
        # 2. Hard Constraints
        # -------------------------------------------------------------

        # A. Bay No-Overlap (only 1 active tanker per bay at a time)
        for b_idx, bay_id in enumerate(bays):
            intervals_in_bay = [bay_intervals[(i, b_idx)] for i in range(n_tankers)]

            # Add maintenance intervals if scheduled
            if bay_maintenance:
                for maint in bay_maintenance:
                    if maint.get("asset_id") == bay_id:
                        m_start = maint["start_minute"]
                        m_dur = maint["duration_min"]
                        m_int = model.new_interval_var(m_start, m_dur, m_start + m_dur, f"maint_{bay_id}_{m_start}")
                        intervals_in_bay.append(m_int)

            model.add_no_overlap(intervals_in_bay)

        # B. Tank Capacity Constraint
        for t_idx, tank_id in enumerate(tanks):
            cap_units = tank_capacities[tank_id]
            init_units = int(initial_stock.get(tank_id, 0.0) / self.volume_unit_l)
            avail_units = max(0, cap_units - init_units)

            if self.tank_method == "reservoir":
                # Event-based reservoir constraint
                times = [end_vars[i] for i in range(n_tankers)]
                # Level changes: vol_units when assigned to tank t_idx
                # In reservoir, level_changes can be integer expressions: tank_presence * vol_units
                level_changes = [
                    tank_presence[(i, t_idx)] * int(round(tankers[i].volume_l / self.volume_unit_l))
                    for i in range(n_tankers)
                ]
                model.add_reservoir_constraint(times, level_changes, 0, avail_units)
            else:
                # Linear sum method
                assigned_units = [
                    tank_presence[(i, t_idx)] * int(round(tankers[i].volume_l / self.volume_unit_l))
                    for i in range(n_tankers)
                ]
                model.add(sum(assigned_units) <= avail_units)

        # C. Empty/Dirty Tank CIP Precedence
        for t_idx, tank_id in enumerate(tanks):
            if not initial_clean.get(tank_id, True):
                cip_duration = self.config.storage_tanks.units[t_idx].cip_min
                for i in range(n_tankers):
                    # If assigned to this dirty tank, cannot start before CIP finishes
                    model.add(start_vars[i] >= cip_duration).only_enforce_if(tank_presence[(i, t_idx)])

        # -------------------------------------------------------------
        # 3. Objective Function
        # -------------------------------------------------------------
        opt_cfg = self.config.optimizer
        w_wait = opt_cfg.get("weights", {}).get("w_waiting_p80", 10.0)
        w_dev = opt_cfg.get("weights", {}).get("w_schedule_deviation", 5.0)

        obj_terms = []

        # Waiting time weighted by risk (P80 - P50 spread)
        for i, t in enumerate(tankers):
            risk_spread = max(0, t.predicted_arrival_p80 - t.predicted_arrival_p50)
            risk_weight = int(10 + min(50, risk_spread))
            obj_terms.append(wait_vars[i] * risk_weight)

        # Deviation from planned slot
        for i, t in enumerate(tankers):
            dev_var = model.new_int_var(0, self.horizon_minutes, f"dev_{i}")
            diff_var = model.new_int_var(-self.horizon_minutes, self.horizon_minutes, f"diff_{i}")
            model.add(diff_var == start_vars[i] - t.planned_slot_minute)
            model.add_abs_equality(dev_var, diff_var)
            obj_terms.append(dev_var * int(w_dev))

        # Deviation from previous schedule (replan stability)
        if previous_schedule:
            for i, t in enumerate(tankers):
                if t.trip_id in previous_schedule:
                    prev_t = previous_schedule[t.trip_id]
                    replan_dev = model.new_int_var(0, self.horizon_minutes, f"replan_dev_{i}")
                    replan_diff = model.new_int_var(-self.horizon_minutes, self.horizon_minutes, f"replan_diff_{i}")
                    model.add(replan_diff == start_vars[i] - prev_t)
                    model.add_abs_equality(replan_dev, replan_diff)
                    obj_terms.append(replan_dev * 25)

        model.minimize(sum(obj_terms))

        # -------------------------------------------------------------
        # 4. Solve
        # -------------------------------------------------------------
        solver = cp_model.CpSolver()
        time_limit = time_limit_seconds or opt_cfg.get("max_time_in_seconds", 10)
        solver.parameters.max_time_in_seconds = float(time_limit)
        solver.parameters.random_seed = seed
        solver.parameters.num_workers = num_workers

        status = solver.solve(model)
        wall_time = time.time() - start_wall_time

        status_str = solver.status_name(status)

        # -------------------------------------------------------------
        # 5. Extract Decisions
        # -------------------------------------------------------------
        decisions: List[TankerDecision] = []
        if status in [cp_model.OPTIMAL, cp_model.FEASIBLE]:
            for i, t in enumerate(tankers):
                assigned_bay_idx = next(b for b in range(n_bays) if solver.value(bay_presence[(i, b)]) == 1)
                assigned_tank_idx = next(t_idx for t_idx in range(n_tanks) if solver.value(tank_presence[(i, t_idx)]) == 1)

                start_val = int(solver.value(start_vars[i]))
                end_val = int(solver.value(end_vars[i]))
                wait_val = int(solver.value(wait_vars[i]))

                reasons = {
                    "critical_predecessor": "lab_release",
                    "earliest_release_minute": earliest_releases[i],
                    "arrival_p50": t.predicted_arrival_p50,
                    "waiting_slack_minutes": wait_val,
                    "assigned_bay": bays[assigned_bay_idx],
                    "assigned_tank": tanks[assigned_tank_idx]
                }

                decisions.append(TankerDecision(
                    trip_id=t.trip_id,
                    farm_id=t.farm_id,
                    volume_l=t.volume_l,
                    planned_slot_minute=t.planned_slot_minute,
                    predicted_arrival_p50=t.predicted_arrival_p50,
                    predicted_arrival_p80=t.predicted_arrival_p80,
                    predicted_lab_duration=t.predicted_lab_duration,
                    p_release=t.p_release,
                    assigned_bay=bays[assigned_bay_idx],
                    assigned_tank=tanks[assigned_tank_idx],
                    scheduled_unload_start=start_val,
                    scheduled_unload_end=end_val,
                    waiting_time_minutes=wait_val,
                    reasons=reasons
                ))

        infeasibility_reasons = []
        if status == cp_model.INFEASIBLE:
            infeasibility_reasons.append("Insufficient bay capacity or cumulative tank volume exceeded available usable capacity.")

        return ScheduleResult(
            schedule_id=f"SCHED-{int(time.time())}",
            timestamp=time.strftime("%Y-%m-%dT%H:%M:%S"),
            status=status_str,
            wall_time_seconds=wall_time,
            objective_value=float(solver.objective_value) if status in [cp_model.OPTIMAL, cp_model.FEASIBLE] else None,
            tanker_decisions=decisions,
            kpis={
                "total_tankers": n_tankers,
                "mean_waiting_minutes": float(np.mean([d.waiting_time_minutes for d in decisions])) if decisions else 0.0,
                "max_waiting_minutes": max([d.waiting_time_minutes for d in decisions]) if decisions else 0,
                "wall_time_seconds": wall_time
            },
            infeasibility_reasons=infeasibility_reasons,
            label="DATA SINTETIS"
        )
