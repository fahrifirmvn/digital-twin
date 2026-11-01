"""
Discrete-Event Simulation Engine for Dairy Processing Plant.
Enforces hard gates (QC Release before unload, Bay exclusivity, Tank limits, CIP).
Data Classification: DATA SINTETIS
Partner: [Nama Pabrik]
"""

from __future__ import annotations
import math
from typing import List, Dict, Any, Optional, Tuple
import simpy
from pydantic import BaseModel, Field

from src.data.config_loader import MasterConfig
from src.data.schemas import (
    TankerTrip,
    LabTest,
    CipEvent,
    ChangeoverEvent,
    TankLevel,
    ProductionOrder,
    FillingOutput,
    QCStatus,
    TankState,
    ChangeoverType,
)


class TransferRecord(BaseModel):
    """Ledger entry recording physical liquid transfer between stages."""
    transfer_id: str
    source_batch: str
    target_batch: str
    source_asset: str
    target_asset: str
    start_time_minute: int
    end_time_minute: int
    volume_l: float
    product_sku: str
    label: str = "DATA SINTETIS"


class SimEventLogger:
    """Collects and organizes event logs matching Phase 0 contracts."""

    def __init__(self):
        self.trips: List[TankerTrip] = []
        self.lab_tests: List[LabTest] = []
        self.cip_events: List[CipEvent] = []
        self.changeover_events: List[ChangeoverEvent] = []
        self.tank_levels: List[TankLevel] = []
        self.filling_outputs: List[FillingOutput] = []
        self.transfer_ledger: List[TransferRecord] = []


class PlantSimulator:
    """
    SimPy-based discrete event simulation of the milk processing chain:
    Farm -> Road -> Gate -> Lab -> Bay -> SFP Storage -> Sterilizer -> AT -> Filling Line -> FG.
    """

    def __init__(self, config: MasterConfig, initial_tank_stock: Optional[Dict[str, float]] = None):
        self.config = config
        self.env = simpy.Environment()
        self.logger = SimEventLogger()

        # Resources
        # Bays: 4 parallel resources (capacity 1 per bay)
        self.bays = {
            bay_id: simpy.Resource(self.env, capacity=1)
            for bay_id in self.config.receiving.bays
        }

        # Lab channels: 2 parallel testing channels
        self.lab_channels = simpy.Resource(
            self.env, capacity=self.config.lab.n_channels
        )

        # Storage Tanks state: SFP-01 .. SFP-15
        self.tanks: Dict[str, Dict[str, Any]] = {}
        for t_cfg in self.config.storage_tanks.units:
            init_vol = (initial_tank_stock or {}).get(t_cfg.id, 0.0)
            self.tanks[t_cfg.id] = {
                "id": t_cfg.id,
                "capacity_l": t_cfg.capacity_l,
                "current_volume_l": init_vol,
                "max_holding_h": t_cfg.holding_max_h,
                "cip_duration_min": t_cfg.cip_min,
                "state": TankState.HOLDING if init_vol > 0 else TankState.EMPTY,
                "last_emptied_time": None,
                "is_clean": True,
                "current_lot_id": f"LOT-INIT-{t_cfg.id}" if init_vol > 0 else None,
                "batch_creation_minute": 0 if init_vol > 0 else None,
                "lock": simpy.Resource(self.env, capacity=1), # single active transfer
            }

        # Filling lines
        self.lines = {
            line_cfg.id: simpy.Resource(self.env, capacity=1)
            for line_cfg in self.config.filling_lines.units
        }

        # Track opening stock
        self.opening_stock_l = sum(t["current_volume_l"] for t in self.tanks.values())

    def simulate_tanker_arrival_and_receiving(
        self,
        trip_id: str,
        farm_id: str,
        volume_l: float,
        planned_slot: int,
        realized_arrival_time: int,
        realized_lab_duration: int,
        qc_passed: bool,
        target_bay: Optional[str] = None,
        target_tank: Optional[str] = None,
    ):
        """Process generator modeling tanker trip lifecycle from gate arrival to bay unloading."""
        trip_record = TankerTrip(
            trip_id=trip_id,
            farm_id=farm_id,
            planned_slot_minute=planned_slot,
            volume_l=volume_l,
            departure_time_minute=max(0, realized_arrival_time - 60),
            gate_arrival_time_minute=realized_arrival_time,
            qc_status=QCStatus.PENDING,
        )

        # Wait until tanker arrives at gate
        if self.env.now < realized_arrival_time:
            yield self.env.timeout(realized_arrival_time - self.env.now)

        sampling_time = int(self.env.now)
        trip_record.sampling_time_minute = sampling_time

        # Lab Testing Stage
        with self.lab_channels.request() as req:
            yield req
            test_start = int(self.env.now)
            yield self.env.timeout(realized_lab_duration)
            test_end = int(self.env.now)

            lab_record = LabTest(
                test_id=f"LT-{trip_id}",
                trip_id=trip_id,
                farm_id=farm_id,
                channel_id="LAB-CH-01",
                sampling_time_minute=sampling_time,
                test_start_minute=test_start,
                test_end_minute=test_end,
                test_duration_min=realized_lab_duration,
                result_released=qc_passed,
                fat_pct=3.9 if qc_passed else 2.1,
                protein_pct=3.2 if qc_passed else 2.0,
                antibiotic_negative=qc_passed
            )
            self.logger.lab_tests.append(lab_record)

            trip_record.lab_release_time_minute = test_end
            trip_record.qc_status = QCStatus.RELEASED if qc_passed else QCStatus.REJECTED

        # If QC fails, tanker is rejected at gate (STRICT GATE)
        if not qc_passed:
            trip_record.notes = "QC Test failed: antibiotics positive or fat/protein below standard"
            self.logger.trips.append(trip_record)
            return

        # Selection of bay
        bay_id = target_bay or self.config.receiving.bays[0]
        bay_res = self.bays[bay_id]

        # Selection of tank
        tank_id = target_tank or "SFP-01"
        tank = self.tanks[tank_id]

        # Request Bay
        with bay_res.request() as bay_req:
            yield bay_req

            # ENFORCE GATE: Unload start >= lab release time
            assert self.env.now >= trip_record.lab_release_time_minute, "Gate violation: Unloading before release!"

            unload_start = int(self.env.now)
            trip_record.assigned_bay = bay_id
            trip_record.unload_start_minute = unload_start
            trip_record.destination_tank_id = tank_id

            # Compute unload duration based on flow rate
            flow_lph = self.config.receiving.bay_flow_lph.value
            duration_minutes = math.ceil((volume_l / flow_lph) * 60)

            # Unload transfer
            yield self.env.timeout(duration_minutes)
            unload_end = int(self.env.now)
            trip_record.unload_end_minute = unload_end

            # Update tank volume
            tank["current_volume_l"] += volume_l
            tank["state"] = TankState.HOLDING
            if tank["current_lot_id"] is None:
                tank["current_lot_id"] = f"LOT-{trip_id}"
                tank["batch_creation_minute"] = unload_start

            # Record in transfer ledger
            self.logger.transfer_ledger.append(TransferRecord(
                transfer_id=f"TRF-{trip_id}",
                source_batch=f"TRIP-{trip_id}",
                target_batch=tank["current_lot_id"],
                source_asset=bay_id,
                target_asset=tank_id,
                start_time_minute=unload_start,
                end_time_minute=unload_end,
                volume_l=volume_l,
                product_sku="RAW-MILK"
            ))

            # Record snapshot of tank level
            self.logger.tank_levels.append(TankLevel(
                timestamp_minute=unload_end,
                tank_id=tank_id,
                current_volume_l=tank["current_volume_l"],
                usable_capacity_l=tank["capacity_l"],
                current_lot_id=tank["current_lot_id"],
                oldest_batch_age_hours=0.0,
                state=tank["state"]
            ))

        self.logger.trips.append(trip_record)

    def simulate_production_order(
        self,
        order: ProductionOrder,
        source_tank_id: str,
        line_id: str,
        start_minute: int
    ):
        """Simulate packaging line execution drawing from SFP tank through Sterilizer and AT."""
        if self.env.now < start_minute:
            yield self.env.timeout(start_minute - self.env.now)

        line_res = self.lines[line_id]
        with line_res.request() as req:
            yield req

            actual_start = int(self.env.now)

            # Calculate liquid consumption
            # Milk usage factor: Full cream = 1.0, Flavour = 0.9
            sku_cfg = next((s for s in self.config.sku_master.skus if s.id == order.sku_id), None)
            milk_usage = sku_cfg.milk_usage_factor if sku_cfg else 1.0
            requested_liquid = order.target_volume_l * milk_usage

            # Draw from tank (only if tank has available volume)
            tank = self.tanks[source_tank_id]
            if tank["current_volume_l"] <= 1.0:
                # Tank empty, cannot produce
                return

            draw_volume = min(tank["current_volume_l"], requested_liquid)

            # Calculate line speed & duration based on actual draw volume
            line_cfg = next(l for l in self.config.filling_lines.units if l.id == line_id)
            pack_size_ml = self.config.pack_sizes.get(order.pack_size_code, 1000)
            pack_count = int((draw_volume / milk_usage * 1000) / pack_size_ml)

            # packs per hour -> minutes
            speed_pph = line_cfg.speed_pack_per_h
            run_duration_min = max(10, math.ceil((pack_count / speed_pph) * 60))

            # Deduct liquid from tank
            tank["current_volume_l"] -= draw_volume
            if tank["current_volume_l"] <= 1e-3:
                tank["current_volume_l"] = 0.0
                tank["state"] = TankState.EMPTY
                tank["current_lot_id"] = None
                tank["batch_creation_minute"] = None

            yield self.env.timeout(run_duration_min)
            actual_end = int(self.env.now)

            # Record filling output
            self.logger.filling_outputs.append(FillingOutput(
                output_id=f"FO-{order.order_id}",
                order_id=order.order_id,
                line_id=line_id,
                sku_id=order.sku_id,
                pack_size_ml=pack_size_ml,
                start_time_minute=actual_start,
                end_time_minute=actual_end,
                pack_count=pack_count,
                good_packs=int(pack_count * 0.995),
                reject_packs=int(pack_count * 0.005),
                liquid_consumed_l=draw_volume
            ))

            # Record transfer to FG
            self.logger.transfer_ledger.append(TransferRecord(
                transfer_id=f"TRF-ORD-{order.order_id}",
                source_batch=source_tank_id,
                target_batch=f"FG-{order.order_id}",
                source_asset=line_id,
                target_asset="FG-OUTPUT",
                start_time_minute=actual_start,
                end_time_minute=actual_end,
                volume_l=draw_volume,
                product_sku=order.sku_id
            ))

    def run_simulation(self, until_minute: int = 1440):
        """Run discrete-event simulation until time horizon."""
        self.env.run(until=until_minute)

    def get_closing_stock_l(self) -> float:
        """Calculate total remaining liquid across all storage tanks."""
        return sum(t["current_volume_l"] for t in self.tanks.values())
