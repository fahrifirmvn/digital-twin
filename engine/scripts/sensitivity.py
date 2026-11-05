"""Analisis sensitivitas parameter placeholder ("X") pada hasil simulasi.
Jalankan: cd engine && uv run python -m scripts.sensitivity
"""

from app.experiment import simulate
from app.kpi import evaluate
from app.plant import PlantConfig, plant_with, with_params


def _run_grid(label: str, cfgs: list[tuple[str, PlantConfig]], seeds: range = range(1, 4)) -> None:
    print(f"### Sensitivitas: {label}\n")
    print(
        "| Nilai Parameter | Konfig | Tunggu Rata-rata (mnt) | Tunggu P90 (mnt) | Dwell Tangki (mnt) | Changeover (mnt) | Pelanggaran Holding | FG Keluar (ton) |"
    )
    print("|---|---|---:|---:|---:|---:|---:|---:|")
    for val_label, cfg in cfgs:
        for config in ("A", "C"):
            waits, p90s, dwells, cos, holds, fgs = [], [], [], [], [], []
            for seed in seeds:
                sim, _ = simulate(config, seed, 320, time_limit=2.0, cfg=cfg)
                sim.run()
                k = evaluate(sim)
                waits.append(k.truck_wait_min.mean or 0.0)
                p90s.append(k.truck_wait_min.p90 or 0.0)
                dwells.append(k.tank_dwell_min.mean or 0.0)
                cos.append(k.changeover_min)
                holds.append(float(k.holding_violations))
                fgs.append(k.fg_ton)
            n = len(seeds)
            print(
                f"| {val_label} | {config} | {sum(waits) / n:.1f} | {sum(p90s) / n:.1f} | "
                f"{sum(dwells) / n:.1f} | {sum(cos) / n:.1f} | {sum(holds) / n:.1f} | {sum(fgs) / n:.1f} |"
            )
    print()


def main() -> None:
    base = PlantConfig()
    _run_grid(
        "Durasi CIP (`cip_min_minutes` - `cip_max_minutes`)",
        [
            ("45-60 mnt (-25%)", with_params(base, cip_min_minutes=45, cip_max_minutes=60)),
            ("60-90 mnt (baseline)", base),
            ("90-120 mnt (+33%)", with_params(base, cip_min_minutes=90, cip_max_minutes=120)),
        ],
    )
    _run_grid(
        "Batas Holding Time G4 (`holding_max_min`)",
        [
            ("120 mnt (-50%)", with_params(base, holding_max_min=120)),
            ("240 mnt (baseline)", base),
            ("360 mnt (+50%)", with_params(base, holding_max_min=360)),
        ],
    )
    _run_grid(
        "Jumlah Unloading Bay (`n_bays`)",
        [
            ("1 bay", plant_with(n_bays=1)),
            ("2 bay", plant_with(n_bays=2)),
            ("3 bay (baseline)", base),
        ],
    )


if __name__ == "__main__":
    main()
