"""Paced SimPy environment; only the run thread mutates simulation state."""

import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import simpy


@dataclass
class Request:
    action: Callable[[], dict[str, Any]]
    done: threading.Event = field(default_factory=threading.Event)
    result: dict[str, Any] | None = None
    error: ValueError | None = None


class LiveEnvironment(simpy.Environment):
    def __init__(self, speed: float):
        super().__init__()
        self.speed = speed
        self.lock = threading.RLock()
        self.requests: deque[Request] = deque()
        self.closed = False
        self.anchor = time.monotonic()
        self.clock = 0.0

    def submit(self, action: Callable[[], dict[str, Any]]) -> dict[str, Any]:
        request = Request(action)
        with self.lock:
            if self.closed:
                raise ValueError("Hari sudah selesai; perintah live tidak dapat diterapkan.")
            self.requests.append(request)
        if not request.done.wait(5):
            raise TimeoutError(
                "Engine belum mengonfirmasi perintah; coba ulang dengan ID yang sama."
            )
        if request.error:
            raise request.error
        assert request.result is not None
        return request.result

    def step(self) -> None:
        while True:
            with self.lock:
                if self.closed:
                    raise RuntimeError("Engine live dihentikan; hari tidak diselesaikan otomatis.")
                now = time.monotonic()
                self.clock += (now - self.anchor) * self.speed
                self.anchor = now
                while self.requests:
                    request = self.requests.popleft()
                    try:
                        request.result = request.action()
                    except ValueError as exc:
                        request.error = exc
                    finally:
                        request.done.set()
                if self.peek() == float("inf") or self.peek() <= self.clock:
                    super().step()
                    return
                delay = min(0.05, (self.peek() - self.clock) / self.speed)
            time.sleep(delay)

    def close(self) -> None:
        with self.lock:
            self.closed = True
            while self.requests:
                request = self.requests.popleft()
                request.error = ValueError("Hari berhenti sebelum perintah diterapkan.")
                request.done.set()
