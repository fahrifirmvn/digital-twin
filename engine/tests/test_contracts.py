import uuid

import pytest
from pydantic import ValidationError

from app.contracts.events import TwinEvent
from scripts import export_contracts


def make(payload: dict) -> dict:
    return {
        "event_id": str(uuid.uuid4()),
        "run_id": 1,
        "seq": 0,
        "sim_time": "2026-10-28T06:00:00Z",
        "payload": payload,
    }


def test_payload_discriminated_by_type():
    ev = TwinEvent.model_validate(
        make(
            {
                "type": "gate.decided",
                "gate": "G2",
                "object_type": "tanker",
                "object_id": "RT-001",
                "decision": "hold",
                "decided_by": "gate_engine",
            }
        )
    )
    assert ev.payload.gate == "G2"


def test_rejects_unknown_type_and_extra_fields():
    with pytest.raises(ValidationError):
        TwinEvent.model_validate(make({"type": "nope"}))
    with pytest.raises(ValidationError):
        TwinEvent.model_validate(make({"type": "sim.clock", "speed": 1, "paused": False, "x": 1}))


def test_exported_contracts_are_up_to_date():
    for name, text in export_contracts.render().items():
        assert (export_contracts.OUT / name).read_text() == text, (
            f"{name} usang. Jalankan: uv run python -m scripts.export_contracts"
        )
