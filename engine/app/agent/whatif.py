"""What-if maintenance tangki untuk hari kampanye yang sedang disusun, plus validator aturan keras
(P3). Validator ini terpisah dari LLM: usulan yang melanggar aturan tidak pernah dibuat, dan Laravel
memeriksa ulang saat persetujuan."""

import hashlib
import json
import re
import threading
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.api import PlantRequest
from app.commands import Command
from app.contracts.result import RunResult
from app.experiment import simulate
from app.kpi import build_result
from app.plant import PlantConfig
from app.scenarios import SCENARIO_KEYS, get_scenario

DAY_MIN = 1440
MIN_DURATION, MAX_DURATION = 15.0, 720.0  # sama dengan CommandIn.duration_min dan config/twin.php
WHATIF_TIME_LIMIT = (
    1.0  # detik CP-SAT per jadwal; what-if harus cukup cepat untuk satu langkah agen
)
STORE_SIZE = 100


class MaintenanceEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    asset: str = Field(pattern=r"^TK-(RAW|STO)-\d{1,2}$")
    minute: float = Field(ge=0, lt=DAY_MIN)
    duration_min: float = Field(ge=MIN_DURATION, le=MAX_DURATION)


class OpenChange(BaseModel):
    model_config = ConfigDict(extra="forbid")

    baseline: float
    candidate: float
    change: float
    better: bool


class OpenProposal(BaseModel):
    """Draf atau usulan yang menunggu keputusan milik pengguna ini pada hari yang sedang disusun.
    Dibangun Laravel dari database; dipakai untuk menjawab tanggapan dan sebagai satu-satunya id
    yang boleh direvisi."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
    version: int = Field(ge=1, le=99)
    status: Literal["draft", "pending"]
    window: MaintenanceEntry
    changes: dict[str, OpenChange] = Field(default_factory=dict, max_length=16)

    @field_validator("changes")
    @classmethod
    def _metric_keys(cls, v: dict[str, OpenChange]) -> dict[str, OpenChange]:
        if any(not re.fullmatch(r"[a-z0-9_]{1,40}", k) for k in v):
            raise ValueError("nama metrik tidak valid")
        return v


class CampaignContext(BaseModel):
    """Keadaan hari kampanye yang sedang disusun. Dibangun Laravel dari database; Engine tidak
    menerimanya dari klien browser."""

    model_config = ConfigDict(extra="forbid")

    campaign_id: int = Field(ge=1)
    day_no: int = Field(ge=1)
    editable: bool
    seed: int = Field(ge=0, le=2147483647)
    config: Literal["A", "B", "C", "D"]
    scenario: str = Field(pattern="^(" + "|".join(SCENARIO_KEYS) + ")$")
    volume_ton: float = Field(ge=50, le=600)
    extra_bad: int = Field(ge=0, le=10)
    plant: PlantRequest | None = None
    existing: list[MaintenanceEntry] = Field(default_factory=list, max_length=20)
    planned_count: int = Field(ge=0, le=20)  # yang diputuskan manusia hari ini (tanpa carry-in)
    max_planned: int = Field(ge=1, le=20)
    open_proposals: list[OpenProposal] = Field(default_factory=list, max_length=10)

    def plant_config(self) -> PlantConfig:
        return self.plant.to_config() if self.plant else PlantConfig()

    def tank_counts(self) -> dict[str, int]:
        cfg = self.plant_config()
        return {"TK-RAW": cfg.n_raw_tanks, "TK-STO": cfg.n_storage_tanks}

    def tank_ids(self) -> set[str]:
        return {f"{kind}-{i}" for kind, n in self.tank_counts().items() for i in range(1, n + 1)}

    def key(self) -> str:
        # Usulan terbuka tidak memengaruhi simulasi, jadi tidak boleh membatalkan cache what-if.
        payload = self.model_dump_json(exclude={"open_proposals"})
        return hashlib.sha256(payload.encode()).hexdigest()[:16]


@dataclass(frozen=True)
class Finding:
    code: str
    message: str
    blocking: bool = True

    def as_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "blocking": self.blocking}


def check_window(ctx: CampaignContext, asset: str, minute: float, duration: float) -> list[Finding]:
    """Aturan keras yang bisa diperiksa tanpa simulasi."""
    out: list[Finding] = []
    if not ctx.editable:
        out.append(Finding("day_not_editable", "Hari ini sedang berjalan atau sudah ditutup."))
    if asset not in ctx.tank_ids():
        out.append(Finding("unknown_asset", f"{asset} tidak ada pada pabrik kampanye ini."))
        return out
    if not (0 <= minute < DAY_MIN and MIN_DURATION <= duration <= MAX_DURATION):
        out.append(Finding("window_out_of_range", "Menit mulai atau durasi di luar batas."))
        return out
    if asset in {e.asset for e in ctx.existing}:
        out.append(Finding("already_planned", f"{asset} sudah dijadwalkan maintenance hari ini."))
    if ctx.planned_count >= ctx.max_planned:
        out.append(Finding("limit_reached", "Jumlah maintenance hari ini sudah mencapai batas."))

    kind = asset[:6]
    end = min(minute + duration, DAY_MIN)
    same = [
        (e.minute, min(e.minute + e.duration_min, DAY_MIN))
        for e in ctx.existing
        if e.asset[:6] == kind
    ]
    points = {minute, *(s for s, _ in same if minute <= s < end)}
    for p in sorted(points):
        down = 1 + sum(1 for s, f in same if s <= p < f)
        if down >= ctx.tank_counts()[kind]:
            out.append(
                Finding(
                    "no_tank_available",
                    f"Pada menit {p:g} semua tangki {kind} akan mati; tidak ada tangki tujuan siap.",
                )
            )
            break
    return out


def blocked(findings: list[Finding]) -> bool:
    return any(f.blocking for f in findings)


def simulate_day(ctx: CampaignContext, extra: tuple[MaintenanceEntry, ...] = ()) -> RunResult:
    """Satu hari kampanye dengan seed dan konfigurasi yang sama. D dihitung sebagai C: seleksi
    Monte Carlo dan replan bergulir butuh puluhan detik, terlalu lama untuk satu langkah agen."""
    config = "C" if ctx.config == "D" else ctx.config
    commands = tuple(
        Command(
            minute=e.minute,
            kind="tank_down",
            actor="what-if",
            reason="what-if asisten",
            duration_min=e.duration_min,
            asset=e.asset,
        )
        for e in (*ctx.existing, *extra)
    )
    sim, plan = simulate(
        config,
        ctx.seed,
        ctx.volume_ton,
        ctx.extra_bad,
        run_id=1,
        time_limit=WHATIF_TIME_LIMIT,
        scenario=ctx.scenario,
        cfg=ctx.plant.to_config() if ctx.plant else None,
        commands=commands,
    )
    sim.run()
    volume, extra_bad = get_scenario(ctx.scenario).apply(ctx.volume_ton, ctx.extra_bad)
    return build_result(
        sim,
        {"volume_ton": volume, "extra_bad": extra_bad},
        ctx.seed,
        config=config,
        plan=plan,
        scenario=ctx.scenario,
    )


def digest_json(data: Any) -> str:
    return hashlib.sha256(
        json.dumps(data, sort_keys=True, ensure_ascii=False, default=str).encode()
    ).hexdigest()


@dataclass
class WhatIf:
    id: str
    campaign_id: int
    day_no: int
    ctx_key: str
    window: dict[str, Any]
    config_requested: str
    config_used: str
    baseline: dict[str, Any]
    candidate: dict[str, Any]
    delta: dict[str, Any]
    findings: list[dict[str, Any]]
    blocked: bool
    result_hash: str
    at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())


class WhatIfStore:
    """What-if terakhir di memori Engine; yang tersimpan permanen adalah bukti pada usulan di Laravel."""

    def __init__(self, size: int = STORE_SIZE):
        self.size = size
        self._items: OrderedDict[str, WhatIf] = OrderedDict()
        self._baselines: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._lock = threading.Lock()

    def new_id(self) -> str:
        return f"wi-{uuid.uuid4().hex[:12]}"

    def put(self, item: WhatIf) -> None:
        with self._lock:
            self._items[item.id] = item
            while len(self._items) > self.size:
                self._items.popitem(last=False)

    def get(self, whatif_id: str) -> WhatIf | None:
        with self._lock:
            return self._items.get(whatif_id)

    def baseline(self, key: str, compute) -> dict[str, Any]:
        with self._lock:
            hit = self._baselines.get(key)
        if hit is not None:
            return hit
        value = compute()
        with self._lock:
            self._baselines[key] = value
            while len(self._baselines) > self.size:
                self._baselines.popitem(last=False)
        return value
