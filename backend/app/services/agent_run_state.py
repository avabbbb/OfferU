from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select

from app.database import async_session
from app.models.models import AgentRunEvent, AgentRunRecord, JobSearchTask
from app.services.security_redaction import redact_sensitive_value

RUN_SCHEMA_VERSION = "offeru.agent_runs.v2"
ACTIVE_STATUSES = {
    "created",
    "planning",
    "waiting_confirmation",
    "executing",
    "interrupted",
}
TERMINAL_STATUSES = {"completed", "cancelled", "failed", "needs_reconciliation"}
MAX_RUNS = 200


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def safe_result_preview(value: Any, limit: int = 6000) -> Any:
    value = redact_sensitive_value(value)
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
    raw_args = action.get("args") if isinstance(action.get("args"), dict) else {}
    args = redact_sensitive_value(raw_args)
    requires_confirmation = bool(action.get("requires_confirmation", True))
    return {
        "id": action_id,
        "idempotency_key": str(action.get("idempotency_key") or ""),
        "tool": tool,
        "args": args,
        "summary": redact_sensitive_value(str(action.get("summary") or tool)),
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
    task_id = str(run.get("task_id") or "").strip()
    if not run_id or not task_id:
        return None
    steps = [
        redact_sensitive_value(step)
        for step in (run.get("steps") or [])
        if isinstance(step, dict) and str(step.get("id") or "").strip()
    ]
    return {
        "schema_version": RUN_SCHEMA_VERSION,
        "id": run_id,
        "task_id": task_id,
        "conversation_id": str(run.get("conversation_id") or ""),
        "goal": redact_sensitive_value(str(run.get("goal") or ""), max_length=4000),
        "mode": str(run.get("mode") or "general"),
        "skill_id": str(run.get("skill_id") or ""),
        "skill_version": str(run.get("skill_version") or ""),
        "skill_snapshot": (
            redact_sensitive_value(run.get("skill_snapshot"))
            if isinstance(run.get("skill_snapshot"), dict)
            else {}
        ),
        "status": str(run.get("status") or "created"),
        "exit_criteria": [
            str(item)
            for item in (run.get("exit_criteria") or [])
            if str(item or "").strip()
        ],
        "steps": steps,
        "llm_runtime": (
            redact_sensitive_value(run.get("llm_runtime"))
            if isinstance(run.get("llm_runtime"), dict)
            else {}
        ),
        "recovery_cursor": (
            redact_sensitive_value(run.get("recovery_cursor"))
            if isinstance(run.get("recovery_cursor"), dict)
            else {}
        ),
        "final_result": (
            redact_sensitive_value(run.get("final_result"))
            if isinstance(run.get("final_result"), dict)
            else {}
        ),
        "failure_reason": redact_sensitive_value(
            str(run.get("failure_reason") or ""), max_length=1000
        ),
        "event_sequence": int(run.get("event_sequence") or 0),
        "created_at": str(run.get("created_at") or _now_iso()),
        "updated_at": str(run.get("updated_at") or _now_iso()),
    }


def _row_to_run(row: AgentRunRecord) -> dict[str, Any]:
    return {
        "schema_version": RUN_SCHEMA_VERSION,
        "id": row.run_id,
        "task_id": row.task_id,
        "conversation_id": row.conversation_id or "",
        "goal": redact_sensitive_value(row.goal or "", max_length=4000),
        "mode": row.mode or "general",
        "skill_id": row.skill_id or "",
        "skill_version": row.skill_version or "",
        "skill_snapshot": redact_sensitive_value(row.skill_snapshot_json or {}),
        "status": row.status or "created",
        "exit_criteria": row.exit_criteria_json or [],
        "steps": redact_sensitive_value(row.steps_json or []),
        "llm_runtime": redact_sensitive_value(row.llm_runtime_json or {}),
        "recovery_cursor": redact_sensitive_value(row.recovery_cursor_json or {}),
        "final_result": redact_sensitive_value(row.final_result_json or {}),
        "failure_reason": redact_sensitive_value(row.failure_reason or "", max_length=1000),
        "event_sequence": int(row.event_sequence or 0),
        "created_at": str(row.created_at) if row.created_at else None,
        "updated_at": str(row.updated_at) if row.updated_at else None,
        # ADR-0051 外部 Harness 身份与单写入租约（Slice 5 Harness 中性化）。
        "harness_name": row.harness_name or "",
        "harness_version": row.harness_version or "",
        "adapter_name": row.adapter_name or "",
        "adapter_version": row.adapter_version or "",
        "harness_session_id": row.harness_session_id or "",
        "lease_id": row.lease_id or "",
        "lease_expires_at": str(row.lease_expires_at) if row.lease_expires_at else None,
        "context_version": int(row.context_version or 0),
    }


async def _resolve_task(
    db,
    *,
    task_id: str,
    conversation_id: str,
    goal: str,
) -> JobSearchTask:
    if task_id:
        task = (
            await db.execute(
                select(JobSearchTask).where(JobSearchTask.task_id == task_id)
            )
        ).scalar_one_or_none()
        if task is None:
            raise ValueError(f"JobSearchTask {task_id} does not exist")
        return task

    if conversation_id:
        task = (
            await db.execute(
                select(JobSearchTask)
                .where(
                    JobSearchTask.conversation_id == conversation_id,
                    JobSearchTask.status == "active",
                )
                .order_by(JobSearchTask.updated_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if task is not None:
            return task

    task = JobSearchTask(
        task_id=f"task_{uuid.uuid4().hex[:16]}",
        conversation_id=conversation_id,
        title=(goal or "OfferU Agent task")[:300],
        goal=(goal or "")[:4000],
        status="active",
        domain_refs_json={},
    )
    db.add(task)
    await db.flush()
    return task


def _append_event_row(
    run: AgentRunRecord,
    *,
    event_type: str,
    payload: dict[str, Any] | None = None,
) -> AgentRunEvent:
    run.event_sequence = int(run.event_sequence or 0) + 1
    return AgentRunEvent(
        event_id=f"evt_{uuid.uuid4().hex}",
        run_id=run.run_id,
        sequence=run.event_sequence,
        event_type=event_type,
        payload_json=safe_result_preview(payload or {}),
    )


async def create_agent_run(
    *,
    conversation_id: str,
    goal: str,
    mode: str,
    skill_id: str = "",
    skill_version: str = "",
    skill_snapshot: dict[str, Any] | None = None,
    task_id: str = "",
    actions: list[dict[str, Any]],
    exit_criteria: list[str] | None = None,
    llm_runtime: dict[str, Any] | None = None,
    run_id: str = "",
) -> dict[str, Any]:
    now = _now_iso()
    steps = [_clean_action(action, index + 1) for index, action in enumerate(actions)]
    steps = [step for step in steps if step["tool"]]
    run_id = str(run_id or "").strip() or f"run_{uuid.uuid4().hex[:16]}"
    if re.fullmatch(r"run_[a-f0-9]{16,32}", run_id) is None:
        raise ValueError("Invalid Agent Run id")
    for step in steps:
        step["idempotency_key"] = f"{run_id}:{step['id']}"
    status = (
        "planning"
        if not steps
        else (
            "waiting_confirmation"
            if any(step["requires_confirmation"] for step in steps)
            else "executing"
        )
    )

    async with async_session() as db:
        task = await _resolve_task(
            db,
            task_id=str(task_id or ""),
            conversation_id=str(conversation_id or ""),
            goal=goal,
        )
        row = AgentRunRecord(
            run_id=run_id,
            task_id=task.task_id,
            conversation_id=str(conversation_id or ""),
            goal=redact_sensitive_value(str(goal or ""), max_length=4000),
            mode=str(mode or "general"),
            skill_id=str(skill_id or ""),
            skill_version=str(skill_version or ""),
            skill_snapshot_json=redact_sensitive_value(skill_snapshot or {}),
            status=status,
            steps_json=steps,
            exit_criteria_json=exit_criteria
            or ["all planned actions have completed"],
            llm_runtime_json=redact_sensitive_value(llm_runtime or {}),
            recovery_cursor_json={},
            final_result_json={},
            failure_reason="",
            event_sequence=0,
        )
        db.add(row)
        await db.flush()
        db.add(
            _append_event_row(
                row,
                event_type="run.started",
                payload={"goal": row.goal, "mode": row.mode, "task_id": row.task_id},
            )
        )
        if row.skill_id:
            db.add(
                _append_event_row(
                    row,
                    event_type="skill.selected",
                    payload={
                        "skill_id": row.skill_id,
                        "skill_version": row.skill_version,
                        "skill_snapshot": row.skill_snapshot_json,
                    },
                )
            )
        for step in steps:
            db.add(
                _append_event_row(
                    row,
                    event_type="operation.proposed",
                    payload={
                        "action_id": step["id"],
                        "operation": step["tool"],
                        "args": step["args"],
                        "idempotency_key": step["idempotency_key"],
                    },
                )
            )
        await db.commit()
        await db.refresh(row)
        result = _row_to_run(row)
        result["created_at"] = result["created_at"] or now
        return result


async def save_agent_run(
    run: dict[str, Any],
    *,
    event_type: str = "",
    event_payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    cleaned = _clean_run({**run, "updated_at": _now_iso()})
    if cleaned is None:
        raise ValueError("Invalid agent run")
    async with async_session() as db:
        row = (
            await db.execute(
                select(AgentRunRecord).where(
                    AgentRunRecord.run_id == cleaned["id"]
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise ValueError(f"Agent Run {cleaned['id']} does not exist")
        previous_status = row.status
        row.status = cleaned["status"]
        row.steps_json = cleaned["steps"]
        row.exit_criteria_json = cleaned["exit_criteria"]
        row.llm_runtime_json = cleaned["llm_runtime"]
        row.recovery_cursor_json = cleaned["recovery_cursor"]
        row.final_result_json = cleaned["final_result"]
        row.failure_reason = cleaned["failure_reason"]
        if event_type:
            db.add(
                _append_event_row(
                    row,
                    event_type=event_type,
                    payload=event_payload or {},
                )
            )
        if row.status != previous_status and row.status in TERMINAL_STATUSES:
            terminal_type = {
                "completed": "run.completed",
                "failed": "run.failed",
                "cancelled": "run.cancelled",
                "needs_reconciliation": "run.failed",
            }[row.status]
            db.add(
                _append_event_row(
                    row,
                    event_type=terminal_type,
                    payload={
                        "status": row.status,
                        "failure_reason": row.failure_reason,
                    },
                )
            )
        await db.commit()
        await db.refresh(row)
        return _row_to_run(row)


async def load_agent_run(run_id: str | None) -> dict[str, Any] | None:
    if not run_id:
        return None
    async with async_session() as db:
        row = (
            await db.execute(
                select(AgentRunRecord).where(
                    AgentRunRecord.run_id == str(run_id)
                )
            )
        ).scalar_one_or_none()
        return _row_to_run(row) if row is not None else None


async def find_active_agent_run(
    conversation_id: str | None,
) -> dict[str, Any] | None:
    if not conversation_id:
        return None
    async with async_session() as db:
        row = (
            await db.execute(
                select(AgentRunRecord)
                .where(
                    AgentRunRecord.conversation_id == str(conversation_id),
                    AgentRunRecord.status.in_(ACTIVE_STATUSES),
                )
                .order_by(AgentRunRecord.updated_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        return _row_to_run(row) if row is not None else None


async def list_agent_runs(
    conversation_id: str | None = None,
    task_id: str | None = None,
    limit: int = 20,
) -> list[dict[str, Any]]:
    safe_limit = max(1, min(int(limit or 20), 100))
    async with async_session() as db:
        query = select(AgentRunRecord)
        if conversation_id:
            query = query.where(
                AgentRunRecord.conversation_id == str(conversation_id)
            )
        if task_id:
            query = query.where(AgentRunRecord.task_id == str(task_id))
        rows = (
            await db.execute(
                query.order_by(AgentRunRecord.updated_at.desc()).limit(safe_limit)
            )
        ).scalars().all()
        return [_row_to_run(row) for row in rows]


async def list_agent_run_events(
    run_id: str,
    *,
    after_sequence: int = 0,
    limit: int = 200,
) -> list[dict[str, Any]]:
    safe_limit = max(1, min(int(limit or 200), 1000))
    async with async_session() as db:
        rows = (
            await db.execute(
                select(AgentRunEvent)
                .where(
                    AgentRunEvent.run_id == str(run_id),
                    AgentRunEvent.sequence > max(0, int(after_sequence or 0)),
                )
                .order_by(AgentRunEvent.sequence.asc())
                .limit(safe_limit)
            )
        ).scalars().all()
        return [
            {
                "event_id": row.event_id,
                "run_id": row.run_id,
                "sequence": row.sequence,
                "type": row.event_type,
                "timestamp": str(row.created_at),
                "payload": row.payload_json or {},
            }
            for row in rows
        ]


async def recover_interrupted_agent_runs() -> dict[str, int]:
    """Classify non-terminal Runs after process restart without replaying work."""

    recovered = 0
    reconciliation_required = 0
    async with async_session() as db:
        rows = (
            await db.execute(
                select(AgentRunRecord).where(
                    AgentRunRecord.status.in_({"planning", "executing"})
                )
            )
        ).scalars().all()
        for row in rows:
            runtime = (
                row.llm_runtime_json
                if isinstance(row.llm_runtime_json, dict)
                else {}
            )
            if runtime.get("runtime") != "pi_sdk_worker":
                continue
            steps = [
                dict(item)
                for item in (row.steps_json or [])
                if isinstance(item, dict)
            ]
            uncertain = any(
                step.get("status") == "executing" for step in steps
            )
            previous_status = row.status
            row.recovery_cursor_json = {
                **(
                    row.recovery_cursor_json
                    if isinstance(row.recovery_cursor_json, dict)
                    else {}
                ),
                "reason": "backend_or_worker_restart",
                "previous_status": previous_status,
                "last_event_sequence": int(row.event_sequence or 0),
                "recovered_at": _now_iso(),
            }
            if uncertain:
                row.status = "needs_reconciliation"
                row.failure_reason = (
                    "Run was interrupted while a confirmed Operation was executing; "
                    "automatic replay is forbidden."
                )
                reconciliation_required += 1
                db.add(
                    _append_event_row(
                        row,
                        event_type="recovery.reconciliation_required",
                        payload={
                            "previous_status": previous_status,
                            "reason": row.failure_reason,
                        },
                    )
                )
                db.add(
                    _append_event_row(
                        row,
                        event_type="run.failed",
                        payload={
                            "status": row.status,
                            "failure_reason": row.failure_reason,
                        },
                    )
                )
            else:
                row.status = "interrupted"
                row.failure_reason = ""
                recovered += 1
                db.add(
                    _append_event_row(
                        row,
                        event_type="recovery.interrupted",
                        payload={
                            "previous_status": previous_status,
                            "resume_available": bool(runtime.get("session_file")),
                        },
                    )
                )
        await db.commit()
    return {
        "interrupted": recovered,
        "needs_reconciliation": reconciliation_required,
    }


async def append_agent_run_event(
    run_id: str,
    *,
    event_type: str,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    async with async_session() as db:
        row = (
            await db.execute(
                select(AgentRunRecord).where(
                    AgentRunRecord.run_id == str(run_id)
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise ValueError(f"Agent Run {run_id} does not exist")
        event = _append_event_row(
            row,
            event_type=event_type,
            payload=payload or {},
        )
        db.add(event)
        await db.commit()
        await db.refresh(event)
        return {
            "event_id": event.event_id,
            "run_id": event.run_id,
            "sequence": event.sequence,
            "type": event.event_type,
            "timestamp": str(event.created_at),
            "payload": event.payload_json or {},
        }


async def propose_agent_run_action(
    run_id: str,
    *,
    operation: str,
    args: dict[str, Any],
    summary: str,
) -> dict[str, Any]:
    async with async_session() as db:
        row = (
            await db.execute(
                select(AgentRunRecord).where(
                    AgentRunRecord.run_id == str(run_id)
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise ValueError(f"Agent Run {run_id} does not exist")
        if row.status in TERMINAL_STATUSES:
            raise ValueError(
                f"Agent Run {run_id} is terminal ({row.status})"
            )
        steps = [
            dict(item)
            for item in (row.steps_json or [])
            if isinstance(item, dict)
        ]
        existing = next(
            (
                item
                for item in steps
                if item.get("status") == "waiting_confirmation"
                and str(item.get("tool") or "") == operation
                and (item.get("args") or {}) == args
            ),
            None,
        )
        if existing is not None:
            return existing
        action_id = f"{operation}:{len(steps) + 1}"
        step = _clean_action(
            {
                "id": action_id,
                "tool": operation,
                "args": args,
                "summary": summary,
                "risk_level": "confirm",
                "requires_confirmation": True,
            },
            len(steps) + 1,
        )
        step["idempotency_key"] = f"{row.run_id}:{action_id}"
        steps.append(step)
        row.steps_json = steps
        row.status = "waiting_confirmation"
        event = _append_event_row(
            row,
            event_type="operation.proposed",
            payload={
                "action_id": action_id,
                "operation": operation,
                "args": args,
                "idempotency_key": step["idempotency_key"],
            },
        )
        db.add(event)
        await db.commit()
        return step


def pending_actions_for_run(run: dict[str, Any]) -> list[dict[str, Any]]:
    actions: list[dict[str, Any]] = []
    for step in run.get("steps") or []:
        if not isinstance(step, dict) or step.get("status") != "waiting_confirmation":
            continue
        actions.append(
            {
                "id": str(step.get("id") or ""),
                "tool": str(step.get("tool") or ""),
                "args": (
                    step.get("args")
                    if isinstance(step.get("args"), dict)
                    else {}
                ),
                "summary": str(step.get("summary") or step.get("tool") or ""),
                "risk_level": str(step.get("risk_level") or "confirm"),
                "requires_confirmation": bool(
                    step.get("requires_confirmation", True)
                ),
            }
        )
    return [action for action in actions if action["id"] and action["tool"]]


def mark_run_actions_executed(
    run: dict[str, Any],
    tool_calls: list[dict[str, Any]],
) -> dict[str, Any]:
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
        step["error"] = (
            str(result.get("error"))
            if has_error and isinstance(result, dict)
            else None
        )
    statuses = {
        str(step.get("status") or "")
        for step in run.get("steps") or []
        if isinstance(step, dict)
    }
    if "failed" in statuses:
        run["status"] = "failed"
    elif statuses and statuses.issubset({"completed"}):
        run["status"] = "completed"
    elif "waiting_confirmation" in statuses:
        run["status"] = "waiting_confirmation"
    else:
        run["status"] = "executing"
    return run
