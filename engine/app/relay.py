"""Relay event twin ke Laravel (POST internal), yang lalu menyiarkannya lewat Reverb."""

import logging
import queue
import threading
import time

import httpx

from app.contracts.events import TwinEvent

log = logging.getLogger(__name__)

_STOP = object()


class Relay:
    def __init__(
        self,
        url: str,
        token: str,
        client: httpx.Client | None = None,
        flush_interval: float = 0.2,
        batch_size: int = 100,
        result_url: str = "",
        retry_delay: float = 1.0,
    ):
        self.url = url
        self.result_url = result_url  # berisi {run_id}
        self.retry_delay = retry_delay
        self.token = token
        self.client = client or httpx.Client(timeout=5.0)
        self.flush_interval = flush_interval
        self.batch_size = batch_size
        self._q: queue.Queue = queue.Queue()
        self._thread = threading.Thread(target=self._worker, daemon=True)
        self._thread.start()

    def publish(self, event: TwinEvent) -> None:
        self._q.put(event)

    def send_result(self, run_id: int, body: str) -> bool:
        """Hasil run adalah data sumber kebenaran, jadi dicoba ulang. True bila diterima."""
        if not self.result_url:
            return False
        for attempt in range(4):
            try:
                res = self.client.post(
                    self.result_url.format(run_id=run_id),
                    content=body,
                    headers={"X-Internal-Token": self.token, "Content-Type": "application/json"},
                    timeout=30.0,
                )
                res.raise_for_status()
                return True
            except httpx.HTTPError as exc:
                log.warning(
                    "hasil run %d gagal dikirim (percobaan %d): %s", run_id, attempt + 1, exc
                )
                time.sleep(self.retry_delay * (attempt + 1))
        return False

    def close(self) -> None:
        self._q.put(_STOP)
        self._thread.join(timeout=10)

    def _worker(self) -> None:
        stop = False
        while not stop:
            batch: list[TwinEvent] = []
            try:
                item = self._q.get(timeout=self.flush_interval)
                batch.append(item)
                while len(batch) < self.batch_size:
                    batch.append(self._q.get_nowait())
            except queue.Empty:
                pass
            if _STOP in batch:
                batch = [e for e in batch if e is not _STOP]
                stop = True
            if batch:
                self._send(batch)

    def _send(self, batch: list[TwinEvent]) -> None:
        # Kegagalan relay tidak boleh menghentikan simulasi. Klien dapat mengambil ulang lewat /events.
        try:
            res = self.client.post(
                self.url,
                json={"events": [e.model_dump(mode="json") for e in batch]},
                headers={"X-Internal-Token": self.token},
            )
            res.raise_for_status()
        except httpx.HTTPError as exc:
            log.warning("relay gagal mengirim %d event: %s", len(batch), exc)
