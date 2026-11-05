"""Kontrak event twin (sumber tunggal). JSON Schema diekspor ke contracts/twin-event.schema.json."""

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TankerStatus(StrEnum):
    ON_THE_WAY = "on_the_way"
    QUEUED = "queued"
    SAMPLING = "sampling"
    LAB_TEST = "lab_test"
    QA_HOLD = "qa_hold"
    RELEASED = "released"
    REJECTED = "rejected"
    UNLOADING = "unloading"
    STORED = "stored"


class AssetStatus(StrEnum):
    IDLE = "idle"
    IN_USE = "in_use"
    FILLING = "filling"
    HOLDING = "holding"
    CIP = "cip"
    UNAVAILABLE = "unavailable"


class GateId(StrEnum):
    G1 = "G1"
    G2 = "G2"
    G3 = "G3"
    G4 = "G4"
    G5 = "G5"
    G6 = "G6"


class SimClock(Strict):
    type: Literal["sim.clock"] = "sim.clock"
    speed: float = Field(ge=0, description="Menit simulasi per detik nyata, 0 = secepat mungkin")
    paused: bool


class TruckDispatched(Strict):
    """Truk memasuki jendela pendekatan menuju gerbang (masih di luar pabrik, tampil di Maps)."""

    type: Literal["truck.dispatched"] = "truck.dispatched"
    tanker_code: str
    farm_code: str
    plate: str
    route: int = Field(ge=0, description="Indeks rute pendekatan menuju gerbang")
    eta: datetime = Field(description="Perkiraan tiba di gerbang (UTC)")
    window_min: float = Field(gt=0, description="Lama pendekatan dari awal jendela sampai tiba")


class TruckArrived(Strict):
    type: Literal["truck.arrived"] = "truck.arrived"
    tanker_code: str
    farm_code: str
    volume_ton: float = Field(gt=0)
    temp_c: float
    plate: str | None = Field(default=None, description="Plat nomor; kosong pada run lama")


class TankerStatusChanged(Strict):
    type: Literal["tanker.status_changed"] = "tanker.status_changed"
    tanker_code: str
    status: TankerStatus
    bay_code: str | None = None


class UnloadFinished(Strict):
    type: Literal["unload.finished"] = "unload.finished"
    tanker_code: str
    bay_code: str
    tank_code: str
    batch_code: str
    volume_ton: float = Field(gt=0)


class TransferCompleted(Strict):
    type: Literal["transfer.completed"] = "transfer.completed"
    from_asset: str
    to_asset: str
    batch_code: str
    volume_ton: float = Field(gt=0)


class AssetStatusChanged(Strict):
    type: Literal["asset.status_changed"] = "asset.status_changed"
    asset_code: str
    status: AssetStatus
    level_ton: float | None = Field(default=None, ge=0, description="Hanya untuk tangki")
    capacity_ton: float | None = Field(
        default=None,
        gt=0,
        description="Kapasitas tangki, agar persen isi dihitung dari angka yang sama",
    )


class AssetLevel(Strict):
    """Isi aseptic tank: level, lot yang sedang ditahan, sejak kapan, dan kapan pengisian dimulai."""

    type: Literal["asset.level"] = "asset.level"
    asset_code: str
    level_ton: float = Field(ge=0)
    capacity_ton: float = Field(gt=0)
    lot: str | None = Field(default=None, description="Batch tertua yang masih ada di tangki")
    since: datetime | None = Field(default=None, description="Saat lot tertua masuk tangki (UTC)")
    fill_start: datetime | None = Field(
        default=None, description="Saat line mulai mengisi dari lot ini (UTC)"
    )
    hold_max_min: float = Field(gt=0, description="Batas holding time (menit)")
    low: bool = Field(description="Isi hampir habis saat line masih mengisi")


class RouteBlock(Strict):
    sku: str
    reason: str


class PlantRoute(Strict):
    sterilizer: str
    aseptic: str
    line: str
    usable: bool
    reason: str | None = Field(
        default=None, description="Alasan line tidak dapat dipakai sama sekali"
    )
    allowed: list[str] = Field(description="Kode SKU yang boleh diisi di line ini")
    blocked: list[RouteBlock] = Field(description="SKU yang ditolak di line ini, beserta alasan")


class PlantRoutes(Strict):
    """Peta rute sterilizer -> aseptic -> line dan izin SKU; dikirim sekali di awal run."""

    type: Literal["plant.routes"] = "plant.routes"
    policy: str
    skus: list[str]
    routes: list[PlantRoute]


class OrderCause(Strict):
    code: Literal["gate", "qa", "unfinished", "supply"]
    label: str
    milk_ton: float


class OrderResult(Strict):
    order: str
    sku: str
    ordered_ton: float
    milk_needed_ton: float
    milk_used_ton: float
    fulfilled_ton: float
    shortfall_ton: float
    feasible: bool
    causes: list[OrderCause]


class OrdersEvaluated(Strict):
    """Order produksi dan kelayakannya, dikirim sekali di akhir hari (P9/Q4)."""

    type: Literal["orders.evaluated"] = "orders.evaluated"
    source: Literal["manual", "planned"]
    milk_use_full_pct: float
    milk_use_flavour_pct: float
    orders: list[OrderResult]


class VolumeBalance(Strict):
    """Neraca volume akhir hari dalam ton (P9/Q5): masuk = stok awal + diterima; keluar = FG + susut + QA + sisa."""

    type: Literal["volume.balance"] = "volume.balance"
    opening_stock_ton: float
    received_ton: float
    fg_ton: float
    loss_ton: float
    qa_hold_ton: float
    tank_end_ton: float
    in_process_ton: float
    not_received_ton: float


class SterilizerFouling(Strict):
    asset_code: str
    run_min: float = Field(description="Menit sterilisasi sejak CIP terakhir, akhir hari")
    peak_min: float = Field(description="Terpanjang sejak CIP selama hari itu")
    cip_count: int
    state: Literal["ok", "near", "over"]
    reached_at: datetime | None = Field(default=None, description="Saat batas fouling tercapai")


class FoulingReport(Strict):
    limit_min: float
    sterilizers: list[SterilizerFouling]


class SkuExpiry(Strict):
    sku: str
    lots: int
    volume_ton: float
    produced_on: str = Field(description="Tanggal isi pertama, YYYY-MM-DD")
    expires_on: str = Field(description="Tanggal kedaluwarsa lot pertama, YYYY-MM-DD")
    remaining_pct: float = Field(description="Sisa umur simpan saat tiba di pelanggan")
    state: Literal["ok", "short"]


class ExpiryReport(Strict):
    shelf_life_days: float
    dispatch_lead_days: float
    min_remaining_pct: float
    skus: list[SkuExpiry]


class FoulingExpiry(Strict):
    """Fouling sterilizer dan umur simpan produk, dikirim sekali di akhir hari (P9/Q6)."""

    type: Literal["fouling.expiry"] = "fouling.expiry"
    fouling: FoulingReport
    expiry: ExpiryReport


class LineChangeover(Strict):
    """Filling line berganti SKU: tidak mengisi selama `minutes`."""

    type: Literal["line.changeover"] = "line.changeover"
    asset_code: str
    from_sku: str
    to_sku: str
    minutes: float = Field(gt=0)


class CipEvent(Strict):
    type: Literal["cip.started", "cip.finished"]
    asset_code: str
    is_scheduled: bool


class LabResult(Strict):
    """Hasil uji lab satu truk, dikirim begitu uji selesai (sebelum keputusan G2)."""

    type: Literal["lab.result"] = "lab.result"
    tanker_code: str
    analyst: str
    started_min: float = Field(description="Menit simulasi uji dimulai")
    duration_min: float = Field(gt=0)
    # Kolom legacy hanya untuk membaca snapshot lama; uji baru hanya menghasilkan pH.
    fat_pct: float | None = None
    protein_pct: float | None = None
    acidity_pct: float | None = None
    ph: float | None = Field(default=None, description="Kosong bila hasil tidak memuat pH")
    antibiotic_residue: bool | None = None
    adulterant: bool | None = None
    test_type: str
    g2: Literal["pass", "hold"]
    g2_reason: str | None = None


class GateDecided(Strict):
    type: Literal["gate.decided"] = "gate.decided"
    gate: GateId
    object_type: str
    object_id: str
    decision: Literal["pass", "hold"]
    reason: str | None = None
    decided_by: str


class QaFailure(Strict):
    parameter: str
    value: float | bool | None = None
    minimum: float | None = None
    maximum: float | None = None
    reason: str


class QaReview(Strict):
    type: Literal["qa.review"] = "qa.review"
    tanker_code: str
    status: Literal["held", "testing", "confirmed", "released", "rejected"]
    reason: str
    actor: str
    request_id: str | None = None
    results: dict[str, float | bool | None] | None = None
    failures: list[QaFailure]
    category: Literal["incomplete", "quality", "hazard", "pass"]
    disposition: Literal["return_supplier", "controlled_disposal", "unresolved_hold"] | None = None
    expires_min: float


class ScheduleReplanned(Strict):
    """Rencana disusun ulang saat berjalan (re-optimization bergulir). Usulan, bukan keputusan."""

    type: Literal["schedule.replanned"] = "schedule.replanned"
    version: int = Field(ge=2)
    trigger: str
    status: str
    objective: float | None = None
    trucks: int = Field(ge=0, description="Jumlah truk yang direncanakan ulang")


class CommandApplied(Strict):
    request_id: str | None = None
    """Perintah pengguna (mode Simulasi) mulai berlaku. Dicatat di aliran event agar replay dan audit
    memuat siapa, kapan, apa, dan alasannya."""

    type: Literal["command.applied"] = "command.applied"
    command_id: int = Field(ge=1, description="Urut per run")
    kind: Literal[
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
    actor: str
    reason: str
    count: int | None = Field(default=None, ge=1, description="Sterilizer mati atau truk dadakan")
    duration_min: float | None = Field(default=None, gt=0)
    factor: float | None = Field(default=None, gt=1, description="Pengali durasi CIP")
    truck: str | None = Field(default=None, description="Intervensi PPIC: kode truk")
    bay: str | None = Field(default=None, description="plan_change: bay pilihan")
    start_min: float | None = Field(default=None, ge=0, description="plan_change: menit bongkar")
    asset: str | None = Field(default=None, description="tank_down: tangki yang di-maintenance")
    blocked: str | None = Field(
        default=None, description="Alasan intervensi ditolak sistem; kosong = berlaku"
    )
    gate: GateId | None = Field(
        default=None, description="Gate SOP yang dicoba dilewati (pelanggaran), bila ada"
    )


class MaintenanceStatus(Strict):
    type: Literal["maintenance.status"] = "maintenance.status"
    request_id: str
    asset: str
    status: Literal["waiting_safe", "maintenance", "completed"]
    duration_min: float = Field(gt=0)


class DayStarted(Strict):
    """Awal hari operasi. Keadaan dari hari sebelumnya sudah terbawa (SKU line, umur fouling, truk tertunda)."""

    type: Literal["day.started"] = "day.started"
    day: int = Field(ge=1)
    date: str = Field(description="Tanggal operasi, YYYY-MM-DD")
    carried_trucks: int = Field(ge=0, description="Truk tertunda dari kemarin")
    stock_ton: float = Field(ge=0, description="Stok barang jadi di awal hari")


class DayIncident(Strict):
    """Kejadian acak hari itu yang mengganggu operasi (mesin atau tangki)."""

    type: Literal["day.incident"] = "day.incident"
    kind: Literal["machine", "tank"]
    asset_code: str
    text: str
    duration_min: float = Field(gt=0)


class DaySummary(Strict):
    """Ringkasan akhir hari: diterima, ditolak, diolah, dirilis, stok, dan masalah."""

    type: Literal["day.summary"] = "day.summary"
    day: int = Field(ge=1)
    date: str
    trucks: int
    late_carried_in: int
    received_ton: float
    rejected_ton: float
    processed_ton: float
    released_ton: float
    qa_hold_ton: float
    stock_ton: float
    overtime_min: float
    issues: list[str]


TwinPayload = Annotated[
    SimClock
    | DayStarted
    | DayIncident
    | DaySummary
    | TruckDispatched
    | TruckArrived
    | TankerStatusChanged
    | UnloadFinished
    | TransferCompleted
    | AssetStatusChanged
    | AssetLevel
    | LineChangeover
    | PlantRoutes
    | OrdersEvaluated
    | VolumeBalance
    | FoulingExpiry
    | CipEvent
    | LabResult
    | QaReview
    | GateDecided
    | ScheduleReplanned
    | CommandApplied
    | MaintenanceStatus,
    Field(discriminator="type"),
]


class TwinEvent(Strict):
    """Amplop yang disiarkan Engine lalu dirilis Laravel ke browser lewat Reverb."""

    event_id: UUID
    run_id: int
    seq: int = Field(ge=0, description="Urut per run, tanpa celah")
    sim_time: datetime = Field(description="Waktu simulasi (UTC)")
    payload: TwinPayload
