"""Perintah simulasi (mode Simulasi). Cabang dari hari dasar dibuat dengan menjalankan ulang seed yang sama
dengan daftar perintah, sehingga riwayat sebelum menit perintah identik dan setiap cabang dapat diaudit."""

from dataclasses import dataclass, replace
from typing import Literal, get_args

from app.generator import TankerSpec, command_trucks
from app.plant import PlantConfig
from app.scenarios import Disturbance

CommandKind = Literal[
    "ster_down",
    "tank_down",
    "cip_delay",
    "truck_surge",
    "plan_approve",
    "plan_change",
    "plan_reject",
    "truck_hold",
    "truck_release",
]
COMMAND_KINDS: tuple[str, ...] = get_args(CommandKind)
# Intervensi PPIC atas usulan jadwal dan truk; tidak mengubah kondisi pabrik, hanya keputusan.
INTERVENTION_KINDS = ("plan_approve", "plan_change", "plan_reject", "truck_hold", "truck_release")

# Nilai bawaan per jenis; batas ada di CommandIn (api.py) dan config/twin.php (Laravel).
DEFAULT_COUNT = {"ster_down": 1, "truck_surge": 4}
DEFAULT_DURATION = {
    "ster_down": 240.0,
    "tank_down": 240.0,
    "cip_delay": 120.0,
    "truck_hold": 60.0,
}
DEFAULT_FACTOR = 2.0
MAX_COMMANDS = 20


@dataclass(frozen=True)
class Command:
    minute: float  # menit sejak awal hari
    kind: str
    actor: str
    reason: str
    count: int | None = None  # ster_down: jumlah sterilizer; truck_surge: jumlah truk
    duration_min: float | None = None  # ster_down, cip_delay
    factor: float | None = None  # cip_delay: pengali durasi CIP
    truck: str | None = None  # intervensi: kode truk
    bay: str | None = None  # plan_change: bay pilihan
    start_min: float | None = None  # plan_change: menit mulai bongkar pilihan
    asset: str | None = None  # tank_down: kode tangki (TK-RAW-n / TK-STO-n)
    request_id: str | None = None

    def normalized(self, cfg: PlantConfig) -> "Command":
        """Isi nilai bawaan, buang argumen yang tidak berlaku, dan batasi pada jumlah aset nyata."""
        if self.kind not in COMMAND_KINDS:
            raise ValueError(f"perintah {self.kind!r} tidak dikenal")
        intervention = self.kind in INTERVENTION_KINDS
        if intervention and not self.truck:
            raise ValueError(f"{self.kind} wajib menyebut truk")
        if self.kind == "plan_change" and self.bay is None and self.start_min is None:
            raise ValueError("plan_change wajib mengubah bay atau menit mulai")
        count = (self.count or DEFAULT_COUNT[self.kind]) if self.kind in DEFAULT_COUNT else None
        if self.kind == "tank_down":
            kind, _, n = (self.asset or "").rpartition("-")
            limit = {"TK-RAW": cfg.n_raw_tanks, "TK-STO": cfg.n_storage_tanks}.get(kind, 0)
            if not n.isdigit() or not 1 <= int(n) <= limit:
                raise ValueError(f"tangki {self.asset!r} tidak ada di pabrik ini")
        if self.kind == "ster_down" and count:
            count = min(count, cfg.n_sterilizers)
        change = self.kind == "plan_change"
        return replace(
            self,
            count=count,
            duration_min=(self.duration_min or DEFAULT_DURATION[self.kind])
            if self.kind in DEFAULT_DURATION
            else None,
            factor=(self.factor or DEFAULT_FACTOR) if self.kind == "cip_delay" else None,
            truck=self.truck if intervention else None,
            bay=self.bay if change else None,
            start_min=self.start_min if change else None,
            asset=self.asset if self.kind == "tank_down" else None,
        )


def expand(
    commands: tuple[Command, ...], cfg: PlantConfig, seed: int, specs: list[TankerSpec]
) -> tuple[tuple[Command, ...], tuple[Disturbance, ...], list[TankerSpec]]:
    """Perintah (urut menit) -> gangguan aset dan truk dadakan tambahan. Truk hari dasar tidak berubah."""
    if len(commands) > MAX_COMMANDS:
        raise ValueError(f"maksimal {MAX_COMMANDS} perintah per run")
    ordered = tuple(sorted((c.normalized(cfg) for c in commands), key=lambda c: c.minute))
    disturbances: list[Disturbance] = []
    extra: list[TankerSpec] = []
    for i, c in enumerate(ordered):
        if c.kind in INTERVENTION_KINDS:
            continue  # dijalankan sim di menitnya; tidak menambah gangguan atau truk
        if c.kind == "ster_down":
            assert c.count and c.duration_min
            disturbances += [
                Disturbance("ster_down", c.minute, c.duration_min, asset=f"STE-{k + 1}")
                for k in range(c.count)
            ]
        elif c.kind == "tank_down":
            assert c.duration_min and c.asset
            disturbances.append(Disturbance("tank_down", c.minute, c.duration_min, asset=c.asset))
        elif c.kind == "cip_delay":
            assert c.duration_min and c.factor
            disturbances.append(Disturbance("cip_delay", c.minute, c.duration_min, factor=c.factor))
        else:
            assert c.count
            extra += command_trucks(seed, specs + extra, c.minute, c.count, i)
    return ordered, tuple(disturbances), extra
