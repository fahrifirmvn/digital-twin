"""
Unit tests for Phase 0 Acceptance.
Verifies master.yaml loading, validation, placeholder scanning, and Pydantic data contracts.
Data Classification: DATA SINTETIS
Partner: [Nama Pabrik]
"""

import os
from pathlib import Path
import pytest

from src.data.config_loader import load_master_config, MasterConfig
from src.data.schemas import (
    TankerTrip,
    LabTest,
    CipEvent,
    ChangeoverEvent,
    TankLevel,
    ProductionOrder,
    FillingOutput,
    AssetMaster,
    QCStatus,
    TankState,
    ChangeoverType,
    MarketVariant,
    OrderStatus,
)
from src.data.adapter import CsvDataAdapter


def test_master_config_loads_and_validates():
    """Verify master.yaml parses cleanly into MasterConfig."""
    config = load_master_config()
    assert isinstance(config, MasterConfig)
    assert config.metadata["plant_name"] == "[Nama Pabrik]"
    assert config.metadata["data_classification"] == "DATA SINTETIS"

    # Check receiving
    assert config.receiving.n_bays == 4
    assert len(config.receiving.bays) == 4
    assert config.receiving.bay_flow_lph.value == 25000.0

    # Check lab
    assert config.lab.n_channels == 2
    assert config.lab.default_duration_min.value == 20

    # Check storage tanks (must be 15 units)
    assert config.storage_tanks.count == 15
    assert len(config.storage_tanks.units) == 15
    assert config.storage_tanks.units[0].id == "SFP-01"
    assert config.storage_tanks.units[14].id == "SFP-15"

    # Check thermizer & sterilizers
    assert len(config.thermizer.units) == 2
    assert len(config.sterilizer.units) == 5

    # Check aseptic tanks & filling lines
    assert len(config.aseptic_tanks.units) == 5
    assert len(config.filling_lines.units) == 10

    # Check SKUs and milk usage factors
    fc_sku = next(s for s in config.sku_master.skus if s.id == "ESL-FC")
    ch_sku = next(s for s in config.sku_master.skus if s.id == "ESL-CH")
    assert fc_sku.milk_usage_factor == 1.0
    assert ch_sku.milk_usage_factor == 0.9


def test_placeholder_detection():
    """Verify placeholders are explicitly flagged and listed."""
    config = load_master_config()
    placeholders = config.find_all_placeholders()
    assert len(placeholders) > 0

    # Read assumptions.md to ensure all placeholders are documented
    assumptions_path = Path(__file__).resolve().parent.parent / "docs" / "assumptions.md"
    assert assumptions_path.exists()
    assumptions_text = assumptions_path.read_text(encoding="utf-8")

    # Check key placeholder paths in assumptions.md
    assert "bay_flow_lph" in assumptions_text
    assert "tanker_volume_distribution" in assumptions_text
    assert "default_duration_min" in assumptions_text
    assert "storage_tanks" in assumptions_text
    assert "DATA SINTETIS" in assumptions_text
    assert "[Nama Pabrik]" in assumptions_text


def test_pydantic_contracts_serialization():
    """Verify core operational contracts serialize and deserialize with valid types."""
    # 1. TankerTrip
    trip = TankerTrip(
        trip_id="TR-001",
        farm_id="FARM-ALPHA",
        planned_slot_minute=60,
        volume_l=10500.0,
        gate_arrival_time_minute=55,
        qc_status=QCStatus.RELEASED,
        assigned_bay="UB-01",
        destination_tank_id="SFP-01"
    )
    assert trip.volume_l == 10500.0
    trip_dict = trip.model_dump()
    assert trip_dict["qc_status"] == "RELEASED"
    reloaded_trip = TankerTrip.model_validate(trip_dict)
    assert reloaded_trip.trip_id == "TR-001"

    # 2. LabTest
    test = LabTest(
        test_id="LT-001",
        trip_id="TR-001",
        farm_id="FARM-ALPHA",
        channel_id="LAB-CH-01",
        sampling_time_minute=56,
        test_start_minute=58,
        test_end_minute=78,
        test_duration_min=20,
        result_released=True,
        fat_pct=3.85,
        protein_pct=3.20
    )
    assert test.result_released is True

    # 3. CipEvent
    cip = CipEvent(
        event_id="CIP-001",
        asset_id="SFP-01",
        asset_type="StorageTank",
        trigger="EMPTY_TANK",
        start_time_minute=200,
        duration_min=75,
        end_time_minute=275,
        clean_status=True
    )
    assert cip.duration_min == 75

    # 4. ChangeoverEvent
    changeover = ChangeoverEvent(
        event_id="CHG-001",
        line_id="FL-01",
        from_sku_id="ESL-CH",
        to_sku_id="ESL-FC",
        changeover_type=ChangeoverType.VARIANT,
        start_time_minute=300,
        duration_min=90,
        end_time_minute=390
    )
    assert changeover.changeover_type == ChangeoverType.VARIANT

    # 5. ProductionOrder
    order = ProductionOrder(
        order_id="ORD-101",
        sku_id="ESL-FC",
        finished_sku_id="ESL-FC-1000-LOCAL",
        pack_size_code="LARGE_A",
        market_variant=MarketVariant.LOCAL,
        target_volume_l=20000.0,
        due_time_minute=1200,
        priority=1,
        status=OrderStatus.PLANNED
    )
    assert order.target_volume_l == 20000.0


def test_csv_data_adapter_roundtrip(tmp_path):
    """Verify CsvDataAdapter correctly serializes and reads back data models."""
    adapter = CsvDataAdapter(str(tmp_path))

    trips = [
        TankerTrip(
            trip_id="TR-001",
            farm_id="FARM-A",
            planned_slot_minute=10,
            volume_l=10000.0,
            qc_status=QCStatus.RELEASED
        ),
        TankerTrip(
            trip_id="TR-002",
            farm_id="FARM-B",
            planned_slot_minute=40,
            volume_l=9500.0,
            qc_status=QCStatus.PENDING
        )
    ]

    adapter.save_tanker_trips(trips)
    loaded_trips = adapter.load_tanker_trips()
    assert len(loaded_trips) == 2
    assert loaded_trips[0].trip_id == "TR-001"
    assert loaded_trips[1].volume_l == 9500.0
