"""
Synthetic Operational Data Generator for LactaTwin.
Generates 90+ days of realistic, seeded, physics-compliant operational logs.
Data Classification: DATA SINTETIS
Partner: [Nama Pabrik]
"""

from __future__ import annotations
import os
import math
import random
from typing import List, Dict, Any, Tuple
import numpy as np
import pandas as pd

from src.data.config_loader import MasterConfig, load_master_config
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
    MarketVariant,
    OrderStatus,
)
from src.data.adapter import CsvDataAdapter
from src.sim.engine import PlantSimulator, TransferRecord


# Farm specifications
FARM_SPECS = {
    "FARM-01": {"base_transit_min": 45, "qc_fail_rate": 0.020, "daily_trips": 7},
    "FARM-02": {"base_transit_min": 75, "qc_fail_rate": 0.030, "daily_trips": 6},
    "FARM-03": {"base_transit_min": 110, "qc_fail_rate": 0.040, "daily_trips": 6},
    "FARM-04": {"base_transit_min": 140, "qc_fail_rate": 0.025, "daily_trips": 5},
    "FARM-05": {"base_transit_min": 180, "qc_fail_rate": 0.050, "daily_trips": 6},
}


def get_rush_hour_multiplier(minute_of_day: int) -> float:
    """Return traffic delay factor during morning (07:00-09:00) and evening (16:00-18:00) rush hours."""
    # 06:00 is t=0 min
    # Morning rush: 07:00 - 09:00 (t=60..180)
    # Evening rush: 16:00 - 18:00 (t=600..720)
    if 60 <= minute_of_day <= 180:
        return 1.35
    elif 600 <= minute_of_day <= 720:
        return 1.25
    return 1.0


def get_shift_change_delay(minute_of_day: int) -> int:
    """Return additional lab handover queue latency near shift boundaries (14:00, 22:00, 06:00)."""
    # 14:00 is t=480, 22:00 is t=960, 06:00 is t=0 / 1440
    shift_points = [0, 480, 960, 1440]
    for sp in shift_points:
        if abs(minute_of_day - sp) <= 20:
            return 8 # 8 minutes handover delay
    return 0


class SyntheticPlantGenerator:
    """Generates continuous multi-day operations and executes them through the simulator."""

    def __init__(self, config: MasterConfig, seed: int = 42):
        self.config = config
        self.seed = seed
        self.rng = np.random.default_rng(seed)
        random.seed(seed)

    def generate_day(
        self,
        day_index: int,
        opening_stock_by_tank: Optional[Dict[str, float]] = None
    ) -> Tuple[PlantSimulator, Dict[str, Any]]:
        """
        Generate and simulate a single 24-hour day (06:00 to 06:00 next day).
        Returns the completed PlantSimulator instance and daily volume balance summary.
        """
        # Day seed for determinism
        day_seed = self.seed + day_index * 1000
        rng = np.random.default_rng(day_seed)

        # 1. Initialize Simulator
        sim = PlantSimulator(self.config, initial_tank_stock=opening_stock_by_tank)

        # 2. Generate Tanker Arrivals for this day
        # Schedule ~30 tankers spread across the 24 hours
        trips_to_schedule = []
        trip_counter = 1

        # Slot spacing across 24h (0..1380 minutes)
        for farm_id, spec in FARM_SPECS.items():
            base_transit = spec["base_transit_min"]
            qc_fail_rate = spec["qc_fail_rate"]
            n_trips = spec["daily_trips"]

            # Distribute departure slots across the day (10..1260 to allow all unloads to complete by 1440)
            base_slots = np.linspace(10, 1260, n_trips)

            for slot_time in base_slots:
                # Volume distribution
                vol_cfg = self.config.receiving.tanker_volume_distribution
                vol = float(rng.normal(vol_cfg.mean_l, vol_cfg.std_l))
                vol = max(vol_cfg.min_l, min(vol_cfg.max_l, vol))
                # Discretize to 100L
                vol = round(vol / 100.0) * 100.0

                # Departure time and delay
                dep_delay = float(rng.uniform(-10, 15))
                departure_minute = max(0, int(slot_time - base_transit + dep_delay))

                # Transit noise (lognormal) & rush hour multiplier
                log_noise = math.exp(float(rng.normal(0.0, 0.10)))
                rush_mult = get_rush_hour_multiplier(int(slot_time))
                transit_time = int(base_transit * log_noise * rush_mult)
                gate_arrival = departure_minute + transit_time

                # Lab duration (lognormal + shift handover)
                lab_base = float(rng.lognormal(mean=math.log(20.0), sigma=0.15))
                shift_delay = get_shift_change_delay(gate_arrival)
                realized_lab = max(10, int(round(lab_base + shift_delay)))

                # QC pass/fail
                qc_passed = bool(rng.uniform(0.0, 1.0) >= qc_fail_rate)

                # Target bay and tank
                bay_idx = (trip_counter - 1) % len(self.config.receiving.bays)
                target_bay = self.config.receiving.bays[bay_idx]

                tank_idx = (trip_counter - 1) % self.config.storage_tanks.count
                target_tank = self.config.storage_tanks.units[tank_idx].id

                trip_id = f"TR-D{day_index:03d}-{trip_counter:03d}"
                trips_to_schedule.append({
                    "trip_id": trip_id,
                    "farm_id": farm_id,
                    "volume_l": vol,
                    "planned_slot": int(slot_time),
                    "realized_arrival_time": gate_arrival,
                    "realized_lab_duration": realized_lab,
                    "qc_passed": qc_passed,
                    "target_bay": target_bay,
                    "target_tank": target_tank,
                })
                trip_counter += 1

        # Sort trips by gate arrival time
        trips_to_schedule.sort(key=lambda x: x["realized_arrival_time"])

        # Schedule arrival processes in SimPy
        for t_info in trips_to_schedule:
            sim.env.process(sim.simulate_tanker_arrival_and_receiving(**t_info))

        # 3. Schedule Production Orders to draw from tanks during the day
        # Orders are scheduled between t=300 and t=1200 with ~60 min run duration
        expected_released_vol = sum(t["volume_l"] for t in trips_to_schedule if t["qc_passed"])
        opening_vol = sim.opening_stock_l

        target_consumption = expected_released_vol * 0.85
        cum_vol = 0.0
        ord_idx = 1

        available_skus = ["ESL-FC", "ESL-CH", "UHT-FC", "UHT-CH", "ESL-ST"]
        lines_list = ["FL-01", "FL-02", "FL-05", "FL-06", "FL-08"]

        while cum_vol < target_consumption:
            batch_vol = float(rng.choice([10000.0, 12000.0, 15000.0]))
            if cum_vol + batch_vol > target_consumption:
                batch_vol = target_consumption - cum_vol
            if batch_vol < 3000:
                break

            sku = available_skus[(ord_idx - 1) % len(available_skus)]
            line = lines_list[(ord_idx - 1) % len(lines_list)]
            tank_id = self.config.storage_tanks.units[(ord_idx - 1) % 5].id

            start_t = 300 + (ord_idx * 90) # batches spaced every 90 min
            if start_t > 1200:
                break

            po = ProductionOrder(
                order_id=f"ORD-D{day_index:03d}-{ord_idx:03d}",
                sku_id=sku,
                pack_size_code="LARGE_A",
                target_volume_l=batch_vol,
                due_time_minute=start_t + 150,
                priority=1
            )
            sim.env.process(sim.simulate_production_order(po, tank_id, line, start_t))
            cum_vol += batch_vol
            ord_idx += 1

        # 4. Run Simulation
        sim.run_simulation(until_minute=1440)

        # 5. Calculate Daily Volume Balance
        total_milk_in = sum(
            t.volume_l for t in sim.logger.trips
            if t.unload_end_minute is not None and t.qc_status == QCStatus.RELEASED
        )
        total_consumed = sum(fo.liquid_consumed_l for fo in sim.logger.filling_outputs)
        closing_stock = sim.get_closing_stock_l()

        balance_diff = (opening_vol + total_milk_in) - (total_consumed + closing_stock)

        balance_summary = {
            "day": day_index,
            "opening_stock_l": opening_vol,
            "total_milk_in_l": total_milk_in,
            "total_consumed_l": total_consumed,
            "closing_stock_l": closing_stock,
            "balance_diff_l": balance_diff,
            "total_trips": len(sim.logger.trips),
            "qc_rejected_trips": sum(1 for t in sim.logger.trips if t.qc_status == QCStatus.REJECTED),
            "filling_batches": len(sim.logger.filling_outputs),
        }

        return sim, balance_summary

    def generate_and_save_dataset(
        self,
        output_dir: str,
        n_days: int = 90
    ) -> Dict[str, Any]:
        """Generate n_days (90+) of continuous operations and export to CSVs via CsvDataAdapter."""
        os.makedirs(output_dir, exist_ok=True)
        adapter = CsvDataAdapter(output_dir)

        all_trips: List[TankerTrip] = []
        all_lab_tests: List[LabTest] = []
        all_cip_events: List[CipEvent] = []
        all_changeovers: List[ChangeoverEvent] = []
        all_tank_levels: List[TankLevel] = []
        all_orders: List[ProductionOrder] = []
        all_filling_outputs: List[FillingOutput] = []
        all_transfers: List[TransferRecord] = []
        daily_summaries = []

        # Initial tank stock on day 1
        current_tank_stock = {
            t.id: 15000.0 if i < 3 else 0.0
            for i, t in enumerate(self.config.storage_tanks.units)
        }

        for day in range(1, n_days + 1):
            sim, summary = self.generate_day(day, opening_stock_by_tank=current_tank_stock)

            # Accumulate logs
            all_trips.extend(sim.logger.trips)
            all_lab_tests.extend(sim.logger.lab_tests)
            all_cip_events.extend(sim.logger.cip_events)
            all_changeovers.extend(sim.logger.changeover_events)
            all_tank_levels.extend(sim.logger.tank_levels)
            all_filling_outputs.extend(sim.logger.filling_outputs)
            all_transfers.extend(sim.logger.transfer_ledger)
            daily_summaries.append(summary)

            # Carry over closing tank stock to next day's opening
            current_tank_stock = {t_id: t_data["current_volume_l"] for t_id, t_data in sim.tanks.items()}

        # Save all through CsvDataAdapter
        adapter.save_tanker_trips(all_trips)
        adapter.save_lab_tests(all_lab_tests)
        adapter.save_cip_events(all_cip_events)
        adapter.save_changeover_events(all_changeovers)
        adapter.save_tank_levels(all_tank_levels)
        adapter.save_filling_outputs(all_filling_outputs)

        # Save transfer ledger and daily balance report
        transfer_df = pd.DataFrame([t.model_dump() for t in all_transfers])
        transfer_df.to_csv(os.path.join(output_dir, "transfer_ledger.csv"), index=False)

        balance_df = pd.DataFrame(daily_summaries)
        balance_df.to_csv(os.path.join(output_dir, "daily_volume_balance.csv"), index=False)

        return {
            "n_days": n_days,
            "total_trips": len(all_trips),
            "total_lab_tests": len(all_lab_tests),
            "total_transfers": len(all_transfers),
            "total_filling_outputs": len(all_filling_outputs),
            "max_daily_balance_diff": float(balance_df["balance_diff_l"].abs().max()),
            "output_dir": output_dir,
            "label": "DATA SINTETIS"
        }
