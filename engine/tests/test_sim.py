import pytest

from app.generator import generate_day
from app.plant import PlantConfig
from app.sim import PACK_OUT, QA_HOLD, TwinSimulation

SCENARIOS = [(320, 1, 0), (320, 3, 0), (450, 2, 0), (450, 5, 4), (320, 9, 6)]


def unsafe(spec) -> bool:
    """Oracle independen dari Gate Engine."""
    r = spec.lab_results
    return spec.temp_c > 6.0 or not spec.docs_ok or not 6.55 <= r["ph"] <= 6.85


def run(volume, seed, bad):
    return TwinSimulation(generate_day(seed, volume, extra_bad=bad), seed=seed).run()


def test_generator_is_reproducible_and_sized():
    assert generate_day(4, 320) == generate_day(4, 320)
    assert generate_day(4, 320) != generate_day(5, 320)
    assert len(generate_day(1, 320)) == 14
    assert len(generate_day(1, 450)) == 20


def test_same_seed_gives_identical_event_stream():
    a, b = run(320, 1, 0), run(320, 1, 0)
    assert [e.model_dump_json() for e in a.events] == [e.model_dump_json() for e in b.events]


@pytest.mark.parametrize(("volume", "seed", "bad"), SCENARIOS)
def test_false_accept_rate_is_zero(volume, seed, bad):
    sim = run(volume, seed, bad)
    for rec in sim.tankers.values():
        if unsafe(rec.spec):
            assert rec.unload_start is None, f"{rec.spec.code} lolos gate padahal tidak layak"
            assert f"RAW-{rec.spec.code}" not in sim.batches
    assert any(unsafe(r.spec) for r in sim.tankers.values()) or bad == 0


@pytest.mark.parametrize(("volume", "seed", "bad"), SCENARIOS)
def test_every_transfer_is_recorded_and_genealogy_is_complete(volume, seed, bad):
    sim = run(volume, seed, bad)
    by_batch: dict[str, list] = {}
    for t in sim.transfers:
        assert t.batch in sim.batches
        by_batch.setdefault(t.batch, []).append(t)

    for rec in sim.tankers.values():
        if rec.outcome != "completed":
            continue
        raw = sim.batches[f"RAW-{rec.spec.code}"]
        # RT -> BAY -> DEG -> raw tank
        hops = by_batch[raw.code]
        assert hops[0].from_asset == rec.spec.code
        assert all(a.to_asset == b.from_asset for a, b in zip(hops[:2], hops[1:3], strict=True))
        inter = next(b for b in sim.batches.values() if b.parents == [raw.code])
        fg = next(b for b in sim.batches.values() if b.parents == [inter.code])
        assert fg.type == "fg" and fg.tanker == rec.spec.code and fg.sku
        assert by_batch[fg.code][-1].to_asset == PACK_OUT
        assert by_batch[inter.code][-1].to_asset.startswith("LINE-")


@pytest.mark.parametrize(("volume", "seed", "bad"), SCENARIOS)
def test_tanks_never_overfill_and_end_empty_and_clean(volume, seed, bad):
    sim = run(volume, seed, bad)
    cap = {t.code: t.capacity_ton for t in sim.raw.tanks + sim.storage.tanks}
    for e in sim.events:
        p = e.payload
        if p.type == "asset.status_changed" and p.level_ton is not None:
            assert p.level_ton <= cap[p.asset_code] + 1e-6
    for t in sim.raw.tanks + sim.storage.tanks:
        assert t.level_ton < 1e-6 and t.reserved_ton < 1e-6 and t.clean


@pytest.mark.parametrize(("volume", "seed", "bad"), SCENARIOS)
def test_no_batch_is_processed_past_holding_time(volume, seed, bad):
    sim = run(volume, seed, bad)
    limit = PlantConfig().thresholds.holding_max_min
    sterilized = {t.batch: t.t for t in sim.transfers if t.to_asset.startswith("STE-")}
    for code, t in sterilized.items():
        raw_code = sim.batches[code].parents[0]
        received = next(
            x.t for x in sim.transfers if x.batch == raw_code and x.to_asset.startswith("TK-RAW")
        )
        assert t - received <= limit + 1e-6, code


def test_events_are_sequential_and_held_batches_leave_the_line():
    sim = run(450, 1, 0)
    assert [e.seq for e in sim.events] == list(range(len(sim.events)))
    held = [b for b in sim.batches.values() if b.status == "held"]
    for b in held:
        assert any(t.batch == b.code and t.to_asset == QA_HOLD for t in sim.transfers)
        assert not any(x.parents == [b.code] for x in sim.batches.values())
