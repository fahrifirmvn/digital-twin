"""Fouling sterilizer dan umur simpan produk (P9/Q6). Murni evaluasi di atas hasil simulasi: tidak mengubah
jalannya proses. Fouling = menit sterilisasi sejak CIP terakhir terhadap batas (parameter demo); CIP terjadwal
sterilizer belum dimodelkan, jadi hanya CIP darurat yang mereset hitungan. Umur simpan memakai satu angka
untuk semua SKU (demo) dan masa tempuh ke pelanggan sebagai pengurang."""

from datetime import timedelta

from app.plant import PlantConfig

NEAR = 0.75  # bagian batas yang terpakai sebelum dianggap mendekati
MIN_REMAINING_PCT = 60.0  # sisa umur simpan minimum saat tiba di pelanggan (demo)


def _state(used: float, limit: float) -> str:
    return "over" if used >= limit else "near" if used >= limit * NEAR else "ok"


def fouling(sim) -> dict:
    cfg: PlantConfig = sim.cfg
    limit = cfg.fouling_max_min
    inter = {b.tanker: b for b in sim.batches.values() if b.type == "intermediate"}
    rows = []
    for ste in sim.sterilizers.codes:
        timeline: list[tuple[float, int, float]] = []
        for rec in sim.tankers.values():
            b = inter.get(rec.spec.code)
            if rec.sterilizer == ste and rec.ster_start is not None and b:
                timeline.append((rec.ster_start, 0, b.volume_ton / cfg.sterilizer_tph * 60))
        cips = [c for c in sim.cips if c.asset == ste]
        timeline += [(c.start, 1, 0.0) for c in cips]
        acc = peak = sim.carry.fouling_min.get(ste, 0.0)
        reached: float | None = None
        for t, kind, dur in sorted(timeline):
            if kind == 1:
                acc = 0.0
                continue
            if reached is None and acc + dur >= limit:
                reached = t + max(0.0, limit - acc)
            acc += dur
            peak = max(peak, acc)
        rows.append(
            {
                "asset_code": ste,
                "run_min": round(acc, 1),
                "peak_min": round(peak, 1),
                "cip_count": len(cips),
                "state": _state(peak, limit),
                "reached_at": sim.at(reached) if reached is not None else None,
            }
        )
    return {"limit_min": limit, "sterilizers": rows}


def expiry(sim) -> dict:
    cfg: PlantConfig = sim.cfg
    shelf, lead = cfg.shelf_life_days, cfg.dispatch_lead_days
    remaining = round(100 * (shelf - lead) / shelf, 1)
    ok = remaining >= MIN_REMAINING_PCT
    first: dict[str, float] = {}
    lots: dict[str, int] = {}
    tons: dict[str, float] = {}
    for b in sim.batches.values():
        rec = sim.tankers.get(b.tanker) if b.tanker else None
        if b.type != "fg" or not b.sku or rec is None or rec.fill_end is None:
            continue
        first[b.sku] = min(first.get(b.sku, rec.fill_end), rec.fill_end)
        lots[b.sku] = lots.get(b.sku, 0) + 1
        tons[b.sku] = tons.get(b.sku, 0.0) + b.volume_ton
    skus = []
    for sku in sorted(first):
        made = sim.at(first[sku])
        skus.append(
            {
                "sku": sku,
                "lots": lots[sku],
                "volume_ton": round(tons[sku], 2),
                "produced_on": made.date().isoformat(),
                "expires_on": (made + timedelta(days=shelf)).date().isoformat(),
                "remaining_pct": remaining,
                "state": "ok" if ok else "short",
            }
        )
    return {
        "shelf_life_days": shelf,
        "dispatch_lead_days": lead,
        "min_remaining_pct": MIN_REMAINING_PCT,
        "skus": skus,
    }


def compute(sim) -> dict:
    return {"fouling": fouling(sim), "expiry": expiry(sim)}
