"""Gate Engine G1-G6 (PRD 9.3). Deterministik dan fail-closed: data hilang atau tidak valid berarti tahan."""

import math
from collections.abc import Mapping
from dataclasses import dataclass

from app.contracts.events import GateId
from app.plant import Thresholds


@dataclass(frozen=True)
class GateResult:
    gate: GateId
    passed: bool
    reason: str | None = None

    @property
    def decision(self) -> str:
        return "pass" if self.passed else "hold"


@dataclass(frozen=True)
class TankState:
    status: str
    clean: bool
    level_ton: float
    reserved_ton: float
    capacity_ton: float
    product: str = "raw"


def _ok(gate: GateId) -> GateResult:
    return GateResult(gate, True)


def _hold(gate: GateId, reason: str) -> GateResult:
    return GateResult(gate, False, reason)


def _num(x: object) -> float | None:
    # bool adalah subclass int, jadi harus ditolak eksplisit.
    if isinstance(x, bool) or not isinstance(x, int | float) or not math.isfinite(x):
        return None
    return float(x)


def g1_truck_arrival(temp_c: object, docs_ok: object, th: Thresholds) -> GateResult:
    t = _num(temp_c)
    if t is None:
        return _hold(GateId.G1, "suhu tidak terbaca")
    if t > th.max_arrival_temp_c:
        return _hold(GateId.G1, f"suhu {t:.1f} C melebihi {th.max_arrival_temp_c:.1f} C")
    if docs_ok is not True:
        return _hold(GateId.G1, "surat jalan tidak sesuai")
    return _ok(GateId.G1)


def g2_lab_result(results: Mapping[str, object] | None, th: Thresholds) -> GateResult:
    if not results:
        return _hold(GateId.G2, "hasil lab tidak tersedia")

    fat, protein, acidity = (
        _num(results.get(k)) for k in ("fat_pct", "protein_pct", "acidity_pct")
    )
    if fat is None or protein is None or acidity is None:
        return _hold(GateId.G2, "parameter lab tidak lengkap")
    if fat < th.fat_min_pct:
        return _hold(GateId.G2, f"lemak {fat:.2f}% di bawah {th.fat_min_pct}%")
    if protein < th.protein_min_pct:
        return _hold(GateId.G2, f"protein {protein:.2f}% di bawah {th.protein_min_pct}%")
    lo, hi = th.acidity_range_pct
    if not lo <= acidity <= hi:
        return _hold(GateId.G2, f"keasaman {acidity:.3f}% di luar {lo}-{hi}%")
    ph = _num(results.get("ph"))
    if ph is not None:  # hasil lama tanpa pH tetap dinilai dari parameter lain
        p_lo, p_hi = th.ph_range
        if not p_lo <= ph <= p_hi:
            return _hold(GateId.G2, f"pH {ph:.2f} di luar {p_lo}-{p_hi}")
    # Residu antibiotik dan adulteran harus eksplisit False, nilai lain dianggap positif.
    if results.get("antibiotic_residue") is not False:
        return _hold(GateId.G2, "residu antibiotik positif atau tidak diuji")
    if results.get("adulterant") is not False:
        return _hold(GateId.G2, "adulteran positif atau tidak diuji")
    return _ok(GateId.G2)


def g3_unload_to_tank(tank: TankState, volume_ton: float, product: str = "raw") -> GateResult:
    if tank.status not in ("idle", "filling"):
        return _hold(GateId.G3, f"tangki berstatus {tank.status}")
    if not tank.clean:
        return _hold(GateId.G3, "tangki belum CIP")
    if tank.product != product:
        return _hold(GateId.G3, "produk tidak kompatibel")
    if tank.level_ton + tank.reserved_ton + volume_ton > tank.capacity_ton:
        return _hold(GateId.G3, "kapasitas tangki tidak cukup")
    return _ok(GateId.G3)


def g4_pre_sterilization(age_min: object, route_ok: object, th: Thresholds) -> GateResult:
    age = _num(age_min)
    if age is None:
        return _hold(GateId.G4, "umur susu tidak diketahui")
    if age > th.holding_max_min:
        return _hold(GateId.G4, f"holding time {age:.0f} menit melebihi {th.holding_max_min:.0f}")
    if route_ok is not True:
        return _hold(GateId.G4, "produk tidak sesuai rute")
    return _ok(GateId.G4)


def g5_sterilization(
    temp_c: object, hold_s: object, divert_active: object, th: Thresholds
) -> GateResult:
    t, h = _num(temp_c), _num(hold_s)
    if t is None or h is None:
        return _hold(GateId.G5, "parameter sterilisasi tidak terbaca")
    if divert_active is not False:
        return _hold(GateId.G5, "divert valve aktif atau tidak terbaca")
    if t < th.steril_min_temp_c:
        return _hold(GateId.G5, f"suhu steril {t:.1f} C di bawah {th.steril_min_temp_c} C")
    if h < th.steril_min_hold_s:
        return _hold(GateId.G5, f"holding steril {h:.1f} s di bawah {th.steril_min_hold_s} s")
    return _ok(GateId.G5)


def g6_ready_to_fill(
    aseptic_sterile: object, line_available: object, qa_hold: object
) -> GateResult:
    if aseptic_sterile is not True:
        return _hold(GateId.G6, "aseptic tank tidak steril")
    if qa_hold is not False:
        return _hold(GateId.G6, "ada penahanan QA")
    if line_available is not True:
        return _hold(GateId.G6, "filling line tidak tersedia")
    return _ok(GateId.G6)
