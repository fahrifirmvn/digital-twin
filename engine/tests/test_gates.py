import math
import random

import pytest

from app import gates
from app.plant import Thresholds

TH = Thresholds()
GARBAGE = [None, float("nan"), float("inf"), "4.0", True, False, [], {}]


def lab_ok() -> dict:
    return {
        "fat_pct": 3.7,
        "protein_pct": 3.1,
        "acidity_pct": 0.15,
        "antibiotic_residue": False,
        "adulterant": False,
    }


def test_g1_pass_and_boundaries():
    assert gates.g1_truck_arrival(6.0, True, TH).passed
    assert not gates.g1_truck_arrival(6.1, True, TH).passed
    assert not gates.g1_truck_arrival(4.0, False, TH).passed


@pytest.mark.parametrize("bad", GARBAGE)
def test_g1_fails_closed_on_garbage(bad):
    assert not gates.g1_truck_arrival(bad, True, TH).passed
    assert not gates.g1_truck_arrival(4.0, bad, TH).passed or bad is True


def test_g2_pass_and_each_failure():
    assert gates.g2_lab_result(lab_ok(), TH).passed
    for key, value in [
        ("fat_pct", 2.9),
        ("protein_pct", 2.7),
        ("acidity_pct", 0.2),
        ("acidity_pct", 0.1),
        ("antibiotic_residue", True),
        ("adulterant", True),
    ]:
        assert not gates.g2_lab_result({**lab_ok(), key: value}, TH).passed, (key, value)


def test_g2_missing_or_empty_is_hold():
    assert not gates.g2_lab_result(None, TH).passed
    assert not gates.g2_lab_result({}, TH).passed
    for key in lab_ok():
        partial = lab_ok()
        del partial[key]
        assert not gates.g2_lab_result(partial, TH).passed, key


def test_g2_flags_must_be_explicit_false():
    for bad in (None, 0, "false", "no"):
        assert not gates.g2_lab_result({**lab_ok(), "antibiotic_residue": bad}, TH).passed


def test_g2_fuzz_never_passes_against_independent_oracle():
    rng = random.Random(7)

    def oracle(r: dict) -> bool:
        def num(x):
            return isinstance(x, float) and math.isfinite(x)

        return (
            num(r.get("fat_pct"))
            and r["fat_pct"] >= 3.0
            and num(r.get("protein_pct"))
            and r["protein_pct"] >= 2.8
            and num(r.get("acidity_pct"))
            and 0.12 <= r["acidity_pct"] <= 0.18
            and r.get("antibiotic_residue") is False
            and r.get("adulterant") is False
        )

    for _ in range(5000):
        r = {
            "fat_pct": rng.choice([rng.uniform(2, 5), *GARBAGE]),
            "protein_pct": rng.choice([rng.uniform(2, 4), *GARBAGE]),
            "acidity_pct": rng.choice([rng.uniform(0.1, 0.22), *GARBAGE]),
            "antibiotic_residue": rng.choice([False, True, None, 0, "x"]),
            "adulterant": rng.choice([False, True, None, 0, "x"]),
        }
        assert gates.g2_lab_result(r, TH).passed == oracle(r), r


def tank(**kw):
    base = dict(status="idle", clean=True, level_ton=0.0, reserved_ton=0.0, capacity_ton=100.0)
    return gates.TankState(**{**base, **kw})


def test_g3_rules():
    assert gates.g3_unload_to_tank(tank(), 22).passed
    assert gates.g3_unload_to_tank(tank(status="filling", level_ton=50), 22).passed
    assert not gates.g3_unload_to_tank(tank(status="cip"), 22).passed
    assert not gates.g3_unload_to_tank(tank(clean=False), 22).passed
    assert not gates.g3_unload_to_tank(tank(level_ton=70, reserved_ton=10), 22).passed
    assert not gates.g3_unload_to_tank(tank(product="cream"), 22).passed


def test_g4_holding_time():
    assert gates.g4_pre_sterilization(240.0, True, TH).passed
    assert not gates.g4_pre_sterilization(240.1, True, TH).passed
    assert not gates.g4_pre_sterilization(10.0, False, TH).passed
    assert not gates.g4_pre_sterilization(None, True, TH).passed


def test_g5_divert_and_parameters():
    assert gates.g5_sterilization(139.0, 5.0, False, TH).passed
    assert not gates.g5_sterilization(139.0, 5.0, True, TH).passed
    assert not gates.g5_sterilization(139.0, 5.0, None, TH).passed
    assert not gates.g5_sterilization(136.9, 5.0, False, TH).passed
    assert not gates.g5_sterilization(139.0, 3.9, False, TH).passed
    assert not gates.g5_sterilization(float("nan"), 5.0, False, TH).passed


def test_g6_requires_all_conditions():
    assert gates.g6_ready_to_fill(True, True, False).passed
    assert not gates.g6_ready_to_fill(False, True, False).passed
    assert not gates.g6_ready_to_fill(True, False, False).passed
    assert not gates.g6_ready_to_fill(True, True, True).passed
    assert not gates.g6_ready_to_fill(True, True, None).passed
