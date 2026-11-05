"""Penilaian pH untuk keputusan QA sebelum penerimaan."""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

import simpy

from app.contracts.events import QaFailure
from app.gates import _num
from app.plant import Thresholds


@dataclass
class Review:
    signal: simpy.Event
    results: dict[str, float | bool]
    failures: list[QaFailure]
    category: Literal["incomplete", "quality", "hazard", "pass"]
    expires_min: float
    status: Literal["held", "testing", "confirmed", "released", "rejected"] = "held"
    attempts: int = 0


def assess(
    results: Mapping[str, object], th: Thresholds
) -> tuple[Literal["incomplete", "quality", "hazard", "pass"], list[QaFailure]]:
    failures = []
    incomplete = False
    bounds = {"ph": th.ph_range}
    for key, (lo, hi) in bounds.items():
        value = _num(results.get(key))
        if value is None:
            incomplete = True
            failures.append(
                QaFailure(
                    parameter=key,
                    minimum=lo,
                    maximum=hi,
                    reason="Hasil belum lengkap atau tidak valid",
                )
            )
        elif value < lo or (hi is not None and value > hi):
            failures.append(
                QaFailure(
                    parameter=key,
                    value=value,
                    minimum=lo,
                    maximum=hi,
                    reason="Di luar spesifikasi penerimaan",
                )
            )
    return ("incomplete" if incomplete else "quality" if failures else "pass"), failures
