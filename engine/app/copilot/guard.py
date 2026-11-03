"""Validator sumber (PRD 10.6, pagar 1): angka dalam jawaban harus berasal dari keluaran alat
(atau dari pesan pengguna sendiri). Jawaban dengan angka tanpa sumber ditolak."""

import re

_LIST_MARKER = re.compile(r"^\s*(?:[-*]\s+)?\d{1,2}[.)]\s+", re.MULTILINE)
_DECIMAL_COMMA = re.compile(r"(?<=\d),(?=\d{1,2}(?!\d))")
_NUMBER = re.compile(r"\d+(?:\.\d+)?")


def numbers_in(text: str) -> list[float]:
    return [float(m) for m in _NUMBER.findall(_DECIMAL_COMMA.sub(".", text))]


def _supported(value: float, known: set[float]) -> bool:
    if value in known:
        return True
    # Jawaban boleh membulatkan angka sumber (45.3 -> 45, 12.346 -> 12.35).
    return any(round(k, d) == value for k in known for d in (0, 1, 2))


def unsupported_numbers(answer: str, sources: list[str]) -> list[float]:
    """Angka pada `answer` yang tidak muncul di `sources` (keluaran alat + pesan pengguna)."""
    known = {n for s in sources for n in numbers_in(s)}
    body = _LIST_MARKER.sub("", answer)
    bad: list[float] = []
    for n in numbers_in(body):
        if not _supported(n, known) and n not in bad:
            bad.append(n)
    return bad
