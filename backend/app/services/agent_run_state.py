from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select, update as sql_update

from app.database import async_session
from app.models.models import (
    AgentInputRequest,
    AgentRunEvent,
    AgentRunRecord,
    CareerTask,
    JobSearchTask,
)
from app.services.security_redaction import redact_sensitive_value

# Eagerly import proposal_plan_store so its module-level ``async_session``
# binding is captured at app import time (the real ``app.database.async_session``).
# Lazy import would otherwise first run inside a test that has patched
# ``app.database.async_session`` to an isolated (later disposed) session, leaving
# proposal_plan_store pinned to a dead engine and breaking recovery/confirmation
# for every subsequent Run in the same process (cross-test pollution).
import app.services.proposal_plan_store as _proposal_plan_store  # noqa: F401

RUN_SCHEMA_VERSION = "offeru.agent_runs.v2"
ACTIVE_STATUSES = {
    "created",
    "planning",
    "waiting_confirmation",
    "waiting_decision",
    "waiting_input",
    "executing",
    "interrupted",
}
TERMINAL_STATUSES = {"completed", "cancelled", "failed", "needs_reconciliation"}
# Recoverable pauses that keep the persisted session resumable; restart
# recovery must never classify them as terminal work.
WAITING_STATUSES = {"waiting_confirmation", "waiting_decision", "waiting_input"}
MAX_RUNS = 200


def proposal_execution_blocker(run: dict[str, Any]) -> str:
    legacy = (run.get("recovery_cursor") or {}).get("proposal_v2_legacy") or {}
    if run.get("legacy_review_required") or any(isinstance(item, dict) and item.get("classification") == "needs_review" for item in legacy.values()):
        return "旧提案原始参数无法验证；请在当前工作区重新准备并审核具体改动。"
    runtime = run.get("llm_runtime") or {}
    if runtime.get("runtime") == "pi_sdk_worker":
        return "旧 Pi 会话仅供历史查阅，不能通过当前 Python Agent 重放操作；请重新发起任务。"
    return ""


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
            career_task = await db.get(CareerTask, task_id)
            if career_task is None:
                raise ValueError(f"JobSearchTask {task_id} does not exist")
            # Existing scheduled tasks own their lifecycle; the Run's required
            # task container uses the same identity and canonical domain refs.
            task = JobSearchTask(
                task_id=task_id, conversation_id=conversation_id,
                title=(goal or "OfferU Agent task")[:300], goal=(goal or "")[:4000],
                status="active", primary_job_id=(int(career_task.target_id)
                    if career_task.target_type == "job" and str(career_task.target_id or "").isdigit() else None),
                domain_refs_json={"career_task_id": task_id, "target_type": career_task.target_type,
                                  "target_id": career_task.target_id},
            )
            db.add(task)
            await db.flush()
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


def _run_status_from_steps(
    steps: list[Any], *, fallback: str = "executing"
) -> str:
    statuses = {
        str(step.get("status") or "")
        for step in steps
        if isinstance(step, dict)
    }
    if "uncertain" in statuses:
        return "needs_reconciliation"
    if "failed" in statuses:
        return "failed"
    if "waiting_confirmation" in statuses:
        return "waiting_confirmation"
    if statuses.intersection({"pending", "executing"}):
        return "executing"
    if statuses and statuses.issubset({"completed", "rejected"}):
        return "completed"
    return fallback


def _preserve_rejected_steps(
    current_steps: list[Any], incoming_steps: list[Any]
) -> tuple[list[Any], bool]:
    """Keep persisted user rejections immutable across stale whole-run saves."""
    rejected = [
        (index, step)
        for index, step in enumerate(current_steps)
        if isinstance(step, dict) and step.get("status") == "rejected"
    ]
    if not rejected:
        return incoming_steps, False

    merged = [dict(step) if isinstance(step, dict) else step for step in incoming_steps]
    found_ids: set[str] = set()
    for index, current in rejected:
        action_id = str(current.get("id") or "")
        match = next(
            (
                position
                for position, step in enumerate(merged)
                if isinstance(step, dict) and str(step.get("id") or "") == action_id
            ),
            None,
        )
        if match is None:
            merged.insert(min(index, len(merged)), dict(current))
        else:
            merged[match] = dict(current)
        found_ids.add(action_id)
    return merged, bool(found_ids)


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
    from app.services.proposal_plan_store import list_plans
    try:
        # Cross-store read for status projection only: an unreachable plan
        # store must never block persisting the run itself. Fail safe to
        # "no plans bound to this run" and let the run's own step statuses
        # decide the next status.
        plans = await list_plans(run_id=str(run.get("id") or ""))
    except Exception:
        plans = []
    cleaned = _clean_run({**run, "updated_at": _now_iso()})
    if cleaned is None:
        raise ValueError("Invalid agent run")
    protected_terminal_statuses = {
        "failed",
        "needs_reconciliation",
        "cancelled",
    }
    for _ in range(3):
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
            previous_failure_reason = row.failure_reason
            previous_event_sequence = int(row.event_sequence or 0)
            previous_steps = row.steps_json if isinstance(row.steps_json, list) else []
            merged_steps, has_rejected_steps = _preserve_rejected_steps(
                previous_steps, cleaned["steps"]
            )
            if not has_rejected_steps:
                next_status = cleaned["status"]
            elif previous_status in protected_terminal_statuses:
                next_status = previous_status
            elif cleaned["status"] in protected_terminal_statuses:
                next_status = cleaned["status"]
            else:
                next_status = _run_status_from_steps(
                    merged_steps, fallback=cleaned["status"]
                )
            failure_reason = (
                previous_failure_reason
                if has_rejected_steps
                and previous_status in protected_terminal_statuses
                and not cleaned["failure_reason"]
                else cleaned["failure_reason"]
            )
            # Lifecycle rows and the Run snapshot commit together. The full
            # steps/status predicate makes a save retry if a concurrent action
            # decision changed the Run after this snapshot was read.
            pending_events: list[tuple[str, dict[str, Any]]] = []
            if event_type:
                pending_events.append((event_type, event_payload or {}))
            if next_status != previous_status and next_status in TERMINAL_STATUSES:
                terminal_type = {
                    "completed": "run.completed",
                    "failed": "run.failed",
                    "cancelled": "run.cancelled",
                    "needs_reconciliation": "run.failed",
                }[next_status]
                pending_events.append(
                    (
                        terminal_type,
                        {"status": next_status, "failure_reason": failure_reason},
                    )
                )
            values = {
                "status": next_status,
                "steps_json": merged_steps,
                "exit_criteria_json": cleaned["exit_criteria"],
                "llm_runtime_json": cleaned["llm_runtime"],
                "recovery_cursor_json": cleaned["recovery_cursor"],
                "final_result_json": cleaned["final_result"],
                "failure_reason": failure_reason,
                "event_sequence": AgentRunRecord.event_sequence
                + len(pending_events),
            }
            if plans:
                # Run steps are historical evidence only. New node authorization
                # and execution state never get written back through this save.
                values["steps_json"] = previous_steps
                values["status"] = _plan_run_status(plans, cleaned["status"])
            new_sequence = (
                await db.execute(
                    sql_update(AgentRunRecord)
                    .where(AgentRunRecord.run_id == cleaned["id"])
                    .where(AgentRunRecord.status == previous_status)
                    .where(AgentRunRecord.steps_json == previous_steps)
                    .where(AgentRunRecord.event_sequence == previous_event_sequence)
                    .values(**values)
                    .returning(AgentRunRecord.event_sequence)
                )
            ).scalar_one_or_none()
            if new_sequence is None:
                await db.rollback()
                continue
            base_sequence = int(new_sequence) - len(pending_events)
            for offset, (etype, epayload) in enumerate(pending_events):
                db.add(
                    AgentRunEvent(
                        event_id=f"evt_{uuid.uuid4().hex}",
                        run_id=row.run_id,
                        sequence=base_sequence + offset + 1,
                        event_type=etype,
                        payload_json=safe_result_preview(epayload),
                    )
                )
            await db.commit()
            await db.refresh(row)
            return _row_to_run(row)
    raise ValueError(
        f"Agent Run {cleaned['id']} changed concurrently; reload it and retry the save"
    )


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
        result = _row_to_run(row) if row is not None else None
    return await _attach_plan_projection(result) if result is not None else None


def _plan_run_status(plans: list[dict[str, Any]], fallback: str) -> str:
    if fallback in {"waiting_input", "waiting_user_input"}:
        return fallback
    if fallback == "cancelled":
        return "cancelled"
    groups = [group for plan in plans if plan.get("status") != "replaced" for group in plan.get("groups") or []]
    if any(group.get("status") == "needs_reconciliation" for group in groups):
        return "needs_reconciliation"
    if any(group.get("status") == "executing" for group in groups):
        return "executing"
    if any(group.get("status") in {"pending", "approved", "paused", "stale"} for group in groups):
        return "waiting_confirmation"
    # Committed plan does not prove the reasoning task completed.
    return fallback


async def _attach_plan_projection(run: dict[str, Any]) -> dict[str, Any]:
    from app.services.proposal_plan_store import list_plans
    try:
        # Cross-store projection read: an unreachable plan store must never
        # break loading the run itself; fall back to the unprojected run.
        plans = await list_plans(run_id=run["id"])
    except Exception:
        plans = []
    if not plans:
        legacy = (run.get("recovery_cursor") or {}).get("proposal_v2_legacy") or {}
        if any(isinstance(item, dict) and item.get("classification") == "needs_review" for item in legacy.values()):
            run["legacy_review_required"] = True
            run["proposal_authority"] = "proposal-plan-v2"
            run["steps"] = [{**step, "status": "blocked", "projection_only": True} for step in run.get("steps") or []]
            run["failure_reason"] = proposal_execution_blocker(run)
        return run
    steps = []
    for plan in plans:
        if plan.get("status") == "replaced":
            continue
        for group in plan.get("groups") or []:
            for node in group.get("nodes") or []:
                status = node["status"]
                if status == "pending":
                    status = "waiting_confirmation" if group["status"] == "pending" else "blocked"
                steps.append({"id": node["id"], "tool": node["operation"], "args": node["args"],
                              "summary": node["summary"], "status": status, "idempotency_key": node["idempotency_key"],
                              "requires_confirmation": group["status"] == "pending", "plan_id": plan["id"],
                              "group_id": group["id"], "group_digest": group["digest"], "projection_only": True,
                              "result": node.get("result"), "error": node.get("error")})
    run.update(steps=steps, proposal_plans=plans, proposal_authority="proposal-plan-v2", status=_plan_run_status(plans, run["status"]))
    if run.get("mode") == "ui_operation_request" and run["status"] not in {"cancelled", "needs_reconciliation"}:
        groups = [group for plan in plans if plan.get("status") != "replaced" for group in plan.get("groups") or []]
        if groups and all(group["status"] in {"completed", "rejected", "blocked"} for group in groups):
            run["status"] = "completed" if any(group["status"] == "completed" for group in groups) else "failed"
    return run


async def sync_proposal_plan_state(run_id: str, *, event_type: str = "proposal.plan_ready",
                                   payload: dict[str, Any] | None = None) -> dict[str, Any]:
    run = await load_agent_run(run_id)
    if run is None:
        raise ValueError("Agent Run does not exist")
    await save_agent_run(run, event_type=event_type, event_payload=payload or {})
    result = await load_agent_run(run_id)
    assert result is not None
    return result


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

    from app.services.proposal_plan_store import (
        migrate_legacy_proposals,
        recover_executing_nodes,
        list_plans,
    )
    # These only classify/control proposal state. They never invoke business
    # Operations or a reasoning engine during migration/startup.
    await migrate_legacy_proposals()
    await recover_executing_nodes()
    plan_run_ids = {plan["run_id"] for plan in await list_plans()}

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
            if row.run_id in plan_run_ids:
                plans = await list_plans(run_id=row.run_id)
                previous_status = row.status
                row.status = _plan_run_status(plans, "interrupted")
                if row.status == "needs_reconciliation":
                    row.failure_reason = "Run has an interrupted Operation with unknown effects; automatic replay is forbidden until reconciliation."
                    db.add(_append_event_row(row, event_type="recovery.reconciliation_required",
                        payload={"previous_status": previous_status, "reason": row.failure_reason, "authority": "proposal-plan-v2"}))
                    db.add(_append_event_row(row, event_type="run.failed",
                        payload={"status": row.status, "failure_reason": row.failure_reason}))
                    reconciliation_required += 1
                else:
                    recovered += 1
                continue
            runtime = (
                row.llm_runtime_json
                if isinstance(row.llm_runtime_json, dict)
                else {}
            )
            if runtime.get("runtime") not in {"pi_sdk_worker", "python_agent"}:
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
                            "resume_available": runtime.get("runtime") == "python_agent" and bool(runtime.get("session_file")),
                            "legacy_session_preserved": runtime.get("runtime") == "pi_sdk_worker",
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


async def propose_agent_run_action(run_id: str, *, operation: str, args: dict[str, Any], summary: str) -> dict[str, Any]:
    """Legacy write interface retired; steps are read-only history/projections."""
    raise ValueError("Operation-level proposal writes are retired; prepare and review a Proposal Plan")


async def reject_agent_run_action(run_id: str, *, action_id: str | None = None) -> dict[str, Any]:
    """Legacy step-backed rejection cannot mint a ConfirmationDecision."""
    return {"error": "Legacy action decisions are retired; reject the displayed ConfirmationGroup in Desktop"}


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
                "plan_id": step.get("plan_id"),
                "group_id": step.get("group_id"),
                "group_digest": step.get("group_digest"),
                "projection_only": bool(step.get("projection_only")),
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
    run["status"] = _run_status_from_steps(
        run.get("steps") or [], fallback="executing"
    )
    return run


# ---------------------------------------------------------------------------
# Structured Ask (AgentInputRequest) persistence.
#
# A request is collaboration about preferences/strategy — it is never a
# proposal and never authorizes a mutation. At most one request may be
# ``pending`` per run; identical Ask calls in the same turn collapse onto the
# already persisted row instead of stacking prompts.
# ---------------------------------------------------------------------------


def _input_request_signature(question: str, options: list[Any]) -> str:
    payload = {
        "question": str(question or ""),
        "options": options if isinstance(options, list) else [],
    }
    return canonical_json_digest(payload)


def canonical_json_digest(value: Any) -> str:
    """Contract canonical JSON digest — delegated to the Domain implementation."""

    from app.services.proposal_plan_builder import canonical_digest

    return canonical_digest(value)


def _input_request_view(row: AgentInputRequest) -> dict[str, Any]:
    answer = row.answer_json if isinstance(row.answer_json, dict) else None
    return {
        "request_id": row.request_id,
        "run_id": row.run_id,
        "status": row.status,
        "question": row.question,
        "reason": row.reason or "",
        "options": list(row.options_json or []),
        "allow_free_text": bool(row.allow_free_text),
        "answer": answer,
        "answer_digest": row.answer_digest or "",
        "created_at": str(row.created_at or ""),
        "answered_at": str(row.answered_at or ""),
        "consumed_at": str(row.consumed_at or ""),
    }


async def create_agent_input_request(
    run_id: str,
    *,
    question: str,
    reason: str = "",
    options: list[dict[str, Any]] | None = None,
    allow_free_text: bool = True,
) -> dict[str, Any]:
    """Persist one pending Ask for a run, or return the identical pending one.

    A second pending request with different content is refused so a run always
    waits on exactly one question; the Ask tool may retry identical arguments
    safely.
    """

    clean_question = str(question or "").strip()
    if not clean_question:
        raise ValueError("request_user_input 需要非空 question。")
    clean_options = [
        {
            key: value
            for key, value in dict(item).items()
            if key in {"option_id", "label", "description"}
        }
        for item in (options or [])
        if isinstance(item, dict) and str(item.get("option_id") or "").strip()
    ]
    signature = _input_request_signature(clean_question, clean_options)
    for _ in range(3):
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
            pending = (
                (
                    await db.execute(
                        select(AgentInputRequest).where(
                            AgentInputRequest.run_id == str(run_id),
                            AgentInputRequest.status == "pending",
                        )
                    )
                )
                .scalars()
                .all()
            )
            if pending:
                identical = next(
                    (
                        item
                        for item in pending
                        if _input_request_signature(
                            item.question, list(item.options_json or [])
                        )
                        == signature
                    ),
                    None,
                )
                if identical is not None:
                    return _input_request_view(identical)
                raise ValueError(
                    "该 Agent Run 已有一个待回答的提问；请先回答它再提问。"
                )
            request = AgentInputRequest(
                request_id=f"input_{uuid.uuid4().hex}",
                run_id=row.run_id,
                status="pending",
                question=clean_question[:4000],
                reason=str(reason or "")[:2000],
                options_json=redact_sensitive_value(clean_options),
                allow_free_text=bool(allow_free_text),
                answer_json=None,
                answer_digest="",
            )
            db.add(request)
            # Persist the wait with the question so a restart between the
            # tool result and host projection cannot hide the unanswered Ask.
            row.status = "waiting_input"
            try:
                await db.commit()
            except Exception:
                await db.rollback()
                continue
            await db.refresh(request)
            return _input_request_view(request)
    raise RuntimeError(
        f"Agent Run {run_id} changed concurrently while asking for input; retry"
    )


async def list_pending_agent_input_requests(run_id: str) -> list[dict[str, Any]]:
    async with async_session() as db:
        rows = (
            (
                await db.execute(
                    select(AgentInputRequest)
                    .where(
                        AgentInputRequest.run_id == str(run_id),
                        AgentInputRequest.status == "pending",
                    )
                    .order_by(AgentInputRequest.created_at)
                )
            )
            .scalars()
            .all()
        )
        return [_input_request_view(row) for row in rows]


async def load_agent_input_request(
    run_id: str, request_id: str
) -> dict[str, Any] | None:
    async with async_session() as db:
        row = (
            await db.execute(
                select(AgentInputRequest).where(
                    AgentInputRequest.run_id == str(run_id),
                    AgentInputRequest.request_id == str(request_id),
                )
            )
        ).scalar_one_or_none()
        return _input_request_view(row) if row is not None else None


async def answer_agent_input_request(
    run_id: str,
    request_id: str,
    *,
    answer: dict[str, Any],
) -> dict[str, Any]:
    """Store one answer idempotently; ``consumed_at`` stays untouched here.

    Returns ``{"ok", "request", "duplicate"}`` — a replayed identical answer
    returns the stored row, a mismatched replay on an answered request fails
    closed.
    """

    clean_answer = redact_sensitive_value(
        answer if isinstance(answer, dict) else {}
    )
    digest = canonical_json_digest(clean_answer)
    for _ in range(3):
        async with async_session() as db:
            row = (
                await db.execute(
                    select(AgentInputRequest).where(
                        AgentInputRequest.run_id == str(run_id),
                        AgentInputRequest.request_id == str(request_id),
                    )
                )
            ).scalar_one_or_none()
            if row is None:
                return {"ok": False, "error": "not_found"}
            if row.status == "answered":
                if (
                    row.answer_digest == digest
                    and isinstance(row.answer_json, dict)
                    and row.answer_json == clean_answer
                ):
                    return {
                        "ok": True,
                        "request": _input_request_view(row),
                        "duplicate": True,
                    }
                return {
                    "ok": False,
                    "error": "conflict",
                    "request": _input_request_view(row),
                }
            if row.status != "pending":
                return {
                    "ok": False,
                    "error": "conflict",
                    "request": _input_request_view(row),
                }
            claimed = (
                await db.execute(
                    sql_update(AgentInputRequest)
                    .where(
                        AgentInputRequest.request_id == row.request_id,
                        AgentInputRequest.status == "pending",
                    )
                    .values(
                        status="answered",
                        answer_json=clean_answer,
                        answer_digest=digest,
                        answered_at=datetime.now(timezone.utc).replace(
                            tzinfo=None
                        ),
                    )
                )
            ).rowcount or 0
            if not claimed:
                await db.rollback()
                continue
            await db.commit()
            await db.refresh(row)
            return {
                "ok": True,
                "request": _input_request_view(row),
                "duplicate": False,
            }
    return {"ok": False, "error": "conflict"}


async def consume_agent_input_request(request_id: str) -> bool:
    """Claim the one allowed same-run continuation for an answered request."""

    async with async_session() as db:
        claimed = (
            await db.execute(
                sql_update(AgentInputRequest)
                .where(
                    AgentInputRequest.request_id == str(request_id),
                    AgentInputRequest.status == "answered",
                    AgentInputRequest.consumed_at.is_(None),
                )
                .values(
                    consumed_at=datetime.now(timezone.utc).replace(tzinfo=None)
                )
            )
        ).rowcount or 0
        await db.commit()
        return bool(claimed)


async def expire_pending_agent_input_requests(
    run_id: str, *, reason: str = ""
) -> int:
    """Fail closed on run end: a pending Ask can never outlive its turn."""

    async with async_session() as db:
        rows = (
            (
                await db.execute(
                    select(AgentInputRequest).where(
                        AgentInputRequest.run_id == str(run_id),
                        AgentInputRequest.status == "pending",
                    )
                )
            )
            .scalars()
            .all()
        )
        for row in rows:
            row.status = "expired"
            if reason:
                row.answer_json = {
                    **(row.answer_json if isinstance(row.answer_json, dict) else {}),
                    "expired_reason": str(reason)[:500],
                }
        await db.commit()
        return len(rows)
