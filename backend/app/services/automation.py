"""OfferU event-to-task automation.

Automation is an explicit rule dispatcher, not a second Agent Loop.  It owns
durable signals and the user-facing inbox, while CareerTask and the Operation
Registry remain the only execution/control boundaries.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from app.database import async_session
from app.services.diagnostics import new_error_id, record_error
from app.models.models import (
    AutomationEvent,
    AutomationInboxItem,
    CareerTask,
    AutomationRule,
    JobResearchRun,
)
from app.services.security_redaction import (
    redact_secret_text,
    redact_secret_value,
    redact_sensitive_text,
    safe_error_message,
)


AUTOMATION_EVENT_TYPES = frozenset(
    {
        "JOB_SAVED",
        "JOB_UPDATED",
        "APPLICATION_CREATED",
        "APPLICATION_SUBMITTED",
        "APPLICATION_STAGE_CANDIDATE",
        "EMAIL_RECEIVED",
        "INTERVIEW_INVITATION_DETECTED",
        "REJECTION_DETECTED",
        "OFFER_DETECTED",
        "CAREER_FILE_CHANGED",
        "CAREER_FACT_CANDIDATE_CREATED",
        "RESUME_UPDATED",
        "INTERVIEW_COMPLETED",
        "INTERVIEW_DEBRIEF_CREATED",
        "ROLE_BENCHMARK_STALE",
        "DAILY_REVIEW",
        "WEEKLY_REVIEW",
    }
)
AUTOMATION_EVENT_STATUSES = frozenset(
    {"queued", "processing", "dispatched", "completed", "failed", "blocked", "skipped"}
)
INBOX_CATEGORIES = frozenset(
    {"needs_approval", "needs_review", "fyi", "completed", "failed"}
)
INBOX_STATUSES = frozenset({"pending", "resolved", "dismissed"})

_DEFAULT_RULES: dict[str, dict[str, Any]] = {
    "JOB_SAVED": {
        "task_type": "role_intelligence",
        "runtime_provider": "auto",
        "enabled": True,
        "automation_level": "derived_candidate",
        "description": "保存岗位后后台建立岗位情报；结果仍是候选/提案。",
    },
}

_AUTOMATION_EVENT_CREATE_LOCK = asyncio.Lock()
_AUTOMATION_EVENT_PROCESS_LOCK = asyncio.Lock()


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _bounded(value: Any, limit: int = 120_000) -> Any:
    value = redact_secret_value(value, max_length=limit)
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    try:
        encoded = json.dumps(value, ensure_ascii=False, sort_keys=True)
    except (TypeError, ValueError):
        return str(value)[:limit]
    if len(encoded) <= limit:
        return value
    return {"preview": encoded[:limit], "truncated": True}


def _event_view(row: AutomationEvent) -> dict[str, Any]:
    return {
        "event_id": row.event_id,
        "event_type": row.event_type,
        "source": row.source or "",
        "target_type": row.target_type or "",
        "target_id": row.target_id or "",
        "payload": redact_secret_value(row.payload_json if isinstance(row.payload_json, dict) else {}),
        "dedupe_key": row.dedupe_key,
        "status": row.status,
        "result": redact_secret_value(row.result_json if isinstance(row.result_json, dict) else {}),
        "error": redact_sensitive_text(row.error or "", max_length=2000),
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "processed_at": row.processed_at.isoformat() if row.processed_at else None,
    }


def _inbox_view(row: AutomationInboxItem, task: CareerTask | None = None) -> dict[str, Any]:
    view = {
        "item_id": row.item_id,
        "category": row.category,
        "status": row.status,
        "event_id": row.event_id or "",
        "task_id": row.task_id or "",
        "operation": row.operation or "",
        "proposal_run_id": row.proposal_run_id or "",
        "target_type": row.target_type or "",
        "target_id": row.target_id or "",
        "title": redact_secret_text(row.title or "", max_length=300),
        "body": redact_secret_text(row.body or "", max_length=20_000),
        "payload": redact_secret_value(row.payload_json if isinstance(row.payload_json, dict) else {}),
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        "resolved_at": row.resolved_at.isoformat() if row.resolved_at else None,
    }
    # The inbox row is durable user-facing workflow state, while the linked
    # CareerTask owns the live execution state.  Project a bounded snapshot so
    # Today can show progress/retryability without duplicating task truth.
    task_progress = (
        task.progress_json
        if task is not None and isinstance(task.progress_json, dict)
        else {}
    )
    view.update(
        {
            "task_status": task.status if task is not None else None,
            "task_progress": redact_secret_value(task_progress),
            "task_error_id": str(task_progress.get("error_id") or "")[:40],
            "task_error": redact_sensitive_text(task.error or "", max_length=2000) if task is not None else "",
            "task_retryable": bool(task.retryable) if task is not None else False,
            "task_attempt_count": int(task.attempt_count or 0) if task is not None else 0,
            "task_max_attempts": int(task.max_attempts or 0) if task is not None else 0,
        }
    )
    return view


def _rule_view(row: AutomationRule | None, event_type: str) -> dict[str, Any]:
    default = _DEFAULT_RULES.get(event_type, {})
    if row is None:
        return {
            "rule_id": f"default:{event_type.lower()}",
            "event_type": event_type,
            "task_type": default.get("task_type", ""),
            "enabled": bool(default.get("enabled", False)),
            "policy": default,
            "version": "default.v1",
            "source": "built_in",
        }
    return {
        "rule_id": row.rule_id,
        "event_type": row.event_type,
        "task_type": row.task_type,
        "enabled": bool(row.enabled),
        "policy": row.policy_json if isinstance(row.policy_json, dict) else {},
        "version": row.version,
        "source": "stored",
    }


def _dedupe_key(
    *,
    event_type: str,
    source: str,
    target_type: str,
    target_id: str,
    payload: dict[str, Any],
) -> str:
    canonical = json.dumps(
        {
            "event_type": event_type,
            "source": source,
            "target_type": target_type,
            "target_id": target_id,
            "payload": payload,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return f"automation:{hashlib.sha256(canonical.encode('utf-8')).hexdigest()}"


async def _rule(event_type: str) -> dict[str, Any]:
    async with async_session() as db:
        row = (
            await db.execute(
                select(AutomationRule).where(AutomationRule.event_type == event_type)
            )
        ).scalar_one_or_none()
    return _rule_view(row, event_type)


async def list_automation_rules(*, enabled: bool | None = None) -> dict[str, Any]:
    async with async_session() as db:
        rows = (await db.execute(select(AutomationRule).order_by(AutomationRule.event_type))).scalars().all()
    stored = {row.event_type: row for row in rows}
    event_types = sorted(set(_DEFAULT_RULES) | set(stored))
    items = [_rule_view(stored.get(event_type), event_type) for event_type in event_types]
    if enabled is not None:
        items = [item for item in items if item["enabled"] == enabled]
    return {"rules": items}


async def _upsert_inbox(
    *,
    item_id: str,
    category: str,
    event_id: str = "",
    task_id: str = "",
    target_type: str = "",
    target_id: str = "",
    title: str,
    body: str,
    payload: dict[str, Any] | None = None,
    operation: str = "",
    proposal_run_id: str = "",
) -> dict[str, Any]:
    if category not in INBOX_CATEGORIES:
        raise ValueError(f"不支持的 Automation Inbox 类别: {category}")
    async with async_session() as db:
        row = await db.get(AutomationInboxItem, item_id)
        if row is None:
            row = AutomationInboxItem(
                item_id=item_id,
                category=category,
                status="pending",
                event_id=event_id,
                task_id=task_id,
                operation=operation,
                proposal_run_id=proposal_run_id,
                target_type=target_type,
                target_id=target_id,
                title=redact_secret_text(title, max_length=300),
                body=redact_secret_text(body, max_length=20_000),
                payload_json=_bounded(payload or {}),
            )
            db.add(row)
        else:
            row.category = category
            row.event_id = event_id or row.event_id
            row.task_id = task_id or row.task_id
            row.operation = operation or row.operation
            row.proposal_run_id = proposal_run_id or row.proposal_run_id
            row.target_type = target_type or row.target_type
            row.target_id = target_id or row.target_id
            row.title = redact_secret_text(title, max_length=300)
            row.body = redact_secret_text(body, max_length=20_000)
            row.payload_json = _bounded(payload or {})
            if row.status in {"resolved", "dismissed"}:
                row.status = "pending"
                row.resolved_at = None
        try:
            await db.commit()
        except IntegrityError:
            # The primary key is the cross-process authority when two
            # recovery paths project the same task at once.  Reuse the row
            # committed by the winner instead of reporting a false failure.
            await db.rollback()
            existing = await db.get(AutomationInboxItem, item_id)
            if existing is None:
                raise
            row = existing
        await db.refresh(row)
        return _inbox_view(row)


async def _dispatch_job_saved(event: AutomationEvent, rule: dict[str, Any]) -> dict[str, Any]:
    from app.services.career_tasks import start_career_task

    payload = event.payload_json if isinstance(event.payload_json, dict) else {}
    job_id = int(payload.get("job_id") or event.target_id or 0)
    if job_id <= 0:
        raise ValueError("JOB_SAVED 缺少有效 job_id")
    policy = rule.get("policy") if isinstance(rule.get("policy"), dict) else {}
    provider = str(payload.get("runtime_provider") or policy.get("runtime_provider") or "auto")
    task = await start_career_task(
        task_type="role_intelligence",
        source="automation",
        target_type="job",
        target_id=str(job_id),
        runtime_provider=provider,
        input={
            "job_id": job_id,
            "automation_event_id": event.event_id,
            **{
                key: str(payload.get(key) or "")
                for key in ("role_family", "specialization", "seniority", "region", "industry")
                if payload.get(key)
            },
        },
        output_contract={"schema": "offeru.role_benchmark_result.v1", "type": "object"},
        idempotency_key=f"automation:{event.event_id}:role-intelligence",
    )
    await _upsert_inbox(
        item_id=f"automation_task_{task['task_id']}",
        category="fyi",
        event_id=event.event_id,
        task_id=task["task_id"],
        target_type="job",
        target_id=str(job_id),
        title="岗位情报后台任务已排队",
        body=(
            f"OfferU 已为岗位 #{job_id} 创建 Role Intelligence CareerTask。"
            "结果会先作为候选/提案进入收件箱，不会静默修改 Career Profile。"
        ),
        payload={"runtime_provider": provider, "task": task},
    )
    return {"task": task, "job_id": job_id, "runtime_provider": provider}


async def _update_event(
    event_id: str,
    *,
    status: str,
    result: dict[str, Any] | None = None,
    error: str = "",
    expected_statuses: tuple[str, ...] = ("processing",),
) -> dict[str, Any]:
    async with async_session() as db:
        db_result = await db.execute(
            update(AutomationEvent)
            .where(AutomationEvent.event_id == event_id)
            .where(AutomationEvent.status.in_(expected_statuses))
            .values(
                status=status,
                result_json=_bounded(result or {}),
                error=redact_sensitive_text(error or "", max_length=2000),
                processed_at=_now(),
            )
        )
        if int(db_result.rowcount or 0) != 1:
            await db.rollback()
            row = await db.get(AutomationEvent, event_id)
            if row is None:
                raise ValueError(f"AutomationEvent {event_id} 不存在")
            return _event_view(row)
        await db.commit()
        row = await db.get(AutomationEvent, event_id)
        if row is None:
            raise ValueError(f"AutomationEvent {event_id} 不存在")
        await db.refresh(row)
        return _event_view(row)


async def _claim_automation_event(event_id: str) -> AutomationEvent | None:
    """Atomically claim one queued signal across backend processes."""

    async with async_session() as db:
        db_result = await db.execute(
            update(AutomationEvent)
            .where(AutomationEvent.event_id == str(event_id or ""))
            .where(AutomationEvent.status == "queued")
            .values(
                status="processing",
                error="",
                # While processing, this is a lease timestamp. Terminal
                # transitions overwrite it with the completion timestamp.
                processed_at=_now(),
            )
        )
        if int(db_result.rowcount or 0) != 1:
            await db.rollback()
            return None
        await db.commit()
        return await db.get(AutomationEvent, str(event_id or ""))


async def _prepare_resume_candidate(job_id: int) -> dict[str, Any]:
    """Use the existing resume proposal operation when its prerequisites exist."""

    async with async_session() as db:
        research = (
            await db.execute(
                select(JobResearchRun)
                .where(JobResearchRun.job_id == int(job_id))
                .where(JobResearchRun.status == "completed")
                .where(JobResearchRun.review_status == "accepted")
                .order_by(
                    JobResearchRun.completed_at.desc(),
                    JobResearchRun.updated_at.desc(),
                )
            )
        ).scalars().first()
    if research is None:
        return {
            "status": "blocked",
            "reason": "需要一份已完成并通过审核的岗位调研，才能生成现有 Resume Proposal。",
            "next_operation": "start_job_research",
        }

    from app.ops import execute_operation

    result = await execute_operation(
        "prepare_resume_optimization",
        {
            "job_id": int(job_id),
            "research_run_id": research.run_id,
        },
        surface="automation",
    )
    if not result.get("ok"):
        return {
            "status": "failed",
            "research_run_id": research.run_id,
            "errors": [str(item) for item in result.get("errors") or []],
        }
    proposal = result.get("outputs") if isinstance(result.get("outputs"), dict) else {}
    return {
        "status": "ready",
        "research_run_id": research.run_id,
        "proposal": proposal,
        "next_operation": "review_resume_optimization",
    }


async def record_automation_event(
    *,
    event_type: str,
    source: str = "system",
    target_type: str = "",
    target_id: str = "",
    payload: dict[str, Any] | None = None,
    dedupe_key: str = "",
) -> dict[str, Any]:
    clean_type = str(event_type or "").strip().upper()
    if clean_type not in AUTOMATION_EVENT_TYPES:
        raise ValueError(f"不支持的 AutomationEvent: {clean_type}")
    clean_source = str(source or "system").strip()[:80]
    clean_target_type = str(target_type or "").strip()[:80]
    clean_target_id = str(target_id or "").strip()[:160]
    clean_payload = redact_secret_value(payload if isinstance(payload, dict) else {})
    clean_key = str(dedupe_key or "").strip() or _dedupe_key(
        event_type=clean_type,
        source=clean_source,
        target_type=clean_target_type,
        target_id=clean_target_id,
        payload=clean_payload,
    )
    stored_key = clean_key[:180]
    async with _AUTOMATION_EVENT_CREATE_LOCK:
        async with async_session() as db:
            existing = (
                await db.execute(
                    select(AutomationEvent).where(AutomationEvent.dedupe_key == stored_key)
                )
            ).scalar_one_or_none()
            if existing is not None:
                event_id = existing.event_id
                reused = True
            else:
                event = AutomationEvent(
                    event_id=f"automation_evt_{uuid.uuid4().hex[:24]}",
                    event_type=clean_type,
                    source=clean_source,
                    target_type=clean_target_type,
                    target_id=clean_target_id,
                    payload_json=_bounded(clean_payload),
                    dedupe_key=stored_key,
                    status="queued",
                )
                db.add(event)
                try:
                    await db.commit()
                except IntegrityError:
                    # The unique constraint remains authoritative across
                    # multiple backend processes; reuse the committed winner.
                    await db.rollback()
                    existing = (
                        await db.execute(
                            select(AutomationEvent).where(
                                AutomationEvent.dedupe_key == stored_key
                            )
                        )
                    ).scalar_one_or_none()
                    if existing is None:
                        raise
                    event_id = existing.event_id
                    reused = True
                else:
                    event_id = event.event_id
                    reused = False
    return {**(await _process_automation_event(event_id)), "reused": reused}


async def _process_automation_event(event_id: str) -> dict[str, Any]:
    """Process one queued signal exactly once within this backend process."""

    async with _AUTOMATION_EVENT_PROCESS_LOCK:
        event = await _claim_automation_event(event_id)
        if event is None:
            async with async_session() as db:
                current = await db.get(AutomationEvent, str(event_id or ""))
            if current is None:
                raise ValueError(f"AutomationEvent {event_id} 不存在")
            return _event_view(current)

        rule = await _rule(event.event_type)
        if not rule["enabled"]:
            return await _update_event(event.event_id, status="skipped", result={"rule": rule})
        if event.event_type != "JOB_SAVED":
            return await _update_event(event.event_id, status="completed", result={"rule": rule})
        try:
            result = await _dispatch_job_saved(event, rule)
        except Exception as exc:  # keep the signal visible; never claim success
            blocked = any(
                marker in str(exc).casefold()
                for marker in ("401", "unauthorized", "invalid_api_key", "authentication")
            )
            error_message = "provider authentication failed" if blocked else safe_error_message(exc)
            error_id = new_error_id()
            record_error(
                error_id,
                method="AUTOMATION",
                path=f"/api/agent/automation/events/{event.event_id}",
                status_code=503 if blocked else 500,
                kind="automation_provider_blocked" if blocked else "automation_dispatch",
                message=error_message,
                provider_id=(
                    str(event.payload_json.get("runtime_provider") or "")
                    if isinstance(event.payload_json, dict)
                    else ""
                ),
            )
            return await _update_event(
                event.event_id,
                status="blocked" if blocked else "failed",
                result={"error_id": error_id},
                error=error_message,
            )
        return await _update_event(event.event_id, status="dispatched", result=result)


async def recover_automation_events() -> dict[str, int]:
    """Resume signals committed before a backend restart but not yet processed."""

    async with async_session() as db:
        rows = (
            await db.execute(
                select(AutomationEvent)
                .where(AutomationEvent.status.in_(("queued", "processing")))
                .order_by(AutomationEvent.created_at.asc())
            )
        ).scalars().all()
        event_ids: list[str] = []
        for row in rows:
            if row.status == "processing":
                # A processing event has no durable provider-side commit of
                # its own. Requeue it after startup so the idempotent task
                # boundary can safely finish the dispatch.
                db_result = await db.execute(
                    update(AutomationEvent)
                    .where(AutomationEvent.event_id == row.event_id)
                    .where(AutomationEvent.status == "processing")
                    .values(status="queued", processed_at=None, error="")
                )
                if int(db_result.rowcount or 0) != 1:
                    continue
            event_ids.append(row.event_id)
        await db.commit()
    recovered = 0
    completed = 0
    failed = 0
    for event_id in event_ids:
        result = await _process_automation_event(event_id)
        recovered += 1
        if result["status"] in {"failed", "blocked"}:
            failed += 1
        elif result["status"] in {"completed", "dispatched", "skipped"}:
            completed += 1
    return {"recovered": recovered, "completed": completed, "failed": failed}


async def handle_career_task_finished(task_id: str) -> dict[str, Any] | None:
    """Project a terminal CareerTask into the Automation Inbox.

    The focus plan is read/derived through the existing Operation Registry;
    no Profile or Resume truth is written here.
    """

    from app.services.career_tasks import get_career_task

    task = await get_career_task(task_id)
    if task["task_type"] != "role_intelligence":
        return None
    input_payload = task.get("input") if isinstance(task.get("input"), dict) else {}
    event_id = str(input_payload.get("automation_event_id") or "")
    if not event_id:
        return None
    result = task.get("result") if isinstance(task.get("result"), dict) else {}
    benchmark = result.get("benchmark") if isinstance(result.get("benchmark"), dict) else {}
    focus_plan: dict[str, Any] = {}
    resume_candidate: dict[str, Any] = {}
    if task["status"] == "completed":
        from app.ops import execute_operation

        focus_result = await execute_operation(
            "prepare_role_interview_focus",
            {
                "job_id": int(task.get("target_id") or input_payload.get("job_id") or 0),
                "run_id": str(result.get("benchmark_run_id") or ""),
                "question_count": 5,
                "focus_count": 5,
            },
            surface="automation",
        )
        if focus_result.get("ok") and isinstance(focus_result.get("outputs"), dict):
            focus_plan = focus_result["outputs"]
        resume_candidate = await _prepare_resume_candidate(
            int(task.get("target_id") or input_payload.get("job_id") or 0)
        )
    category = "needs_review" if task["status"] == "completed" else "failed"
    body = (
        f"Role Intelligence 已完成：{benchmark.get('valid_sample_count', 0)} 个有效 comparator，"
        f"{len(benchmark.get('signals') or [])} 个 Delta signal。"
        "请查看岗位证据、Resume Proposal 和专项训练 Focus Plan。"
        if task["status"] == "completed"
        else f"Role Intelligence 未完成：{task.get('error') or '任务失败'}"
    )
    packet_status = (
        "ready"
        if task["status"] == "completed"
        and focus_plan
        and resume_candidate.get("status") == "ready"
        else "partial"
        if task["status"] == "completed"
        else "blocked"
    )
    application_packet = {
        "schema": "offeru.application_packet.v1",
        "status": packet_status,
        "job_id": int(task.get("target_id") or input_payload.get("job_id") or 0),
        "benchmark_run_id": result.get("benchmark_run_id"),
        "research_run_id": resume_candidate.get("research_run_id")
        or result.get("fixture_research_run_id"),
        "resume_candidate": resume_candidate,
        "interview_focus_plan": focus_plan,
    }
    task_summary = {
        key: task.get(key)
        for key in (
            "task_id",
            "task_type",
            "source",
            "target_type",
            "target_id",
            "runtime_provider",
            "status",
            "progress",
            "result_ref",
            "error",
        )
    }
    benchmark_summary = {
        key: benchmark.get(key)
        for key in (
            "schema",
            "run_id",
            "target_job_id",
            "data_mode",
            "runtime_id",
            "valid_sample_count",
            "minimum_sample_count",
            "sample_sufficient",
            "company_count",
        )
        if key in benchmark
    }
    benchmark_summary["signals"] = [
        {
            key: signal.get(key)
            for key in (
                "capability_id",
                "category",
                "target_importance",
                "market_frequency",
                "direction",
                "confidence",
                "priority",
                "evidence_gap",
            )
            if key in signal
        }
        for signal in benchmark.get("signals") or []
        if isinstance(signal, dict)
    ]
    item = await _upsert_inbox(
        item_id=f"automation_task_{task_id}",
        category=category,
        event_id=event_id,
        task_id=task_id,
        target_type="job",
        target_id=str(task.get("target_id") or input_payload.get("job_id") or ""),
        title="岗位情报与专项训练已准备" if task["status"] == "completed" else "岗位情报任务需要处理",
        body=body,
        payload={
            "task": task_summary,
            "benchmark": benchmark_summary,
            "benchmark_run_id": result.get("benchmark_run_id"),
            "resume_candidate": resume_candidate,
            "interview_focus_plan": focus_plan,
            "application_packet": application_packet,
        },
    )
    if event_id:
        await _update_event(
            event_id,
            status=("completed" if task["status"] == "completed" else task["status"]),
            result={
                "task_id": task_id,
                "benchmark_run_id": result.get("benchmark_run_id"),
                "resume_candidate_status": resume_candidate.get("status"),
                "application_packet_status": packet_status,
            },
            error=task.get("error") or "",
            expected_statuses=("processing", "dispatched"),
        )
    return item


async def handle_career_task_projection_failure(
    task_id: str,
    error: Any,
) -> dict[str, Any] | None:
    """Make a post-task automation projection failure user-visible."""

    from app.services.career_tasks import get_career_task

    task = await get_career_task(task_id)
    input_payload = task.get("input") if isinstance(task.get("input"), dict) else {}
    event_id = str(input_payload.get("automation_event_id") or "")
    if not event_id:
        return None
    message = safe_error_message(
        error if isinstance(error, BaseException) else RuntimeError(str(error or "")),
    )
    error_id = new_error_id()
    record_error(
        error_id,
        method="TASK",
        path=f"/api/agent/runtime/career-tasks/{task_id}/projection",
        status_code=500,
        kind="career_task_projection",
        message=message,
        task_id=task_id,
    )
    event = await _update_event(
        event_id,
        status="failed",
        result={"task_id": task_id, "projection": "failed", "error_id": error_id},
        error=message,
        expected_statuses=("processing", "dispatched"),
    )
    if event["status"] != "failed":
        return None
    return await _upsert_inbox(
        item_id=f"automation_task_{task_id}",
        category="failed",
        event_id=event_id,
        task_id=task_id,
        target_type=task.get("target_type") or "",
        target_id=task.get("target_id") or "",
        title="自动化结果投影失败",
        body=f"CareerTask 已完成，但结果没有完整进入 Today/岗位收件箱：{message}（错误 ID：{error_id}）",
        payload={
            "task": {"task_id": task_id, "error_id": error_id},
            "task_id": task_id,
            "projection_error": message,
            "projection_error_id": error_id,
        },
    )


async def list_automation_events(
    *,
    event_type: str | None = None,
    status: str | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    clean_limit = max(1, min(int(limit), 500))
    async with async_session() as db:
        query = select(AutomationEvent).order_by(AutomationEvent.created_at.desc()).limit(clean_limit)
        if event_type:
            query = query.where(AutomationEvent.event_type == str(event_type).upper())
        if status:
            query = query.where(AutomationEvent.status == str(status))
        rows = (await db.execute(query)).scalars().all()
    return {"events": [_event_view(row) for row in rows]}


async def list_automation_inbox(
    *,
    status: str = "pending",
    category: str | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    if status not in INBOX_STATUSES and status != "all":
        raise ValueError("Automation Inbox status 无效")
    if category and category not in INBOX_CATEGORIES:
        raise ValueError("Automation Inbox category 无效")
    clean_limit = max(1, min(int(limit), 500))
    async with async_session() as db:
        query = select(AutomationInboxItem).order_by(AutomationInboxItem.created_at.desc()).limit(clean_limit)
        if status != "all":
            query = query.where(AutomationInboxItem.status == status)
        if category:
            query = query.where(AutomationInboxItem.category == category)
        rows = (await db.execute(query)).scalars().all()
        task_ids = {row.task_id for row in rows if row.task_id}
        task_map: dict[str, CareerTask] = {}
        if task_ids:
            task_rows = (
                await db.execute(select(CareerTask).where(CareerTask.task_id.in_(task_ids)))
            ).scalars().all()
            task_map = {task.task_id: task for task in task_rows}
    return {"items": [_inbox_view(row, task_map.get(row.task_id)) for row in rows]}


async def resolve_automation_inbox_item(*, item_id: str, action: str) -> dict[str, Any]:
    clean_id = str(item_id or "").strip()
    clean_action = str(action or "").strip().lower()
    if clean_action not in {"resolve", "dismiss", "reopen"}:
        raise ValueError("Automation Inbox action 必须是 resolve/dismiss/reopen")
    async with async_session() as db:
        row = await db.get(AutomationInboxItem, clean_id)
        if row is None:
            raise ValueError(f"Automation Inbox item {clean_id} 不存在")
        if clean_action == "resolve":
            row.status = "resolved"
            row.resolved_at = _now()
        elif clean_action == "dismiss":
            row.status = "dismissed"
            row.resolved_at = _now()
        else:
            row.status = "pending"
            row.resolved_at = None
        await db.commit()
        await db.refresh(row)
        return _inbox_view(row)


__all__ = [
    "AUTOMATION_EVENT_TYPES",
    "INBOX_CATEGORIES",
    "handle_career_task_finished",
    "handle_career_task_projection_failure",
    "list_automation_events",
    "list_automation_inbox",
    "list_automation_rules",
    "record_automation_event",
    "resolve_automation_inbox_item",
]
