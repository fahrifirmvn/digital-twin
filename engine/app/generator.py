"""Generator data DEMO. Semua pola sintetis: dapat direproduksi lewat seed, dengan noise dan ekor panjang (PRD 10.8)."""

import math
import random
from dataclasses import dataclass, replace

from app.plant import SKUS

FARMS = (
    ("FRM-01", "Farm Pasuruan", 45.0),
    ("FRM-02", "Farm Malang", 95.0),
    ("FRM-03", "Farm Probolinggo", 70.0),
    ("FRM-04", "Farm Batu", 110.0),
    ("FRM-05", "Farm Lumajang", 130.0),
    ("FRM-06", "Farm Jember", 190.0),
    ("FRM-07", "Farm Blitar", 120.0),
    ("FRM-08", "Farm Kediri", 150.0),
)

MEAN_TRUCK_TON = 22.5

APPROACH_MIN = 45.0  # jendela pendekatan: truk tampil di Maps sebelum tiba di gerbang
N_ROUTES = 3  # utara, barat, selatan; semuanya bertemu di gerbang masuk
FARM_ROUTE = {
    "FRM-01": 0, "FRM-02": 1, "FRM-03": 0, "FRM-04": 1,
    "FRM-05": 2, "FRM-06": 2, "FRM-07": 2, "FRM-08": 1,
}  # fmt: skip
_REGION_PLATE = {
    "FRM-06": "P",
    "FRM-07": "AG",
    "FRM-08": "AG",
}  # lainnya "N" (Malang Raya, Tapal Kuda)
_OTHER_PLATE = ("L", "W", "S", "B", "AE", "DK")
_PLATE_LETTERS = "ABCDEFGHJKLMNPRSTUVWXYZ"
SKU_WEIGHTS = (4, 2, 2, 1)  # urutan sama dengan plant.SKUS
RUSH_HOURS = ((6, 8), (16, 18))
SHIFT_CHANGE_HOUR = 14  # serah terima analis, uji lebih lama


DAY_START_HOUR = 6  # hari operasi 06:00-06:00; menit 0 simulasi = 06:00


def clock_minute(minute: float) -> float:
    """Menit sejak awal run -> menit sejak 00:00 pada jam dinding."""
    return (minute + DAY_START_HOUR * 60) % 1440


def is_rush(minute: float) -> bool:
    return any(a * 60 <= clock_minute(minute) < b * 60 for a, b in RUSH_HOURS)


def is_shift_change(minute: float) -> bool:
    return SHIFT_CHANGE_HOUR * 60 <= clock_minute(minute) < (SHIFT_CHANGE_HOUR + 1) * 60


@dataclass(frozen=True)
class TankerSpec:
    code: str
    farm_code: str
    volume_ton: float
    scheduled_eta_min: float
    arrival_min: float
    temp_c: float
    docs_ok: bool
    lab_duration_min: float
    lab_results: dict[str, float | bool]
    farm_distance_km: float = 0.0
    test_type: str = "standard"  # standard, extended (uji residu tambahan)
    sku_code: str = "UHT-FULL-1000"
    announced: bool = True  # False: truk dadakan, baru diketahui perencana saat tiba
    plate: str = ""  # plat nomor sintetis, kosong bila spec dibuat di luar generate_day
    appears_min: float = 0.0  # truk dari perintah: baru terlihat (dispatch) sejak menit ini

    @property
    def route(self) -> int:
        return FARM_ROUTE.get(self.farm_code, 0)


def _plates(
    seed: int, farm_codes: list[str], stream: str = "plate", taken: frozenset[str] = frozenset()
) -> list[str]:
    """Plat unik dan deterministik per seed, dari stream acak terpisah agar data lain tidak bergeser."""
    rng = random.Random(f"{stream}:{seed}")
    seen: set[str] = set(taken)
    out = []
    for farm in farm_codes:
        while True:
            prefix = (
                rng.choice(_OTHER_PLATE) if rng.random() < 0.3 else _REGION_PLATE.get(farm, "N")
            )
            suffix = "".join(rng.choice(_PLATE_LETTERS) for _ in range(rng.choice((2, 2, 3))))
            plate = f"{prefix} {rng.randint(1000, 9999)} {suffix}"
            if plate not in seen:
                seen.add(plate)
                out.append(plate)
                break
    return out


def _ph(res: dict[str, float | bool]) -> float:
    """pH sintetis: turun saat keasaman naik. Stream acak sendiri (turunan nilai lab) agar data lain
    dan seed baseline tidak bergeser."""
    acidity = float(res["acidity_pct"])
    noise = random.Random(f"ph:{res['fat_pct']:.6f}:{acidity:.6f}").gauss(0.0, 0.02)
    return round(6.70 - (acidity - 0.15) * 4.0 + noise, 2)


def _lab_results(rng: random.Random, fail: bool) -> dict[str, float | bool]:
    res: dict[str, float | bool] = {
        "fat_pct": rng.gauss(3.7, 0.25),
        "protein_pct": rng.gauss(3.1, 0.12),
        "acidity_pct": rng.gauss(0.15, 0.007),
        "antibiotic_residue": False,
        "adulterant": False,
    }
    if fail:
        kind = rng.choice(("antibiotic", "fat", "acidity"))
        if kind == "antibiotic":
            res["antibiotic_residue"] = True
        elif kind == "fat":
            res["fat_pct"] = rng.uniform(2.0, 2.9)
        else:
            res["acidity_pct"] = rng.uniform(0.19, 0.25)
    res["ph"] = _ph(res)
    return res


def _surge_trucks(
    seed: int, window: tuple[float, float], n: int, stream: str = "surge"
) -> list[TankerSpec]:
    """Truk dadakan dalam jendela waktu (menit). Stream acak terpisah agar truk lain tidak berubah."""
    rng = random.Random(f"{stream}:{seed}")
    out = []
    for i in range(n):
        farm_code, dist = rng.choice([(c, d) for c, _, d in FARMS])
        at = rng.uniform(*window)
        extended = rng.random() < 0.15 + dist / 800
        median = 80.0 if extended else 45.0
        out.append(
            TankerSpec(
                code=f"SG-{i + 1:03d}",
                farm_code=farm_code,
                volume_ton=round(rng.uniform(20.0, 25.0), 2),
                scheduled_eta_min=at,
                arrival_min=at,
                temp_c=round(rng.gauss(4.0, 0.7), 1),
                docs_ok=True,
                lab_duration_min=min(240.0, max(25.0, rng.lognormvariate(math.log(median), 0.3))),
                lab_results=_lab_results(rng, False),
                farm_distance_km=dist,
                test_type="extended" if extended else "standard",
                sku_code=rng.choices(SKUS, weights=SKU_WEIGHTS)[0].code,
                announced=False,
            )
        )
    return out


SURGE_LEAD_MIN = (10.0, 90.0)  # truk dadakan dari perintah tiba 10-90 menit setelah perintah


def command_trucks(
    seed: int, existing: list[TankerSpec], at: float, n: int, index: int
) -> list[TankerSpec]:
    """Truk dadakan dari perintah pada menit `at`. Kode dan plat melanjutkan hari dasar tanpa
    menggeser truk lain, dan baru terlihat sejak `at`, sehingga riwayat sebelum `at` tetap sama."""
    raw = _surge_trucks(
        seed, (at + SURGE_LEAD_MIN[0], at + SURGE_LEAD_MIN[1]), n, stream=f"cmd-surge:{index}"
    )
    raw.sort(key=lambda s: s.arrival_min)
    plates = _plates(
        seed,
        [s.farm_code for s in raw],
        stream=f"cmd-plate:{index}",
        taken=frozenset(s.plate for s in existing),
    )
    return [
        replace(s, code=f"RT-{len(existing) + i + 1:03d}", plate=plates[i], appears_min=at)
        for i, s in enumerate(raw)
    ]


def generate_day(
    seed: int,
    volume_ton: float = 320.0,
    fail_rate: float = 0.03,
    extra_bad: int = 0,
    surge: tuple[float, float, int] | None = None,
) -> list[TankerSpec]:
    """Satu hari kedatangan truk. `extra_bad` menyisipkan truk di luar batas mutu untuk uji skenario.

    `surge` = (mulai, selesai, jumlah): truk tambahan tanpa jadwal di jendela itu.
    """
    rng = random.Random(seed)
    n = max(1, round(volume_ton / MEAN_TRUCK_TON))
    farm_pool = [(c, d) for c, _, d in FARMS]

    # Kedatangan terkonsentrasi pagi dan sore (jam 04-10 dan 14-18), sisanya tersebar.
    def pick_minute() -> float:
        r = rng.random()
        if r < 0.55:
            return rng.uniform(4 * 60, 10 * 60)
        if r < 0.85:
            return rng.uniform(14 * 60, 18 * 60)
        return rng.uniform(0, 24 * 60)

    bad_idx = set(rng.sample(range(n), min(extra_bad, n)))
    specs = []
    for i in range(n):
        farm_code, dist = rng.choice(farm_pool)
        scheduled = (pick_minute() - DAY_START_HOUR * 60) % 1440
        # Keterlambatan: lognormal, makin jauh makin berpeluang telat, kadang tiba lebih awal.
        # Jam sibuk menambah keterlambatan.
        delay = rng.lognormvariate(math.log(8 + dist / 15), 0.8) - 8
        if is_rush(scheduled):
            delay = delay * 1.6 + 12
        temp = rng.gauss(4.0, 0.7)
        docs_ok = rng.random() > 0.01
        fail = rng.random() < fail_rate
        if i in bad_idx:
            temp, fail = rng.uniform(7.0, 10.0), True
        # Durasi uji bergantung tipe uji dan serah terima shift, dengan ekor panjang (25-240 menit).
        extended = rng.random() < 0.15 + dist / 800
        median = 80.0 if extended else 45.0
        if is_shift_change(scheduled):
            median += 15.0
        lab = min(240.0, max(25.0, rng.lognormvariate(math.log(median), 0.3)))
        sku = rng.choices(SKUS, weights=SKU_WEIGHTS)[0]
        specs.append(
            TankerSpec(
                code=f"RT-{i + 1:03d}",
                farm_code=farm_code,
                volume_ton=round(rng.uniform(20.0, 25.0), 2),
                scheduled_eta_min=scheduled,
                arrival_min=max(0.0, scheduled + delay),
                temp_c=round(temp, 1),
                docs_ok=docs_ok,
                lab_duration_min=lab,
                lab_results=_lab_results(rng, fail),
                farm_distance_km=dist,
                test_type="extended" if extended else "standard",
                sku_code=sku.code,
            )
        )
    if surge:
        specs += _surge_trucks(seed, (surge[0], surge[1]), surge[2])
    ordered = sorted(specs, key=lambda s: s.arrival_min)
    plates = _plates(seed, [s.farm_code for s in ordered])
    return [replace(s, code=f"RT-{i + 1:03d}", plate=plates[i]) for i, s in enumerate(ordered)]
