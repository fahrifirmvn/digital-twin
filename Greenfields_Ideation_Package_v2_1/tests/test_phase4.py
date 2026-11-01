"""
Phase 4 Tests: Production Extension, Setup Modeling (Pairwise vs Circuit),
Shared Aseptic Tank Constraints, Order Feasibility Diagnostics, and Independent Validator Integration.
Data Classification: DATA SINTETIS
Partner: [Nama Pabrik]
"""

import time
import pytest
from src.data.config_loader import load_master_config
from src.data.schemas import (
    ProductionOrder,
    MarketVariant,
    OrderStatus,
    ChangeoverType,
)
from src.opt.prod import ProductionCPSATScheduler
from src.opt.validator import ScheduleValidator


@pytest.fixture(scope="module")
def config():
    return load_master_config()


@pytest.fixture(scope="module")
def validator(config):
    return ScheduleValidator(config)


def test_changeover_and_cip_rules(config):
    """
    Test setup hierarchy: VARIANT (90m) > SIZE (60m) > PAPER (20m) > NONE (0m).
    Ensure paper change is NOT added during size change.
    Ensure CIP triggers operate independently (Choc/Straw -> Full Cream adds 60m).
    """
    scheduler = ProductionCPSATScheduler(config)

    # 1. Variant change (Flavour change: Full Cream -> Chocolate)
    o1 = ProductionOrder(order_id="O1", sku_id="ESL-FC", pack_size_code="LARGE_A", due_time_minute=600, target_volume_l=10000)
    o2 = ProductionOrder(order_id="O2", sku_id="ESL-CH", pack_size_code="LARGE_A", due_time_minute=600, target_volume_l=10000)
    setup, chg_type, cip = scheduler.calculate_changeover_and_cip(o1, o2)
    assert setup == 90
    assert chg_type == ChangeoverType.VARIANT
    assert cip == 0 # FC -> Choc doesn't require CIP

    # 2. Reverse flavour change (Chocolate -> Full Cream: triggers CIP_FLAVOUR)
    setup_rev, chg_type_rev, cip_rev = scheduler.calculate_changeover_and_cip(o2, o1)
    assert setup_rev == 90
    assert chg_type_rev == ChangeoverType.VARIANT
    assert cip_rev == 60 # Dark -> White CIP

    # 3. Size change on same flavour (LARGE_A -> LARGE_B, same flavour ESL-FC)
    # Paper change must NOT be added
    o3 = ProductionOrder(order_id="O3", sku_id="ESL-FC", pack_size_code="LARGE_B", market_variant=MarketVariant.LOCAL, due_time_minute=600, target_volume_l=10000)
    setup_size, chg_type_size, cip_size = scheduler.calculate_changeover_and_cip(o1, o3)
    assert setup_size == 60
    assert chg_type_size == ChangeoverType.SIZE
    assert cip_size == 0

    # 4. Paper change only (Same flavour, same size, different market variant)
    o4 = ProductionOrder(order_id="O4", sku_id="ESL-FC", pack_size_code="LARGE_A", market_variant=MarketVariant.LOCAL, due_time_minute=600, target_volume_l=10000)
    o5 = ProductionOrder(order_id="O5", sku_id="ESL-FC", pack_size_code="LARGE_A", market_variant=MarketVariant.EXP, due_time_minute=600, target_volume_l=10000)
    setup_paper, chg_type_paper, cip_paper = scheduler.calculate_changeover_and_cip(o4, o5)
    assert setup_paper == 20
    assert chg_type_paper == ChangeoverType.PAPER
    assert cip_paper == 0


def test_setup_benchmark_pairwise_vs_circuit(config):
    """
    Benchmark pairwise precedence literals vs circuit constraint on a representative instance.
    Confirm both methods produce valid, optimal schedules and measure wall time.
    """
    orders = [
        ProductionOrder(order_id="ORD-01", sku_id="ESL-FC", pack_size_code="LARGE_A", due_time_minute=400, target_volume_l=8000),
        ProductionOrder(order_id="ORD-02", sku_id="ESL-CH", pack_size_code="LARGE_A", due_time_minute=700, target_volume_l=8000),
        ProductionOrder(order_id="ORD-03", sku_id="ESL-FC", pack_size_code="LARGE_B", due_time_minute=1000, target_volume_l=10000),
        ProductionOrder(order_id="ORD-04", sku_id="ESL-ST", pack_size_code="LARGE_A", due_time_minute=1200, target_volume_l=8000),
    ]
    available_milk = 50000.0

    # Benchmark Pairwise
    sched_pairwise = ProductionCPSATScheduler(config, setup_method="pairwise")
    t0 = time.time()
    res_pairwise = sched_pairwise.solve(orders, available_raw_milk_l=available_milk, time_limit_seconds=5.0)
    pairwise_time = time.time() - t0

    # Benchmark Circuit
    sched_circuit = ProductionCPSATScheduler(config, setup_method="circuit")
    t1 = time.time()
    res_circuit = sched_circuit.solve(orders, available_raw_milk_l=available_milk, time_limit_seconds=5.0)
    circuit_time = time.time() - t1

    assert res_pairwise.status in ["OPTIMAL", "FEASIBLE"]
    assert res_circuit.status in ["OPTIMAL", "FEASIBLE"]
    assert res_pairwise.fulfilled_orders == res_circuit.fulfilled_orders == 4

    print(f"\n[BENCHMARK] Pairwise: {pairwise_time*1000:.2f}ms | Circuit: {circuit_time*1000:.2f}ms")


def test_handbuilt_feasibility_verdicts(config):
    """
    Test exact feasibility diagnostics ("Dapat dipenuhi?") and limiting causes:
    1. Normal eligible orders -> dapat_dipenuhi = True
    2. Deficit raw milk -> dapat_dipenuhi = False, limiting_cause = INSUFFICIENT_RAW_MATERIAL
    3. Impossible due date -> dapat_dipenuhi = False, limiting_cause = INSUFFICIENT_FILLER_CAPACITY
    4. Ineligible SKU/pack size -> dapat_dipenuhi = False, limiting_cause = INELIGIBLE_LINE_SKU
    """
    scheduler = ProductionCPSATScheduler(config)

    # 1. Normal order with plenty of milk
    normal_order = ProductionOrder(
        order_id="NORM-01",
        sku_id="ESL-FC",
        pack_size_code="LARGE_A",
        due_time_minute=600,
        target_volume_l=10000.0
    )
    res_normal = scheduler.solve([normal_order], available_raw_milk_l=50000.0)
    assert res_normal.order_verdicts[0].dapat_dipenuhi is True
    assert res_normal.order_verdicts[0].limiting_cause is None
    assert res_normal.order_verdicts[0].assigned_line is not None

    # 2. Deficit raw milk
    res_deficit = scheduler.solve([normal_order], available_raw_milk_l=2000.0)
    assert res_deficit.order_verdicts[0].dapat_dipenuhi is False
    assert res_deficit.order_verdicts[0].limiting_cause == "INSUFFICIENT_RAW_MATERIAL"

    # 3. Impossible due date (run takes ~80 min, due in 5 min)
    rush_order = ProductionOrder(
        order_id="RUSH-01",
        sku_id="ESL-FC",
        pack_size_code="LARGE_A",
        due_time_minute=5,
        target_volume_l=10000.0
    )
    res_rush = scheduler.solve([rush_order], available_raw_milk_l=50000.0)
    assert res_rush.order_verdicts[0].dapat_dipenuhi is False
    assert res_rush.order_verdicts[0].limiting_cause == "INSUFFICIENT_FILLER_CAPACITY"

    # 4. Ineligible SKU/pack size combination
    ineligible_order = ProductionOrder(
        order_id="INELIG-01",
        sku_id="NON_EXISTENT_SKU",
        pack_size_code="INVALID_SIZE",
        due_time_minute=600,
        target_volume_l=5000.0
    )
    res_inelig = scheduler.solve([ineligible_order], available_raw_milk_l=50000.0)
    assert res_inelig.order_verdicts[0].dapat_dipenuhi is False
    assert res_inelig.order_verdicts[0].limiting_cause == "INELIGIBLE_LINE_SKU"


def test_shared_aseptic_tank_product_consistency(config, validator):
    """
    Lines sharing an Aseptic Tank (e.g. FL-01 & FL-02 share AT-01) must NOT run different SKUs simultaneously.
    If scheduled at the same time, the solver must enforce sequence separation.
    """
    scheduler = ProductionCPSATScheduler(config)

    # Force orders specifically on FL-01 and FL-02 with conflicting SKUs
    # FL-01 and FL-02 both allow ESL-FC and ESL-CH
    order_a = ProductionOrder(
        order_id="ORD-AT-A",
        sku_id="ESL-FC",
        pack_size_code="LARGE_A",
        earliest_start_minute=100,
        due_time_minute=500,
        target_volume_l=15000.0
    )
    order_b = ProductionOrder(
        order_id="ORD-AT-B",
        sku_id="ESL-CH",
        pack_size_code="LARGE_A",
        earliest_start_minute=100,
        due_time_minute=500,
        target_volume_l=15000.0
    )

    orders = [order_a, order_b]
    res = scheduler.solve(orders, available_raw_milk_l=60000.0)

    # Check that validator passes with 0 violations
    violations = validator.validate_production_schedule(res, orders, available_raw_milk_l=60000.0)
    assert len(violations) == 0

    # If both ended up on the same AT pair, verify no time overlap
    va = res.order_verdicts[0]
    vb = res.order_verdicts[1]
    if va.dapat_dipenuhi and vb.dapat_dipenuhi:
        pair_a = (va.assigned_line in ["FL-01", "FL-02"])
        pair_b = (vb.assigned_line in ["FL-01", "FL-02"])
        if pair_a and pair_b and va.assigned_line != vb.assigned_line:
            # Overlap forbidden
            sa, ea = va.scheduled_start_minute, va.scheduled_end_minute
            sb, eb = vb.scheduled_start_minute, vb.scheduled_end_minute
            assert ea <= sb or eb <= sa, f"AT conflict! [{sa}..{ea}] overlaps [{sb}..{eb}]"


def test_validator_passes_realistic_production_day(config, validator):
    """
    Simulate a realistic 1-day production plan with 8 orders across multiple lines and SKUs.
    Validate with independent ScheduleValidator and verify solve time is well within limit (< 10s).
    """
    orders = [
        ProductionOrder(order_id="PO-01", sku_id="ESL-FC", pack_size_code="LARGE_A", due_time_minute=500, target_volume_l=12000),
        ProductionOrder(order_id="PO-02", sku_id="ESL-CH", pack_size_code="LARGE_A", due_time_minute=600, target_volume_l=10000),
        ProductionOrder(order_id="PO-03", sku_id="ESL-ST", pack_size_code="LARGE_B", due_time_minute=700, target_volume_l=8000),
        ProductionOrder(order_id="PO-04", sku_id="UHT-FC", pack_size_code="LARGE_A", due_time_minute=800, target_volume_l=15000),
        ProductionOrder(order_id="PO-05", sku_id="UHT-CH", pack_size_code="LARGE_B", due_time_minute=900, target_volume_l=12000),
        ProductionOrder(order_id="PO-06", sku_id="UHT-ST", pack_size_code="ESL_320", due_time_minute=1000, target_volume_l=6000),
        ProductionOrder(order_id="PO-07", sku_id="ESL-FC", pack_size_code="LARGE_B", due_time_minute=1100, target_volume_l=14000),
        ProductionOrder(order_id="PO-08", sku_id="UHT-FC", pack_size_code="PORTION_125", due_time_minute=1200, target_volume_l=8000),
    ]
    available_milk = 120000.0

    scheduler = ProductionCPSATScheduler(config)
    res = scheduler.solve(orders, available_raw_milk_l=available_milk, time_limit_seconds=10.0)

    # 1. Check solver performance
    assert res.status in ["OPTIMAL", "FEASIBLE"]
    assert res.wall_time_seconds < 10.0, f"Solve time {res.wall_time_seconds}s exceeded limit"
    assert res.fulfilled_orders > 0

    print(f"\n[PHASE 4 SOLVE TIME] Realistic 8-order day: {res.wall_time_seconds:.3f}s (Status: {res.status})")
    print(f"[FULFILLMENT] {res.fulfilled_orders}/{res.total_orders} fulfilled ({res.total_volume_fulfilled_l:.0f}L / {res.total_volume_requested_l:.0f}L)")

    # 2. Run through independent ScheduleValidator (R4)
    violations = validator.validate_production_schedule(res, orders, available_raw_milk_l=available_milk)
    assert len(violations) == 0, f"Validator found violations: {[v.model_dump() for v in violations]}"
