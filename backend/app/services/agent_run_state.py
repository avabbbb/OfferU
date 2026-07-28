from __future__ import annotations

import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.services.agent_files import atomic_write_json

RUN_SCHEMA_VERSION = "offeru.agent_runs.v1"
RUN_DIR = Path(__file__).resolve().parents[2] / "data"
RUN_PATH = RUN_DIR / "harness_agent_runs.json"
ACTIVE_STATUSES = {"waiting_confirmation", "executing"}
MAX_RUNS = 200
_STORE_LOCK = threading.RLock()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _empty_store() -> dict[str, Any]:
    return {"schema_version": RUN_SCHEMA_VERSION, "runs": []}


def _load_store(path: Path | None = None) -> dict[str, Any]:
    with _STORE_LOCK:
        target = path or RUN_PATH
        if not target.exists():
            return _empty_store()
        try:
            payload = json.loads(target.read_text(encoding="utf-8"))
        except Exception:
            return _empty_store()
        if not isinstance(payload, dict) or not isinstance(payload.get("runs"), list):
            return _empty_store()
        payload["schema_version"] = RUN_SCHEMA_VERSION
        return payload


def _save_store(store: dict[str, Any], path: Path | None = None) -> None:
    with _STORE_LOCK:
        target = path or RUN_PATH
        atomic_write_json(target, store)


def safe_result_preview(value: Any, limit: int = 6000) -> Any:
    try:
        text = json.dumps(value, ensure_ascii=False)
    except Exception:
        text = str(value)
    if len(text) <= limit:
        return value
    return {"preview": text[:limit], "truncated": True}


def _clean_action(action: dict[str, Any], index: int) -> dict[str, Any]:
    tool = str(action.get("tool") or "").strip()
    action_id = str(action.get("id") or f"{tool}:{index}").strip()
    args = action.get("args") if isinstance(action.get("args"), dict) else {}
    requires_confirmation = bool(action.get("requires_confirmation", True))
    return {
        "id": action_id,
        "idempotency_key": str(action.get("idempotency_key") or ""),
        "tool": tool,
        "args": args,
        "summary": str(action.get("summary") or tool),
        "risk_level": str(action.get("risk_level") or "confirm"),
        "requires_confirmation": requires_confirmation,
        "status": "waiting_confirmation" if requires_confirmation else "pending",
        "attempts": 0,
        "started_at": None,
        "completed_at": None,
        "result": None,
        "error": None,
    }


def _clean_run(run: Any) -> dict[str, Any] | None:
    if not isinstance(run, dict):
        return None
    run_id = str(run.get("id") or "").strip()
    if not run_id:
        return None
    steps = [
        step
        for step in (run.get("steps") or [])
        if isinstance(step, dict) and str(step.get("id") or "").strip()
    ]
    return {
        "id": run_id,
        "conversation_id": str(run.get("conversation_id") or ""),
        "goal": str(run.get("goal") or ""),
        "mode": str(run.get("mode") or "general"),
        "skill_id": str(run.get("skill_id") or ""),
        "status": str(run.get("status") or "waiting_confirmation"),
        "exit_criteria": [str(item) for item in (run.get("exit_criteria") or []) if str(item or "").strip()],
        "steps": steps,
        "llm_runtime": run.get("llm_runtime") if isinstance(run.get("llm_runtime"), dict) else {},
        "created_at": str(run.get("created_at") or _now_iso()),
        "updated_at": str(run.get("updated_at") or _now_iso()),
    }


def create_agent_run(
    *,
    conversation_id: str,
    goal: str,
    mode: str,
    skill_id: str = "",
    actions: list[dict[str, Any]],
    exit_criteria: list[str] | None = None,
    llm_runtime: dict[str, Any] | None = None,
    path: Path | None = None,
) -> dict[str, Any]:
    now = _now_iso()
    steps = [_clean_action(action, index + 1) for index, action in enumerate(actions)]
    steps = [step for step in steps if step["tool"]]
    run = {
        "id": f"run_{uuid.uuid4().hex[:12]}",
        "conversation_id": str(conversation_id or ""),
        "goal": str(goal or "")[:1000],
        "mode": str(mode or "general"),
        "skill_id": str(skill_id or ""),
        "status": "waiting_confirmation" if any(step["requires_confirmation"] for step in steps) else "executing",
        "exit_criteria": exit_criteria or ["all planned actions have completed"],
        "steps": steps,
        "llm_runtime": llm_runtime or {},
        "created_at": now,
        "updated_at": now,
    }
    for step in steps:
        step["idempotency_key"] = f"{run['id']}:{step['id']}"
    with _STORE_LOCK:
        store = _load_store(path)
        runs = [item for item in store.get("runs") or [] if isinstance(item, dict)]
        runs.append(run)
        runs.sort(key=lambda item: str(item.get("updated_at") or ""), reverse=True)
        store["runs"] = runs[:MAX_RUNS]
        _save_store(store, path)
    return run


def save_agent_run(run: dict[str, Any], path: Path | None = None) -> dict[str, Any]:
    cleaned = _clean_run({**run, "updated_at": _now_iso()})
    if cleaned is None:
        raise ValueError("Invalid agent run")
    with _STORE_LOCK:
        store = _load_store(path)
        runs = [item for item in store.get("runs") or [] if isinstance(item, dict)]
        replaced = False
        for index, item in enumerate(runs):
            if str(item.get("id") or "") == cleaned["id"]:
                runs[index] = cleaned
                replaced = True
                break
        if not replaced:
            runs.append(cleaned)
        runs.sort(key=lambda item: str(item.get("updated_at") or ""), reverse=True)
        store["runs"] = runs[:MAX_RUNS]
        _save_store(store, path)
    return cleaned


def load_agent_run(run_id: str | None, path: Path | None = None) -> dict[str, Any] | None:
    if not run_id:
        return None
    store = _load_store(path)
    for item in store.get("runs") or []:
        cleaned = _clean_run(item)
        if cleaned and cleaned["id"] == str(run_id):
            return cleaned
    return None


def find_active_agent_run(conversation_id: str | None, path: Path | None = None) -> dict[str, Any] | None:
    if not conversation_id:
        return None
    store = _load_store(path)
    candidates: list[dict[str, Any]] = []
    for item in store.get("runs") or []:
        cleaned = _clean_run(item)
        if (
            cleaned
            and cleaned["conversation_id"] == str(conversation_id)
            and cleaned["status"] in ACTIVE_STATUSES
        ):
            candidates.append(cleaned)
    candidates.sort(key=lambda item: item.get("updated_at") or "", reverse=True)
    return candidates[0] if candidates else None


def list_agent_runs(
    conversation_id: str | None = None,
    limit: int = 20,
    path: Path | None = None,
) -> list[dict[str, Any]]:
    safe_limit = max(1, min(int(limit or 20), 100))
    runs = [
        cleaned
        for item in (_load_store(path).get("runs") or [])
        if (cleaned := _clean_run(item)) is not None
        and (not conversation_id or cleaned["conversation_id"] == str(conversation_id))
    ]
    runs.sort(key=lambda item: item.get("updated_at") or "", reverse=True)
    return runs[:safe_limit]


def pending_actions_for_run(run: dict[str, Any]) -> list[dict[str, Any]]:
    actions: list[dict[str, Any]] = []
    for step in run.get("steps") or []:
        if not isinstance(step, dict) or step.get("status") != "waiting_confirmation":
            continue
        actions.append(
            {
                "id": str(step.get("id") or ""),
                "tool": str(step.get("tool") or ""),
                "args": step.get("args") if isinstance(step.get("args"), dict) else {},
                "summary": str(step.get("summary") or step.get("tool") or ""),
                "risk_level": str(step.get("risk_level") or "confirm"),
                "requires_confirmation": bool(step.get("requires_confirmation", True)),
            }
        )
    return [action for action in actions if action["id"] and action["tool"]]


def mark_run_actions_executed(run: dict[str, Any], tool_calls: list[dict[str, Any]]) -> dict[str, Any]:
    calls_by_id = {
        str(call.get("action_id") or ""): call
        for call in tool_calls
        if isinstance(call, dict) and str(call.get("action_id") or "")
    }
    for step in run.get("steps") or []:
        if not isinstance(step, dict):
            continue
        call = calls_by_id.get(str(step.get("id") or ""))
        if call is None:
            continue
        result = call.get("result")
        has_error = isinstance(result, dict) and bool(result.get("error"))
        step["status"] = "failed" if has_error else "completed"
        step["result"] = safe_result_preview(result)
        step["error"] = str(result.get("error")) if has_error and isinstance(result, dict) else None
    statuses = {str(step.get("status") or "") for step in run.get("steps") or [] if isinstance(step, dict)}
    if "failed" in statuses:
        run["status"] = "failed"
    elif statuses and statuses.issubset({"completed"}):
        run["status"] = "completed"
    elif "waiting_confirmation" in statuses:
        run["status"] = "waiting_confirmation"
    else:
        run["status"] = "executing"
    return run
