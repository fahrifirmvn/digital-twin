"""
Unit and Integration Tests for Phase 1: Simulator and Synthetic Data Generation.
Acceptance Criteria:
1. Volume balance holds each simulated day.
2. Executor passes the independent schedule validator without violations.
3. Generator produces compliant operational logs matching Phase 0 contracts.
4. Transfer ledger records all movements with source/target batches.
Data Classification: DATA SINTETIS
Partner: [Nama Pabrik]
"""

import os
from pathlib import Path
import pytest
import pandas as pd

from src.data.config_loader import load_master_config
from src.data.schemas import QCStatus
from src.sim.generator import SyntheticPlantGenerator
from src.opt.validator import ScheduleValidator


@pytest.fixture
def config():
    return load_master_config()


def test_single_day_simulation_and_volume_balance(config):
    """Verify that a single simulated day strictly satisfies volume balance and passes validation."""
    generator = SyntheticPlantGenerator(config, seed=42)
    sim, summary = generator.generate_day(day_index=1)

    # 1. Check volume balance equation:
    # opening_stock + total_milk_in = total_consumed + closing_stock
    opening = summary["opening_stock_l"]
    milk_in = summary["total_milk_in_l"]
    consumed = summary["total_consumed_l"]
    closing = summary["closing_stock_l"]
    diff = summary["balance_diff_l"]

    assert abs(diff) < 1e-3, f"Volume balance failed! Diff: {diff} L"
    assert milk_in > 0, "No milk was unloaded!"
    assert consumed > 0, "No milk was processed!"

    # 2. Check independent validator
    validator = ScheduleValidator(config)
    report = validator.validate_full_execution(
        trips=sim.logger.trips,
        lab_tests=sim.logger.lab_tests,
        tank_levels=sim.logger.tank_levels,
        cip_events=sim.logger.cip_events,
        opening_stock_l=opening,
        closing_stock_l=closing,
        filling_outputs=sim.logger.filling_outputs
    )

    assert report.is_valid, f"Validation failed with violations: {report.violations}"
    assert report.volume_balance_verified is True
    assert report.total_violations == 0


def test_qc_release_gate_enforcement(config):
    """Verify that rejected tankers are never unloaded and accepted tankers only unload after release."""
    generator = SyntheticPlantGenerator(config, seed=42)
    sim, _ = generator.generate_day(day_index=1)

    for trip in sim.logger.trips:
        if trip.qc_status == QCStatus.REJECTED:
            # Must not be unloaded
            assert trip.unload_start_minute is None, f"Rejected trip {trip.trip_id} was unloaded!"
            assert trip.assigned_bay is None
        elif trip.qc_status == QCStatus.RELEASED and trip.unload_start_minute is not None:
            # Must satisfy unload_start >= lab_release_time
            assert trip.lab_release_time_minute is not None
            assert trip.unload_start_minute >= trip.lab_release_time_minute, (
                f"Trip {trip.trip_id} started at {trip.unload_start_minute} "
                f"before release at {trip.lab_release_time_minute}!"
            )


def test_transfer_ledger_integrity(config):
    """Verify that every transfer is recorded in the ledger with valid volume and batch links."""
    generator = SyntheticPlantGenerator(config, seed=42)
    sim, _ = generator.generate_day(day_index=1)

    ledger = sim.logger.transfer_ledger
    assert len(ledger) > 0, "Transfer ledger is empty!"

    for rec in ledger:
        assert rec.volume_l > 0
        assert rec.start_time_minute <= rec.end_time_minute
        assert rec.source_asset != ""
        assert rec.target_asset != ""
        assert rec.source_batch != ""
        assert rec.target_batch != ""
        assert rec.label == "DATA SINTETIS"


def test_multi_day_dataset_generation(config, tmp_path):
    """Verify generating multi-day data, exporting via CsvDataAdapter, and checking balance consistency."""
    generator = SyntheticPlantGenerator(config, seed=42)
    output_dir = str(tmp_path / "test_synth_data")
    stats = generator.generate_and_save_dataset(output_dir=output_dir, n_days=5)

    assert stats["n_days"] == 5
    assert stats["total_trips"] > 100
    assert stats["max_daily_balance_diff"] < 1e-3

    # Check exported files
    for filename in [
        "tanker_trips.csv",
        "lab_tests.csv",
        "filling_output.csv",
        "transfer_ledger.csv",
        "daily_volume_balance.csv",
    ]:
        file_path = Path(output_dir) / filename
        assert file_path.exists(), f"File {filename} was not exported!"
        df = pd.read_csv(file_path)
        assert len(df) > 0, f"File {filename} is empty!"
