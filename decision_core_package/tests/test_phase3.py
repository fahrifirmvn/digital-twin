"""
Test Suite for Phase 3: CP-SAT Receiving Core.
Acceptance Criteria:
1. Brute-force cross-check on tiny instances (n <= 4) confirms exact optimality.
2. Independent validator passes on 200 random instances with zero hard constraint violations.
3. Solves a realistic 40-tanker, 15-tank, 3-bay problem day within the 10-second limit.
Data Classification: DATA SINTETIS
Partner: [Nama Pabrik]
"""

import time
import random
from pathlib import Path
import pytest
import numpy as np

from src.data.config_loader import load_master_config
from src.data.schemas import TankerTrip, LabTest, QCStatus
from src.opt.core import ReceivingCPSATScheduler, TankerInput
from src.opt.brute_force import TinyInstanceBruteForceSolver
from src.opt.validator import ScheduleValidator


@pytest.fixture
def config():
    return load_master_config()


def test_tiny_instance_brute_force_optimality(config):
    """
    Mathematical verification: CP-SAT objective must match brute-force global optimum
    on tiny instances (n = 2, 3, 4).
    """
    bf_solver = TinyInstanceBruteForceSolver(config)
    cpsat_solver = ReceivingCPSATScheduler(config)

    for n in [2, 3, 4]:
        tankers = [
            TankerInput(
                trip_id=f"TINY-{i}",
                farm_id=f"FARM-0{i+1}",
                volume_l=10000.0,
                planned_slot_minute=100 + i * 40,
                predicted_arrival_p50=90 + i * 35,
                predicted_arrival_p80=100 + i * 40,
                predicted_lab_duration=20
            )
            for i in range(n)
        ]

        bays = config.receiving.bays[:2] # 2 bays
        tanks = [t.id for t in config.storage_tanks.units[:2]]

        bf_res = bf_solver.solve_optimal(tankers, bays, tanks)
        cpsat_res = cpsat_solver.solve(tankers, time_limit_seconds=5.0)

        assert cpsat_res.status in ["OPTIMAL", "FEASIBLE"]
        assert cpsat_res.objective_value is not None

        # CP-SAT must match brute force minimum objective
        assert abs(cpsat_res.objective_value - bf_res["optimal_objective"]) < 1e-4, (
            f"Optimality mismatch on n={n}: CP-SAT={cpsat_res.objective_value} vs BF={bf_res['optimal_objective']}"
        )


def test_validator_passes_on_200_random_instances(config):
    """
    Stress verification: Solve 200 random instances across varying congestion,
    arrival spreads, and volumes; verify independent validator passes on every instance.
    """
    scheduler = ReceivingCPSATScheduler(config)
    validator = ScheduleValidator(config)

    rng = random.Random(42)
    n_instances = 200
    solved_count = 0

    for inst in range(n_instances):
        n_tankers = rng.randint(4, 15)
        tankers = []
        for i in range(n_tankers):
            slot = rng.randint(30, 1200)
            arr = max(0, slot + rng.randint(-30, 40))
            lab_dur = rng.randint(15, 30)
            vol = rng.choice([8000.0, 9000.0, 10000.0, 11000.0, 12000.0])
            tankers.append(TankerInput(
                trip_id=f"RND-{inst}-{i}",
                farm_id=f"FARM-0{rng.randint(1, 5)}",
                volume_l=vol,
                planned_slot_minute=slot,
                predicted_arrival_p50=arr,
                predicted_arrival_p80=arr + 15,
                predicted_lab_duration=lab_dur
            ))

        # Solve with 1 second time limit per random instance
        res = scheduler.solve(tankers, time_limit_seconds=1.0)
        assert res.status in ["OPTIMAL", "FEASIBLE"]
        solved_count += 1

        # Transform to TankerTrip contracts for validator
        trips = [
            TankerTrip(
                trip_id=d.trip_id,
                farm_id=d.farm_id,
                planned_slot_minute=d.planned_slot_minute,
                volume_l=d.volume_l,
                gate_arrival_time_minute=d.predicted_arrival_p50,
                lab_release_time_minute=d.predicted_arrival_p50 + d.predicted_lab_duration,
                qc_status=QCStatus.RELEASED,
                assigned_bay=d.assigned_bay,
                unload_start_minute=d.scheduled_unload_start,
                unload_end_minute=d.scheduled_unload_end,
                destination_tank_id=d.assigned_tank
            )
            for d in res.tanker_decisions
        ]

        # Run independent validator
        violations = validator.validate_receiving_and_unloading(trips)
        assert len(violations) == 0, f"Validator failed on instance {inst}: {violations}"

    assert solved_count == 200


def test_scalability_40_tanker_day_solve_time(config):
    """
    Benchmark requirement: Solve a full-scale 40-tanker, 15-tank, 3-bay day
    within the 10-second limit and report actual solve time.
    """
    scheduler = ReceivingCPSATScheduler(config)
    rng = np.random.default_rng(42)

    n_tankers = 40
    tankers = []
    for i in range(n_tankers):
        slot = int(20 + i * 32)
        arr = max(0, slot + int(rng.normal(0, 15)))
        lab_dur = int(rng.uniform(15, 28))
        vol = float(rng.choice([8500.0, 9500.0, 10000.0, 11000.0, 11500.0]))
        tankers.append(TankerInput(
            trip_id=f"TR-40T-{i:02d}",
            farm_id=f"FARM-0{(i % 5) + 1}",
            volume_l=vol,
            planned_slot_minute=slot,
            predicted_arrival_p50=arr,
            predicted_arrival_p80=arr + 12,
            predicted_lab_duration=lab_dur
        ))

    start_time = time.time()
    res = scheduler.solve(tankers, time_limit_seconds=10.0)
    actual_time = time.time() - start_time

    assert res.status in ["OPTIMAL", "FEASIBLE"]
    assert len(res.tanker_decisions) == 40
    assert actual_time < 10.0, f"Solve time {actual_time:.2f}s exceeded 10.0s limit!"

    print(f"\n[BENCHMARK] 40-Tanker Day Solved in {actual_time:.3f}s (Status: {res.status}, Obj: {res.objective_value})")
