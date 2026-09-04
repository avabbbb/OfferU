"""Durable CareerTask control-plane runtime.

CareerTask is an execution envelope, not a second Job/Memory model.  It keeps
provider lifecycle, progress and recovery state durable while every business
mutation remains an Operation Registry concern.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from app.database import async_session
from app.models.models import CareerTask, CareerTaskEvent
from app.services.security_redaction import (
    redact_secret_value,
    redact_sensitive_text,
    safe_error_message,
)
from app.services.diagnostics import new_error_id, record_error

TASK_STATUSES = {
    "queued",
    "running",
    "waiting_for_approval",
    "completed",
    "failed",
    "blocked",
    "cancelled",
}
TASK_TYPES = {
    "agent_turn",
    "run_artifact",
    "role_intelligence",
    "plugin_capability",
}
TERMINAL_STATUSES = {"completed", "failed", "blocked", "cancelled"}

_LIVE_TASKS: dict[str, asyncio.Task[Any]] = {}
_TASK_LOCKS: dict[str, asyncio.Lock] = {}
_TASK_CREATE_LOCK = asyncio.Lock()


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _bounded_json(value: Any, limit: int = 120_000) -> Any:
    value = redact_secret_value(value, max_length=limit)
    if not isinstance(value, (dict, list, str, int, float, bool)) and value is not None:
        return str(value)[:limit]
    try:
        encoded = json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(value)[:limit]
    if len(encoded) <= limit:
        return value
    return {"preview": encoded[:limit], "truncated": True}


def _safe_error(value: Any) -> str:
    text = safe_error_message(
        value if isinstance(value, BaseException) else RuntimeError(str(value or "")),
        max_length=2000,
    )
    lowered = text.casefold()
    if any(marker in lowered for marker in ("api_key", "apikey", "bearer", "token")):
        return "provider authentication failed"
    return text[:2000]


def _is_provider_blocked(value: Any) -> bool:
    text = str(value or "").casefold()
    return any(marker in text for marker in ("401", "unauthorized", "invalid_api_key", "authentication"))


def _record_task_error(
    task_id: str,
    *,
    message: Any,
    provider_id: str = "",
    run_id: str = "",
    kind: str = "career_task",
) -> str:
    error_id = new_error_id()
    record_error(
        error_id,
        method="TASK",
        path=f"/api/agent/runtime/career-tasks/{task_id}",
        status_code=503 if kind in {"task_restart", "provider_blocked"} else 500,
        kind=kind,
        message=message,
        task_id=task_id,
        run_id=run_id,
        provider_id=provider_id,
    )
    return error_id


def _task_view(row: CareerTask) -> dict[str, Any]:
    progress = row.progress_json if isinstance(row.progress_json, dict) else {}
    return {
        "task_id": row.task_id,
        "task_type": row.task_type,
        "source": row.source or "",
        "target_type": row.target_type or "",
        "target_id": row.target_id or "",
        "runtime_provider": row.runtime_provider or "",
        "input": redact_secret_value(row.input_json if isinstance(row.input_json, dict) else {}),
        "output_contract": redact_secret_value(row.output_contract_json if isinstance(row.output_contract_json, dict) else {}),
        "status": row.status,
        "progress": redact_secret_value(progress),
        "error_id": str(progress.get("error_id") or "")[:40],
        "agent_thread_id": row.agent_thread_id or "",
        "agent_turn_id": row.agent_turn_id or "",
        "run_id": row.run_id or "",
        "result_ref": row.result_ref or "",
        "result": redact_secret_value(row.result_json if isinstance(row.result_json, dict) else {}),
        "checkpoint": redact_secret_value(row.checkpoint_json if isinstance(row.checkpoint_json, dict) else {}),
        "error": redact_sensitive_text(row.error or "", max_length=2000),
        "retryable": bool(row.retryable),
        "attempt_count": int(row.attempt_count or 0),
        "max_attempts": int(row.max_attempts or 0),
        "next_retry_at": row.next_retry_at.isoformat() if row.next_retry_at else None,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "started_at": row.started_at.isoformat() if row.started_at else None,
        "finished_at": row.finished_at.isoformat() if row.finished_at else None,
    }


def _task_lock(task_id: str) -> asyncio.Lock:
    return _TASK_LOCKS.setdefault(task_id, asyncio.Lock())


async def _claim_task(task_id: str) -> dict[str, Any] | None:
    """Atomically claim a queued task across backend processes.

    The in-process task map prevents duplicate scheduling inside one event
    loop, but it cannot coordinate two local backend processes.  The durable
    queued -> running transition is therefore the execution lease: exactly
    one process may increment the attempt counter and run the provider.
    """

    async with async_session() as db:
        result = await db.execute(
            update(CareerTask)
            .where(CareerTask.task_id == str(task_id or ""))
            .where(CareerTask.status == "queued")
            .values(
                status="running",
                attempt_count=CareerTask.attempt_count + 1,
                started_at=_utc_now(),
                finished_at=None,
                next_retry_at=None,
                error="",
                progress_json={"stage": "running", "percent": 10},
            )
        )
        if int(result.rowcount or 0) != 1:
            await db.rollback()
            return None
        await db.commit()
        row = await db.get(CareerTask, str(task_id or ""))
        return _task_view(row) if row is not None else None


async def _notify_automation(task_id: str) -> None:
    try:
        from app.services.automation import handle_career_task_finished

        await handle_career_task_finished(task_id)
    except Exception as exc:
        # A projection failure must not rewrite the completed task, but it
        # must remain visible on the AutomationEvent/Inbox control surface.
        try:
            from app.services.automation import handle_career_task_projection_failure

            await handle_career_task_projection_failure(task_id, exc)
        except Exception:
            # Failure reporting is best effort and must not change the task's
            # already-persisted Career Truth.
            return


async def _append_event(
    task_id: str,
    event_type: str,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    async with _task_lock(task_id):
        async with async_session() as db:
            row = await db.get(CareerTask, task_id)
            if row is None:
                raise ValueError(f"CareerTask {task_id} 不存在")
            row.event_sequence = int(row.event_sequence or 0) + 1
            event = CareerTaskEvent(
                event_id=f"career_task_evt_{uuid.uuid4().hex}",
                task_id=task_id,
                sequence=row.event_sequence,
                event_type=str(event_type or "task.event")[:100],
                payload_json=_bounded_json(payload or {}),
            )
            db.add(event)
            await db.commit()
            return {
                "event_id": event.event_id,
                "task_id": task_id,
                "sequence": row.event_sequence,
                "type": event.event_type,
                "payload": event.payload_json,
                "created_at": event.created_at.isoformat() if event.created_at else None,
            }


async def _update_task(task_id: str, **values: Any) -> dict[str, Any]:
    async with _task_lock(task_id):
        async with async_session() as db:
            row = await db.get(CareerTask, task_id)
            if row is None:
                raise ValueError(f"CareerTask {task_id} 不存在")
            for key, value in values.items():
                if hasattr(row, key):
                    if key in {
                        "input_json",
                        "output_contract_json",
                        "progress_json",
                        "result_json",
                        "checkpoint_json",
                    }:
                        value = redact_secret_value(value)
                    elif key == "error":
                        value = redact_sensitive_text(value or "", max_length=2000)
                    setattr(row, key, value)
            await db.commit()
            await db.refresh(row)
            return _task_view(row)


async def get_career_task(task_id: str) -> dict[str, Any]:
    async with async_session() as db:
        row = await db.get(CareerTask, str(task_id or ""))
    if row is None:
        raise ValueError(f"CareerTask {task_id} 不存在")
    return _task_view(row)


async def list_career_tasks(
    *,
    status: str | None = None,
    task_type: str | None = None,
    target_type: str | None = None,
    target_id: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    clean_limit = max(1, min(int(limit), 200))
    async with async_session() as db:
        query = select(CareerTask).order_by(CareerTask.created_at.desc()).limit(clean_limit)
        if status:
            query = query.where(CareerTask.status == str(status))
        if task_type:
            query = query.where(CareerTask.task_type == str(task_type))
        if target_type:
            query = query.where(CareerTask.target_type == str(target_type))
        if target_id:
            query = query.where(CareerTask.target_id == str(target_id))
        rows = (await db.execute(query)).scalars().all()
    return {"tasks": [_task_view(row) for row in rows]}


async def list_career_task_events(task_id: str, *, after: int = 0, limit: int = 100) -> dict[str, Any]:
    async with async_session() as db:
        rows = (
            await db.execute(
                select(CareerTaskEvent)
                .where(CareerTaskEvent.task_id == str(task_id or ""))
                .where(CareerTaskEvent.sequence > max(0, int(after)))
                .order_by(CareerTaskEvent.sequence.asc())
                .limit(max(1, min(int(limit), 500)))
            )
        ).scalars().all()
    return {
        "task_id": str(task_id or ""),
        "events": [
            {
                "event_id": row.event_id,
                "sequence": row.sequence,
                "type": row.event_type,
                "payload": row.payload_json or {},
                "created_at": row.created_at.isoformat() if row.created_at else None,
            }
            for row in rows
        ],
        "next": rows[-1].sequence if rows else max(0, int(after)),
    }


async def get_career_task_result(task_id: str) -> dict[str, Any]:
    task = await get_career_task(task_id)
    return {
        "task_id": task["task_id"],
        "status": task["status"],
        "result": task["result"],
        "result_ref": task["result_ref"],
        "error": task["error"],
        "error_id": task["error_id"],
        "retryable": task["retryable"],
    }


def _idempotency_key(
    *,
    task_type: str,
    source: str,
    target_type: str,
    target_id: str,
    runtime_provider: str,
    input_payload: dict[str, Any],
    output_contract: dict[str, Any],
) -> str:
    canonical = json.dumps(
        {
            "task_type": task_type,
            "source": source,
            "target_type": target_type,
            "target_id": target_id,
            "runtime_provider": runtime_provider,
            "input": input_payload,
            "output_contract": output_contract,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return f"career-task:{hashlib.sha256(canonical.encode('utf-8')).hexdigest()}"


def _schedule(task_id: str) -> None:
    if task_id in _LIVE_TASKS and not _LIVE_TASKS[task_id].done():
        return
    worker = asyncio.create_task(_run_task(task_id), name=f"offeru-career-task-{task_id}")
    _LIVE_TASKS[task_id] = worker

    def discard(done: asyncio.Task[Any]) -> None:
        if _LIVE_TASKS.get(task_id) is done:
            _LIVE_TASKS.pop(task_id, None)

    worker.add_done_callback(discard)


async def start_career_task(
    *,
    task_type: str,
    source: str = "ui",
    target_type: str = "",
    target_id: str = "",
    runtime_provider: str = "replay",
    input: dict[str, Any] | None = None,
    output_contract: dict[str, Any] | None = None,
    run_id: str = "",
    idempotency_key: str = "",
    max_attempts: int = 3,
) -> dict[str, Any]:
    clean_type = str(task_type or "").strip()
    if clean_type not in TASK_TYPES:
        raise ValueError(f"不支持的 CareerTask 类型: {clean_type}")
    clean_provider = str(runtime_provider or "replay").strip().casefold()
    payload = redact_secret_value(input if isinstance(input, dict) else {})
    contract = output_contract if isinstance(output_contract, dict) else {}
    key = str(idempotency_key or "").strip() or _idempotency_key(
        task_type=clean_type,
        source=str(source or "ui"),
        target_type=str(target_type or ""),
        target_id=str(target_id or ""),
        runtime_provider=clean_provider,
        input_payload=payload,
        output_contract=contract,
    )
    stored_key = key[:180]
    async with _TASK_CREATE_LOCK:
        async with async_session() as db:
            existing = (
                await db.execute(
                    select(CareerTask).where(CareerTask.idempotency_key == stored_key)
                )
            ).scalar_one_or_none()
            if existing is not None:
                result = {**_task_view(existing), "reused": True}
                task_id = existing.task_id
                created = False
            else:
                task = CareerTask(
                    task_id=f"career_task_{uuid.uuid4().hex[:20]}",
                    task_type=clean_type,
                    source=str(source or "ui")[:80],
                    target_type=str(target_type or "")[:80],
                    target_id=str(target_id or "")[:160],
                    runtime_provider=clean_provider[:100],
                    input_json=_bounded_json(payload),
                    output_contract_json=_bounded_json(contract),
                    status="queued",
                    progress_json={"stage": "queued", "percent": 0},
                    run_id=str(run_id or "")[:160],
                    idempotency_key=stored_key,
                    retryable=True,
                    attempt_count=0,
                    max_attempts=max(1, min(int(max_attempts), 10)),
                )
                db.add(task)
                try:
                    await db.commit()
                except IntegrityError:
                    # The database constraint is the cross-process authority;
                    # re-read the winner instead of surfacing a duplicate error.
                    await db.rollback()
                    existing = (
                        await db.execute(
                            select(CareerTask).where(
                                CareerTask.idempotency_key == stored_key
                            )
                        )
                    ).scalar_one_or_none()
                    if existing is None:
                        raise
                    result = {**_task_view(existing), "reused": True}
                    task_id = existing.task_id
                    created = False
                else:
                    await db.refresh(task)
                    result = _task_view(task)
                    task_id = task.task_id
                    created = True
        if created:
            await _append_event(
                task_id,
                "task.queued",
                {"task_type": clean_type, "provider": clean_provider},
            )
            _schedule(task_id)
            return {**result, "scheduled": True, "reused": False}
        if result["status"] in {"queued", "running"}:
            _schedule(task_id)
        return result


async def _run_agent_turn(task: dict[str, Any]) -> dict[str, Any]:
    from app.services.agent_runtime import get_agent_runtime_provider

    provider = get_agent_runtime_provider(
        task["runtime_provider"],
        run_id=task.get("run_id") or task["task_id"],
    )
    try:
        await provider.start()
        payload = task["input"] if isinstance(task.get("input"), dict) else {}
        cwd = str(payload.get("cwd") or "")
        await _append_event(task["task_id"], "runtime.ready", {"provider": task["runtime_provider"]})
        await provider.create_thread(
            cwd=cwd,
            tool_descriptions=[str(item) for item in payload.get("tool_descriptions") or []],
        )
        result = await provider.start_turn(prompt=str(payload.get("prompt") or ""), cwd=cwd)
        await _update_task(
            task["task_id"],
            agent_thread_id=str(result.get("thread_id") or result.get("threadId") or ""),
            agent_turn_id=str(result.get("turn_id") or result.get("turnId") or ""),
            progress_json={"stage": "agent_turn_completed", "percent": 100},
        )
        provider_events = await provider.events()
        await _append_event(
            task["task_id"],
            "runtime.events_collected",
            {"count": len(provider_events.get("events") or []), "next": provider_events.get("next", 0)},
        )
        return result
    finally:
        with contextlib.suppress(Exception):
            await provider.shutdown()


async def _run_artifact_task(task: dict[str, Any]) -> dict[str, Any]:
    from app.services.artifact_workspace import ArtifactWorkspaceManager
    from app.services.coding_agent_runtime import DeepTaskSpec, execute_deep_task
    from app.services.context_projector import ContextProjector

    payload = task["input"] if isinstance(task.get("input"), dict) else {}
    workspace_run_id = str(payload.get("workspace_run_id") or task.get("run_id") or "")
    if not workspace_run_id:
        raise ValueError("run_artifact 缺少 workspace_run_id")
    workspace = ArtifactWorkspaceManager(workspace_run_id)
    workspace.verify()
    job_id = int(payload.get("job_id") or 0)
    if job_id <= 0:
        raise ValueError("run_artifact 缺少有效 job_id")
    context = await ContextProjector(workspace).project(job_id=job_id)
    timeout = max(1, min(int(payload.get("timeout_seconds") or 240), 3600))
    provider_result = await execute_deep_task(
        DeepTaskSpec(
            runtime_id=task["runtime_provider"],
            prompt=str(payload.get("prompt") or ""),
            cwd=workspace.workspace_dir,
            output_schema={"type": "object", "additionalProperties": True},
            timeout_seconds=timeout,
            web_search_mode=str(payload.get("web_search_mode") or "disabled"),
            task_type="run_artifact",
            task_id=task["task_id"],
            capability_grant={
                "data_scope": {"runId": workspace_run_id, "jobId": job_id},
                "filesystem": "task_cwd_read_only",
            },
        )
    )
    return {
        "workspace_run_id": workspace_run_id,
        "job_id": job_id,
        "context_version": int(context.get("confirmedAt") is not None),
        **provider_result,
    }


async def _run_role_intelligence_task(task: dict[str, Any]) -> dict[str, Any]:
    """Run the existing Role Intelligence domain service through the Registry."""

    from app.services import role_intelligence
    from app.ops import execute_operation

    payload = task["input"] if isinstance(task.get("input"), dict) else {}
    job_id = int(payload.get("job_id") or task.get("target_id") or 0)
    if job_id <= 0:
        raise ValueError("role_intelligence 缺少有效 job_id")
    operation_args = {
        "job_id": job_id,
        "runtime_id": task["runtime_provider"],
        **{
            key: str(payload.get(key) or "")
            for key in ("role_family", "specialization", "seniority", "region", "industry")
            if payload.get(key)
        },
    }
    envelope = await execute_operation(
        "build_role_benchmark",
        operation_args,
        surface="career_task_runtime",
    )
    if not envelope.get("ok"):
        raise RuntimeError(
            "; ".join(str(item) for item in envelope.get("errors") or [])
            or "build_role_benchmark failed"
        )
    outputs = envelope.get("outputs") if isinstance(envelope.get("outputs"), dict) else {}
    run_id = str(outputs.get("run_id") or "")
    if not run_id:
        raise ValueError("build_role_benchmark 未返回 run_id")
    await _update_task(
        task["task_id"],
        run_id=run_id,
        progress_json={"stage": "role_benchmark_running", "percent": 25},
    )
    worker = role_intelligence._LIVE_TASKS.get(run_id)
    if worker is not None:
        await worker

    deadline = asyncio.get_running_loop().time() + 3600
    while True:
        benchmark = await role_intelligence.get_role_benchmark(run_id=run_id)
        status = str(benchmark.get("status") or "")
        if status in {"completed", "failed", "interrupted", "blocked"}:
            break
        if asyncio.get_running_loop().time() >= deadline:
            raise TimeoutError("role_intelligence benchmark 等待超时")
        await asyncio.sleep(0.25)
    if status != "completed":
        raise RuntimeError(
            str(benchmark.get("last_error") or f"Role benchmark status={status}")
        )
    fixture_research_run_id = ""
    if task["runtime_provider"] in {"fixture", "replay"}:
        fixture_research = await execute_operation(
            "create_fixture_job_research",
            {"job_id": job_id},
            surface="career_task_runtime",
        )
        if not fixture_research.get("ok"):
            raise RuntimeError(
                "; ".join(str(item) for item in fixture_research.get("errors") or [])
                or "create_fixture_job_research failed"
            )
        fixture_outputs = (
            fixture_research.get("outputs")
            if isinstance(fixture_research.get("outputs"), dict)
            else {}
        )
        fixture_research_run_id = str(fixture_outputs.get("run_id") or "")
    return {
        "benchmark_run_id": run_id,
        "job_id": job_id,
        "benchmark": benchmark,
        "fixture_research_run_id": fixture_research_run_id,
    }


async def _complete_task(task_id: str, result: dict[str, Any]) -> dict[str, Any]:
    """Commit success unless a user cancellation won the terminal transition."""

    async with _task_lock(task_id):
        async with async_session() as db:
            row = await db.get(CareerTask, task_id)
            if row is None:
                raise ValueError(f"CareerTask {task_id} 不存在")
            if row.status == "cancelled":
                return _task_view(row)
            row.status = "completed"
            row.result_json = _bounded_json(result)
            row.result_ref = f"career-task:{task_id}"
            row.progress_json = {"stage": "completed", "percent": 100}
            row.error = ""
            row.retryable = False
            row.finished_at = _utc_now()
            await db.commit()
            await db.refresh(row)
            return _task_view(row)


async def _run_task(task_id: str) -> None:
    task = await _claim_task(task_id)
    if task is None:
        # Another process either claimed the task or moved it to a terminal
        # state.  It owns execution and durable completion.
        return
    try:
        await _append_event(task_id, "task.started", {"attempt": task["attempt_count"]})
        if task["task_type"] == "agent_turn":
            result = await _run_agent_turn(task)
        elif task["task_type"] == "run_artifact":
            result = await _run_artifact_task(task)
        elif task["task_type"] == "role_intelligence":
            result = await _run_role_intelligence_task(task)
        elif task["task_type"] == "plugin_capability":
            from app.services.capability_plugins import invoke_plugin_capability

            payload = task["input"] if isinstance(task.get("input"), dict) else {}
            result = await invoke_plugin_capability(**payload)
        else:
            raise ValueError(f"unsupported CareerTask type: {task['task_type']}")
        completed = await _complete_task(task_id, result)
        if completed["status"] == "cancelled":
            return
        await _append_event(task_id, "task.completed", {"result_ref": f"career-task:{task_id}"})
        await _notify_automation(task_id)
    except asyncio.CancelledError:
        current = await get_career_task(task_id)
        if current["status"] not in TERMINAL_STATUSES:
            error_message = "任务被运行环境中断；未自动重放外部副作用"
            error_id = _record_task_error(
                task_id,
                message=error_message,
                provider_id=current.get("runtime_provider") or "",
                run_id=current.get("run_id") or "",
                kind="task_cancelled",
            )
            await _update_task(
                task_id,
                status="blocked",
                error=error_message,
                retryable=True,
                finished_at=_utc_now(),
                progress_json={"stage": "blocked", "percent": 0, "error_id": error_id},
            )
            await _append_event(
                task_id,
                "task.blocked",
                {"reason": "cancelled_by_runtime", "error_id": error_id},
            )
        raise
    except Exception as exc:  # noqa: BLE001 - persisted task failure is explicit
        blocked = _is_provider_blocked(exc)
        current = await get_career_task(task_id)
        if current["status"] == "cancelled":
            return
        error_message = "provider authentication failed" if blocked else _safe_error(exc)
        error_id = _record_task_error(
            task_id,
            message=error_message,
            provider_id=current.get("runtime_provider") or "",
            run_id=current.get("run_id") or "",
            kind="provider_blocked" if blocked else "career_task",
        )
        await _update_task(
            task_id,
            status="blocked" if blocked else "failed",
            error=error_message,
            retryable=bool(blocked or current["attempt_count"] < current["max_attempts"]),
            finished_at=_utc_now(),
            progress_json={
                "stage": "blocked" if blocked else "failed",
                "percent": 0,
                "error_id": error_id,
            },
        )
        await _append_event(
            task_id,
            "task.blocked" if blocked else "task.failed",
            {
                "retryable": bool(blocked or current["attempt_count"] < current["max_attempts"]),
                "error_id": error_id,
            },
        )
        await _notify_automation(task_id)


async def cancel_career_task(task_id: str) -> dict[str, Any]:
    task_key = str(task_id or "")
    async with _task_lock(task_key):
        async with async_session() as db:
            row = await db.get(CareerTask, task_key)
            if row is None:
                raise ValueError(f"CareerTask {task_key} 不存在")
            if row.status in TERMINAL_STATUSES:
                return {**_task_view(row), "reused": True}
            progress = row.progress_json if isinstance(row.progress_json, dict) else {}
            result = await db.execute(
                update(CareerTask)
                .where(CareerTask.task_id == task_key)
                .where(~CareerTask.status.in_(TERMINAL_STATUSES))
                .values(
                    status="cancelled",
                    retryable=False,
                    finished_at=_utc_now(),
                    progress_json={
                        "stage": "cancelled",
                        "percent": progress.get("percent", 0),
                    },
                )
            )
            if int(result.rowcount or 0) != 1:
                await db.rollback()
                latest = await db.get(CareerTask, task_key)
                if latest is None:
                    raise ValueError(f"CareerTask {task_key} 不存在")
                return {**_task_view(latest), "reused": True}
            await db.commit()
            cancelled_row = await db.get(CareerTask, task_key)
            if cancelled_row is None:
                raise ValueError(f"CareerTask {task_key} 不存在")
            cancelled = _task_view(cancelled_row)
    worker = _LIVE_TASKS.get(task_key)
    if worker is not None and not worker.done():
        worker.cancel()
    await _append_event(task_key, "task.cancelled")
    return cancelled


async def retry_career_task(task_id: str) -> dict[str, Any]:
    task_key = str(task_id or "")
    async with _task_lock(task_key):
        async with async_session() as db:
            row = await db.get(CareerTask, task_key)
            if row is None:
                raise ValueError(f"CareerTask {task_key} 不存在")
            current = _task_view(row)
            if current["status"] in {"queued", "running", "waiting_for_approval", "completed"}:
                return {**current, "reused": True}
            if current["status"] not in {"failed", "blocked"}:
                raise ValueError("只有 failed 或 blocked 的 CareerTask 可以 retry")
            if not current["retryable"]:
                raise ValueError("该 CareerTask 不允许 retry")
            if current["attempt_count"] >= current["max_attempts"]:
                raise ValueError("CareerTask 已达到最大 retry 次数")
            result = await db.execute(
                update(CareerTask)
                .where(CareerTask.task_id == task_key)
                .where(CareerTask.status.in_(("failed", "blocked")))
                .where(CareerTask.retryable.is_(True))
                .where(CareerTask.attempt_count < CareerTask.max_attempts)
                .values(
                    status="queued",
                    error="",
                    finished_at=None,
                    next_retry_at=None,
                    progress_json={"stage": "queued", "percent": 0},
                )
            )
            if int(result.rowcount or 0) != 1:
                await db.rollback()
                latest = await db.get(CareerTask, task_key)
                if latest is None:
                    raise ValueError(f"CareerTask {task_key} 不存在")
                latest_view = _task_view(latest)
                if latest_view["status"] in {
                    "queued",
                    "running",
                    "waiting_for_approval",
                    "completed",
                }:
                    return {**latest_view, "reused": True}
                raise ValueError("该 CareerTask 已被其他进程处理，无法重复 retry")
            await db.commit()
            queued_row = await db.get(CareerTask, task_key)
            if queued_row is None:
                raise ValueError(f"CareerTask {task_key} 不存在")
            queued = _task_view(queued_row)
    await _append_event(task_key, "task.retry_requested", {"attempt": current["attempt_count"] + 1})
    _schedule(task_key)
    return {**queued, "reused": False}


async def resume_career_task(task_id: str) -> dict[str, Any]:
    return await retry_career_task(task_id)


async def recover_career_tasks() -> dict[str, Any]:
    recovered = 0
    rescheduled = 0
    waiting = 0
    async with async_session() as db:
        rows = (
            await db.execute(
                select(CareerTask).where(
                    CareerTask.status.in_(("running", "queued", "waiting_for_approval"))
                )
            )
        ).scalars().all()
        for row in rows:
            if row.status == "running":
                error_message = "OfferU backend restarted while task was running"
                error_id = _record_task_error(
                    row.task_id,
                    message=error_message,
                    provider_id=row.runtime_provider or "",
                    run_id=row.run_id or "",
                    kind="task_restart",
                )
                row.status = "blocked"
                row.error = error_message
                row.retryable = True
                row.finished_at = _utc_now()
                row.progress_json = {
                    "stage": "blocked",
                    "percent": 0,
                    "error_id": error_id,
                }
                recovered += 1
            elif row.status == "waiting_for_approval":
                waiting += 1
            else:
                rescheduled += 1
        await db.commit()
    for row in rows:
        if row.status == "blocked":
            progress = row.progress_json if isinstance(row.progress_json, dict) else {}
            await _append_event(
                row.task_id,
                "task.blocked",
                {
                    "reason": "backend_restart",
                    "error_id": str(progress.get("error_id") or "")[:40],
                },
            )
        elif row.status == "queued":
            await _append_event(row.task_id, "task.recovered", {"reason": "backend_restart"})
            _schedule(row.task_id)
        else:
            await _append_event(
                row.task_id,
                "task.recovered",
                {"reason": "backend_restart", "status": "waiting_for_approval"},
            )
    return {"blocked": recovered, "rescheduled": rescheduled, "waiting_for_approval": waiting}


async def delegate_workspace_task(
    *,
    run_id: str,
    job_id: int,
    runtime_id: str,
    prompt: str,
    timeout_seconds: int = 240,
    web_search_mode: str = "disabled",
) -> dict[str, Any]:
    from app.services.artifact_workspace import ArtifactWorkspaceManager

    clean_run = str(run_id or "").strip()
    clean_prompt = str(prompt or "").strip()
    if not clean_prompt:
        raise ValueError("workspace.delegate requires a non-empty prompt")
    workspace = ArtifactWorkspaceManager(clean_run)
    workspace.verify()
    clean_job = int(job_id)
    if clean_job <= 0:
        raise ValueError("workspace.delegate requires a positive job_id")
    prompt_hash = hashlib.sha256(clean_prompt.encode("utf-8")).hexdigest()[:16]
    return await start_career_task(
        task_type="run_artifact",
        source="agent_bridge",
        target_type="job",
        target_id=str(clean_job),
        runtime_provider=str(runtime_id or "codex"),
        input={
            "workspace_run_id": clean_run,
            "job_id": clean_job,
            "prompt": clean_prompt,
            "timeout_seconds": max(1, min(int(timeout_seconds), 3600)),
            "web_search_mode": str(web_search_mode or "disabled"),
        },
        output_contract={"type": "object", "additionalProperties": True},
        run_id=clean_run,
        idempotency_key=f"workspace-delegate:{clean_run}:{clean_job}:{prompt_hash}",
    )


__all__ = [
    "TASK_STATUSES",
    "TASK_TYPES",
    "cancel_career_task",
    "delegate_workspace_task",
    "get_career_task",
    "get_career_task_result",
    "list_career_task_events",
    "list_career_tasks",
    "recover_career_tasks",
    "retry_career_task",
    "resume_career_task",
    "start_career_task",
]
