"""Order produksi dan kelayakannya (P9/Q4). Murni evaluasi di atas hasil simulasi: susu yang benar-benar
selesai diisi per SKU dibandingkan dengan kebutuhan susu tiap order. Pemakaian susu per ton produk jadi
(full cream 100%, rasa 90%) adalah parameter demo. Premix/mixing belum dimodelkan, jadi bahan non-susu
dianggap selalu tersedia."""

from dataclasses import dataclass, field

from app.plant import SKUS, PlantConfig, Sku

YIELD_FG = 0.995 * 0.995  # separator lalu filling, sama dengan sim.py (YIELD dua kali)
SKU_BY_CODE = {s.code: s for s in SKUS}

CAUSE_LABEL = {
    "gate": "Truk ditahan/ditolak di gerbang atau lab (G1/G2)",
    "qa": "Batch ditahan QA (G4/G5)",
    "unfinished": "Belum selesai diisi pada akhir hari",
    "supply": "Susu terjadwal untuk SKU ini kurang dari kebutuhan order",
}
CAUSE_ORDER = ("gate", "qa", "unfinished", "supply")


def milk_use_pct(cfg: PlantConfig, sku: Sku) -> float:
    """Persen susu per ton produk jadi: rasa (cokelat) memakai angka rasa, selain itu full cream."""
    return cfg.milk_use_flavour_pct if sku.flavor == "chocolate" else cfg.milk_use_full_pct


@dataclass
class SkuMilk:
    """Susu (ton) per SKU menurut nasib trucknya."""

    planned: float = 0.0
    completed: float = 0.0
    lost: dict[str, float] = field(
        default_factory=lambda: {"gate": 0.0, "qa": 0.0, "unfinished": 0.0}
    )


LOSS_OF = {"held_g1": "gate", "rejected_g2": "gate", "held_qa": "qa", "in_progress": "unfinished"}


def milk_by_sku(tankers) -> dict[str, SkuMilk]:
    out: dict[str, SkuMilk] = {}
    for rec in tankers:
        m = out.setdefault(rec.spec.sku_code, SkuMilk())
        v = rec.spec.volume_ton
        m.planned += v
        if rec.outcome == "completed":
            m.completed += v
        else:
            m.lost[LOSS_OF.get(rec.outcome, "unfinished")] += v
    return out


def default_orders(cfg: PlantConfig, milk: dict[str, SkuMilk]) -> list[tuple[str, float]]:
    """Tanpa order manual: satu order per SKU sebesar produk jadi yang direncanakan dari susu terjadwal."""
    rows = []
    for s in SKUS:
        m = milk.get(s.code)
        if m and m.planned > 0:
            rows.append((s.code, m.planned * YIELD_FG / (milk_use_pct(cfg, s) / 100)))
    return rows


def evaluate(cfg: PlantConfig, tankers) -> dict:
    """Hasil per order: terpenuhi, kurang, dan penyebab kekurangan (urut dari yang terbesar)."""
    milk = milk_by_sku(tankers)
    manual = bool(cfg.orders)
    orders = list(cfg.orders) if manual else default_orders(cfg, milk)
    # Susu selesai dan susu hilang dipakai berurutan oleh order SKU yang sama (tidak dihitung dua kali).
    left = {c: SkuMilk(m.planned, m.completed, dict(m.lost)) for c, m in milk.items()}
    results = []
    for i, (code, ton) in enumerate(orders, 1):
        sku = SKU_BY_CODE[code]
        use = milk_use_pct(cfg, sku) / 100
        pool = left.setdefault(code, SkuMilk())
        need = ton * use / YIELD_FG
        got = min(need, pool.completed)
        pool.completed -= got
        gap = need - got
        causes = []
        for cause in ("gate", "qa", "unfinished"):
            take = min(gap, pool.lost[cause])
            if take > 1e-9:
                causes.append((cause, take))
                pool.lost[cause] -= take
                gap -= take
        if gap > 1e-9:
            causes.append(("supply", gap))
        causes.sort(key=lambda c: (-c[1], CAUSE_ORDER.index(c[0])))
        made = got * YIELD_FG / use
        short = max(0.0, ton - made)
        results.append(
            {
                "order": f"ORD-{i}",
                "sku": code,
                "ordered_ton": round(ton, 2),
                "milk_needed_ton": round(need, 2),
                "milk_used_ton": round(got, 2),
                "fulfilled_ton": round(min(made, ton), 2),
                "shortfall_ton": round(short, 2),
                "feasible": short < 0.05,
                "causes": [
                    {"code": c, "label": CAUSE_LABEL[c], "milk_ton": round(t, 2)} for c, t in causes
                ],
            }
        )
    return {
        "source": "manual" if manual else "planned",
        "milk_use_full_pct": cfg.milk_use_full_pct,
        "milk_use_flavour_pct": cfg.milk_use_flavour_pct,
        "orders": results,
    }
