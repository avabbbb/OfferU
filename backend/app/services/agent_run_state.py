from __future__ import annotations

import hashlib
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

RUN_SCHEMA_VERSION = "offeru.agent_runs.v2"
# A Run never waits on the user: queued confirmations and Ask answers start a
# new turn on the same session (services/action_gate).
ACTIVE_STATUSES = {"created", "planning", "executing", "interrupted"}
TERMINAL_STATUSES = {"completed", "cancelled", "failed"}
MAX_RUNS = 200


def proposal_execution_blocker(run: dict[str, Any]) -> str:
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
        "status": "pending",
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
    status = "planning" if not steps else "executing"

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
            previous_event_sequence = int(row.event_sequence or 0)
            previous_steps = row.steps_json if isinstance(row.steps_json, list) else []
            next_status = cleaned["status"]
            failure_reason = cleaned["failure_reason"]
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
                }[next_status]
                pending_events.append(
                    (
                        terminal_type,
                        {"status": next_status, "failure_reason": failure_reason},
                    )
                )
            values = {
                "status": next_status,
                "steps_json": cleaned["steps"],
                "exit_criteria_json": cleaned["exit_criteria"],
                "llm_runtime_json": cleaned["llm_runtime"],
                "recovery_cursor_json": cleaned["recovery_cursor"],
                "final_result_json": cleaned["final_result"],
                "failure_reason": failure_reason,
                "event_sequence": AgentRunRecord.event_sequence
                + len(pending_events),
            }
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

    recovered = 0
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
            if runtime.get("runtime") not in {"pi_sdk_worker", "python_agent"}:
                continue
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
            # Keep the transport descriptor aligned with the recovered Run
            # lifecycle while preserving provider/model/session metadata.
            row.llm_runtime_json = {**runtime, "status": row.status}
        await db.commit()
    return {"interrupted": recovered}


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

    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


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
        "selection_mode": _selection_mode(getattr(row, "selection_mode", None)),
        "min_selections": int(getattr(row, "min_selections", 0) or 0),
        "max_selections": int(getattr(row, "max_selections", 0) or 0),
        "allow_skip": bool(
            True if getattr(row, "allow_skip", None) is None else row.allow_skip
        ),
        "answer": answer,
        "answer_digest": row.answer_digest or "",
        "created_at": str(row.created_at or ""),
        "answered_at": str(row.answered_at or ""),
        "consumed_at": str(row.consumed_at or ""),
    }


ASK_SELECTION_MODES = ("single", "multiple")


def _selection_mode(value: Any) -> str:
    mode = str(value or "").strip().lower()
    return mode if mode in ASK_SELECTION_MODES else "single"


def _normalize_selection_bounds(
    mode: str, min_selections: Any, max_selections: Any, option_count: int
) -> tuple[int, int]:
    """Clamp min/max so the question is always answerable (anti-deadlock)."""

    def _int(value: Any) -> int:
        try:
            return max(0, int(value or 0))
        except (TypeError, ValueError):
            return 0

    if mode == "single":
        return (min(_int(min_selections), 1, option_count), 1)
    upper = _int(max_selections)
    if option_count and upper:
        upper = min(upper, option_count)
    lower = min(_int(min_selections), option_count)
    if upper:
        lower = min(lower, upper)
    return (lower, upper)


def validate_agent_input_answer(
    request: dict[str, Any], answer: dict[str, Any]
) -> list[str]:
    """Return human-readable violations; an empty list means acceptable.

    Free text counts as the「其他」answer, so min_selections only applies when
    the user neither typed anything nor skipped.
    """

    selected = [str(item) for item in (answer.get("selected_option_ids") or [])]
    free_text = str(answer.get("free_text") or "").strip()
    skipped = bool(answer.get("skipped"))
    option_ids = {
        str(item.get("option_id"))
        for item in (request.get("options") or [])
        if isinstance(item, dict)
    }
    errors: list[str] = []
    if len(set(selected)) != len(selected):
        errors.append("选项重复。")
    unknown = [item for item in selected if item not in option_ids]
    if unknown:
        errors.append("包含不属于该问题的选项。")
    if skipped:
        if not request.get("allow_skip", True):
            errors.append("该问题不能跳过。")
        if selected or free_text:
            errors.append("跳过时不能同时提交选项或补充说明。")
        return errors
    if free_text and not request.get("allow_free_text", True):
        errors.append("该问题不接受自由输入。")
    mode = _selection_mode(request.get("selection_mode"))
    if mode == "single" and len(selected) > 1:
        errors.append("这是单选问题，只能选择一个选项。")
    maximum = int(request.get("max_selections") or 0)
    if mode == "multiple" and maximum and len(selected) > maximum:
        errors.append(f"最多选择 {maximum} 项。")
    if not free_text:
        minimum = max(int(request.get("min_selections") or 0), 1)
        if len(selected) < minimum:
            errors.append(
                "请选择一个选项、填写补充说明，或跳过。"
                if minimum == 1
                else f"至少选择 {minimum} 项，或填写补充说明。"
            )
    return errors


async def create_agent_input_request(
    run_id: str,
    *,
    question: str,
    reason: str = "",
    options: list[dict[str, Any]] | None = None,
    allow_free_text: bool = True,
    selection_mode: str = "single",
    min_selections: int = 0,
    max_selections: int = 0,
    allow_skip: bool = True,
) -> dict[str, Any]:
    """Persist one pending Ask for a run, or return the identical pending one.

    A second pending request with different content is refused so a run always
    waits on exactly one question; the Ask tool may retry identical arguments
    safely.
    """

    clean_question = str(question or "").strip()
    if not clean_question:
        raise ValueError("request_user_input 需要非空 question。")
    clean_options = []
    seen_option_ids: set[str] = set()
    for item in options or []:
        if not isinstance(item, dict):
            continue
        option_id = str(item.get("option_id") or "").strip()
        if not option_id or option_id in seen_option_ids:
            continue
        seen_option_ids.add(option_id)
        clean = {
            key: value
            for key, value in dict(item).items()
            if key in {"option_id", "label", "description"}
        }
        if item.get("recommended") is True:
            clean["recommended"] = True
        clean_options.append(clean)
    clean_mode = _selection_mode(selection_mode)
    if clean_mode == "single":
        # 单选最多一个推荐项，否则「推荐项预选」会产生非法的初始状态。
        first = True
        for option in clean_options:
            if option.get("recommended"):
                if not first:
                    option.pop("recommended", None)
                first = False
    clean_min, clean_max = _normalize_selection_bounds(
        clean_mode, min_selections, max_selections, len(clean_options)
    )
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
                selection_mode=clean_mode,
                min_selections=clean_min,
                max_selections=clean_max,
                allow_skip=bool(allow_skip),
                answer_json=None,
                answer_digest="",
            )
            db.add(request)
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
            violations = validate_agent_input_answer(
                _input_request_view(row), clean_answer
            )
            if violations:
                return {
                    "ok": False,
                    "error": "invalid",
                    "errors": violations,
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
