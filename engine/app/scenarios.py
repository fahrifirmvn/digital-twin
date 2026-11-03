"""Skenario uji (PRD 10.7): gangguan yang diterapkan di atas volume dan truk bermasalah yang diminta."""

from dataclasses import dataclass
from typing import Literal

SCENARIO_KEYS = (
    "normal",
    "truck_surge",
    "sterilizer_down",
    "cip_delay",
    "out_of_spec",
    "peak_450",
)


@dataclass(frozen=True)
class Disturbance:
    kind: Literal["ster_down", "cip_delay", "tank_down"]
    start: float  # menit sejak awal hari
    duration: float
    asset: str | None = None
    factor: float = 1.0  # pengali durasi CIP


@dataclass(frozen=True)
class Scenario:
    key: str
    label: str
    min_volume: float = 0.0
    min_extra_bad: int = 0
    surge: tuple[float, float, int] | None = None
    disturbances: tuple[Disturbance, ...] = ()

    def apply(self, volume_ton: float, extra_bad: int) -> tuple[float, int]:
        """Skenario berlaku di atas masukan pengguna: tidak pernah mengurangi volume atau truk bermasalah."""
        return max(volume_ton, self.min_volume), max(extra_bad, self.min_extra_bad)


SCENARIOS: dict[str, Scenario] = {
    "normal": Scenario("normal", "Hari normal"),
    "truck_surge": Scenario("truck_surge", "Lonjakan truk dadakan", surge=(240, 360, 8)),
    "sterilizer_down": Scenario(
        "sterilizer_down",
        "4 dari 5 sterilizer mati 4 jam (10:00)",
        disturbances=tuple(
            Disturbance("ster_down", 240, 240, asset=f"STE-{k}") for k in (1, 2, 3, 4)
        ),
    ),
    "cip_delay": Scenario(
        "cip_delay",
        "CIP dua kali lebih lama",
        disturbances=(Disturbance("cip_delay", 0, 1440, factor=2.0),),
    ),
    "out_of_spec": Scenario("out_of_spec", "Truk di luar batas mutu", min_extra_bad=3),
    "peak_450": Scenario("peak_450", "Puncak 450 ton", min_volume=450),
}


def get_scenario(key: str) -> Scenario:
    if key not in SCENARIOS:
        raise ValueError(f"skenario {key!r} tidak dikenal")
    return SCENARIOS[key]
