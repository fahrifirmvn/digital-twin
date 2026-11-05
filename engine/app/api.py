from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.carry import CarryState
from app.commands import INTERVENTION_KINDS, MAX_COMMANDS, Command, CommandKind
from app.config import settings
from app.contracts.result import RunResult
from app.main_deps import require_internal_token
from app.ml.service import LABEL, get_ai
from app.plant import (
    MAINTENANCE_MAX,
    MODULE_LIMITS,
    ORDER_TON,
    ORDERS_MAX,
    PARAM_LIMITS,
    Maintenance,
    PlantConfig,
    plant_with,
    with_params,
)
from app.predictor import metrics as predictor_metrics
from app.runs import DuplicateRunError, Run, RunManager
from app.scenarios import SCENARIO_KEYS

router = APIRouter(prefix="/v1", dependencies=[Depends(require_internal_token)])


def _module(name: str) -> dict[str, int]:
    lo, hi = MODULE_LIMITS[name]
    return {"ge": lo, "le": hi}


class PlantRequest(BaseModel):
    """Jumlah modul pabrik; yang tidak diisi memakai nilai bawaan. Mengubah pabrik berarti run baru."""

    model_config = ConfigDict(extra="forbid")

    n_bays: int | None = Field(default=None, **_module("n_bays"), description="Bay penerimaan")
    n_analysts: int | None = Field(default=None, **_module("n_analysts"), description="Analis lab")
    n_raw_tanks: int | None = Field(
        default=None, **_module("n_raw_tanks"), description="Tangki susu mentah"
    )
    n_degassing: int | None = Field(default=None, **_module("n_degassing"))
    n_thermal: int | None = Field(default=None, **_module("n_thermal"))
    n_separators: int | None = Field(default=None, **_module("n_separators"))
    n_storage_tanks: int | None = Field(default=None, **_module("n_storage_tanks"))
    n_sterilizers: int | None = Field(default=None, **_module("n_sterilizers"))

    def to_config(self) -> PlantConfig:
        return plant_with(**self.model_dump())


def _param(name: str, description: str) -> float | None:
    lo, hi = PARAM_LIMITS[name]
    return Field(default=None, ge=lo, le=hi, description=description)


class MaintenanceIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    asset: str = Field(pattern=r"^STE-[1-8]$", description="Sterilizer yang dimaintenance")
    start_min: float = Field(ge=0, lt=1440, description="Menit mulai sejak awal hari")
    duration_min: float = Field(ge=15, le=480)


class OrderIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sku: Literal["UHT-FULL-1000", "UHT-LOW-1000", "UHT-FULL-200", "UHT-CHOC-200"]
    ton: float = Field(ge=ORDER_TON[0], le=ORDER_TON[1], description="Ton produk jadi")


class ParamsRequest(BaseModel):
    """Parameter operasional (nilai demo, bukan SOP); yang tidak diisi memakai nilai bawaan."""

    model_config = ConfigDict(extra="forbid")

    bay_flow_tph: float | None = _param("bay_flow_tph", "Aliran bongkar per bay (t/jam)")
    degassing_tph: float | None = _param("degassing_tph", "Aliran degassing (t/jam)")
    thermal_tph: float | None = _param("thermal_tph", "Aliran thermalisasi (t/jam)")
    separator_tph: float | None = _param("separator_tph", "Aliran separator (t/jam)")
    sterilizer_tph: float | None = _param("sterilizer_tph", "Aliran sterilizer (t/jam)")
    filling_tph: float | None = _param("filling_tph", "Aliran filling per line (t/jam)")
    cip_min_minutes: float | None = _param("cip_min_minutes", "Durasi CIP minimum (menit)")
    cip_max_minutes: float | None = _param("cip_max_minutes", "Durasi CIP maksimum (menit)")
    holding_max_min: float | None = _param("holding_max_min", "Holding time maksimum (menit)")
    changeover_size_min: float | None = _param("changeover_size_min", "Changeover beda ukuran")
    changeover_flavor_min: float | None = _param("changeover_flavor_min", "Changeover beda rasa")
    slot_tolerance_min: float | None = _param("slot_tolerance_min", "Toleransi slot (menit)")
    milk_use_full_pct: float | None = _param(
        "milk_use_full_pct", "Susu per ton produk full cream (%)"
    )
    milk_use_flavour_pct: float | None = _param(
        "milk_use_flavour_pct", "Susu per ton produk rasa (%)"
    )
    opening_stock_ton: float | None = _param("opening_stock_ton", "Stok awal tangki (ton)")
    fouling_max_min: float | None = _param(
        "fouling_max_min", "Batas menit sterilisasi sejak CIP terakhir"
    )
    shelf_life_days: float | None = _param("shelf_life_days", "Umur simpan produk (hari)")
    dispatch_lead_days: float | None = _param(
        "dispatch_lead_days", "Hari dari pengisian sampai tiba di pelanggan"
    )
    sku_policy: Literal["free", "dedicated"] | None = Field(
        default=None, description="Izin SKU per line: free (bawaan) atau dedicated (demo)"
    )
    maintenance: list[MaintenanceIn] = Field(default_factory=list, max_length=MAINTENANCE_MAX)
    orders: list[OrderIn] = Field(
        default_factory=list, max_length=ORDERS_MAX, description="Order produksi; kosong = otomatis"
    )

    def apply(self, cfg: PlantConfig) -> PlantConfig:
        values = self.model_dump(exclude={"maintenance", "orders"})
        maint = tuple(Maintenance(m.asset, m.start_min, m.duration_min) for m in self.maintenance)
        orders = tuple((o.sku, o.ton) for o in self.orders)
        return with_params(cfg, maint, orders=orders, **values)


class CommandIn(BaseModel):
    """Perintah mode Simulasi. Argumen yang tidak berlaku untuk jenisnya diabaikan."""

    model_config = ConfigDict(extra="forbid")
    request_id: str | None = None

    minute: float = Field(ge=0, lt=1440, description="Menit sejak awal hari")
    kind: CommandKind
    actor: str = Field(min_length=1, max_length=80, description="Siapa yang memberi perintah")
    reason: str = Field(min_length=3, max_length=300, description="Alasan, dicatat di log")
    count: int | None = Field(default=None, ge=1, le=12, description="Sterilizer mati / truk")
    duration_min: float | None = Field(default=None, ge=15, le=720)
    factor: float | None = Field(default=None, ge=1.2, le=5)
    truck: str | None = Field(default=None, pattern=r"^[A-Z]{2}-\d{3,}$", description="Kode truk")
    bay: str | None = Field(default=None, pattern=r"^BAY-\d{1,2}$")
    start_min: float | None = Field(default=None, ge=0, lt=2880, description="Menit bongkar baru")
    asset: str | None = Field(
        default=None, pattern=r"^TK-(RAW|STO)-\d{1,2}$", description="Tangki yang di-maintenance"
    )

    @model_validator(mode="after")
    def _intervention_args(self) -> "CommandIn":
        if self.kind == "tank_down" and not self.asset:
            raise ValueError("tank_down wajib menyebut tangki")
        if self.kind in INTERVENTION_KINDS and not self.truck:
            raise ValueError(f"{self.kind} wajib menyebut truk")
        if self.kind == "plan_change" and self.bay is None and self.start_min is None:
            raise ValueError("plan_change wajib mengubah bay atau menit mulai")
        return self

    def to_command(self) -> Command:
        return Command(**self.model_dump())


class RunRequest(BaseModel):
    live: bool = False
    run_id: int = Field(ge=1, description="Dialokasikan Laravel (sim_runs.id)")
    seed: int = 1
    volume_ton: float = Field(default=320.0, ge=50, le=1000)
    extra_bad: int = Field(default=0, ge=0, le=10)
    config: Literal["A", "B", "C", "D"] = Field(
        default="A",
        description="A=FIFO, B=CP-SAT rata-rata, C=CP-SAT P80, D=C + seleksi Monte Carlo + replan bergulir",
    )
    scenario: str = Field(
        default="normal",
        pattern="^(" + "|".join(SCENARIO_KEYS) + ")$",
        description="Skenario uji PRD 10.7",
    )
    speed: float | None = Field(default=None, gt=0, le=600, description="Menit simulasi per detik")
    plant: PlantRequest | None = Field(
        default=None, description="Jumlah modul; kosong = pabrik bawaan"
    )
    params: ParamsRequest | None = Field(
        default=None, description="Parameter operasional; kosong = nilai bawaan"
    )
    commands: list[CommandIn] = Field(
        default_factory=list,
        max_length=MAX_COMMANDS,
        description="Perintah mode Simulasi; kosong = hari dasar",
    )
    day: int | None = Field(
        default=None, ge=1, le=3650, description="Nomor hari operasi; kosong = run tunggal"
    )
    date: str | None = Field(
        default=None, pattern=r"^\d{4}-\d{2}-\d{2}$", description="Tanggal hari operasi, YYYY-MM-DD"
    )
    carry: CarryState | None = Field(
        default=None, description="Keadaan akhir hari sebelumnya (hanya bersama `day`)"
    )

    @model_validator(mode="after")
    def _params_fit_plant(self) -> "RunRequest":
        if self.params is None:
            return self
        cfg = self.plant.to_config() if self.plant else PlantConfig()
        self.params.apply(cfg)
        too_big = [m.asset for m in self.params.maintenance if int(m.asset[4:]) > cfg.n_sterilizers]
        if too_big:
            raise ValueError(f"maintenance untuk sterilizer yang tidak ada: {too_big}")
        return self

    def to_plant(self) -> PlantConfig | None:
        cfg = self.plant.to_config() if self.plant else None
        if self.params:
            cfg = self.params.apply(cfg or PlantConfig())
        return cfg


class RunInfo(BaseModel):
    run_id: int
    status: str
    last_seq: int
    error: str | None = None


def manager(request: Request) -> RunManager:
    return request.app.state.runs


def _info(run: Run) -> RunInfo:
    events = run.sim.events if run.sim else []
    return RunInfo(run_id=run.id, status=run.status, last_seq=len(events) - 1, error=run.error)


def _get(runs: RunManager, run_id: int) -> Run:
    run = runs.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="run not found")
    return run


@router.post("/runs", status_code=201)
def start_run(body: RunRequest, runs: Annotated[RunManager, Depends(manager)]) -> RunInfo:
    try:
        run = runs.start(
            body.run_id,
            body.seed,
            body.volume_ton,
            body.extra_bad,
            body.speed,
            body.config,
            body.scenario,
            body.to_plant(),
            tuple(c.to_command() for c in body.commands),
            body.day,
            body.carry,
            body.date,
            body.live,
        )
    except DuplicateRunError as exc:
        raise HTTPException(status_code=409, detail="run_id sudah dipakai") from exc
    return _info(run)


class LiveMaintenanceIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str = Field(pattern=r"^[a-fA-F0-9-]{36}$")
    asset: str = Field(pattern=r"^TK-(RAW|STO)-\d{1,2}$")
    start_min: float | None = Field(default=None, ge=0, lt=1440)
    duration_min: float = Field(ge=15, le=720)
    actor: str = Field(min_length=1, max_length=80)
    reason: str = Field(min_length=5, max_length=200)


class LiveSpeedIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    speed: Literal[1, 5, 20, 60]


class QaResultsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ph: float = Field(ge=0, le=14, allow_inf_nan=False, strict=True)


class LiveQaIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str = Field(pattern=r"^[0-9a-fA-F-]{36}$")
    truck: str = Field(pattern=r"^[A-Z]{2}-\d{3,}$")
    action: Literal["retest", "release", "reject"]
    actor: str = Field(min_length=1, max_length=80)
    reason: str = Field(min_length=5, max_length=200)
    results: QaResultsIn | None = None
    disposition: Literal["return_supplier", "controlled_disposal"] | None = None

    @model_validator(mode="after")
    def require_details(self) -> "LiveQaIn":
        if self.action == "retest" and self.results is None:
            raise ValueError("Uji konfirmasi membutuhkan hasil lengkap.")
        if self.action == "reject" and self.disposition is None:
            raise ValueError("Penolakan membutuhkan disposisi.")
        if self.action != "retest" and self.results is not None:
            raise ValueError("Hasil hanya untuk uji konfirmasi.")
        return self


def _control(runs: RunManager, run_id: int, action: str, payload: dict) -> dict:
    try:
        return runs.control(_get(runs, run_id), action, payload)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/runs/{run_id}/maintenance")
def live_maintenance(
    run_id: int, body: LiveMaintenanceIn, runs: Annotated[RunManager, Depends(manager)]
) -> dict:
    return _control(runs, run_id, "maintenance", body.model_dump())


@router.post("/runs/{run_id}/speed")
def live_speed(
    run_id: int, body: LiveSpeedIn, runs: Annotated[RunManager, Depends(manager)]
) -> dict:
    return _control(runs, run_id, "speed", body.model_dump())


@router.post("/runs/{run_id}/qa")
def live_qa(run_id: int, body: LiveQaIn, runs: Annotated[RunManager, Depends(manager)]) -> dict:
    return _control(runs, run_id, "qa", body.model_dump())


@router.get("/runs/{run_id}/live")
def live_state(
    run_id: int,
    runs: Annotated[RunManager, Depends(manager)],
    after: int = Query(default=-1, ge=-1),
) -> dict:
    try:
        return runs.snapshot(_get(runs, run_id), after)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/predictor/metrics")
def get_predictor_metrics() -> dict:
    """Akurasi prediktor kuantil pada hari holdout (pinball, coverage) dibanding baseline."""
    return predictor_metrics()


@router.get("/predictor/models")
def get_predictor_models() -> dict:
    """Kartu model AI (metrik latih, hash data) dan prediktor aktif. Semua data SINTETIS."""
    ai = get_ai()
    return {
        "label": LABEL,
        "active": settings.predictor if ai else "builtin",
        "available": ai is not None,
        "models": ai.cards() if ai else [],
    }


@router.get("/runs/{run_id}")
def get_run(run_id: int, runs: Annotated[RunManager, Depends(manager)]) -> RunInfo:
    return _info(_get(runs, run_id))


@router.get("/runs/{run_id}/result")
def get_result(run_id: int, runs: Annotated[RunManager, Depends(manager)]) -> RunResult:
    run = _get(runs, run_id)
    if run.result is None:
        raise HTTPException(status_code=409, detail="run belum selesai")
    return run.result


@router.get("/runs/{run_id}/events")
def get_events(
    run_id: int,
    runs: Annotated[RunManager, Depends(manager)],
    after: int = Query(default=-1, ge=-1),
    limit: int = Query(default=500, ge=1, le=2000),
) -> dict:
    """Ambil ulang event (seq > after), untuk klien yang terlambat bergabung atau kehilangan siaran."""
    run = _get(runs, run_id)
    events = run.sim.events if run.sim else []
    return {"events": [e.model_dump(mode="json") for e in events[after + 1 : after + 1 + limit]]}
