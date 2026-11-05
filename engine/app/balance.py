"""Neraca volume (P9/Q5): murni hitungan atas keadaan akhir simulasi, satuan ton.

Masuk  = stok awal tangki + susu diterima (selesai bongkar).
Keluar = FG keluar + susut proses + ditahan QA + sisa di tangki + masih dalam proses.
Stok awal tidak diproses simulasi (demo); ia ikut sebagai sisa tangki. "Masih dalam proses" adalah
selisih (volume di mesin atau pipa saat simulasi berhenti), nol pada run harian yang selesai."""

from app.plant import PlantConfig


def compute_detailed(sim) -> dict:
    cfg: PlantConfig = sim.cfg
    batches = list(sim.batches.values())
    raws = [b for b in batches if b.type == "raw"]
    inters = {b.code: b for b in batches if b.type == "intermediate"}
    fgs = [b for b in batches if b.type == "fg"]

    received = sum(b.volume_ton for b in raws)
    fg = sum(b.volume_ton for b in fgs)
    raw_by_code = {b.code: b for b in raws}
    loss_therm_sep = 0.0
    for b in inters.values():
        parent = raw_by_code.get(b.parents[0]) if b.parents else None
        if parent:
            loss_therm_sep += parent.volume_ton - b.volume_ton
    fg_by_inter: dict[str, float] = {}
    for b in fgs:
        if b.parents:
            fg_by_inter[b.parents[0]] = fg_by_inter.get(b.parents[0], 0.0) + b.volume_ton
    loss_filling = 0.0
    for code, fg_sum in fg_by_inter.items():
        parent = inters.get(code)
        if parent:
            loss_filling += parent.volume_ton - fg_sum
    loss = loss_therm_sep + loss_filling
    qa_hold = sum(b.volume_ton for b in inters.values() if b.status == "held")
    tank_end = (
        sum(t.level_ton for t in sim.raw.tanks)
        + sum(t.level_ton for t in sim.storage.tanks)
        + sum(a.level for a in sim.aseptic.values())
    )
    not_received = sum(
        r.spec.volume_ton for r in sim.tankers.values() if r.outcome in ("held_g1", "rejected_g2")
    )
    raw_diff = received - fg - loss - qa_hold - tank_end
    in_process = 0.0 if abs(raw_diff) < 0.005 else raw_diff
    residual = round(received - (fg + loss + qa_hold + tank_end + in_process), 4)
    return {
        "opening_stock_ton": round(cfg.opening_stock_ton, 2),
        "received_ton": round(received, 2),
        "fg_ton": round(fg, 2),
        "loss_ton": round(loss, 2),
        "loss_therm_sep_ton": round(loss_therm_sep, 2),
        "loss_filling_ton": round(loss_filling, 2),
        "qa_hold_ton": round(qa_hold, 2),
        "tank_end_ton": round(tank_end, 2),
        "closing_stock_ton": round(cfg.opening_stock_ton + tank_end, 2),
        "in_process_ton": round(in_process, 2),
        "not_received_ton": round(not_received, 2),
        "residual_ton": 0.0 if abs(residual) < 1e-4 else residual,
        "yield_pct": round(100.0 * fg / received, 2) if received > 0 else 0.0,
    }


def compute(sim) -> dict:
    d = compute_detailed(sim)
    return {
        "opening_stock_ton": d["opening_stock_ton"],
        "received_ton": d["received_ton"],
        "fg_ton": d["fg_ton"],
        "loss_ton": d["loss_ton"],
        "qa_hold_ton": d["qa_hold_ton"],
        "tank_end_ton": d["tank_end_ton"],
        "in_process_ton": d["in_process_ton"],
        "not_received_ton": d["not_received_ton"],
    }
