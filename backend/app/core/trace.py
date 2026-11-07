"""一次 Agent Run 的 Trace。

记录：run / journey、关联岗位与产物、代码版本、模型、提示词版本、工具调用（含错误与重试）、
工具内部的子模型调用耗时、change_id、终态与停止原因。token 拿不到就是 None。

只写到 OFFERU_TRACE_DIR（默认 <数据目录>/traces），不进业务库，changes 表不是 trace。
写入前走 redact_secret_value：去掉密钥类字段，保留普通求职内容。
"""

from __future__ import annotations

import contextvars
import hashlib
import json
import os
import subprocess
import time
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

from app.runtime_paths import PACKAGE_BACKEND_DIR, runtime_data_dir
from app.services.security_redaction import redact_secret_value, safe_error_message

SCHEMA = "offeru.trace.v1"
TERMINAL_STATES = ("completed", "waiting_user", "partial", "failed", "cancelled")
_current: contextvars.ContextVar[Optional["Trace"]] = contextvars.ContextVar("offeru_trace", default=None)


def trace_dir() -> Path:
    configured = os.environ.get("OFFERU_TRACE_DIR", "").strip()
    return Path(configured).expanduser().resolve() if configured else runtime_data_dir() / "traces"


@lru_cache(maxsize=1)
def code_version() -> str:
    def git(*args: str) -> str:
        return subprocess.run(["git", *args], cwd=PACKAGE_BACKEND_DIR, capture_output=True, text=True,
                              timeout=5).stdout.strip()
    try:
        rev = git("rev-parse", "--short", "HEAD")
        dirty = git("status", "--porcelain", "--untracked-files=no")
    except (OSError, subprocess.SubprocessError):
        return ""
    return rev + ("-dirty" if dirty else "")


def text_version(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12] if text else ""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ids(value: Any) -> list[int]:
    if isinstance(value, bool):
        return []
    if isinstance(value, int):
        return [value]
    if isinstance(value, (list, tuple)):
        return [v for v in value if isinstance(v, int) and not isinstance(v, bool)]
    return []


def _preview(value: Any, limit: int = 2000) -> str:
    text = json.dumps(redact_secret_value(value, max_length=limit), ensure_ascii=False, default=str)
    return text if len(text) <= limit else text[:limit] + "…"


class Trace:
    def __init__(self, run_id: str, *, journey_id: str = "", meta: Optional[dict[str, Any]] = None):
        self.data: dict[str, Any] = {
            "schema": SCHEMA,
            "run_id": run_id,
            "journey_id": journey_id,
            "started_at": _now(),
            "ended_at": None,
            "code_version": code_version(),
            "model": "",
            "provider": "",
            "prompt_version": "",
            "skill_version": "",
            "step_budget": None,
            "steps_used": 0,
            "job_ids": [],
            "artifacts": [],
            "change_ids": [],
            "tool_calls": [],
            "llm_calls": [],
            "usage": {"prompt": None, "completion": None},  # token 用量，网关不回传就是 None；键名避开 token，否则脱敏会整段抹掉
            "terminal_state": None,
            "stop_reason": None,
            "error": None,
            **(meta or {}),
        }
        self._t0 = time.perf_counter()

    def update(self, **fields: Any) -> None:
        self.data.update(fields)

    def _job(self, job_id: Any) -> None:
        for value in _ids(job_id):
            if value not in self.data["job_ids"]:
                self.data["job_ids"].append(value)

    def tool(self, name: str, args: Any, *, seconds: float, result: Any = None,
             error: Optional[BaseException] = None) -> None:
        calls = self.data["tool_calls"]
        previous = calls[-1] if calls else None
        args = args if isinstance(args, dict) else {}
        entry: dict[str, Any] = {
            "seq": len(calls) + 1,
            "tool": name,
            "args": redact_secret_value(args, max_length=1500),
            "seconds": round(seconds, 3),
            "ok": error is None,
            "retry_of": previous["seq"] if previous and previous["tool"] == name and not previous["ok"] else None,
            "change_ids": [],
        }
        self._job(args.get("job_id"))
        self._job(args.get("job_ids"))
        if args.get("type") == "job":
            self._job(args.get("id"))
        if error is not None:
            entry["error"] = safe_error_message(error)
        elif isinstance(result, dict):
            changes = _ids(result.get("change_id")) + _ids(result.get("change_ids"))
            entry["change_ids"] = changes
            self.data["change_ids"] += [c for c in changes if c not in self.data["change_ids"]]
            record = result.get("record") if isinstance(result.get("record"), dict) else {}
            if name in ("save", "add_job") and (args.get("type") == "job" or name == "add_job"):
                self._job(record.get("id"))
            doc_id = result.get("doc_id") or (record.get("id") if args.get("type") == "doc" else None)
            if doc_id:
                data = args.get("data") if isinstance(args.get("data"), dict) else {}
                self._job(data.get("job_id") or record.get("job_id"))
                self.data["artifacts"].append({"doc_id": doc_id, "tool": name,
                                               "kind": data.get("kind") or record.get("kind") or "",
                                               "job_id": data.get("job_id") or record.get("job_id")})
            entry["result_preview"] = _preview(result)
        calls.append(entry)

    def llm(self, *, purpose: str, model: str, seconds: float, ok: bool, error: str = "",
            input_tokens: Optional[int] = None, output_tokens: Optional[int] = None) -> None:
        tool = self.data["tool_calls"]
        self.data["llm_calls"].append({
            "seq": len(self.data["llm_calls"]) + 1, "purpose": purpose, "model": model,
            "during_tool_seq": len(tool) + 1, "seconds": round(seconds, 3), "ok": ok,
            "error": error or None, "usage_prompt": input_tokens, "usage_completion": output_tokens,
        })

    def finish(self, terminal_state: str, *, stop_reason: str = "", error: str = "") -> Path:
        if terminal_state not in TERMINAL_STATES:
            raise ValueError(f"未知终态 {terminal_state}")
        self.data.update(terminal_state=terminal_state, stop_reason=stop_reason or None,
                         error=error or None, ended_at=_now(),
                         seconds=round(time.perf_counter() - self._t0, 3))
        return write(self.data)


def write(data: dict[str, Any]) -> Path:
    folder = trace_dir() / (data.get("journey_id") or "adhoc")
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{data['run_id']}.json"
    path.write_text(json.dumps(redact_secret_value(data, max_length=20000), ensure_ascii=False, indent=1,
                               default=str), encoding="utf-8")
    with (trace_dir() / "index.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({k: data.get(k) for k in ("run_id", "journey_id", "started_at", "terminal_state",
                                                          "stop_reason", "model", "code_version")},
                                ensure_ascii=False) + "\n")
    return path


def start(run_id: str, *, journey_id: str = "", meta: Optional[dict[str, Any]] = None) -> Trace:
    trace = Trace(run_id, journey_id=journey_id, meta=meta)
    _current.set(trace)
    return trace


def current() -> Optional[Trace]:
    return _current.get()


def clear() -> None:
    _current.set(None)


def record_tool(name: str, args: Any, *, seconds: float, result: Any = None,
                error: Optional[BaseException] = None) -> None:
    if (trace := _current.get()) is not None:
        trace.tool(name, args, seconds=seconds, result=result, error=error)


def record_llm(**fields: Any) -> None:
    if (trace := _current.get()) is not None:
        trace.llm(**fields)
