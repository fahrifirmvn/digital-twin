"""Twin Simulator berbasis SimPy (PRD 10.3). Satuan waktu: menit sejak awal hari simulasi.

Cakupan Fase 1: bay -> degassing -> raw buffer -> thermal+separator -> storage -> sterilizer
-> aseptic -> filling. Premix, mixing, dan cream belum dimodelkan. Dispatch FIFO (baseline A).
"""

import random
import uuid
from collections.abc import Callable, Generator
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from typing import Any

import simpy

from app import balance, gates, orders, wear
from app.carry import CarryState, day_date, day_summary
from app.commands import INTERVENTION_KINDS, Command
from app.contracts.events import (
    AssetLevel,
    AssetStatus,
    AssetStatusChanged,
    CipEvent,
    CommandApplied,
    DayIncident,
    DayStarted,
    DaySummary,
    FoulingExpiry,
    GateDecided,
    GateId,
    LabResult,
    LineChangeover,
    OrdersEvaluated,
    PlantRoute,
    PlantRoutes,
    RouteBlock,
    SimClock,
    TankerStatus,
    TankerStatusChanged,
    TransferCompleted,
    TruckArrived,
    TruckDispatched,
    TwinEvent,
    UnloadFinished,
    VolumeBalance,
)
from app.generator import APPROACH_MIN, DAY_START_HOUR, TankerSpec
from app.plan import Plan, TruckPlan
from app.plant import SKUS, PlantConfig, Sku, changeover_minutes
from app.routing import Routing
from app.scenarios import Disturbance

DAY_START = datetime(2026, 10, 28, DAY_START_HOUR, tzinfo=UTC)
QA_HOLD = "QA-HOLD"
PACK_OUT = "PACK-OUT"
YIELD = 0.995  # kehilangan kecil di separator dan filling
FLOW_STEPS = (
    6  # tangki terisi/terkuras bertahap, bukan sekaligus, agar levelnya terlihat naik-turun
)
SKU_BY_CODE = {s.code: s for s in SKUS}


@dataclass
class Transfer:
    from_asset: str
    to_asset: str
    batch: str
    volume_ton: float
    t: float


@dataclass
class Batch:
    code: str
    type: str  # raw, intermediate, fg
    volume_ton: float
    parents: list[str] = field(default_factory=list)
    tanker: str | None = None
    sku: str | None = None
    status: str = "active"  # active, held
    changeover: bool = False


@dataclass
class TankerRecord:
    spec: TankerSpec
    status: TankerStatus = TankerStatus.ON_THE_WAY
    outcome: str = "in_progress"  # completed, held_g1, rejected_g2, held_qa
    arrived: float | None = None
    lab_start: float | None = None
    lab_end: float | None = None
    analyst: str | None = None
    released: float | None = None
    ster_start: float | None = None
    unload_start: float | None = None
    unload_end: float | None = None
    bay: str | None = None
    proc_start: float | None = None
    sterilizer: str | None = None
    line: str | None = None
    fill_start: float | None = None  # saat pengisian benar-benar mulai, setelah changeover
    fill_end: float | None = None


LOW_MIN = 15.0  # aseptic dianggap hampir habis bila isinya cukup untuk kurang dari ini


def aseptic_low(level_ton: float, busy_lines: int, filling_tph: float) -> bool:
    """Isi tangki hanya cukup < LOW_MIN menit bagi line yang sedang mengisi darinya."""
    return busy_lines > 0 and level_ton / (busy_lines * filling_tph) * 60 < LOW_MIN


@dataclass
class Aseptic:
    """Isi satu aseptic tank: lot (kode, ton, menit masuk) menurut urutan masuk."""

    lots: list[list] = field(default_factory=list)  # [kode, ton, menit masuk, menit mulai isi]
    busy: int = 0

    @property
    def level(self) -> float:
        return sum(lot[1] for lot in self.lots)


@dataclass
class GateRecord:
    gate: str
    object_type: str
    object_id: str
    decision: str
    reason: str | None
    t: float


@dataclass
class CipRecord:
    asset: str
    start: float
    end: float
    scheduled: bool = True


@dataclass(frozen=True)
class Downtime:
    asset: str
    start: float
    end: float


@dataclass(frozen=True)
class Override:
    """Keputusan PPIC atas usulan satu truk. Bertahan walau rencana disusun ulang."""

    pin: TruckPlan | None = None  # usulan yang disetujui dan dikunci
    bay: str | None = None
    start: float | None = None  # menit bongkar pilihan; waktu tahap lain ikut bergeser
    reject: bool = False  # usulan ditolak: truk dilayani menurut urutan tiba


@dataclass
class Hold:
    """Truk ditahan di gerbang SOP sejak tiba, paling lama `duration` menit atau sampai dilepas."""

    duration: float
    released: simpy.Event
    done: bool = False


Key = float | Callable[[], float]
Prefer = str | None | Callable[[], str | None]
Allow = Callable[[str], bool] | None


class Pool:
    """Kumpulan aset identik dengan identitas (kode). Tanpa kunci: FIFO. Dengan kunci: pemohon dengan
    kunci terkecil dilayani dulu, dan aset pilihan dipakai bila bebas (tetap work-conserving).
    Kunci/pilihan boleh fungsi yang dievaluasi ulang saat dispatch (rencana bisa berganti)."""

    def __init__(self, env: simpy.Environment, codes: list[str]):
        self.env = env
        self.free = list(codes)
        self.codes = list(codes)
        self._waiting: list[tuple[Key, int, Prefer, str | None, Allow, simpy.Event]] = []
        self._n = 0

    def get(self, key: Key = 0.0, prefer: Prefer = None, allow: Allow = None) -> simpy.Event:
        """`allow` menyaring aset yang boleh melayani pemohon ini (izin rute, P9/Q3)."""
        return self._request(key, prefer, None, allow)

    def take(self, code: str) -> simpy.Event:
        """Ambil aset tertentu (mis. untuk gangguan), didahulukan begitu aset itu bebas."""
        return self._request(-1e9, None, code, None)

    def _request(self, key: Key, prefer: Prefer, only: str | None, allow: Allow) -> simpy.Event:
        ev = self.env.event()
        self._waiting.append((key, self._n, prefer, only, allow, ev))
        self._n += 1
        self._dispatch()
        return ev

    def put(self, code: str) -> None:
        self.free.append(code)
        self._dispatch()

    def _dispatch(self) -> None:
        progressed = True
        while self.free and self._waiting and progressed:
            progressed = False
            self._waiting.sort(key=lambda w: (w[0]() if callable(w[0]) else w[0], w[1]))
            for idx, (_, _, prefer_, only, allow, ev) in enumerate(self._waiting):
                prefer = prefer_() if callable(prefer_) else prefer_
                ok = [c for c in self.free if allow is None or allow(c)]
                if not (only or ok):
                    continue
                code = only or (prefer if prefer in ok else ok[0])
                if code in self.free:
                    del self._waiting[idx]
                    self.free.remove(code)
                    ev.succeed(code)
                    progressed = True
                    break

    def available(self) -> bool:
        return bool(self.free)


@dataclass
class Tank:
    code: str
    capacity_ton: float
    status: str = "idle"  # idle, filling, cip
    level_ton: float = 0.0
    reserved_ton: float = 0.0
    clean: bool = True
    down: bool = False  # maintenance: tidak menerima susu baru
    last_used: float = (
        -1.0
    )  # menit terakhir dipesan; tangki bersih yang paling lama menganggur dipilih dulu


class TankPool:
    """Tangki dengan siklus isi, kosong, CIP. Tangki hanya dipakai ulang setelah CIP (G3)."""

    def __init__(self, sim: "TwinSimulation", prefix: str, n: int, capacity_ton: float):
        self.sim = sim
        self.tanks = [Tank(f"{prefix}-{i + 1}", capacity_ton) for i in range(n)]
        self.changed = sim.env.event()

    def _notify(self) -> None:
        ev, self.changed = self.changed, self.sim.env.event()
        ev.succeed()

    @staticmethod
    def _state(t: Tank) -> gates.TankState:
        return gates.TankState(t.status, t.clean, t.level_ton, t.reserved_ton, t.capacity_ton)

    def reserve(
        self, volume_ton: float, object_type: str, object_id: str
    ) -> Generator[simpy.Event, Any, Tank]:
        waited = False
        while True:
            # Utamakan tangki yang sedang diisi agar tangki lain bisa kosong dan CIP; sisanya bergilir.
            order = sorted(
                (t for t in self.tanks if not t.down),
                key=lambda t: (t.status != "filling", -t.level_ton, t.last_used),
            )
            for t in order:
                result = gates.g3_unload_to_tank(self._state(t), volume_ton)
                if result.passed:
                    t.reserved_ton += volume_ton
                    t.status = "filling"
                    t.last_used = self.sim.env.now
                    self.sim.record_gate(result, object_type, object_id)
                    return t
            if not waited:
                waited = True
                hold = gates.GateResult(
                    gates.GateId.G3, False, "tidak ada tangki kosong dan bersih"
                )
                self.sim.record_gate(hold, object_type, object_id)
            yield self.changed

    def commit(self, t: Tank, volume_ton: float) -> None:
        t.reserved_ton -= volume_ton
        t.level_ton += volume_ton
        self.sim.status(t.code, AssetStatus.FILLING, t.level_ton, t.capacity_ton)

    def remove(self, t: Tank, volume_ton: float, draining: bool = False) -> None:
        t.level_ton = max(0.0, t.level_ton - volume_ton)
        if t.level_ton < 1e-6 and t.reserved_ton < 1e-6:
            t.clean, t.status = False, "cip"
            self.sim.env.process(self._cip(t))
        else:
            status = AssetStatus.IN_USE if draining else AssetStatus.FILLING
            self.sim.status(t.code, status, t.level_ton, t.capacity_ton)

    def filler(self, t: Tank, volume_ton: float) -> Callable[[bool], None]:
        """Langkah pengisian bertahap: tiap panggilan memindahkan 1/FLOW_STEPS dari pesanan ke isi."""
        done = 0.0

        def step(last: bool) -> None:
            nonlocal done
            part = volume_ton - done if last else volume_ton / FLOW_STEPS
            done += part
            self.commit(t, part)

        return step

    def drainer(self, t: Tank, volume_ton: float) -> Callable[[bool], None]:
        """Langkah pengosongan bertahap; setelah langkah terakhir tangki kosong dan masuk CIP."""
        done = 0.0

        def step(last: bool) -> None:
            nonlocal done
            part = volume_ton - done if last else volume_ton / FLOW_STEPS
            done += part
            self.remove(t, part, draining=True)

        return step

    def maintain(
        self, code: str, start: float, duration: float
    ) -> Generator[simpy.Event, Any, None]:
        """Maintenance tangki: sejak `start` tidak menerima susu baru; begitu kosong dan bersih berstatus
        tidak tersedia sampai `start + duration`, lalu dipakai lagi."""
        yield self.sim.env.timeout(start)
        t = next(x for x in self.tanks if x.code == code)
        t.down = True
        while t.status != "idle" or t.level_ton > 1e-6 or t.reserved_ton > 1e-6:
            yield self.changed
        t.status = "maintenance"
        self.sim.status(t.code, AssetStatus.UNAVAILABLE, 0.0, t.capacity_ton)
        yield self.sim.env.timeout(max(0.0, start + duration - self.sim.env.now))
        t.down, t.status = False, "idle"
        self.sim.serviced[code] = self.sim.env.now
        self.sim.status(t.code, AssetStatus.IDLE, 0.0, t.capacity_ton)
        self._notify()

    def _cip(self, t: Tank) -> Generator[simpy.Event, Any, None]:
        start = self.sim.env.now
        self.sim.emit(CipEvent(type="cip.started", asset_code=t.code, is_scheduled=True))
        self.sim.status(t.code, AssetStatus.CIP, 0.0, t.capacity_ton)
        yield self.sim.env.timeout(self.sim.cip_duration())
        t.clean, t.status = True, "idle"
        self.sim.cips.append(CipRecord(t.code, start, self.sim.env.now))
        self.sim.emit(CipEvent(type="cip.finished", asset_code=t.code, is_scheduled=True))
        self.sim.status(t.code, AssetStatus.IDLE, 0.0, t.capacity_ton)
        self._notify()


class TwinSimulation:
    def __init__(
        self,
        specs: list[TankerSpec],
        cfg: PlantConfig | None = None,
        seed: int = 0,
        run_id: int = 1,
        env: simpy.Environment | None = None,
        sink: Callable[[TwinEvent], None] | None = None,
        speed: float = 1.0,
        plan: Plan | None = None,
        disturbances: tuple[Disturbance, ...] = (),
        commands: tuple[Command, ...] = (),
        day: int | None = None,
        date: str | None = None,
        carry: CarryState | None = None,
        deferred: tuple[TankerSpec, ...] = (),
        incident_notes: tuple[tuple[float, str, str, str, float], ...] = (),
    ):
        # `day` mengaktifkan mode operasi harian: tanggal dari nomor hari, keadaan awal dari `carry`.
        self.day = day
        self.carry = carry or CarryState()
        self.deferred = deferred  # truk yang tiba lewat batas hari, dilayani besok
        self.incident_notes = incident_notes
        self.day0 = (
            (datetime.fromisoformat(date) if date else day_date(day)).replace(
                hour=DAY_START_HOUR, tzinfo=UTC
            )
            if day
            else DAY_START
        )
        self.cfg = cfg or PlantConfig()
        self.env = env or simpy.Environment()
        self.plan = plan
        self.disturbances = disturbances
        self.commands = commands
        self.downtimes: list[Downtime] = []
        self.overrides: dict[str, Override] = {}
        self.holds: dict[str, Hold] = {}
        self.replan_signal = self.env.event()
        # Riwayat versi rencana: (waktu berlaku, pemicu, rencana). Dipakai untuk KPI kepatuhan jadwal.
        self.plan_log: list[tuple[float, str, Plan]] = [(0.0, "initial", plan)] if plan else []
        self.rolling = False  # True bila ada timer perencana yang bisa memperpanjang env.now
        self.replans: list[Any] = []  # app.rolling.Replan, diisi Replanner
        self.mc: Any = None  # app.mc.MonteCarlo bila rencana dipilih lewat Monte Carlo
        self._last_t = 0.0
        self.t_end = 0.0
        self.seed = seed
        self.rng = random.Random(seed)
        self.run_id = run_id
        self.sink = sink
        self.speed = speed
        self.specs = specs

        self.events: list[TwinEvent] = []
        self.transfers: list[Transfer] = []
        self.batches: dict[str, Batch] = {}
        self.gate_log: list[GateRecord] = []
        self.cips: list[CipRecord] = []
        self.serviced: dict[str, float] = {}  # tangki yang selesai maintenance -> menit selesainya
        self.changeovers: list[tuple[str, float]] = []
        self.tankers = {s.code: TankerRecord(s) for s in specs}

        c = self.cfg
        self.analysts = Pool(self.env, [f"ANL-{i + 1}" for i in range(c.n_analysts)])
        self.bays = Pool(self.env, [f"BAY-{i + 1}" for i in range(c.n_bays)])
        self.degassing = Pool(self.env, [f"DEG-{i + 1}" for i in range(c.n_degassing)])
        self.thermal = Pool(self.env, [f"THM-{i + 1}" for i in range(c.n_thermal)])
        self.separators = Pool(self.env, [f"SEP-{i + 1}" for i in range(c.n_separators)])
        self.sterilizers = Pool(self.env, [f"STE-{i + 1}" for i in range(c.n_sterilizers)])
        self.raw = TankPool(self, "TK-RAW", c.n_raw_tanks, c.raw_tank_cap_ton)
        self.storage = TankPool(self, "TK-STO", c.n_storage_tanks, c.storage_tank_cap_ton)
        # Rute dan izin SKU per line; line yang melanggar batas aliran tidak masuk pool.
        self.routing = Routing(c, c.sku_policy)
        self.lines = {
            k: Pool(self.env, self.routing.usable_lines(k)) for k in range(1, c.n_sterilizers + 1)
        }
        self.line_sku: dict[str, Sku | None] = {
            code: SKU_BY_CODE.get(self.carry.line_sku.get(code, ""))
            for pool in self.lines.values()
            for code in pool.codes
        }
        self.aseptic_sterile = {k: True for k in self.lines}
        self.aseptic = {k: Aseptic() for k in self.lines}
        self._seq = 0
        self._counters = {"INT": 0, "FG": 0}

    # --- infrastruktur event ---

    def now_dt(self) -> datetime:
        return self.day0 + timedelta(minutes=self.env.now)

    def at(self, minute: float) -> datetime:
        return self.day0 + timedelta(minutes=minute)

    def _plant_routes(self) -> PlantRoutes:
        r = self.routing
        return PlantRoutes(
            policy=r.policy,
            skus=[s.code for s in SKUS],
            routes=[
                PlantRoute(
                    sterilizer=x.sterilizer,
                    aseptic=x.aseptic,
                    line=x.line,
                    usable=x.usable,
                    reason=x.reason,
                    allowed=list(x.allowed),
                    blocked=[RouteBlock(sku=a, reason=b) for a, b in x.blocked],
                )
                for x in r.routes
            ],
        )

    def emit(self, payload: Any, at: float | None = None) -> None:
        ev = TwinEvent(
            event_id=uuid.uuid5(uuid.NAMESPACE_URL, f"lactos:{self.run_id}:{self._seq}"),
            run_id=self.run_id,
            seq=self._seq,
            sim_time=self.day0 + timedelta(minutes=self.env.now if at is None else at),
            payload=payload,
        )
        self._seq += 1
        if at is None:
            self._last_t = self.env.now
        self.events.append(ev)
        if self.sink:
            self.sink(ev)

    def status(
        self,
        code: str,
        status: AssetStatus,
        level: float | None = None,
        capacity: float | None = None,
    ) -> None:
        self.emit(
            AssetStatusChanged(
                asset_code=code, status=status, level_ton=level, capacity_ton=capacity
            )
        )

    def _ramp(
        self, minutes: float, *steps: Callable[[bool], None]
    ) -> Generator[simpy.Event, Any, None]:
        """Tunggu `minutes` dalam FLOW_STEPS langkah; tiap langkah menjalankan pengisian/pengosongan tangki."""
        for i in range(FLOW_STEPS):
            yield self.env.timeout(minutes / FLOW_STEPS)
            for step in steps:
                step(i == FLOW_STEPS - 1)

    def aseptic_level(self, k: int) -> None:
        tank = self.aseptic[k]
        first = tank.lots[0] if tank.lots else None
        level = round(tank.level, 3)
        self.emit(
            AssetLevel(
                asset_code=f"ASEP-{k}",
                level_ton=level,
                capacity_ton=self.cfg.aseptic_cap_ton,
                lot=first[0] if first else None,
                since=self.at(first[2]) if first else None,
                fill_start=self.at(first[3]) if first and first[3] is not None else None,
                hold_max_min=self.cfg.thresholds.holding_max_min,
                low=aseptic_low(level, tank.busy, self.cfg.filling_tph),
            )
        )

    def record_gate(self, r: gates.GateResult, object_type: str, object_id: str) -> bool:
        self.gate_log.append(
            GateRecord(r.gate, object_type, object_id, r.decision, r.reason, self.env.now)
        )
        self.emit(
            GateDecided(
                gate=r.gate,
                object_type=object_type,
                object_id=object_id,
                decision=r.decision,
                reason=r.reason,
                decided_by="gate_engine",
            )
        )
        return r.passed

    def _emit_lab_result(
        self, spec: TankerSpec, analyst: str, started: float, g2: gates.GateResult
    ) -> None:
        r = spec.lab_results
        num = lambda k: float(r[k]) if isinstance(r.get(k), int | float) else 0.0  # noqa: E731
        self.emit(
            LabResult(
                tanker_code=spec.code,
                analyst=analyst,
                started_min=round(started, 2),
                duration_min=round(spec.lab_duration_min, 2),
                fat_pct=round(num("fat_pct"), 3),
                protein_pct=round(num("protein_pct"), 3),
                acidity_pct=round(num("acidity_pct"), 4),
                ph=round(num("ph"), 2) if "ph" in r else None,
                antibiotic_residue=r.get("antibiotic_residue") is not False,
                adulterant=r.get("adulterant") is not False,
                test_type=spec.test_type,
                g2=g2.decision,
                g2_reason=g2.reason,
            )
        )

    def transfer(self, src: str, dst: str, batch: str, vol: float) -> None:
        self.transfers.append(Transfer(src, dst, batch, round(vol, 2), self.env.now))
        self.emit(
            TransferCompleted(
                from_asset=src, to_asset=dst, batch_code=batch, volume_ton=round(vol, 2)
            )
        )

    def _tanker_status(
        self, rec: TankerRecord, status: TankerStatus, bay: str | None = None
    ) -> None:
        rec.status = status
        self.emit(TankerStatusChanged(tanker_code=rec.spec.code, status=status, bay_code=bay))

    def _new_batch(
        self, kind: str, prefix: str, vol: float, parents: list[str], **kw: Any
    ) -> Batch:
        self._counters[prefix] += 1
        b = Batch(f"{prefix}-{self._counters[prefix]:04d}", kind, round(vol, 2), parents, **kw)
        self.batches[b.code] = b
        return b

    def _truck_plan(self, code: str) -> TruckPlan | None:
        o = self.overrides.get(code)
        if o and o.reject:
            return None
        tp = o.pin if o and o.pin else (self.plan.trucks.get(code) if self.plan else None)
        if tp is None or o is None or (o.bay is None and o.start is None):
            return tp
        d = o.start - tp.unload_start if o.start is not None else 0.0
        return replace(
            tp,
            bay=o.bay or tp.bay,
            lab_start=tp.lab_start + d,
            unload_start=tp.unload_start + d,
            ster_start=tp.ster_start + d,
            fill_start=tp.fill_start + d,
            fill_end=tp.fill_end + d,
        )

    def _pq(
        self, code: str, attr: str, fmt: Callable[[Any], str] = str
    ) -> tuple[Callable[[], float], Callable[[], str | None]]:
        """Kunci dan aset pilihan dari rencana TERKINI (dievaluasi saat dispatch, jadi rencana baru
        langsung berlaku bagi truk yang sedang antre). Truk di luar rencana dilayani menurut waktu minta."""
        t_req = self.env.now if self.plan else 0.0
        plan_attr = {"analyst": "lab_start", "bay": "unload_start", "sterilizer": "ster_start"}.get(
            attr, "fill_start"
        )

        def key() -> float:
            tp = self._truck_plan(code)
            return getattr(tp, plan_attr) if tp else t_req

        def prefer() -> str | None:
            tp = self._truck_plan(code)
            return fmt(getattr(tp, attr)) if tp else None

        return key, prefer

    def all_done(self) -> bool:
        return all(r.outcome != "in_progress" for r in self.tankers.values())

    def signal(self, reason: str) -> None:
        """Beri tahu perencana bahwa kondisi berubah (truk dadakan, aset mati)."""
        ev, self.replan_signal = self.replan_signal, self.env.event()
        ev.succeed(reason)

    def cip_duration(self) -> float:
        d = self.rng.uniform(*self.cfg.cip_minutes)
        for x in self.disturbances:
            if x.kind == "cip_delay" and x.start <= self.env.now < x.start + x.duration:
                d *= x.factor
        return d

    def _ster_down(self, d: Disturbance) -> Generator[simpy.Event, Any, None]:
        yield self.env.timeout(d.start)
        assert d.asset is not None
        code = yield self.sterilizers.take(d.asset)
        start = self.env.now
        self.downtimes.append(Downtime(code, start, start + d.duration))
        self.status(code, AssetStatus.UNAVAILABLE)
        self.signal("asset_down")
        yield self.env.timeout(d.duration)
        self.status(code, AssetStatus.IDLE)
        self.sterilizers.put(code)

    # --- proses ---

    def run(self) -> "TwinSimulation":
        self.emit(SimClock(speed=self.speed, paused=False))
        if self.day is not None:
            self.emit(
                DayStarted(
                    day=self.day,
                    date=self.day0.date().isoformat(),
                    carried_trucks=len(self.carry.late_trucks),
                    stock_ton=self.carry.fg_stock_ton,
                )
            )
        self.emit(self._plant_routes())
        for r in self.routing.routes:
            if not r.usable:
                self.status(r.line, AssetStatus.UNAVAILABLE)
        for code in (
            self.bays.codes
            + self.degassing.codes
            + self.thermal.codes
            + self.separators.codes
            + self.sterilizers.codes
            + [c for p in self.lines.values() for c in p.codes]
        ):
            self.status(code, AssetStatus.IDLE)
        for t in self.raw.tanks + self.storage.tanks:
            self.status(t.code, AssetStatus.IDLE, 0.0, t.capacity_ton)

        for spec in self.specs:
            self.env.process(self._dispatch(spec))
            self.env.process(self._tanker(spec))
        # Penanda perintah dijadwalkan sebelum efeknya, supaya tercatat lebih dulu pada menit yang sama.
        for i, c in enumerate(self.commands):
            self.env.process(self._command(i + 1, c))
        for note in self.incident_notes:
            self.env.process(self._incident(*note))
        for d in self.disturbances:
            if d.kind == "ster_down":
                self.env.process(self._ster_down(d))
            elif d.kind == "tank_down":
                pool = self.raw if (d.asset or "").startswith("TK-RAW") else self.storage
                self.env.process(pool.maintain(d.asset or "", d.start, d.duration))
        self.env.run()
        self.t_end = self._last_t if self.rolling else float(self.env.now)
        self.emit(
            OrdersEvaluated(**orders.evaluate(self.cfg, self.tankers.values())), at=self.t_end
        )
        self.emit(VolumeBalance(**balance.compute(self)), at=self.t_end)
        self.emit(FoulingExpiry(**wear.compute(self)), at=self.t_end)
        if self.day is not None:
            self.emit(DaySummary(**day_summary(self, self.carry, self.day)), at=self.t_end)
        self.emit(SimClock(speed=self.speed, paused=True), at=self.t_end)
        return self

    def _incident(
        self, minute: float, text: str, kind: str, asset: str, duration: float
    ) -> Generator[simpy.Event, Any, None]:
        yield self.env.timeout(minute)
        self.emit(
            DayIncident(
                kind=kind,  # type: ignore[arg-type]
                asset_code=asset,
                text=text,
                duration_min=round(duration, 1),
            )
        )

    def _command(self, command_id: int, c: Command) -> Generator[simpy.Event, Any, None]:
        yield self.env.timeout(c.minute)
        blocked, gate = self._intervene(c) if c.kind in INTERVENTION_KINDS else (None, None)
        self.emit(
            CommandApplied(
                command_id=command_id,
                kind=c.kind,
                actor=c.actor,
                reason=c.reason,
                count=c.count,
                duration_min=c.duration_min,
                factor=c.factor,
                truck=c.truck,
                bay=c.bay,
                start_min=c.start_min,
                asset=c.asset,
                blocked=blocked,
                gate=gate,
            )
        )

    def _intervene(self, c: Command) -> tuple[str | None, GateId | None]:
        """Terapkan keputusan PPIC. Mengembalikan (alasan diblokir, gate yang dicoba dilewati);
        (None, None) bila berlaku. Gate SOP tidak pernah bisa dilewati, hanya dicatat sebagai upaya."""
        rec = self.tankers.get(c.truck or "")
        if rec is None:
            return "truk tidak ditemukan", None
        code = rec.spec.code
        if c.kind == "truck_release":
            return self._release(rec)
        if rec.outcome != "in_progress":
            return "truk sudah selesai atau ditahan/ditolak gate", None
        if c.kind == "truck_hold":
            if rec.arrived is not None:
                return "truk sudah melewati gerbang", None
            assert c.duration_min
            self.holds[code] = Hold(c.duration_min, self.env.event())
            return None, None
        prev = self.overrides.get(code)
        if self._truck_plan(code) is None:
            return "tidak ada usulan untuk truk ini", None
        if c.kind == "plan_approve":
            self.overrides[code] = Override(pin=self._truck_plan(code))
        elif c.kind == "plan_reject":
            self.overrides[code] = Override(reject=True)
        else:
            if c.bay and c.bay not in self.bays.codes:
                return f"{c.bay} tidak ada di pabrik", None
            self.overrides[code] = Override(
                pin=prev.pin if prev else None,
                bay=c.bay or (prev.bay if prev else None),
                start=c.start_min if c.start_min is not None else (prev.start if prev else None),
            )
        return None, None

    def _release(self, rec: TankerRecord) -> tuple[str | None, GateId | None]:
        hold = self.holds.get(rec.spec.code)
        if hold and not hold.done and not hold.released.triggered:
            hold.released.succeed()
            return None, None
        gate = {"held_g1": GateId.G1, "rejected_g2": GateId.G2}.get(rec.outcome)
        if rec.outcome == "held_qa":
            batches = {b.code for b in self.batches.values() if b.tanker == rec.spec.code}
            gate = next(
                (
                    GateId(g.gate)
                    for g in reversed(self.gate_log)
                    if g.object_id in batches and g.decision == "hold"
                ),
                None,
            )
        if gate:
            return f"{gate.value} tidak dapat dilepas: SOP mutu mengikat", gate
        return "truk tidak sedang ditahan", None

    def _dispatch(self, spec: TankerSpec) -> Generator[simpy.Event, Any, None]:
        """Hanya menyiarkan; proses terpisah agar urutan dan hasil simulasi tidak berubah."""
        start = max(spec.appears_min, spec.arrival_min - APPROACH_MIN, 0.0)
        yield self.env.timeout(start)
        # Truk dari perintah baru muncul saat perintah berlaku, jadi jendelanya bisa lebih pendek.
        window = min(APPROACH_MIN, spec.arrival_min - start) if spec.appears_min else APPROACH_MIN
        self.emit(
            TruckDispatched(
                tanker_code=spec.code,
                farm_code=spec.farm_code,
                plate=spec.plate or spec.code,
                route=spec.route,
                eta=self.at(spec.arrival_min),
                window_min=window,
            )
        )

    def _tanker(self, spec: TankerSpec) -> Generator[simpy.Event, Any, None]:
        th, cfg = self.cfg.thresholds, self.cfg
        rec = self.tankers[spec.code]
        yield self.env.timeout(spec.arrival_min)
        rec.arrived = self.env.now
        self.emit(
            TruckArrived(
                tanker_code=spec.code,
                farm_code=spec.farm_code,
                volume_ton=spec.volume_ton,
                temp_c=spec.temp_c,
                plate=spec.plate or None,
            )
        )
        self._tanker_status(rec, TankerStatus.QUEUED)
        if not spec.announced:
            self.signal("unannounced_arrival")
        if not self.record_gate(
            gates.g1_truck_arrival(spec.temp_c, spec.docs_ok, th), "tanker", spec.code
        ):
            rec.outcome = "held_g1"
            return

        hold = self.holds.get(spec.code)
        if hold and not hold.released.triggered:
            yield hold.released | self.env.timeout(hold.duration)
        if hold:
            hold.done = True

        self._tanker_status(rec, TankerStatus.SAMPLING)
        analyst = yield self.analysts.get(*self._pq(spec.code, "analyst"))
        rec.lab_start, rec.analyst = self.env.now, analyst
        self._tanker_status(rec, TankerStatus.LAB_TEST)
        yield self.env.timeout(spec.lab_duration_min)
        rec.lab_end = self.env.now
        self.analysts.put(analyst)
        g2 = gates.g2_lab_result(spec.lab_results, th)
        self._emit_lab_result(spec, analyst, rec.lab_start, g2)
        if not self.record_gate(g2, "tanker", spec.code):
            rec.outcome = "rejected_g2"
            self._tanker_status(rec, TankerStatus.REJECTED)
            return
        rec.released = self.env.now
        self._tanker_status(rec, TankerStatus.RELEASED)

        # Susu hanya dibongkar setelah Released, ke tangki yang lolos G3.
        raw_tank = yield from self.raw.reserve(spec.volume_ton, "tanker", spec.code)
        bay = yield self.bays.get(*self._pq(spec.code, "bay"))
        deg = yield self.degassing.get()
        rec.bay = bay
        self.status(bay, AssetStatus.IN_USE)
        self.status(deg, AssetStatus.IN_USE)
        rec.unload_start = self.env.now
        self._tanker_status(rec, TankerStatus.UNLOADING, bay)
        flow = min(cfg.bay_flow_tph, cfg.degassing_tph)
        yield from self._ramp(
            spec.volume_ton / flow * 60, self.raw.filler(raw_tank, spec.volume_ton)
        )
        rec.unload_end = self.env.now

        raw = Batch(f"RAW-{spec.code}", "raw", spec.volume_ton, tanker=spec.code)
        self.batches[raw.code] = raw
        self.transfer(spec.code, bay, raw.code, raw.volume_ton)
        self.transfer(bay, deg, raw.code, raw.volume_ton)
        self.transfer(deg, raw_tank.code, raw.code, raw.volume_ton)
        self.bays.put(bay)
        self.degassing.put(deg)
        self.status(bay, AssetStatus.IDLE)
        self.status(deg, AssetStatus.IDLE)
        self.emit(
            UnloadFinished(
                tanker_code=spec.code,
                bay_code=bay,
                tank_code=raw_tank.code,
                batch_code=raw.code,
                volume_ton=spec.volume_ton,
            )
        )
        self._tanker_status(rec, TankerStatus.STORED)

        yield from self._downstream(rec, raw, raw_tank)

    def _downstream(
        self, rec: TankerRecord, raw: Batch, raw_tank: Tank
    ) -> Generator[simpy.Event, Any, None]:
        cfg, th = self.cfg, self.cfg.thresholds
        int_vol = round(raw.volume_ton * YIELD, 2)
        inter = self._new_batch("intermediate", "INT", int_vol, [raw.code], tanker=raw.tanker)

        # Thermal dan separator berjalan serentak. Tangki tujuan dipesan dulu agar ada tempat.
        sto_tank = yield from self.storage.reserve(int_vol, "batch", inter.code)
        thm = yield self.thermal.get()
        sep = yield self.separators.get()
        rec.proc_start = self.env.now
        self.status(thm, AssetStatus.IN_USE)
        self.status(sep, AssetStatus.IN_USE)
        self.transfer(raw_tank.code, thm, raw.code, raw.volume_ton)
        yield from self._ramp(
            raw.volume_ton / min(cfg.thermal_tph, cfg.separator_tph) * 60,
            self.raw.drainer(raw_tank, raw.volume_ton),
            self.storage.filler(sto_tank, int_vol),
        )
        self.transfer(thm, sep, inter.code, inter.volume_ton)
        self.transfer(sep, sto_tank.code, inter.code, inter.volume_ton)
        self.thermal.put(thm)
        self.separators.put(sep)
        self.status(thm, AssetStatus.IDLE)
        self.status(sep, AssetStatus.IDLE)

        sku_code = rec.spec.sku_code
        ste = yield self.sterilizers.get(
            *self._pq(rec.spec.code, "sterilizer", lambda n: f"STE-{n}"),
            allow=lambda code: self.routing.sterilizer_ok(int(code.split("-")[1]), sku_code),
        )
        k = int(ste.split("-")[1])
        age = self.env.now - (rec.unload_end or 0.0)
        if not self.record_gate(gates.g4_pre_sterilization(age, True, th), "batch", inter.code):
            self.sterilizers.put(ste)
            self._to_qa_hold(rec, inter, sto_tank.code, self.storage, sto_tank)
            return

        rec.ster_start = self.env.now
        rec.sterilizer = ste
        self.status(ste, AssetStatus.IN_USE)
        self.transfer(sto_tank.code, ste, inter.code, inter.volume_ton)
        yield from self._ramp(
            inter.volume_ton / cfg.sterilizer_tph * 60,
            self.storage.drainer(sto_tank, inter.volume_ton),
        )
        # Common random numbers: hasil G5 terikat ke truk, bukan ke urutan eksekusi,
        # sehingga konfigurasi A/B/C membandingkan batch yang sama.
        r5 = random.Random(f"g5:{self.seed}:{rec.spec.code}")
        g5 = gates.g5_sterilization(
            r5.gauss(139.0, 0.8), r5.gauss(5.0, 0.4), r5.random() < 0.01, th
        )
        if not self.record_gate(g5, "batch", inter.code):
            self._to_qa_hold(rec, inter, ste)
            # Sterilisasi gagal: sterilizer wajib CIP darurat sebelum dipakai lagi.
            self.env.process(self._emergency_cip(ste))
            return
        self.status(ste, AssetStatus.IDLE)
        self.sterilizers.put(ste)
        self.transfer(ste, f"ASEP-{k}", inter.code, inter.volume_ton)
        self.aseptic[k].lots.append([inter.code, inter.volume_ton, self.env.now, None])
        self.aseptic_level(k)

        yield from self._fill(rec, inter, k)

    def _emergency_cip(self, ste: str) -> Generator[simpy.Event, Any, None]:
        start = self.env.now
        self.emit(CipEvent(type="cip.started", asset_code=ste, is_scheduled=False))
        self.status(ste, AssetStatus.CIP)
        yield self.env.timeout(self.cip_duration())
        self.cips.append(CipRecord(ste, start, self.env.now, scheduled=False))
        self.emit(CipEvent(type="cip.finished", asset_code=ste, is_scheduled=False))
        self.status(ste, AssetStatus.IDLE)
        self.sterilizers.put(ste)

    def _to_qa_hold(
        self,
        rec: TankerRecord,
        batch: Batch,
        src: str,
        pool: TankPool | None = None,
        tank: Tank | None = None,
    ) -> None:
        self.transfer(src, QA_HOLD, batch.code, batch.volume_ton)
        if pool and tank:
            pool.remove(tank, batch.volume_ton)
        batch.status = "held"
        rec.outcome = "held_qa"

    def _fill(self, rec: TankerRecord, inter: Batch, k: int) -> Generator[simpy.Event, Any, None]:
        pool = self.lines[k]
        available = pool.available()
        g6 = gates.g6_ready_to_fill(self.aseptic_sterile[k], available, False)
        self.record_gate(g6, "batch", inter.code)
        sku_code = rec.spec.sku_code
        line = yield pool.get(
            *self._pq(rec.spec.code, "line"),
            allow=lambda code: self.routing.allows(code, sku_code),
        )
        if not available:
            self.record_gate(
                gates.g6_ready_to_fill(self.aseptic_sterile[k], True, False), "batch", inter.code
            )

        sku = SKU_BY_CODE[rec.spec.sku_code]
        prev = self.line_sku[line]
        co = (
            changeover_minutes(
                prev, sku, self.cfg.changeover_size_min, self.cfg.changeover_flavor_min
            )
            if prev
            else 0.0
        )
        self.line_sku[line] = sku
        rec.line, rec.fill_start = line, self.env.now + co
        self.status(line, AssetStatus.IN_USE)
        self.transfer(f"ASEP-{k}", line, inter.code, inter.volume_ton)
        tank = self.aseptic[k]
        tank.busy += 1
        if co:
            inter.changeover = True
            self.changeovers.append((line, co))
            self.emit(
                LineChangeover(asset_code=line, from_sku=prev.code, to_sku=sku.code, minutes=co)
            )
            yield self.env.timeout(co)
        lot = next(x for x in tank.lots if x[0] == inter.code)
        lot[3] = self.env.now
        self.aseptic_level(k)
        fg_vol = inter.volume_ton * YIELD
        # Pengisian dibagi empat bagian agar level tangki tampak turun; total durasi tetap.
        end = self.env.now + fg_vol / self.cfg.filling_tph * 60
        step = (end - self.env.now) / 4
        for i in range(3):
            yield self.env.timeout(step)
            lot[1] = inter.volume_ton * (3 - i) / 4
            self.aseptic_level(k)
        yield self.env.timeout(end - self.env.now)
        tank.lots.remove(lot)
        tank.busy -= 1
        self.aseptic_level(k)
        fg = self._new_batch("fg", "FG", fg_vol, [inter.code], tanker=inter.tanker, sku=sku.code)
        self.transfer(line, PACK_OUT, fg.code, fg.volume_ton)
        self.status(line, AssetStatus.IDLE)
        pool.put(line)
        rec.fill_end = self.env.now
        rec.outcome = "completed"
