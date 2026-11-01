"""
Phase 5 Tests: Predict-Then-Optimize Loop, 5 Disruption Replanning Scenarios,
Monte Carlo Risk (N=200), Structured Explainability, What-If Scenarios, and Bi-Directional Traceability.
Data Classification: DATA SINTETIS
Partner: [Nama Pabrik]
"""

import pytest
import numpy as np
from src.data.config_loader import load_master_config
from src.data.schemas import (
    ProductionOrder,
    MarketVariant,
    QCStatus,
)
from src.sim.engine import TransferRecord
from src.opt.core import TankerInput
from src.opt.replan import (
    DynamicReplanner,
    PlantState,
    ReplanEvent,
)
from src.opt.explain import ScheduleExplainer
from src.opt.whatif import (
    WhatIfEngine,
    WhatIfScenario,
)
from src.trace.genealogy import GenealogyTracer


@pytest.fixture(scope="module")
def config():
    return load_master_config()


@pytest.fixture(scope="module")
def sample_tankers():
    return [
        TankerInput(
            trip_id=f"TRIP-{i:03d}",
            farm_id=f"FARM-0{(i % 5) + 1}",
            volume_l=10000.0,
            planned_slot_minute=100 + i * 40,
            predicted_arrival_p50=90 + i * 40,
            predicted_arrival_p80=110 + i * 40,
            predicted_lab_duration=25,
            p_release=0.97
        )
        for i in range(8)
    ]


@pytest.fixture(scope="module")
def sample_orders():
    return [
        ProductionOrder(order_id="ORD-01", sku_id="ESL-FC", pack_size_code="LARGE_A", due_time_minute=500, target_volume_l=10000),
        ProductionOrder(order_id="ORD-02", sku_id="ESL-CH", pack_size_code="LARGE_A", due_time_minute=700, target_volume_l=10000),
        ProductionOrder(order_id="ORD-03", sku_id="UHT-FC", pack_size_code="LARGE_B", due_time_minute=900, target_volume_l=12000),
        ProductionOrder(order_id="ORD-04", sku_id="ESL-ST", pack_size_code="LARGE_A", due_time_minute=1100, target_volume_l=8000),
    ]


def test_replan_handles_5_disruptions(config, sample_tankers, sample_orders):
    """
    Test that DynamicReplanner cleanly handles 5 core disruption triggers:
    1. ETA_SHIFT: Arrival delayed beyond threshold (+45m)
    2. LAB_OVERRUN: Lab test overrun (+35m beyond P80)
    3. MAINTENANCE_CHANGE: Unplanned bay maintenance window added
    4. TANK_NOT_READY: Storage tank status becomes dirty/unavailable
    5. ORDER_CHANGE: Urgent order inserted
    """
    replanner = DynamicReplanner(config)
    state = PlantState(current_time_minute=60, available_raw_milk_l=80000.0)

    # 0. Generate Baseline Plan
    base_plan = replanner.plan_day(state, sample_tankers, sample_orders)
    assert base_plan.receiving_schedule.status in ["OPTIMAL", "FEASIBLE"]
    assert len(base_plan.receiving_schedule.tanker_decisions) == len(sample_tankers)

    # -------------------------------------------------------------
    # Disruption 1: ETA_SHIFT (+45m shift on TRIP-001)
    # -------------------------------------------------------------
    ev1 = ReplanEvent(
        event_type="ETA_SHIFT",
        entity_id="TRIP-001",
        new_value=sample_tankers[1].predicted_arrival_p50 + 45,
        timestamp_minute=70
    )
    res1 = replanner.replan(state, [ev1], base_plan.receiving_schedule, sample_tankers)
    assert res1.replan_triggered is True
    assert "ETA_SHIFT" in res1.trigger_reason
    # Unload start for TRIP-001 must not violate delayed arrival
    d1 = next(d for d in res1.receiving_schedule.tanker_decisions if d.trip_id == "TRIP-001")
    assert d1.scheduled_unload_start >= ev1.new_value + 20

    # -------------------------------------------------------------
    # Disruption 2: LAB_OVERRUN (+35m lab delay on TRIP-002)
    # -------------------------------------------------------------
    ev2 = ReplanEvent(
        event_type="LAB_OVERRUN",
        entity_id="TRIP-002",
        new_value=sample_tankers[2].predicted_lab_duration + 35,
        timestamp_minute=80
    )
    res2 = replanner.replan(state, [ev2], base_plan.receiving_schedule, sample_tankers)
    assert res2.replan_triggered is True
    assert "LAB_OVERRUN" in res2.trigger_reason
    d2 = next(d for d in res2.receiving_schedule.tanker_decisions if d.trip_id == "TRIP-002")
    assert d2.scheduled_unload_start >= sample_tankers[2].predicted_arrival_p50 + ev2.new_value

    # -------------------------------------------------------------
    # Disruption 3: MAINTENANCE_CHANGE (Bay UB-01 blocked)
    # -------------------------------------------------------------
    ev3 = ReplanEvent(
        event_type="MAINTENANCE_CHANGE",
        entity_id="UB-01",
        new_value={"start_minute": 100, "duration_min": 180},
        timestamp_minute=90
    )
    state_maint = PlantState(
        current_time_minute=90,
        maintenance_windows=[{"asset_id": "UB-01", "start_minute": 100, "duration_min": 180}]
    )
    res3 = replanner.replan(state_maint, [ev3], base_plan.receiving_schedule, sample_tankers)
    assert res3.replan_triggered is True
    # Verify no tanker unloads in UB-01 during maintenance window [100..280]
    for d in res3.receiving_schedule.tanker_decisions:
        if d.assigned_bay == "UB-01":
            assert d.scheduled_unload_end <= 100 or d.scheduled_unload_start >= 280

    # -------------------------------------------------------------
    # Disruption 4: TANK_NOT_READY (Tank SFP-01 dirty / CIP)
    # -------------------------------------------------------------
    ev4 = ReplanEvent(
        event_type="TANK_NOT_READY",
        entity_id="SFP-01",
        new_value="DIRTY",
        timestamp_minute=95
    )
    state_tank = PlantState(
        current_time_minute=95,
        tank_clean={"SFP-01": False} # SFP-01 requires 75m CIP before use
    )
    res4 = replanner.replan(state_tank, [ev4], base_plan.receiving_schedule, sample_tankers)
    assert res4.replan_triggered is True
    # If any tanker assigned to SFP-01, start must be >= 75m
    for d in res4.receiving_schedule.tanker_decisions:
        if d.assigned_tank == "SFP-01":
            assert d.scheduled_unload_start >= 75

    # -------------------------------------------------------------
    # Disruption 5: ORDER_CHANGE (Rush order inserted)
    # -------------------------------------------------------------
    rush_order = ProductionOrder(
        order_id="ORD-RUSH",
        sku_id="ESL-FC",
        pack_size_code="LARGE_A",
        due_time_minute=400,
        target_volume_l=5000
    )
    ev5 = ReplanEvent(
        event_type="ORDER_CHANGE",
        entity_id="ORD-RUSH",
        new_value="INSERTED",
        timestamp_minute=100
    )
    orders_with_rush = [rush_order] + sample_orders
    res5 = replanner.replan(state, [ev5], base_plan.receiving_schedule, sample_tankers, production_orders=orders_with_rush)
    assert res5.replan_triggered is True
    assert res5.production_schedule is not None
    assert any(v.order_id == "ORD-RUSH" and v.dapat_dipenuhi for v in res5.production_schedule.order_verdicts)


def test_monte_carlo_risk_evaluation(config, sample_tankers):
    """
    Monte Carlo simulation with N=200 samples:
    Verifies waiting time quantiles and asserts 0 gate violations (Rule R7).
    """
    replanner = DynamicReplanner(config)
    state = PlantState(current_time_minute=0)
    plan = replanner.plan_day(state, sample_tankers)

    mc = plan.monte_carlo_risk
    assert mc.n_samples == 200
    assert 0.0 <= mc.p_waiting_over_30m <= 1.0
    assert mc.mean_waiting_minutes >= 0.0
    assert mc.gate_violations == 0, "Gate violations must be strictly 0 by construction!"


def test_schedule_explainer_structured_reasons(config, sample_tankers, sample_orders):
    """
    Verify explain() produces non-empty reasons[], binding constraints, and minimal conflict sets.
    """
    replanner = DynamicReplanner(config)
    state = PlantState(current_time_minute=0, available_raw_milk_l=15000.0) # Intentionally constrained milk
    plan = replanner.plan_day(state, sample_tankers, sample_orders)

    explainer = ScheduleExplainer(config)
    explanation = explainer.explain(
        receiving_schedule=plan.receiving_schedule,
        production_schedule=plan.production_schedule,
        orders=sample_orders,
        available_raw_milk_l=15000.0
    )

    # 1. Non-empty tanker rationales
    assert len(explanation.tanker_rationales) == len(sample_tankers)
    for r in explanation.tanker_rationales:
        assert len(r.reasons) > 0, f"Tanker {r.trip_id} rationale reasons[] must not be empty"

    # 2. Binding constraints identified
    assert len(explanation.binding_constraints) > 0

    # 3. Slacks measured
    assert len(explanation.slacks) > 0
    tanker_slacks = [s for s in explanation.slacks if s.entity_type == "TANKER"]
    line_slacks = [s for s in explanation.slacks if s.entity_type == "LINE"]
    assert len(tanker_slacks) > 0
    assert len(line_slacks) > 0

    # 4. Minimal conflict sets for unfulfilled orders
    unfulfilled_in_plan = [v for v in plan.production_schedule.order_verdicts if not v.dapat_dipenuhi]
    if unfulfilled_in_plan:
        assert len(explanation.minimal_conflict_sets) > 0
        for cs in explanation.minimal_conflict_sets:
            assert cs.conflict_type in ["INSUFFICIENT_RAW_MATERIAL", "INSUFFICIENT_FILLER_CAPACITY", "INELIGIBLE_LINE_SKU"]
            assert len(cs.contributing_factors) > 0
            assert len(cs.suggested_action) > 0


def test_what_if_parameter_overrides(config, sample_tankers, sample_orders):
    """
    Test What-If engine with parameter overrides:
    1. Bay flow increased (+20%) -> waiting time decreases or holds
    2. Available raw milk reduced -> delta fulfilled volume is negative
    """
    replanner = DynamicReplanner(config)
    state = PlantState(current_time_minute=0, available_raw_milk_l=60000.0)
    base_plan = replanner.plan_day(state, sample_tankers, sample_orders)

    whatif = WhatIfEngine(config)

    # Scenario 1: Faster bay flow (+20%)
    scen1 = WhatIfScenario(
        scenario_id="SCEN-FASTER-FLOW",
        description="Pumping flow increased by 20% across all receiving bays",
        bay_flow_multiplier=1.2
    )
    res1 = whatif.run_scenario(
        scenario=scen1,
        base_receiving_schedule=base_plan.receiving_schedule,
        tanker_inputs=sample_tankers
    )
    assert res1.delta_kpis.delta_total_waiting_time_minutes <= 0.0

    # Scenario 2: Severe raw milk shortage (reduce to 8,000L)
    scen2 = WhatIfScenario(
        scenario_id="SCEN-MILK-SHORTAGE",
        description="Raw milk shortage limiting plant intake to 8,000 L",
        available_raw_milk_l=8000.0
    )
    res2 = whatif.run_scenario(
        scenario=scen2,
        base_receiving_schedule=base_plan.receiving_schedule,
        tanker_inputs=sample_tankers,
        base_production_schedule=base_plan.production_schedule,
        production_orders=sample_orders,
        available_raw_milk_l=60000.0
    )
    assert res2.delta_kpis.delta_fulfilled_volume_l < 0.0


def test_bi_directional_traceability_and_volume_conservation(config):
    """
    Test bi-directional traceability (Forward & Backward) and assert volume conservation
    through all intermediate stages.
    """
    # Create realistic transfer ledger entries
    ledger = [
        # Receiving from Tanker TRIP-001 into SFP-01
        TransferRecord(
            transfer_id="TRF-001",
            source_batch="TRIP-001",
            target_batch="LOT-001",
            source_asset="UB-01",
            target_asset="SFP-01",
            start_time_minute=120,
            end_time_minute=150,
            volume_l=10000.0,
            product_sku="RAW-MILK"
        ),
        # Packaging order ORD-01 drawn from SFP-01 on FL-01
        TransferRecord(
            transfer_id="TRF-002",
            source_batch="SFP-01",
            target_batch="FG-ORD-01",
            source_asset="FL-01",
            target_asset="FG-OUTPUT",
            start_time_minute=200,
            end_time_minute=280,
            volume_l=10000.0,
            product_sku="ESL-FC"
        )
    ]

    tracer = GenealogyTracer(transfer_ledger=ledger)

    # 1. Forward Trace from TRIP-001
    fwd = tracer.forward_trace("001")
    assert fwd.source_trip_id == "001"
    assert "SFP-01" in fwd.impacted_storage_tanks
    assert "FL-01" in fwd.impacted_filling_lines
    assert "FG-ORD-01" in fwd.finished_goods_lots
    assert fwd.volume_conserved is True

    # 2. Backward Trace from FG-ORD-01
    bwd = tracer.backward_trace("FG-ORD-01")
    assert bwd.finished_lot_id == "FG-ORD-01"
    assert bwd.packaging_line_id == "FL-01"
    assert bwd.finished_sku_id == "ESL-FC"
    assert "SFP-01" in bwd.source_storage_tanks
    assert "001" in bwd.source_tanker_trips
    assert bwd.volume_conserved is True
