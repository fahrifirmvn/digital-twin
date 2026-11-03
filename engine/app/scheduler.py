"""Scheduler CP-SAT (PRD 10.2): urutan uji lab, bay, sterilizer, filling line, dan changeover.

Model ini penyederhanaan dari pabrik di sim.py: tangki dimodelkan agregat (kapasitas kumulatif), CIP tangki
dan aseptic tank tidak dimodelkan, dan truk yang ditolak gate tidak diketahui saat perencanaan. Rencana dipakai
sebagai kunci prioritas oleh simulator, jadi selisih dengan kenyataan tidak membuat jadwal tidak layak.
"""

import math
import time
from dataclasses import dataclass

from ortools.sat.python import cp_model

from app.generator import TankerSpec
from app.plan import Plan, TruckPlan
from app.plant import PlantConfig, Sku, changeover_minutes
from app.predictor import Predictor
from app.sim import SKU_BY_CODE, YIELD

HORIZON = 3600
HOLD_MARGIN = 20  # menit di bawah batas holding time, agar G4 tidak jadi pembatas
DUE_MIN = 600  # target FG selesai paling lambat 10 jam setelah truk tiba
DEFAULT_WEIGHTS = {"wait": 1, "dwell": 2, "changeover": 1, "tardiness": 1}


class SchedulingError(Exception):
    pass


@dataclass(frozen=True)
class Job:
    code: str
    volume: float
    arrival: int
    lab: int
    sku: Sku


@dataclass(frozen=True)
class Pin:
    """Tahap truk yang sudah dimulai di simulasi: (waktu mulai, indeks aset 0-based)."""

    lab: tuple[int, int] | None = None
    unl: tuple[int, int] | None = None
    prc: int | None = None
    ste: tuple[int, int] | None = None
    fil: tuple[int, int] | None = None


@dataclass(frozen=True)
class Frozen:
    """Keadaan simulasi saat replan. Tahap yang sudah mulai dikunci (waktu mulai dan durasi dibulatkan
    ke bawah agar serah-terima antar pemakai aset tetap layak), tahap lain tidak boleh mulai sebelum `now`."""

    now: int
    pins: dict[str, Pin]
    downtimes: tuple[tuple[int, int, int], ...] = ()  # (indeks sterilizer, mulai, selesai)
    line_sku: dict[int, Sku] | None = None  # SKU terakhir tiap line
    prev: Plan | None = None  # rencana lama, untuk petunjuk awal solver


def build_jobs(
    specs: list[TankerSpec],
    config: str,
    predictor: Predictor,
    quantile: float = 0.8,
    eta_quantile: float = 0.5,
) -> list[Job]:
    """Durasi yang dipakai solver. B: rata-rata riwayat global. C: kuantil per truk dari Predictor."""
    if config == "B":
        delay = [predictor.mean["eta_delay"]] * len(specs)
        lab = [predictor.mean["lab_duration"]] * len(specs)
    elif config == "C":
        delay = [f.at(eta_quantile) for f in predictor.forecast("eta_delay", specs)]
        lab = [f.at(quantile) for f in predictor.forecast("lab_duration", specs)]
    else:
        raise ValueError(f"config {config!r} tidak memakai solver")
    return [
        Job(
            s.code,
            s.volume_ton,
            max(0, round(s.scheduled_eta_min + d)),
            max(1, math.ceil(p)),
            SKU_BY_CODE[s.sku_code],
        )
        for s, d, p in zip(specs, delay, lab, strict=True)
    ]


def _ceil_min(ton: float, tph: float) -> int:
    return math.ceil(ton / tph * 60 - 1e-9)


def _floor_min(ton: float, tph: float) -> int:
    return math.floor(ton / tph * 60 + 1e-9)


@dataclass
class _Greedy:
    lab: list[int]
    analyst: list[int]
    unl: list[int]
    bay: list[int]
    prc: list[int]
    ste: list[int]
    fil: list[int]
    line: list[int]


def _greedy(
    jobs: list[Job],
    cfg: PlantConfig,
    lab_d: list[int],
    unl_d: list[int],
    prc_d: list[int],
    ste_d: list[int],
    fil_d: list[int],
    co: list[list[int]],
) -> _Greedy:
    """Jadwal FCFS menurut perkiraan kedatangan, dengan line terpilih yang selesai paling awal."""
    n = len(jobs)
    g = _Greedy(*([0] * n for _ in range(8)))
    an_free = [0] * cfg.n_analysts
    bay_free = [0] * cfg.n_bays
    deg_free = [0] * cfg.n_degassing
    prc_free = [0] * min(cfg.n_thermal, cfg.n_separators)
    ste_free = [0] * cfg.n_sterilizers
    n_lines = cfg.n_sterilizers * cfg.lines_per_aseptic
    line_free = [0] * n_lines
    line_last: list[int | None] = [None] * n_lines  # indeks job terakhir di tiap line
    per = cfg.lines_per_aseptic
    for i in sorted(range(n), key=lambda i: (jobs[i].arrival, i)):
        a = min(range(len(an_free)), key=lambda x: an_free[x])
        g.analyst[i], g.lab[i] = a, max(jobs[i].arrival, an_free[a])
        an_free[a] = g.lab[i] + lab_d[i]
        ready = g.lab[i] + lab_d[i]
        b = min(range(len(bay_free)), key=lambda x: bay_free[x])
        d = min(range(len(deg_free)), key=lambda x: deg_free[x])
        g.bay[i], g.unl[i] = b, max(ready, bay_free[b], deg_free[d])
        bay_free[b] = deg_free[d] = g.unl[i] + unl_d[i]
        p = min(range(len(prc_free)), key=lambda x: prc_free[x])
        g.prc[i] = max(g.unl[i] + unl_d[i], prc_free[p])
        prc_free[p] = g.prc[i] + prc_d[i]
        pe = g.prc[i] + prc_d[i]

        def finish(line: int, i: int = i, pe: int = pe) -> tuple[int, int, int]:
            ss = max(pe, ste_free[line // per])
            prev = line_last[line]
            setup = co[prev][i] if prev is not None else 0
            return max(ss + ste_d[i], line_free[line] + setup), setup, line

        line = min(range(n_lines), key=finish)
        k = line // per
        g.ste[i] = max(pe, ste_free[k])
        g.fil[i] = finish(line)[0]
        g.line[i] = line
        ste_free[k] = g.ste[i] + ste_d[i]
        line_free[line] = g.fil[i] + fil_d[i]
        line_last[line] = i
    return g


def solve(
    jobs: list[Job],
    cfg: PlantConfig,
    config: str,
    weights: dict[str, float] | None = None,
    time_limit: float = 10.0,
    quantile: float | None = None,
    frozen: Frozen | None = None,
) -> Plan:
    w = {**DEFAULT_WEIGHTS, **(weights or {})}
    m = cp_model.CpModel()
    n = len(jobs)
    n_lines = cfg.n_sterilizers * cfg.lines_per_aseptic
    now = frozen.now if frozen else 0
    pins = [(frozen.pins.get(j.code) if frozen else None) or Pin() for j in jobs]

    def var(name: str, i: int, lo: int, pinned: bool) -> cp_model.IntVar:
        return m.NewIntVar(0 if pinned else lo, HORIZON, f"{name}{i}")

    def ended(start: int | None, d: int) -> bool:
        return start is not None and start + d <= now

    lab_s = [var("lab", i, max(jobs[i].arrival, now), bool(pins[i].lab)) for i in range(n)]
    unl_s = [var("unl", i, now, bool(pins[i].unl)) for i in range(n)]
    prc_s = [var("prc", i, now, pins[i].prc is not None) for i in range(n)]
    ste_s = [var("ste", i, now, bool(pins[i].ste)) for i in range(n)]
    fil_s = [var("fil", i, now, bool(pins[i].fil)) for i in range(n)]
    for i, p in enumerate(pins):
        if p.lab:
            m.Add(lab_s[i] == p.lab[0])
        if p.unl:
            m.Add(unl_s[i] == p.unl[0])
        if p.prc is not None:
            m.Add(prc_s[i] == p.prc)
        if p.ste:
            m.Add(ste_s[i] == p.ste[0])
        if p.fil:
            m.Add(fil_s[i] == p.fil[0])

    def dur(pinned: bool, ton: float, tph: float) -> int:
        return (_floor_min if pinned else _ceil_min)(ton, tph)

    lab_d = [j.lab for j in jobs]
    unl_d = [
        dur(bool(pins[i].unl), j.volume, min(cfg.bay_flow_tph, cfg.degassing_tph))
        for i, j in enumerate(jobs)
    ]
    prc_d = [
        dur(pins[i].prc is not None, j.volume, min(cfg.thermal_tph, cfg.separator_tph))
        for i, j in enumerate(jobs)
    ]
    inter = [round(j.volume * YIELD, 2) for j in jobs]
    ste_d = [dur(bool(pins[i].ste), v, cfg.sterilizer_tph) for i, v in enumerate(inter)]
    fil_d = [dur(bool(pins[i].fil), v * YIELD, cfg.filling_tph) for i, v in enumerate(inter)]

    # Urutan tahap dalam satu truk.
    for i in range(n):
        m.Add(unl_s[i] >= lab_s[i] + lab_d[i])  # bongkar hanya setelah Released
        m.Add(prc_s[i] >= unl_s[i] + unl_d[i])
        m.Add(ste_s[i] >= prc_s[i] + prc_d[i])
        m.Add(fil_s[i] >= ste_s[i] + ste_d[i])
        if pins[i].ste is None:
            bound = int(cfg.thresholds.holding_max_min) - HOLD_MARGIN
            if pins[i].unl:  # sudah lewat batas? longgarkan agar model tetap layak
                bound = max(bound, now - (pins[i].unl[0] + unl_d[i]) + 30)
            m.Add(ste_s[i] - (unl_s[i] + unl_d[i]) <= bound)

    def assign(name: str, count: int) -> list[list[cp_model.IntVar]]:
        x = [[m.NewBoolVar(f"{name}{i}_{k}") for k in range(count)] for i in range(n)]
        for i in range(n):
            m.AddExactlyOne(x[i])
        return x

    # Analis lab: no-overlap per analis.
    xa = assign("anl", cfg.n_analysts)
    for i, p in enumerate(pins):
        if p.lab:
            m.Add(xa[i][p.lab[1]] == 1)
    for a in range(cfg.n_analysts):
        m.AddNoOverlap(
            [
                m.NewOptionalFixedSizeIntervalVar(lab_s[i], lab_d[i], xa[i][a], f"la{i}_{a}")
                for i in range(n)
                if not ended(pins[i].lab[0] if pins[i].lab else None, lab_d[i])
            ]
        )

    # Bay no-overlap, degassing kumulatif (bongkar memakai satu degassing).
    xb = assign("bay", cfg.n_bays)
    live_unl = [i for i in range(n) if not ended(pins[i].unl[0] if pins[i].unl else None, unl_d[i])]
    for i, p in enumerate(pins):
        if p.unl:
            m.Add(xb[i][p.unl[1]] == 1)
    for b in range(cfg.n_bays):
        m.AddNoOverlap(
            [
                m.NewOptionalFixedSizeIntervalVar(unl_s[i], unl_d[i], xb[i][b], f"ub{i}_{b}")
                for i in live_unl
            ]
        )
    m.AddCumulative(
        [m.NewFixedSizeIntervalVar(unl_s[i], unl_d[i], f"ud{i}") for i in live_unl],
        [1] * len(live_unl),
        cfg.n_degassing,
    )

    # Thermal dan separator berjalan serentak, jadi satu kapasitas.
    live_prc = [i for i in range(n) if not ended(pins[i].prc, prc_d[i])]
    m.AddCumulative(
        [m.NewFixedSizeIntervalVar(prc_s[i], prc_d[i], f"pr{i}") for i in live_prc],
        [1] * len(live_prc),
        min(cfg.n_thermal, cfg.n_separators),
    )

    # Tangki agregat: susu mentah dari akhir bongkar sampai mulai proses, produk antara dari akhir
    # proses sampai mulai sterilisasi. Satuan 0.1 ton. Interval yang sudah lewat tidak dimodelkan.
    raw_iv, sto_iv, raw_dem, sto_dem = [], [], [], []
    raw_dws, sto_dws = [], []
    for i in range(n):
        raw_dw = m.NewIntVar(0, HORIZON, f"rawdw{i}")
        sto_dw = m.NewIntVar(0, HORIZON, f"stodw{i}")
        raw_dws.append(raw_dw)
        sto_dws.append(sto_dw)
        if pins[i].prc is None:
            raw_iv.append(m.NewIntervalVar(unl_s[i] + unl_d[i], raw_dw, prc_s[i], f"rw{i}"))
            raw_dem.append(math.ceil(jobs[i].volume * 10))
        if not pins[i].ste:
            sto_iv.append(m.NewIntervalVar(prc_s[i] + prc_d[i], sto_dw, ste_s[i], f"st{i}"))
            sto_dem.append(math.ceil(inter[i] * 10))
    m.AddCumulative(raw_iv, raw_dem, round(cfg.n_raw_tanks * cfg.raw_tank_cap_ton * 10))
    m.AddCumulative(sto_iv, sto_dem, round(cfg.n_storage_tanks * cfg.storage_tank_cap_ton * 10))

    # Pilihan line menentukan sterilizer: line (2k-1, 2k) dilayani sterilizer k.
    xl = assign("line", n_lines)
    per = cfg.lines_per_aseptic
    for i, p in enumerate(pins):
        if p.fil:
            m.Add(xl[i][p.fil[1]] == 1)
    ys: list[list[cp_model.IntVar]] = []
    for k in range(cfg.n_sterilizers):
        y = [m.NewBoolVar(f"ste{i}_{k}") for i in range(n)]
        ys.append(y)
        for i in range(n):
            m.Add(y[i] == sum(xl[i][k * per : (k + 1) * per]))
            if pins[i].ste and pins[i].ste[1] == k:
                m.Add(y[i] == 1)
        ivs = [
            m.NewOptionalFixedSizeIntervalVar(ste_s[i], ste_d[i], y[i], f"sk{i}_{k}")
            for i in range(n)
            if not ended(pins[i].ste[0] if pins[i].ste else None, ste_d[i])
        ]
        if frozen:
            ivs += [
                m.NewFixedSizeIntervalVar(s, e - s, f"down{k}_{s}")
                for kk, s, e in frozen.downtimes
                if kk == k and e > now
            ]
        m.AddNoOverlap(ivs)

    # Urutan filling per line dengan changeover bergantung urutan SKU (sirkuit per line).
    co = [
        [
            round(
                changeover_minutes(a.sku, b.sku, cfg.changeover_size_min, cfg.changeover_flavor_min)
            )
            for b in jobs
        ]
        for a in jobs
    ]
    co_terms: list[tuple[cp_model.IntVar, int]] = []
    used_lit: dict[int, cp_model.IntVar] = {}
    edge_lit: dict[tuple[int, int, int], cp_model.IntVar] = {}  # (line, dari, ke); -1 = depot
    for line in range(n_lines):
        arcs = []
        used = m.NewBoolVar(f"used{line}")
        used_lit[line] = used
        arcs.append((0, 0, used.Not()))
        for i in range(n):
            arcs.append((i + 1, i + 1, xl[i][line].Not()))
            first = m.NewBoolVar(f"first{line}_{i}")
            last = m.NewBoolVar(f"last{line}_{i}")
            edge_lit[(line, -1, i)] = first
            edge_lit[(line, i, -1)] = last
            arcs.append((0, i + 1, first))
            arcs.append((i + 1, 0, last))
            m.AddImplication(first, xl[i][line])
            m.AddImplication(last, xl[i][line])
            if frozen and frozen.line_sku and pins[i].fil is None:
                last_sku = frozen.line_sku.get(line)
                c0 = (
                    round(
                        changeover_minutes(
                            last_sku,
                            jobs[i].sku,
                            cfg.changeover_size_min,
                            cfg.changeover_flavor_min,
                        )
                    )
                    if last_sku
                    else 0
                )
                m.Add(fil_s[i] >= now + c0).OnlyEnforceIf(first)
                if c0:
                    co_terms.append((first, c0))
            for j in range(n):
                if i == j:
                    continue
                lit = m.NewBoolVar(f"arc{line}_{i}_{j}")
                edge_lit[(line, i, j)] = lit
                arcs.append((i + 1, j + 1, lit))
                m.Add(fil_s[j] >= fil_s[i] + fil_d[i] + co[i][j]).OnlyEnforceIf(lit)
                if co[i][j]:
                    co_terms.append((lit, co[i][j]))
        m.AddCircuit(arcs)

    # Fungsi tujuan berbobot (PRD 10.2).
    wait = [unl_s[i] - jobs[i].arrival for i in range(n)]
    dwell = [ste_s[i] - (unl_s[i] + unl_d[i]) for i in range(n)]
    tard = []
    for i in range(n):
        t = m.NewIntVar(0, HORIZON, f"tard{i}")
        m.Add(t >= fil_s[i] + fil_d[i] - (jobs[i].arrival + DUE_MIN))
        tard.append(t)
    m.Minimize(
        round(w["wait"] * 10) * sum(wait)
        + round(w["dwell"] * 10) * sum(dwell)
        + round(w["changeover"] * 10) * sum(c * lit for lit, c in co_terms)
        + round(w["tardiness"] * 10) * sum(tard)
    )

    # Warm start: greedy FCFS pada perencanaan awal, rencana lama pada replan.
    g = _greedy(jobs, cfg, lab_d, unl_d, prc_d, ste_d, fil_d, co) if frozen is None else None
    if frozen and frozen.prev:
        for i, j in enumerate(jobs):
            t = frozen.prev.trucks.get(j.code)
            if t is None:
                continue
            m.AddHint(lab_s[i], max(t.lab_start, now))
            m.AddHint(unl_s[i], max(t.unload_start, now))
            m.AddHint(ste_s[i], max(t.ster_start, now))
            m.AddHint(fil_s[i], max(t.fill_start, now))
            m.AddHint(xa[i][int(t.analyst.split("-")[1]) - 1], 1)
            m.AddHint(xb[i][int(t.bay.split("-")[1]) - 1], 1)
            m.AddHint(xl[i][int(t.line.split("-")[1]) - 1], 1)
    for i in range(n if g else 0):
        m.AddHint(lab_s[i], g.lab[i])
        m.AddHint(unl_s[i], g.unl[i])
        m.AddHint(prc_s[i], g.prc[i])
        m.AddHint(ste_s[i], g.ste[i])
        m.AddHint(fil_s[i], g.fil[i])
        m.AddHint(raw_dws[i], g.prc[i] - (g.unl[i] + unl_d[i]))
        m.AddHint(sto_dws[i], g.ste[i] - (g.prc[i] + prc_d[i]))
        m.AddHint(tard[i], max(0, g.fil[i] + fil_d[i] - (jobs[i].arrival + DUE_MIN)))
        for a in range(cfg.n_analysts):
            m.AddHint(xa[i][a], int(g.analyst[i] == a))
        for b in range(cfg.n_bays):
            m.AddHint(xb[i][b], int(g.bay[i] == b))
        for line in range(n_lines):
            m.AddHint(xl[i][line], int(g.line[i] == line))
        for k in range(cfg.n_sterilizers):
            m.AddHint(ys[k][i], int(g.line[i] // per == k))
    for line in range(n_lines if g else 0):
        seq = sorted((i for i in range(n) if g.line[i] == line), key=lambda i: g.fil[i])
        on = {(line, -1, seq[0]), (line, seq[-1], -1)} if seq else set()
        on |= {(line, a, b) for a, b in zip(seq, seq[1:], strict=False)}
        m.AddHint(used_lit[line], int(bool(seq)))
        for key, lit in edge_lit.items():
            if key[0] == line:
                m.AddHint(lit, int(key in on))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit * 8  # batas aman; batas utama deterministik
    solver.parameters.max_deterministic_time = time_limit
    solver.parameters.num_workers = 4
    solver.parameters.interleave_search = True
    solver.parameters.random_seed = 1
    t0 = time.monotonic()
    status = solver.Solve(m)
    elapsed = time.monotonic() - t0
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        if g is None:
            raise SchedulingError("replan tanpa solusi dalam batas waktu")
        # Tanpa solusi dalam batas waktu: pakai jadwal greedy yang jujur diberi status heuristic.
        trucks = {
            j.code: TruckPlan(
                code=j.code,
                analyst=f"ANL-{g.analyst[i] + 1}",
                lab_start=g.lab[i],
                bay=f"BAY-{g.bay[i] + 1}",
                unload_start=g.unl[i],
                sterilizer=g.line[i] // per + 1,
                ster_start=g.ste[i],
                line=f"LINE-{g.line[i] + 1}",
                fill_start=g.fil[i],
                fill_end=g.fil[i] + fil_d[i],
            )
            for i, j in enumerate(jobs)
        }
        return Plan(config, trucks, "heuristic", None, round(elapsed, 2), quantile, w)

    def pick(x: list[cp_model.IntVar]) -> int:
        return next(k for k, v in enumerate(x) if solver.Value(v))

    trucks = {}
    for i, j in enumerate(jobs):
        line = pick(xl[i])
        trucks[j.code] = TruckPlan(
            code=j.code,
            analyst=f"ANL-{pick(xa[i]) + 1}",
            lab_start=solver.Value(lab_s[i]),
            bay=f"BAY-{pick(xb[i]) + 1}",
            unload_start=solver.Value(unl_s[i]),
            sterilizer=line // per + 1,
            ster_start=solver.Value(ste_s[i]),
            line=f"LINE-{line + 1}",
            fill_start=solver.Value(fil_s[i]),
            fill_end=solver.Value(fil_s[i]) + fil_d[i],
        )
    return Plan(
        config=config,
        trucks=trucks,
        status="optimal" if status == cp_model.OPTIMAL else "feasible",
        objective=solver.ObjectiveValue() / 10,
        solve_seconds=round(elapsed, 2),
        quantile=quantile,
        weights=w,
    )


def make_plan(
    specs: list[TankerSpec],
    cfg: PlantConfig,
    config: str,
    predictor: Predictor,
    time_limit: float = 10.0,
    quantile: float = 0.8,
    weights: dict[str, float] | None = None,
    eta_quantile: float = 0.5,
) -> Plan:
    jobs = build_jobs(specs, config, predictor, quantile, eta_quantile)
    return solve(
        jobs, cfg, config, weights, time_limit, quantile=quantile if config == "C" else None
    )
