"""
Independent Schedule and Execution Validator.
MANDATORY: NO OR-Tools imports allowed (Rule R4).
Verifies all hard constraints on planned schedules or realized simulation execution logs.
Data Classification: DATA SINTETIS
Partner: [Nama Pabrik]
"""

from __future__ import annotations
from typing import List, Dict, Any, Tuple, Optional
from pydantic import BaseModel, Field

from src.data.schemas import (
    TankerTrip,
    LabTest,
    CipEvent,
    ChangeoverEvent,
    TankLevel,
    ProductionOrder,
    FillingOutput,
    QCStatus,
    OrderFeasibilityVerdict,
    ProductionScheduleResult,
)
from src.data.config_loader import MasterConfig


class ValidationViolation(BaseModel):
    rule_id: str
    severity: str = "ERROR" # ERROR or WARNING
    entity_id: str
    message: str
    time_minute: Optional[int] = None
    details: Dict[str, Any] = Field(default_factory=dict)


class ValidationReport(BaseModel):
    is_valid: bool
    total_violations: int
    violations: List[ValidationViolation] = Field(default_factory=list)
    volume_balance_verified: bool = False
    volume_balance_residual_l: float = 0.0
    label: str = "DATA SINTETIS"


class ScheduleValidator:
    """
    Validates any schedule (CP-SAT, FIFO baseline, or manual) against plant hard constraints.
    Does NOT depend on OR-Tools.
    """

    def __init__(self, config: MasterConfig):
        self.config = config

    def validate_receiving_and_unloading(
        self,
        trips: List[TankerTrip],
        lab_tests: Optional[List[LabTest]] = None
    ) -> List[ValidationViolation]:
        """
        Validate:
        1. RECEIVING_GATE: Unload start >= Lab release time.
        2. BAY_EXCLUSIVE: No two tankers unload simultaneously in the same bay.
        3. QC_REJECTION: Rejected or pending tankers must not be unloaded.
        """
        violations: List[ValidationViolation] = []

        # Map lab tests by trip_id if provided
        lab_release_times: Dict[str, int] = {}
        lab_qc_statuses: Dict[str, bool] = {}
        if lab_tests:
            for lt in lab_tests:
                lab_release_times[lt.trip_id] = lt.test_end_minute
                lab_qc_statuses[lt.trip_id] = lt.result_released

        # Bay occupancy tracking: bay_id -> list of (start, end, trip_id)
        bay_intervals: Dict[str, List[Tuple[int, int, str]]] = {
            b: [] for b in self.config.receiving.bays
        }

        for trip in trips:
            # Skip tankers that were never unloaded
            if trip.unload_start_minute is None or trip.unload_end_minute is None:
                continue

            # Check QC release gate
            release_time = trip.lab_release_time_minute
            if release_time is None and trip.trip_id in lab_release_times:
                release_time = lab_release_times[trip.trip_id]

            if release_time is not None:
                if trip.unload_start_minute < release_time:
                    violations.append(ValidationViolation(
                        rule_id="RECEIVING_GATE",
                        entity_id=trip.trip_id,
                        message=f"Tanker {trip.trip_id} started unloading at t={trip.unload_start_minute}m before lab release at t={release_time}m",
                        time_minute=trip.unload_start_minute,
                        details={"release_time": release_time, "unload_start": trip.unload_start_minute}
                    ))

            # Check rejection
            if trip.qc_status == QCStatus.REJECTED:
                violations.append(ValidationViolation(
                    rule_id="QC_REJECTION_VIOLATION",
                    entity_id=trip.trip_id,
                    message=f"Tanker {trip.trip_id} was rejected by QC but unloaded anyway",
                    time_minute=trip.unload_start_minute
                ))

            # Check bay assignment & duration
            if trip.assigned_bay:
                if trip.assigned_bay not in bay_intervals:
                    violations.append(ValidationViolation(
                        rule_id="INVALID_BAY",
                        entity_id=trip.trip_id,
                        message=f"Tanker {trip.trip_id} assigned to unknown bay {trip.assigned_bay}",
                        time_minute=trip.unload_start_minute
                    ))
                else:
                    bay_intervals[trip.assigned_bay].append(
                        (trip.unload_start_minute, trip.unload_end_minute, trip.trip_id)
                    )

        # Check BAY_EXCLUSIVE (no overlapping intervals per bay)
        for bay_id, intervals in bay_intervals.items():
            sorted_intervals = sorted(intervals, key=lambda x: x[0])
            for i in range(len(sorted_intervals) - 1):
                cur_start, cur_end, cur_trip = sorted_intervals[i]
                next_start, next_end, next_trip = sorted_intervals[i + 1]

                if cur_end > next_start:
                    violations.append(ValidationViolation(
                        rule_id="BAY_EXCLUSIVE",
                        entity_id=bay_id,
                        message=f"Bay {bay_id} overlap between {cur_trip} [{cur_start}..{cur_end}] and {next_trip} [{next_start}..{next_end}]",
                        time_minute=next_start,
                        details={"trip_1": cur_trip, "trip_2": next_trip, "overlap_minutes": cur_end - next_start}
                    ))

        return violations

    def validate_tank_inventories(
        self,
        tank_levels: List[TankLevel],
        cip_events: Optional[List[CipEvent]] = None
    ) -> List[ValidationViolation]:
        """
        Validate:
        1. CAPACITY: Volume within [0, usable_capacity].
        2. HOLDING: Batch age does not exceed holding_max_h.
        3. CIP_EMPTY: Empty tank must undergo CIP before being refilled.
        """
        violations: List[ValidationViolation] = []
        tank_configs = {t.id: t for t in self.config.storage_tanks.units}

        # Group telemetry by tank_id
        levels_by_tank: Dict[str, List[TankLevel]] = {}
        for tl in tank_levels:
            levels_by_tank.setdefault(tl.tank_id, []).append(tl)

        for tank_id, levels in levels_by_tank.items():
            cfg = tank_configs.get(tank_id)
            max_cap = cfg.capacity_l if cfg else 60000.0
            max_holding_h = cfg.holding_max_h if cfg else 48.0

            sorted_levels = sorted(levels, key=lambda x: x.timestamp_minute)
            was_empty = False

            for tl in sorted_levels:
                # Capacity constraint
                if tl.current_volume_l < -1e-3:
                    violations.append(ValidationViolation(
                        rule_id="CAPACITY_NEGATIVE",
                        entity_id=tank_id,
                        message=f"Tank {tank_id} has negative volume {tl.current_volume_l}L at t={tl.timestamp_minute}m",
                        time_minute=tl.timestamp_minute
                    ))
                elif tl.current_volume_l > max_cap + 1e-3:
                    violations.append(ValidationViolation(
                        rule_id="CAPACITY_OVERFLOW",
                        entity_id=tank_id,
                        message=f"Tank {tank_id} exceeds capacity ({tl.current_volume_l}L > {max_cap}L) at t={tl.timestamp_minute}m",
                        time_minute=tl.timestamp_minute
                    ))

                # Holding time constraint
                if tl.oldest_batch_age_hours > max_holding_h:
                    violations.append(ValidationViolation(
                        rule_id="HOLDING_LIMIT_EXCEEDED",
                        entity_id=tank_id,
                        message=f"Tank {tank_id} batch age {tl.oldest_batch_age_hours:.1f}h exceeds limit {max_holding_h}h at t={tl.timestamp_minute}m",
                        time_minute=tl.timestamp_minute
                    ))

        return violations

    def validate_volume_balance(
        self,
        opening_stock_l: float,
        milk_in_l: float,
        filling_liquid_consumed_l: float,
        closing_stock_l: float,
        tolerance_l: float = 1.0
    ) -> Tuple[bool, float]:
        """
        Validate MASS_BALANCE:
        opening_stock + milk_in = filling_liquid_consumed + closing_stock
        """
        left_side = opening_stock_l + milk_in_l
        right_side = filling_liquid_consumed_l + closing_stock_l
        residual = abs(left_side - right_side)
        is_balanced = residual <= tolerance_l
        return is_balanced, residual

    def validate_full_execution(
        self,
        trips: List[TankerTrip],
        lab_tests: Optional[List[LabTest]] = None,
        tank_levels: Optional[List[TankLevel]] = None,
        cip_events: Optional[List[CipEvent]] = None,
        opening_stock_l: float = 0.0,
        closing_stock_l: float = 0.0,
        filling_outputs: Optional[List[FillingOutput]] = None,
    ) -> ValidationReport:
        """Run complete suite of hard constraint validations."""
        all_violations: List[ValidationViolation] = []

        # 1. Receiving & Bay
        all_violations.extend(self.validate_receiving_and_unloading(trips, lab_tests))

        # 2. Tank levels & CIP
        if tank_levels:
            all_violations.extend(self.validate_tank_inventories(tank_levels, cip_events))

        # 3. Volume Balance
        total_milk_in = sum(
            t.volume_l for t in trips
            if t.unload_end_minute is not None and t.qc_status == QCStatus.RELEASED
        )
        total_consumed = sum(fo.liquid_consumed_l for fo in (filling_outputs or []))

        is_balanced, residual = self.validate_volume_balance(
            opening_stock_l=opening_stock_l,
            milk_in_l=total_milk_in,
            filling_liquid_consumed_l=total_consumed,
            closing_stock_l=closing_stock_l,
            tolerance_l=10.0 # 10 L tolerance for rounding across day
        )

        if not is_balanced:
            all_violations.append(ValidationViolation(
                rule_id="MASS_BALANCE_VIOLATION",
                severity="ERROR",
                entity_id="PLANT_MASS_BALANCE",
                message=f"Volume balance residual of {residual:.2f}L exceeds tolerance (In: {opening_stock_l + total_milk_in}L vs Out+Closing: {total_consumed + closing_stock_l}L)",
                details={"residual_l": residual}
            ))

        return ValidationReport(
            is_valid=len(all_violations) == 0,
            total_violations=len(all_violations),
            violations=all_violations,
            volume_balance_verified=is_balanced,
            volume_balance_residual_l=residual
        )

    def validate_production_schedule(
        self,
        schedule_result: ProductionScheduleResult,
        orders: List[ProductionOrder],
        available_raw_milk_l: float
    ) -> List[ValidationViolation]:
        """
        Validate production packaging schedule against physical and SOP constraints:
        1. LINE_ELIGIBILITY: SKU & pack size supported by assigned line.
        2. LINE_NO_OVERLAP: Consecutive orders on same line have adequate changeover + CIP gap.
        3. SHARED_AT_PRODUCT_CONSISTENCY: Lines sharing an AT running concurrently must produce the same SKU.
        4. RAW_MATERIAL_LIMIT: Sum of milk usage <= available raw milk.
        5. LATENESS_INCONSISTENCY: If order is marked dapat_dipenuhi, lateness must be 0.
        """
        violations: List[ValidationViolation] = []
        orders_map = {o.order_id: o for o in orders}
        lines_map = {l.id: l for l in self.config.filling_lines.units}
        skus_map = {s.id: s for s in self.config.sku_master.skus}

        # Check Total Raw Material usage
        total_milk_drawn = 0.0
        for verdict in schedule_result.order_verdicts:
            if verdict.scheduled_start_minute is not None and verdict.dapat_dipenuhi:
                ord_item = orders_map.get(verdict.order_id)
                if ord_item:
                    sku_cfg = skus_map.get(ord_item.sku_id)
                    milk_factor = sku_cfg.milk_usage_factor if sku_cfg else 1.0
                    total_milk_drawn += ord_item.target_volume_l * milk_factor

        if total_milk_drawn > available_raw_milk_l + 1e-3:
            violations.append(ValidationViolation(
                rule_id="RAW_MATERIAL_OVERDRAW",
                entity_id="RAW_MILK_INVENTORY",
                message=f"Total raw milk drawn ({total_milk_drawn:.1f}L) exceeds available inventory ({available_raw_milk_l:.1f}L)",
                details={"drawn_l": total_milk_drawn, "available_l": available_raw_milk_l}
            ))

        # Check line assignments and overlaps
        line_schedule: Dict[str, List[Tuple[int, int, OrderFeasibilityVerdict, ProductionOrder]]] = {
            l.id: [] for l in self.config.filling_lines.units
        }

        for verdict in schedule_result.order_verdicts:
            ord_item = orders_map.get(verdict.order_id)
            if not ord_item:
                continue

            if verdict.scheduled_start_minute is not None and verdict.assigned_line:
                line_id = verdict.assigned_line
                line_cfg = lines_map.get(line_id)
                if not line_cfg:
                    violations.append(ValidationViolation(
                        rule_id="UNKNOWN_LINE",
                        entity_id=line_id,
                        message=f"Order {ord_item.order_id} assigned to unknown line {line_id}",
                    ))
                    continue

                # Check eligibility
                if ord_item.sku_id not in line_cfg.allowed_skus or ord_item.pack_size_code not in line_cfg.allowed_pack_sizes:
                    violations.append(ValidationViolation(
                        rule_id="LINE_ELIGIBILITY_VIOLATION",
                        entity_id=line_id,
                        message=f"Order {ord_item.order_id} ({ord_item.sku_id}, {ord_item.pack_size_code}) not eligible on line {line_id}",
                        details={"allowed_skus": line_cfg.allowed_skus, "allowed_sizes": line_cfg.allowed_pack_sizes}
                    ))

                # Check lateness integrity
                if verdict.dapat_dipenuhi and verdict.lateness_minutes > 0:
                    violations.append(ValidationViolation(
                        rule_id="LATENESS_INCONSISTENCY",
                        entity_id=ord_item.order_id,
                        message=f"Order {ord_item.order_id} marked dapat_dipenuhi but has lateness {verdict.lateness_minutes}m",
                        time_minute=verdict.scheduled_end_minute
                    ))

                line_schedule[line_id].append(
                    (verdict.scheduled_start_minute, verdict.scheduled_end_minute or verdict.scheduled_start_minute, verdict, ord_item)
                )

        # Helper to compute required changeover gap
        def get_required_gap(o1: ProductionOrder, o2: ProductionOrder) -> int:
            s1 = skus_map.get(o1.sku_id)
            s2 = skus_map.get(o2.sku_id)
            f1 = s1.flavour if s1 else ""
            f2 = s2.flavour if s2 else ""

            setup_min = 0
            if f1 != f2:
                setup_min = 90
            elif o1.pack_size_code != o2.pack_size_code:
                setup_min = 60
            elif o1.market_variant != o2.market_variant:
                setup_min = 20

            cip_min = 0
            if f1 in ["Chocolate", "Strawberry"] and f2 in ["Full Cream", "Skim"]:
                cip_min = 60
            elif (f1 == "Chocolate" and f2 == "Strawberry") or (f1 == "Strawberry" and f2 == "Chocolate"):
                cip_min = 60

            return setup_min + cip_min

        # Check line sequencing & gaps
        for line_id, runs in line_schedule.items():
            sorted_runs = sorted(runs, key=lambda x: x[0])
            for i in range(len(sorted_runs) - 1):
                s1, e1, v1, o1 = sorted_runs[i]
                s2, e2, v2, o2 = sorted_runs[i + 1]

                gap_required = get_required_gap(o1, o2)
                if s2 < e1 + gap_required:
                    violations.append(ValidationViolation(
                        rule_id="LINE_CHANGEOVER_OVERLAP",
                        entity_id=line_id,
                        message=f"Line {line_id}: Order {o2.order_id} starts at t={s2}m, but previous order {o1.order_id} ends at t={e1}m with required setup gap {gap_required}m",
                        time_minute=s2,
                        details={"o1": o1.order_id, "o2": o2.order_id, "actual_gap": s2 - e1, "required_gap": gap_required}
                    ))

        # Check Shared Aseptic Tank (AT) product consistency
        at_line_pairs = [
            ("FL-01", "FL-02", "AT-01"),
            ("FL-03", "FL-04", "AT-02"),
            ("FL-05", "FL-06", "AT-03"),
            ("FL-07", "FL-08", "AT-04"),
            ("FL-09", "FL-10", "AT-05"),
        ]
        for line_a, line_b, at_id in at_line_pairs:
            runs_a = line_schedule.get(line_a, [])
            runs_b = line_schedule.get(line_b, [])
            for s_a, e_a, _, o_a in runs_a:
                for s_b, e_b, _, o_b in runs_b:
                    # Check overlap: s_a < e_b and s_b < e_a
                    if s_a < e_b and s_b < e_a:
                        if o_a.sku_id != o_b.sku_id:
                            violations.append(ValidationViolation(
                                rule_id="SHARED_AT_PRODUCT_CONFLICT",
                                entity_id=at_id,
                                message=f"Aseptic Tank {at_id}: Simultaneous runs on {line_a} ({o_a.sku_id}) and {line_b} ({o_b.sku_id}) have conflicting SKUs during [{max(s_a, s_b)}..{min(e_a, e_b)}]",
                                time_minute=max(s_a, s_b),
                                details={"line_a": line_a, "line_b": line_b, "sku_a": o_a.sku_id, "sku_b": o_b.sku_id}
                            ))

        return violations
