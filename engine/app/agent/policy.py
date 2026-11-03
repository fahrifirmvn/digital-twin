"""Policy engine Operator Agent: RBAC, batas laju, dan pemeriksaan mode. Dijalankan di kode, bukan
di prompt, sehingga LLM tidak bisa membujuknya."""

import threading
import time
from collections import defaultdict, deque

from app.agent.registry import MODES, READ_ROLES


class PolicyError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class RateLimiter:
    """Jendela geser per pengguna."""

    def __init__(self, limit: int, window: float = 60.0, clock=time.monotonic):
        self.limit, self.window, self.clock = limit, window, clock
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = self.clock()
        with self._lock:
            hits = self._hits[key]
            while hits and now - hits[0] >= self.window:
                hits.popleft()
            if len(hits) >= self.limit:
                return False
            hits.append(now)
            return True


class Policy:
    def __init__(self, limiter: RateLimiter):
        self.limiter = limiter

    def check_turn(self, user_id: int, role: str, mode: str) -> None:
        if role not in READ_ROLES:
            raise PolicyError("role_denied", f"peran {role} tidak boleh memakai Asisten AI")
        if mode not in MODES:
            raise PolicyError("mode_invalid", f"mode {mode!r} tidak dikenal")
        if not self.limiter.allow(str(user_id)):
            raise PolicyError("rate_limited", "terlalu banyak permintaan; coba lagi sebentar")
