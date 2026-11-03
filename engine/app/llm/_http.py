import time

import httpx

from app.llm.types import LLMProtocolError, LLMRequestError

RETRY_STATUS = {429, 500, 502, 503, 504}


class HttpProvider:
    """Dasar provider HTTP/JSON: timeout, retry berbackoff untuk 429/5xx, dan galat tanpa membocorkan kunci."""

    name = "http"

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        *,
        timeout: float = 60.0,
        max_tokens: int = 1024,
        temperature: float | None = None,
        retries: int = 2,
        backoff: float = 0.5,
        client: httpx.Client | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.max_tokens = max_tokens
        self.temperature = temperature
        self.retries = retries
        self.backoff = backoff
        self.client = client or httpx.Client(timeout=timeout)

    def _post(self, url: str, payload: dict, headers: dict[str, str]) -> dict:
        last: LLMRequestError | None = None
        for attempt in range(self.retries + 1):
            try:
                r = self.client.post(url, json=payload, headers=headers)
            except httpx.HTTPError as exc:
                last = LLMRequestError(f"koneksi ke LLM gagal ({type(exc).__name__})")
            else:
                if r.status_code < 400:
                    try:
                        data = r.json()
                    except ValueError as exc:
                        raise LLMProtocolError("respons LLM bukan JSON") from exc
                    if not isinstance(data, dict):
                        raise LLMProtocolError("respons LLM bukan objek JSON")
                    return data
                last = LLMRequestError(f"LLM HTTP {r.status_code}: {r.text[:200]}", r.status_code)
                if r.status_code not in RETRY_STATUS:
                    raise last
            if attempt < self.retries:
                time.sleep(self.backoff * 2**attempt)
        assert last is not None
        raise last
