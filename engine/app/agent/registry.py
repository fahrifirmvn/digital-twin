"""Inti registry alat Operator Agent: argumen bertipe ketat, izin per peran dan mode, eksekusi
yang tidak pernah melempar ke orkestrator, dan keluaran alat yang selalu dibungkus sebagai data
tidak tepercaya (P6)."""

import hashlib
import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Annotated, Any, Protocol

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    ValidationInfo,
)

from app.contracts.result import RunResult
from app.llm import ToolSpec
from app.plant import PlantConfig

ROLES = ("ppic", "qa", "operator", "driver", "admin", "observer")
READ_ROLES = frozenset({"ppic", "qa", "operator", "admin", "observer"})  # = view-twin-full
MODES = ("SIMULASI", "LIVE")
LIST_LIMIT = 40
MAX_OUTPUT_CHARS = 16000


class ToolError(Exception):
    """Pesan ini dikembalikan ke LLM sebagai hasil alat (bukan ke pengguna)."""


class RunSource(Protocol):
    def get_result(self, run_id: int) -> RunResult | None: ...


@dataclass
class ToolEnv:
    source: RunSource
    run_id: int | None = None  # run yang sedang dibuka pengguna
    cited: list[dict[str, Any]] = field(default_factory=list)

    def result(self, run_id: int | None) -> RunResult:
        rid = run_id if run_id is not None else self.run_id
        if rid is None:
            raise ToolError("run_id wajib diisi: tidak ada run yang sedang dibuka")
        res = self.source.get_result(rid)
        if res is None:
            raise ToolError(f"run {rid} tidak ditemukan atau belum selesai di Engine")
        return res

    def cite(self, tool: str, run_id: int, code: str | None = None) -> None:
        item = {"tool": tool, "run_id": run_id, "code": code}
        if item not in self.cited:
            self.cited.append(item)

    def asset_ids(self, run_id: int | None) -> set[str]:
        """Kode tangki nyata di pabrik run ini; kosong bila run tidak ada."""
        rid = run_id if run_id is not None else self.run_id
        res = self.source.get_result(rid) if rid is not None else None
        if res is None:
            return set()
        default = PlantConfig()
        raw = int(res.params.get("n_raw_tanks", default.n_raw_tanks))
        sto = int(res.params.get("n_storage_tanks", default.n_storage_tanks))
        return {f"TK-RAW-{i}" for i in range(1, raw + 1)} | {
            f"TK-STO-{i}" for i in range(1, sto + 1)
        }


class Args(BaseModel):
    """Semua argumen alat: ekstra ditolak, jadi teks bebas tidak bisa menyelinap ke alat."""

    model_config = ConfigDict(extra="forbid")


def _known_asset(value: str, info: ValidationInfo) -> str:
    known = (info.context or {}).get("assets")
    if known is None or value not in known:
        raise ValueError(f"aset {value!r} tidak dikenal; panggil list_assets")
    return value


AssetId = Annotated[str, Field(pattern=r"^TK-(RAW|STO)-\d{1,2}$"), AfterValidator(_known_asset)]


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    args: type[Args]
    roles: frozenset[str]
    handler: Callable[[ToolEnv, Any], dict[str, Any]]
    modes: frozenset[str] = frozenset(MODES)

    def spec(self) -> ToolSpec:
        schema = self.args.model_json_schema()
        schema.pop("title", None)
        return ToolSpec(self.name, self.description, schema)


@dataclass(frozen=True)
class ToolResult:
    text: str  # dikirim ke LLM
    ok: bool
    error: str | None
    result_hash: str  # sha256 dari data mentah, untuk audit


def digest(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def tools_for(registry: dict[str, Tool], role: str, mode: str) -> list[Tool]:
    return [t for t in registry.values() if role in t.roles and mode in t.modes]


def execute(
    registry: dict[str, Tool],
    name: str,
    arguments: dict[str, Any],
    role: str,
    mode: str,
    env: ToolEnv,
) -> ToolResult:
    """Jalankan satu panggilan alat. Semua kegagalan menjadi hasil terstruktur untuk LLM."""

    def fail(code: str, message: str) -> ToolResult:
        text = json.dumps({"error": code, "message": message}, ensure_ascii=False)
        return ToolResult(text, False, code, digest(text))

    tool = registry.get(name)
    if tool is None:
        return fail("unknown_tool", f"alat {name!r} tidak ada")
    if role not in tool.roles:
        return fail("role_denied", f"peran {role} tidak diizinkan memakai {name}")
    if mode not in tool.modes:
        return fail("mode_denied", f"{name} tidak tersedia pada mode {mode}")
    rid = arguments.get("run_id")
    context = {"assets": env.asset_ids(rid if isinstance(rid, int) else None)}
    try:
        data = tool.handler(env, tool.args.model_validate(arguments, context=context))
    except ValidationError as exc:
        msg = "; ".join(f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in exc.errors())
        return fail("invalid_arguments", msg)
    except ToolError as exc:
        return fail("tool_error", str(exc))
    raw = json.dumps(data, ensure_ascii=False, default=str)
    envelope = json.dumps(
        {"untrusted_data": True, "tool": name, "data": data}, ensure_ascii=False, default=str
    )
    if len(envelope) > MAX_OUTPUT_CHARS:
        text = json.dumps(
            {"error": "result_too_large", "message": "hasil terlalu besar; persempit pertanyaan"}
        )
        return ToolResult(text, False, "result_too_large", digest(raw))
    return ToolResult(envelope, True, None, digest(raw))
