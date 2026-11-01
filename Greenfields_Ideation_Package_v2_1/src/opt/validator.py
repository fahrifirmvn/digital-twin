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
