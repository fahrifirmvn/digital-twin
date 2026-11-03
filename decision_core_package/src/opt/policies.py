"""
Benchmark Policies and Comparative Simulator Evaluation for LactaTwin Decision Core.
Policies:
- B0: FIFO (First In, First Out to first available bay)
- B1: Fixed Slot (Planned slots without dynamic adjustment)
- B2: CP-SAT with Mean predictions
- B3: CP-SAT with P50 predictions
- B4: CP-SAT with P80 predictions (LactaTwin Recommendation)
Evaluated in the simulator with REALIZED durations (Rule R7).
Data Classification: DATA SINTETIS
Partner: [Nama Pabrik]
"""

from __future__ import annotations
import math
import time
from typing import List, Dict, Any, Optional, Tuple
from pydantic import BaseModel, Field
import numpy as np

from src.data.config_loader import MasterConfig
from src.data.schemas import (
    ScheduleResult,
    TankerDecision,
    ProductionOrder,
)
from src.opt.core import ReceivingCPSATScheduler, TankerInput
from src.opt.prod import ProductionCPSATScheduler


class PolicyMetrics(BaseModel):
    policy_name: str
    scenario_name: str
    mean_waiting_minutes: float
    p95_waiting_minutes: float
    max_waiting_minutes: float
    holding_violations: int = 0
    total_cip_count: int = 0
    changeover_count: int = 0
    order_lateness_minutes: int = 0
    mean_solve_time_seconds: float = 0.0
    gate_violations: int = 0
    label: str = "DATA SINTETIS"


class PolicyEvaluator:
    """
    Executes and compares policies in the realized simulation environment.
    """

    def __init__(self, config: MasterConfig):
        self.config = config
        self.scheduler = ReceivingCPSATScheduler(config)
        self.prod_scheduler = ProductionCPSATScheduler(config)
        self.bay_flow_lph = self.config.receiving.bay_flow_lph.value
        self.bays = self.config.receiving.bays
        self.tanks = [t.id for t in self.config.storage_tanks.units]

    def run_b0_fifo(
        self,
        tankers: List[TankerInput],
        realized_arrivals: Dict[str, float],
        realized_lab_durations: Dict[str, float],
    ) -> PolicyMetrics:
        """
        B0: FIFO Baseline.
        Tankers arrive, wait for lab clearance, and are dispatched to the earliest available bay in arrival order.
        """
        t0 = time.time()
        # Sort by realized arrival time
        sorted_tankers = sorted(tankers, key=lambda t: realized_arrivals.get(t.trip_id, t.predicted_arrival_p50))

        bay_available_time = {b: 0.0 for b in self.bays}
        tank_occupancy = {t: 0.0 for t in self.tanks}
        waiting_times: List[float] = []

        for t in sorted_tankers:
            arr = realized_arrivals.get(t.trip_id, t.predicted_arrival_p50)
            lab_dur = realized_lab_durations.get(t.trip_id, t.predicted_lab_duration)
            release_time = arr + lab_dur

            # Earliest available bay
            best_bay = min(bay_available_time, key=bay_available_time.get)
            unload_start = max(release_time, bay_available_time[best_bay])
            dur = max(10, math.ceil((t.volume_l / self.bay_flow_lph) * 60))
            unload_end = unload_start + dur

            bay_available_time[best_bay] = unload_end
            wait = max(0.0, unload_start - arr)
            waiting_times.append(wait)

        solve_time = time.time() - t0
        waits = np.array(waiting_times) if waiting_times else np.array([0.0])

        return PolicyMetrics(
            policy_name="B0 (FIFO Baseline)",
            scenario_name="Realized",
            mean_waiting_minutes=round(float(np.mean(waits)), 2),
            p95_waiting_minutes=round(float(np.percentile(waits, 95)), 2),
            max_waiting_minutes=round(float(np.max(waits)), 2),
            mean_solve_time_seconds=round(solve_time, 4),
            gate_violations=0
        )

    def run_b1_fixed_slots(
        self,
        tankers: List[TankerInput],
        realized_arrivals: Dict[str, float],
        realized_lab_durations: Dict[str, float],
    ) -> PolicyMetrics:
        """
        B1: Fixed Slots.
        Tankers are bound to planned slots. If released late, slot slips; if early, waits for slot.
        """
        t0 = time.time()
        waiting_times: List[float] = []
        bay_available_time = {b: 0.0 for b in self.bays}

        for i, t in enumerate(tankers):
            arr = realized_arrivals.get(t.trip_id, t.predicted_arrival_p50)
            lab_dur = realized_lab_durations.get(t.trip_id, t.predicted_lab_duration)
            release_time = arr + lab_dur

            # Rigid bay assignment by round-robin
            assigned_bay = self.bays[i % len(self.bays)]
            dur = max(10, math.ceil((t.volume_l / self.bay_flow_lph) * 60))

            # Must wait for planned slot, lab release, and bay clearance
            unload_start = max(t.planned_slot_minute, release_time, bay_available_time[assigned_bay])
            unload_end = unload_start + dur
            bay_available_time[assigned_bay] = unload_end

            wait = max(0.0, unload_start - arr)
            waiting_times.append(wait)

        solve_time = time.time() - t0
        waits = np.array(waiting_times) if waiting_times else np.array([0.0])

        return PolicyMetrics(
            policy_name="B1 (Fixed Slots)",
            scenario_name="Realized",
            mean_waiting_minutes=round(float(np.mean(waits)), 2),
            p95_waiting_minutes=round(float(np.percentile(waits, 95)), 2),
            max_waiting_minutes=round(float(np.max(waits)), 2),
            mean_solve_time_seconds=round(solve_time, 4),
            gate_violations=0
        )

    def run_cpsat_policy(
        self,
        policy_name: str,
        tankers: List[TankerInput],
        realized_arrivals: Dict[str, float],
        realized_lab_durations: Dict[str, float],
        quantile_mode: str = "P80" # Mean, P50, P80
    ) -> PolicyMetrics:
        """
        CP-SAT Policies (B2 Mean, B3 P50, B4 P80).
        Solves with optimization model, then evaluates plan execution in the simulator
        using REALIZED durations.
        """
        t0 = time.time()

        # Adjust inputs based on quantile mode
        adjusted_tankers = []
        for t in tankers:
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
            if quantile_mode == "Mean":
                t_copy.predicted_lab_duration = max(10, int(t.predicted_lab_duration * 0.9))
            elif quantile_mode == "P50":
                t_copy.predicted_lab_duration = t.predicted_lab_duration
            elif quantile_mode == "P80":
                # P80 adds conservative buffer for lab test completion
                t_copy.predicted_lab_duration = int(t.predicted_lab_duration * 1.2)

            adjusted_tankers.append(t_copy)

        sched_res = self.scheduler.solve(
            tankers=adjusted_tankers,
            time_limit_seconds=self.config.optimizer.get("max_time_in_seconds", 10),
            seed=42
        )
        solve_time = time.time() - t0

        # Evaluate execution in simulator with realized times
        waiting_times: List[float] = []
        bay_available_time = {b: 0.0 for b in self.bays}

        for dec in sched_res.tanker_decisions:
            t = next((tk for tk in tankers if tk.trip_id == dec.trip_id), None)
            arr = realized_arrivals.get(dec.trip_id, t.predicted_arrival_p50 if t else 0)
            lab_dur = realized_lab_durations.get(dec.trip_id, t.predicted_lab_duration if t else 25)
            release_time = arr + lab_dur

            dur = max(10, math.ceil((dec.volume_l / self.bay_flow_lph) * 60))
            # Realized execution enforces: cannot start before released, nor before bay clear
            realized_start = max(dec.scheduled_unload_start, release_time, bay_available_time[dec.assigned_bay])
            realized_end = realized_start + dur
            bay_available_time[dec.assigned_bay] = realized_end

            wait = max(0.0, realized_start - arr)
            waiting_times.append(wait)

        waits = np.array(waiting_times) if waiting_times else np.array([0.0])

        return PolicyMetrics(
            policy_name=policy_name,
            scenario_name="Realized",
            mean_waiting_minutes=round(float(np.mean(waits)), 2),
            p95_waiting_minutes=round(float(np.percentile(waits, 95)), 2),
            max_waiting_minutes=round(float(np.max(waits)), 2),
            mean_solve_time_seconds=round(solve_time, 4),
            gate_violations=0
        )
