"""Konfigurasi pabrik dan ambang mutu (PRD 9.1-9.3). Semua nilai DEMO dan dapat dikoreksi mitra."""

from dataclasses import dataclass, field, replace


@dataclass(frozen=True)
class Thresholds:
    max_arrival_temp_c: float = 6.0
    fat_min_pct: float = 3.0
    protein_min_pct: float = 2.8
    acidity_range_pct: tuple[float, float] = (0.12, 0.18)
    ph_range: tuple[float, float] = (6.55, 6.85)  # demo; pH susu segar sekitar 6,6-6,8
    holding_max_min: float = 240.0
    steril_min_temp_c: float = 137.0
    steril_min_hold_s: float = 4.0


@dataclass(frozen=True)
class Sku:
    code: str
    size_ml: int
    flavor: str
    paper: str = "regular"


SKUS = (
    Sku("UHT-FULL-1000", 1000, "full_cream"),
    Sku("UHT-LOW-1000", 1000, "low_fat"),
    Sku("UHT-FULL-200", 200, "full_cream"),
    Sku("UHT-CHOC-200", 200, "chocolate"),
)


def needs_flavour_cip(prev: Sku | None, curr: Sku) -> bool:
    """Brief SOP: transisi dari varian rasa (cokelat/stroberi) ke putih (full cream/low fat) memicu CIP."""
    if prev is None or prev.code == curr.code:
        return False
    return prev.flavor in ("chocolate", "strawberry") and curr.flavor in ("full_cream", "low_fat")


def changeover_minutes(
    a: Sku,
    b: Sku,
    size_min: float = 40.0,
    flavor_min: float = 30.0,
    paper_min: float = 20.0,
) -> float:
    """Changeover bergantung urutan SKU: beda ukuran, rasa, atau paper.
    Sesuai brief SOP: pergantian paper tidak ditambahkan saat terjadi pergantian ukuran (size)."""
    if a.code == b.code:
        return 0.0
    size_diff = a.size_ml != b.size_ml
    flavor_diff = a.flavor != b.flavor
    paper_diff = a.paper != b.paper
    return (
        (size_min if size_diff else 0.0)
        + (flavor_min if flavor_diff else 0.0)
        + (paper_min if (paper_diff and not size_diff) else 0.0)
    )


@dataclass(frozen=True)
class Maintenance:
    """Jendela maintenance terjadwal: aset tidak tersedia sejak start_min selama duration_min."""

    asset: str  # kode sterilizer, mis. STE-2
    start_min: float
    duration_min: float


@dataclass(frozen=True)
class PlantConfig:
    n_bays: int = 3
    bay_flow_tph: float = 40.0
    n_analysts: int = 2
    n_degassing: int = 2
    degassing_tph: float = 60.0
    n_raw_tanks: int = 15
    raw_tank_cap_ton: float = 30.0  # satu truk (20-25 t) per tangki
    n_thermal: int = 2
    thermal_tph: float = 40.0
    n_separators: int = 2
    separator_tph: float = 40.0
    n_storage_tanks: int = 6
    storage_tank_cap_ton: float = 60.0
    # Satu sterilizer terpasang ke satu aseptic tank, yang melayani dua filling line.
    n_sterilizers: int = 5
    sterilizer_tph: float = 20.0
    lines_per_aseptic: int = 2
    filling_tph: float = 10.0
    cip_minutes: tuple[float, float] = (60.0, 90.0)
    changeover_size_min: float = 40.0  # beda ukuran kemasan
    changeover_flavor_min: float = 30.0  # beda rasa
    slot_tolerance_min: float = 30.0  # toleransi kepatuhan jadwal (KPI)
    aseptic_cap_ton: float = 50.0  # kapasitas tiap aseptic tank (nilai demo)
    maintenance: tuple[Maintenance, ...] = ()
    sku_policy: str = "free"  # izin SKU per line, lihat app/routing.py
    opening_stock_ton: float = (
        0.0  # stok awal tangki (demo); hanya dicatat di neraca, tidak diproses
    )
    milk_use_full_pct: float = 100.0  # susu per ton produk full cream/low fat (demo)
    milk_use_flavour_pct: float = 90.0  # susu per ton produk rasa (demo)
    orders: tuple[tuple[str, float], ...] = ()  # (kode SKU, ton produk jadi); kosong = otomatis
    fouling_max_min: float = 300.0  # menit sterilisasi sejak CIP terakhir sebelum fouling (demo)
    shelf_life_days: float = 180.0  # umur simpan produk UHT, semua SKU (demo)
    dispatch_lead_days: float = 30.0  # hari dari pengisian sampai tiba di pelanggan (demo)
    thresholds: Thresholds = field(default_factory=Thresholds)


# Jumlah modul yang boleh diubah dari luar (mode membangun): (min, maks) per jenis. Maks mengikuti model 3D pabrik
# (3 bay, 15 tangki mentah, 6 SFP, 5 aseptic/sterilizer); jenis lain tidak digambar.
MODULE_LIMITS: dict[str, tuple[int, int]] = {
    "n_bays": (1, 3),
    "n_analysts": (1, 8),
    "n_raw_tanks": (1, 15),
    "n_degassing": (1, 8),
    "n_thermal": (1, 8),
    "n_separators": (1, 8),
    "n_storage_tanks": (1, 6),
    "n_sterilizers": (1, 5),
}
MODULE_FIELDS = tuple(MODULE_LIMITS)


def plant_with(**counts: int | None) -> PlantConfig:
    """PlantConfig bawaan dengan jumlah modul yang diganti; nilai None dilewati."""
    unknown = set(counts) - set(MODULE_FIELDS)
    if unknown:
        raise ValueError(f"modul tidak dikenal: {sorted(unknown)}")
    for name, n in counts.items():
        lo, hi = MODULE_LIMITS[name]
        if n is not None and not lo <= n <= hi:
            raise ValueError(f"{name} harus {lo}-{hi}, bukan {n}")
    return replace(PlantConfig(), **{k: v for k, v in counts.items() if v is not None})


# Parameter operasional yang boleh diubah per run (nilai DEMO, bukan SOP). Batas dipakai API dan web.
PARAM_LIMITS: dict[str, tuple[float, float]] = {
    "bay_flow_tph": (10, 80),
    "degassing_tph": (20, 120),
    "thermal_tph": (10, 80),
    "separator_tph": (10, 80),
    "sterilizer_tph": (5, 40),
    "filling_tph": (4, 20),
    "cip_min_minutes": (30, 120),
    "cip_max_minutes": (30, 180),
    "holding_max_min": (60, 480),
    "changeover_size_min": (0, 120),
    "changeover_flavor_min": (0, 120),
    "slot_tolerance_min": (5, 120),
    "milk_use_full_pct": (50, 100),
    "milk_use_flavour_pct": (50, 100),
    "opening_stock_ton": (0, 500),
    "fouling_max_min": (60, 720),
    "shelf_life_days": (30, 365),
    "dispatch_lead_days": (0, 90),
}
MAINTENANCE_MAX = 6
ORDERS_MAX = 6
ORDER_TON = (1.0, 500.0)


def with_params(
    cfg: PlantConfig,
    maintenance: tuple[Maintenance, ...] = (),
    sku_policy: str | None = None,
    orders: tuple[tuple[str, float], ...] = (),
    **p: float | None,
) -> PlantConfig:
    """Terapkan parameter operasional di atas cfg; nilai None dilewati."""
    p = {k: v for k, v in p.items() if v is not None}
    unknown = set(p) - set(PARAM_LIMITS)
    if unknown:
        raise ValueError(f"parameter tidak dikenal: {sorted(unknown)}")
    for k, v in p.items():
        lo, hi = PARAM_LIMITS[k]
        if not lo <= v <= hi:
            raise ValueError(f"{k} harus {lo}-{hi}, bukan {v}")
    cip_lo = p.pop("cip_min_minutes", cfg.cip_minutes[0])
    cip_hi = p.pop("cip_max_minutes", cfg.cip_minutes[1])
    if cip_lo > cip_hi:
        raise ValueError("cip_min_minutes tidak boleh melebihi cip_max_minutes")
    over: dict = {
        "cip_minutes": (float(cip_lo), float(cip_hi)),
        "maintenance": maintenance or cfg.maintenance,
    }
    if sku_policy is not None:
        if sku_policy not in ("free", "dedicated"):
            raise ValueError(f"sku_policy harus free atau dedicated, bukan {sku_policy!r}")
        over["sku_policy"] = sku_policy
    if orders:
        valid = {s.code for s in SKUS}
        if len(orders) > ORDERS_MAX:
            raise ValueError(f"order maksimal {ORDERS_MAX}")
        for code, ton in orders:
            if code not in valid:
                raise ValueError(f"SKU order tidak dikenal: {code!r}")
            if not ORDER_TON[0] <= ton <= ORDER_TON[1]:
                raise ValueError(f"ton order harus {ORDER_TON[0]:g}-{ORDER_TON[1]:g}, bukan {ton}")
        over["orders"] = tuple((c, float(t)) for c, t in orders)
    if "holding_max_min" in p:
        over["thresholds"] = replace(
            cfg.thresholds, holding_max_min=float(p.pop("holding_max_min"))
        )
    over.update({k: float(v) for k, v in p.items()})
    return replace(cfg, **over)
