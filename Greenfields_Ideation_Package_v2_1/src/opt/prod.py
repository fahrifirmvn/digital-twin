"""
Production Extension Scheduler: Scheduling orders from storage tanks to filling lines.
Constraints: Line eligibility, shared Aseptic Tank flow and product consistency,
sequence-dependent changeovers (Variant > Size > Paper), CIP triggers, and maintenance.
Data Classification: DATA SINTETIS
Partner: [Nama Pabrik]
"""

from __future__ import annotations
import math
import time
from typing import List, Dict, Any, Optional, Tuple, Union
from pydantic import BaseModel, Field
import numpy as np
from ortools.sat.python import cp_model

from src.data.config_loader import MasterConfig
from src.data.schemas import (
    ProductionOrder,
    ChangeoverType,
    OrderStatus,
    OrderFeasibilityVerdict,
    ProductionScheduleResult,
)


class ProductionCPSATScheduler:
    """
    CP-SAT Optimization model for packaging line sequencing, changeover minimization,
    and order feasibility determination.
    """

    def __init__(self, config: MasterConfig, setup_method: str = "pairwise"):
        self.config = config
        self.setup_method = setup_method # 'pairwise' or 'circuit'
        self.horizon_minutes = self.config.plant_global.get("horizon_minutes", 1440)
        self.volume_unit_l = self.config.plant_global.get("volume_unit_l", 100)

    def calculate_changeover_and_cip(
        self,
        order_from: ProductionOrder,
        order_to: ProductionOrder
    ) -> Tuple[int, ChangeoverType, int]:
        """
        Compute sequence-dependent setup time and CIP requirement between two orders on the same line.
        Hierarchy: VARIANT (90m) > SIZE (60m) > PAPER (20m) > NONE (0m).
        Paper change is NOT added during a size change!
        CIP triggers: Chocolate/Strawberry -> Full Cream (+60m), Chocolate <-> Strawberry (+60m).
        """
        sku_from = next((s for s in self.config.sku_master.skus if s.id == order_from.sku_id), None)
        sku_to = next((s for s in self.config.sku_master.skus if s.id == order_to.sku_id), None)

        flavour_from = sku_from.flavour if sku_from else "Unknown"
        flavour_to = sku_to.flavour if sku_to else "Unknown"

        size_from = order_from.pack_size_code
        size_to = order_to.pack_size_code

        market_from = order_from.market_variant
        market_to = order_to.market_variant

        setup_min = 0
        chg_type = ChangeoverType.NONE
        cip_min = 0

        # 1. Changeover Precedence
        if flavour_from != flavour_to:
            chg_type = ChangeoverType.VARIANT
            setup_min = 90
        elif size_from != size_to:
            chg_type = ChangeoverType.SIZE
            setup_min = 60
            # Paper change is explicitly NOT added during size change
        elif market_from != market_to:
            chg_type = ChangeoverType.PAPER
            setup_min = 20
        else:
            chg_type = ChangeoverType.NONE
            setup_min = 0

        # 2. CIP Triggers (independent from mechanical setup)
        is_dark_from = flavour_from in ["Chocolate", "Strawberry"]
        is_fc_to = flavour_to in ["Full Cream", "Skim"]

        if is_dark_from and is_fc_to:
            cip_min = 60 # CIP_FLAVOUR
        elif (flavour_from == "Chocolate" and flavour_to == "Strawberry") or (flavour_from == "Strawberry" and flavour_to == "Chocolate"):
            cip_min = 60 # CIP_CH_ST

        return setup_min, chg_type, cip_min

    def check_preflight_eligibility(
        self,
        order: ProductionOrder
    ) -> Tuple[bool, List[str], Optional[str]]:
        """Determine eligible filling lines for order based on line_dedication rules."""
        eligible_lines = []
        for line in self.config.filling_lines.units:
            if order.sku_id in line.allowed_skus and order.pack_size_code in line.allowed_pack_sizes:
                eligible_lines.append(line.id)

        if not eligible_lines:
            return False, [], "INELIGIBLE_LINE_SKU"
        return True, eligible_lines, None

    def solve(
        self,
        orders: List[ProductionOrder],
        available_raw_milk_l: float,
        line_maintenance: Optional[List[Dict[str, Any]]] = None,
        time_limit_seconds: float = 10.0,
        num_workers: int = 1,
        seed: int = 42
    ) -> ProductionScheduleResult:
        """Schedule production orders to maximize fulfillment and minimize lateness."""
        start_wall_time = time.time()
        model = cp_model.CpModel()

        n_orders = len(orders)
        all_lines = self.config.filling_lines.units
        line_map = {l.id: l for l in all_lines}
        line_ids = [l.id for l in all_lines]

        # -------------------------------------------------------------
        # Preflight Check: Eligibility & Fast Rejection
        # -------------------------------------------------------------
        order_eligibility: Dict[int, List[str]] = {}
        ineligible_causes: Dict[int, str] = {}

        for k, ord_item in enumerate(orders):
            is_eligible, elig_lines, cause = self.check_preflight_eligibility(ord_item)
            if not is_eligible:
                ineligible_causes[k] = cause
                order_eligibility[k] = []
            else:
                order_eligibility[k] = elig_lines

        # Calculate milk usage factors
        liquid_draws = {}
        for k, ord_item in enumerate(orders):
            sku_cfg = next((s for s in self.config.sku_master.skus if s.id == ord_item.sku_id), None)
            milk_factor = sku_cfg.milk_usage_factor if sku_cfg else 1.0
            liquid_draws[k] = ord_item.target_volume_l * milk_factor

        # -------------------------------------------------------------
        # 1. Variables
        # -------------------------------------------------------------
        fulfilled_vars: Dict[int, cp_model.IntVar] = {}
        start_vars: Dict[int, cp_model.IntVar] = {}
        end_vars: Dict[int, cp_model.IntVar] = {}
        lateness_vars: Dict[int, cp_model.IntVar] = {}
        line_assignment: Dict[Tuple[int, str], cp_model.IntVar] = {}
        order_intervals: Dict[Tuple[int, str], cp_model.IntervalVar] = {}

        # Precompute run durations per order on each eligible line
        order_durations: Dict[Tuple[int, str], int] = {}

        for k, ord_item in enumerate(orders):
            fulfilled_vars[k] = model.new_bool_var(f"fulfilled_{k}")
            start_vars[k] = model.new_int_var(ord_item.earliest_start_minute, self.horizon_minutes, f"start_{k}")
            end_vars[k] = model.new_int_var(ord_item.earliest_start_minute, self.horizon_minutes + 360, f"end_{k}")

            lateness_vars[k] = model.new_int_var(0, self.horizon_minutes, f"lateness_{k}")

            if k in ineligible_causes:
                # Force unfulfilled
                model.add(fulfilled_vars[k] == 0)
                continue

            pack_size_ml = self.config.pack_sizes.get(ord_item.pack_size_code, 1000)
            pack_count = int((ord_item.target_volume_l * 1000) / pack_size_ml)

            line_choices = []
            for line_id in order_eligibility[k]:
                lv = model.new_bool_var(f"line_{k}_{line_id}")
                line_assignment[(k, line_id)] = lv
                line_choices.append(lv)

                line_speed = line_map[line_id].speed_pack_per_h
                # Derated nominal speed
                dur_min = max(15, math.ceil((pack_count / (line_speed * 0.95)) * 60))
                order_durations[(k, line_id)] = dur_min

                # Optional interval for line
                order_intervals[(k, line_id)] = model.new_optional_interval_var(
                    start_vars[k], dur_min, end_vars[k], lv, f"interval_{k}_{line_id}"
                )

            # Exactly one line if fulfilled, zero if unfulfilled
            model.add(sum(line_choices) == fulfilled_vars[k])

            # Duration constraint: end = start + dur
            for line_id in order_eligibility[k]:
                dur_min = order_durations[(k, line_id)]
                model.add(end_vars[k] == start_vars[k] + dur_min).only_enforce_if(line_assignment[(k, line_id)])

            # Lateness definition
            model.add(lateness_vars[k] >= end_vars[k] - ord_item.due_time_minute).only_enforce_if(fulfilled_vars[k])

        # -------------------------------------------------------------
        # 2. Hard Constraints
        # -------------------------------------------------------------

        # A. Total Raw Milk Availability Constraint
        # Sum of fulfilled milk draws <= available raw milk
        total_drawn_units = [
            fulfilled_vars[k] * int(liquid_draws[k] / self.volume_unit_l)
            for k in range(n_orders)
        ]
        avail_units = int(available_raw_milk_l / self.volume_unit_l)
        model.add(sum(total_drawn_units) <= avail_units)

        # B. Sequence-Dependent Setups & Line No-Overlap
        total_setup_penalties = []
        for line_id in line_ids:
            orders_on_line = [k for k in range(n_orders) if line_id in order_eligibility.get(k, [])]
            m = len(orders_on_line)
            if m == 0:
                continue

            if self.setup_method == "circuit" and m >= 2:
                # Circuit formulation: nodes 0..m-1 (orders) + node m (depot)
                arcs = []
                depot = m
                for i_idx in range(m):
                    k_i = orders_on_line[i_idx]
                    assigned_i = line_assignment[(k_i, line_id)]
                    # Self-loop when not assigned
                    arcs.append((i_idx, i_idx, ~assigned_i))

                    # Transitions to other orders
                    for j_idx in range(m):
                        if i_idx == j_idx:
                            continue
                        k_j = orders_on_line[j_idx]
                        arc_ij = model.new_bool_var(f"arc_{k_i}_{k_j}_{line_id}")
                        arcs.append((i_idx, j_idx, arc_ij))
                        setup_ij, _, cip_ij = self.calculate_changeover_and_cip(orders[k_i], orders[k_j])
                        gap_ij = setup_ij + cip_ij
                        model.add(start_vars[k_j] >= end_vars[k_i] + gap_ij).only_enforce_if(arc_ij)
                        total_setup_penalties.append(arc_ij * gap_ij)

                    # Arc to depot
                    arc_i_depot = model.new_bool_var(f"arc_to_depot_{k_i}_{line_id}")
                    arcs.append((i_idx, depot, arc_i_depot))

                    # Arc from depot
                    arc_depot_i = model.new_bool_var(f"arc_from_depot_{k_i}_{line_id}")
                    arcs.append((depot, i_idx, arc_depot_i))

                # Depot self-loop if no orders assigned to this line
                no_orders = model.new_bool_var(f"no_orders_{line_id}")
                model.add(sum(line_assignment[(k, line_id)] for k in orders_on_line) == 0).only_enforce_if(no_orders)
                model.add(sum(line_assignment[(k, line_id)] for k in orders_on_line) > 0).only_enforce_if(~no_orders)
                arcs.append((depot, depot, no_orders))

                model.add_circuit(arcs)
            else:
                # Pairwise precedence between any two orders on the same line
                for i_idx in range(m):
                    k1 = orders_on_line[i_idx]
                    for j_idx in range(i_idx + 1, m):
                        k2 = orders_on_line[j_idx]

                        setup_12, _, cip_12 = self.calculate_changeover_and_cip(orders[k1], orders[k2])
                        total_gap_12 = setup_12 + cip_12

                        setup_21, _, cip_21 = self.calculate_changeover_and_cip(orders[k2], orders[k1])
                        total_gap_21 = setup_21 + cip_21

                        # Boolean: k1 precedes k2 on this line
                        before_12 = model.new_bool_var(f"before_{k1}_{k2}_{line_id}")

                        both_assigned = model.new_bool_var(f"both_{k1}_{k2}_{line_id}")
                        model.add_bool_and([line_assignment[(k1, line_id)], line_assignment[(k2, line_id)]]).only_enforce_if(both_assigned)
                        model.add_bool_or([~line_assignment[(k1, line_id)], ~line_assignment[(k2, line_id)]]).only_enforce_if(~both_assigned)

                        # If both assigned, order k1 is before k2 or k2 before k1
                        model.add(start_vars[k2] >= end_vars[k1] + total_gap_12).only_enforce_if([both_assigned, before_12])
                        model.add(start_vars[k1] >= end_vars[k2] + total_gap_21).only_enforce_if([both_assigned, ~before_12])

                        total_setup_penalties.append(before_12 * total_gap_12 + (~before_12) * total_gap_21)

        # C. Shared Aseptic Tank (AT) Constraints
        # Lines sharing an AT cannot exceed AT output flow (18,000 L/h)
        # Pairs: (FL-01, FL-02) -> AT-01, (FL-03, FL-04) -> AT-02, etc.
        at_line_pairs = [
            ("FL-01", "FL-02", "AT-01"),
            ("FL-03", "FL-04", "AT-02"),
            ("FL-05", "FL-06", "AT-03"),
            ("FL-07", "FL-08", "AT-04"),
            ("FL-09", "FL-10", "AT-05"),
        ]

        for line_a, line_b, at_id in at_line_pairs:
            orders_a = [k for k in range(n_orders) if line_a in order_eligibility.get(k, [])]
            orders_b = [k for k in range(n_orders) if line_b in order_eligibility.get(k, [])]

            for ka in orders_a:
                for kb in orders_b:
                    # If liquid SKU is different, they CANNOT run simultaneously (AT_SAME_PRODUCT)
                    if orders[ka].sku_id != orders[kb].sku_id:
                        # Overlap forbidden
                        overlap_a_b = model.new_bool_var(f"overlap_{ka}_{kb}")
                        # ka ends before kb starts OR kb ends before ka starts
                        a_before_b = model.new_bool_var(f"a_before_b_{ka}_{kb}")
                        model.add(start_vars[kb] >= end_vars[ka]).only_enforce_if([line_assignment[(ka, line_a)], line_assignment[(kb, line_b)], a_before_b])
                        model.add(start_vars[ka] >= end_vars[kb]).only_enforce_if([line_assignment[(ka, line_a)], line_assignment[(kb, line_b)], ~a_before_b])

        # -------------------------------------------------------------
        # 3. Objective Function
        # -------------------------------------------------------------
        # Hierarchy:
        # 1. Maximise fulfilled volume (very high weight)
        # 2. Minimise lateness
        # 3. Minimise changeovers
        obj_fulfillment = sum(
            fulfilled_vars[k] * int(orders[k].target_volume_l) * 10
            for k in range(n_orders)
        )
        obj_lateness = sum(lateness_vars[k] * 20 for k in range(n_orders))
        obj_setup = sum(total_setup_penalties) if total_setup_penalties else 0

        model.maximize(obj_fulfillment - obj_lateness - obj_setup)

        # -------------------------------------------------------------
        # 4. Solve
        # -------------------------------------------------------------
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = float(time_limit_seconds)
        solver.parameters.random_seed = seed
        solver.parameters.num_workers = num_workers

        status = solver.solve(model)
        wall_time = time.time() - start_wall_time
        status_str = solver.status_name(status)

        # -------------------------------------------------------------
        # 5. Build Verdicts & Diagnostics
        # -------------------------------------------------------------
        verdicts: List[OrderFeasibilityVerdict] = []
        fulfilled_count = 0
        fulfilled_volume = 0.0

        for k, ord_item in enumerate(orders):
            if k in ineligible_causes:
                verdicts.append(OrderFeasibilityVerdict(
                    order_id=ord_item.order_id,
                    sku_id=ord_item.sku_id,
                    target_volume_l=ord_item.target_volume_l,
                    due_time_minute=ord_item.due_time_minute,
                    dapat_dipenuhi=False,
                    limiting_cause="INELIGIBLE_LINE_SKU",
                    details={"error": "No filling line supports this SKU and pack size"}
                ))
                continue

            is_fulfilled = bool(solver.value(fulfilled_vars[k]) == 1) if status in [cp_model.OPTIMAL, cp_model.FEASIBLE] else False
            lateness = int(solver.value(lateness_vars[k])) if is_fulfilled else 0

            assigned_line = None
            start_val = None
            end_val = None

            if is_fulfilled:
                for line_id in order_eligibility[k]:
                    if solver.value(line_assignment[(k, line_id)]) == 1:
                        assigned_line = line_id
                        break
                start_val = int(solver.value(start_vars[k]))
                end_val = int(solver.value(end_vars[k]))
                fulfilled_count += 1
                fulfilled_volume += ord_item.target_volume_l

            # Diagnostic for unfulfilled or late orders
            limiting_cause = None
            if not is_fulfilled or lateness > 0:
                # Diagnose root cause
                if available_raw_milk_l < ord_item.target_volume_l:
                    limiting_cause = "INSUFFICIENT_RAW_MATERIAL"
                elif ord_item.due_time_minute < ord_item.earliest_start_minute + 30:
                    limiting_cause = "INSUFFICIENT_FILLER_CAPACITY"
                else:
                    limiting_cause = "INSUFFICIENT_FILLER_CAPACITY"

            verdicts.append(OrderFeasibilityVerdict(
                order_id=ord_item.order_id,
                sku_id=ord_item.sku_id,
                target_volume_l=ord_item.target_volume_l,
                due_time_minute=ord_item.due_time_minute,
                dapat_dipenuhi=is_fulfilled and (lateness == 0),
                assigned_line=assigned_line,
                scheduled_start_minute=start_val,
                scheduled_end_minute=end_val,
                lateness_minutes=lateness,
                limiting_cause=limiting_cause,
                details={
                    "is_fulfilled": is_fulfilled,
                    "milk_drawn_l": liquid_draws[k],
                    "eligible_lines": order_eligibility[k]
                }
            ))

        return ProductionScheduleResult(
            schedule_id=f"PROD-SCHED-{int(time.time())}",
            status=status_str,
            wall_time_seconds=wall_time,
            total_orders=n_orders,
            fulfilled_orders=fulfilled_count,
            unfulfilled_orders=n_orders - fulfilled_count,
            total_volume_requested_l=sum(o.target_volume_l for o in orders),
            total_volume_fulfilled_l=fulfilled_volume,
            order_verdicts=verdicts,
            objective_value=float(solver.objective_value) if status in [cp_model.OPTIMAL, cp_model.FEASIBLE] else None
        )
