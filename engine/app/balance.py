"""Neraca volume (P9/Q5): murni hitungan atas keadaan akhir simulasi, satuan ton.

Masuk  = stok awal tangki + susu diterima (selesai bongkar).
Keluar = FG keluar + susut proses + ditahan QA + sisa di tangki + masih dalam proses.
Stok awal tidak diproses simulasi (demo); ia ikut sebagai sisa tangki. "Masih dalam proses" adalah
selisih (volume di mesin atau pipa saat simulasi berhenti), nol pada run harian yang selesai."""

from app.plant import PlantConfig


def compute(sim) -> dict:
    cfg: PlantConfig = sim.cfg
    batches = list(sim.batches.values())
    raws = [b for b in batches if b.type == "raw"]
    inters = {b.code: b for b in batches if b.type == "intermediate"}
    fgs = [b for b in batches if b.type == "fg"]

    received = sum(b.volume_ton for b in raws)
    fg = sum(b.volume_ton for b in fgs)
    raw_by_code = {b.code: b for b in raws}
    loss = 0.0
    for b in inters.values():
        parent = raw_by_code.get(b.parents[0]) if b.parents else None
        if parent:
            loss += parent.volume_ton - b.volume_ton
    for b in fgs:
        parent = inters.get(b.parents[0]) if b.parents else None
        if parent:
            loss += parent.volume_ton - b.volume_ton
    qa_hold = sum(b.volume_ton for b in inters.values() if b.status == "held")
    tank_end = (
        sum(t.level_ton for t in sim.raw.tanks)
        + sum(t.level_ton for t in sim.storage.tanks)
        + sum(a.level for a in sim.aseptic.values())
    )
    not_received = sum(
        r.spec.volume_ton for r in sim.tankers.values() if r.outcome in ("held_g1", "rejected_g2")
    )
    in_process = received - fg - loss - qa_hold - tank_end
    if abs(in_process) < 0.005:
        in_process = 0.0
    return {
        "opening_stock_ton": round(cfg.opening_stock_ton, 2),
        "received_ton": round(received, 2),
        "fg_ton": round(fg, 2),
        "loss_ton": round(loss, 2),
        "qa_hold_ton": round(qa_hold, 2),
        "tank_end_ton": round(tank_end, 2),
        "in_process_ton": round(in_process, 2),
        "not_received_ton": round(not_received, 2),
    }
