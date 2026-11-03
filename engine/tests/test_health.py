from fastapi.testclient import TestClient

from app.config import settings
from app.main import app

client = TestClient(app)


def test_health():
    assert client.get("/health").json() == {"status": "ok"}


def test_ready_requires_token():
    assert client.get("/ready").status_code == 401
    assert client.get("/ready", headers={"X-Internal-Token": "wrong"}).status_code == 401


def test_ready_reports_db_down(monkeypatch):
    monkeypatch.setattr(settings, "database_url", "postgresql://x:x@127.0.0.1:1/x")
    res = client.get("/ready", headers={"X-Internal-Token": settings.internal_token})
    assert res.status_code == 503
