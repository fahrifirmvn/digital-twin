"""
Brute-Force Exact Enumerator for Tiny Instances (n <= 4).
Mathematically cross-checks CP-SAT solver optimality.
Data Classification: DATA SINTETIS
Partner: [Nama Pabrik]
"""

from __future__ import annotations
import math
import itertools
from typing import List, Dict, Any, Tuple, Optional

from src.data.config_loader import MasterConfig
from src.opt.core import TankerInput


class TinyInstanceBruteForceSolver:
    """
    Exhaustively enumerates all discrete bay assignments and processing permutations
    for small instances (n <= 4) to verify CP-SAT mathematical optimality.
    """

    def __init__(self, config: MasterConfig):
        self.config = config
        self.bay_flow_lph = self.config.receiving.bay_flow_lph.value

    def solve_optimal(
        self,
        tankers: List[TankerInput],
        bays: List[str],
        tanks: List[str]
    ) -> Dict[str, Any]:
        """Exhaustively find the global minimum objective value."""
        n = len(tankers)
        assert n <= 4, f"Brute force only intended for n <= 4, got {n}"

        durations = [
            max(10, math.ceil((t.volume_l / self.bay_flow_lph) * 60))
            for t in tankers
        ]
        releases = [
            t.predicted_arrival_p50 + t.predicted_lab_duration
            for t in tankers
        ]

        best_obj = float("inf")
        best_schedule = None

        # Enumerate all bay assignments: bay_choice[i] in range(len(bays))
        for bay_assignment in itertools.product(range(len(bays)), repeat=n):
            # For each bay, enumerate all permutations of tankers assigned to it
            bay_tanker_indices = {b_idx: [] for b_idx in range(len(bays))}
            for i, b_idx in enumerate(bay_assignment):
                bay_tanker_indices[b_idx].append(i)

            # Generate permutations per bay
            per_bay_perms = [
                list(itertools.permutations(bay_tanker_indices[b_idx]))
                for b_idx in range(len(bays))
            ]

            for perm_combination in itertools.product(*per_bay_perms):
                # Now compute starts deterministically
                starts = [0] * n
                ends = [0] * n

                valid = True
                for b_idx, tanker_seq in enumerate(perm_combination):
                    current_bay_free = 0
                    for t_idx in tanker_seq:
                        st = max(releases[t_idx], current_bay_free)
                        dur = durations[t_idx]
                        et = st + dur
                        starts[t_idx] = st
                        ends[t_idx] = et
                        current_bay_free = et

                if not valid:
                    continue

                # Compute exact objective matching CP-SAT formulation:
                # obj = sum(wait * risk_weight) + sum(abs(start - slot) * w_dev)
                obj = 0
                for i, t in enumerate(tankers):
                    wait = starts[i] - t.predicted_arrival_p50
                    risk_spread = max(0, t.predicted_arrival_p80 - t.predicted_arrival_p50)
                    risk_weight = int(10 + min(50, risk_spread))
                    dev = abs(starts[i] - t.planned_slot_minute)
                    w_dev = int(self.config.optimizer.get("weights", {}).get("w_schedule_deviation", 5.0))
                    obj += wait * risk_weight + dev * w_dev

                if obj < best_obj:
                    best_obj = obj
                    best_schedule = {
                        "starts": starts,
                        "ends": ends,
                        "bay_assignment": bay_assignment,
                        "objective": obj
                    }

        return {
            "optimal_objective": best_obj,
            "best_schedule": best_schedule,
            "label": "DATA SINTETIS"
        }
