"""Kelayakan rute STE -> aseptic -> LINE (P9/Q3). Satu sterilizer terpasang ke satu aseptic tank yang
melayani `lines_per_aseptic` line. Rute dibatasi dua hal: izin SKU per line (kebijakan) dan aliran
(line yang jalan serentak tidak boleh menarik lebih dari output aseptic). Rute yang diblokir selalu
membawa alasan. Nilai demo; matriks sebenarnya milik mitra."""

from dataclasses import dataclass

from app.plant import SKUS, PlantConfig

SKU_POLICIES = ("free", "dedicated")
POLICY_LABEL = {
    "free": "Bebas: semua SKU di semua line",
    "dedicated": "Dedikasi demo: line ke-2 tiap aseptic hanya kemasan 1000 ml",
}
FREE, DEDICATED = SKU_POLICIES
LARGE_ML = 1000


def sterilizer_code(k: int) -> str:
    return f"STE-{k}"


def aseptic_code(k: int) -> str:
    return f"ASEP-{k}"


def line_codes(cfg: PlantConfig, k: int) -> list[str]:
    n = cfg.lines_per_aseptic
    return [f"LINE-{(k - 1) * n + j + 1}" for j in range(n)]


def line_cap(cfg: PlantConfig) -> int:
    """Banyak line per aseptic yang boleh jalan serentak: total aliran filling <= output aseptic."""
    fit = int(cfg.sterilizer_tph / cfg.filling_tph + 1e-9)
    return max(1, min(cfg.lines_per_aseptic, fit))


@dataclass(frozen=True)
class Route:
    sterilizer: str
    aseptic: str
    line: str
    usable: bool
    reason: str | None  # alasan line tidak dapat dipakai sama sekali
    allowed: tuple[str, ...]  # kode SKU yang boleh di line ini
    blocked: tuple[tuple[str, str], ...]  # (kode SKU, alasan)


class Routing:
    def __init__(self, cfg: PlantConfig, policy: str = FREE):
        if policy not in SKU_POLICIES:
            raise ValueError(f"sku_policy harus salah satu {SKU_POLICIES}, bukan {policy!r}")
        self.cfg = cfg
        self.policy = policy
        self.cap = line_cap(cfg)
        self.routes = [
            self._route(k, j, line)
            for k in range(1, cfg.n_sterilizers + 1)
            for j, line in enumerate(line_codes(cfg, k))
        ]
        self._by_line = {r.line: r for r in self.routes}

    def _sku_reason(self, j: int, line: str, size_ml: int, code: str) -> str | None:
        if self.policy == DEDICATED and j >= 1 and size_ml != LARGE_ML:
            return f"{code} berukuran {size_ml} ml; {line} khusus kemasan {LARGE_ML} ml (dedikasi demo)"
        return None

    def _route(self, k: int, j: int, line: str) -> Route:
        cfg = self.cfg
        ste, asep = sterilizer_code(k), aseptic_code(k)
        if j >= self.cap:
            reason = (
                f"Aliran {cfg.lines_per_aseptic} line x {cfg.filling_tph:g} t/jam melebihi output "
                f"aseptic {cfg.sterilizer_tph:g} t/jam; hanya {self.cap} line per aseptic yang "
                "boleh jalan serentak"
            )
            return Route(ste, asep, line, False, reason, (), ())
        allowed, blocked = [], []
        for s in SKUS:
            why = self._sku_reason(j, line, s.size_ml, s.code)
            if why:
                blocked.append((s.code, why))
            else:
                allowed.append(s.code)
        return Route(ste, asep, line, True, None, tuple(allowed), tuple(blocked))

    def usable_lines(self, k: int) -> list[str]:
        return [line for line in line_codes(self.cfg, k) if self._by_line[line].usable]

    def allows(self, line: str, sku: str) -> bool:
        return sku in self._by_line[line].allowed

    def sterilizer_ok(self, k: int, sku: str) -> bool:
        """Sterilizer k boleh dipilih untuk SKU ini bila minimal satu line di belakangnya menerimanya."""
        return any(self.allows(line, sku) for line in self.usable_lines(k))

    @property
    def default(self) -> bool:
        """True bila rute identik dengan perilaku sebelum Q3 (tanpa pembatasan)."""
        return all(r.usable and not r.blocked for r in self.routes)
