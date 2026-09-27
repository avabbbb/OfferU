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
from datetime import datetime, timedelta, timezone
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
    CalendarEvent,
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
        "PROFILE_BASELINE_REQUIRED",
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
    "PROFILE_BASELINE_REQUIRED": {
        "task_type": "career_director",
        "runtime_provider": "pi",
        "enabled": True,
        "automation_level": "L1",
        "description": "首次职业方向发现；结果只作可审核建议，不写入 Career Truth。",
    },
    "DAILY_REVIEW": {
        "task_type": "career_director",
        "runtime_provider": "pi",
        "enabled": True,
        "automation_level": "L1",
        "description": "每日由真实 Career Director 对当前机会和待办重新排序；不直接修改 Career Truth。",
    },
    "INTERVIEW_INVITATION_DETECTED": {
        "task_type": "career_director",
        "runtime_provider": "pi",
        "enabled": True,
        "automation_level": "L1",
        "description": "读取已安排面试及当前岗位证据，由 Career Director 准备有依据的练习重点。",
    },
    "INTERVIEW_COMPLETED": {
        "task_type": "career_director",
        "runtime_provider": "pi",
        "enabled": True,
        "automation_level": "L1",
        "description": "日历面试时间已过后主动生成复盘问题；不写入职业事实。",
    },
    "INTERVIEW_DEBRIEF_CREATED": {
        "task_type": "career_director",
        "runtime_provider": "pi",
        "enabled": True,
        "automation_level": "L1",
        "description": "分析用户提交的面试复盘，仅生成待审核学习候选。",
    },
    "RESUME_UPDATED": {
        "task_type": "career_director",
        "runtime_provider": "pi",
        "enabled": True,
        "automation_level": "L1",
        "description": "评估新简历证据是否值得重新联系旧机会；仅准备候选，不发送消息。",
    },
    "JOB_SAVED": {
        "task_type": "role_intelligence",
        "runtime_provider": "auto",
        "enabled": True,
        "automation_level": "derived_candidate",
        "description": "保存岗位后后台建立岗位情报；结果仍是候选/提案。",
    },
}

_AUTOMATION_EVENT_CREATE_LOCK = asyncio.Lock()


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
    """Preserve deterministic Role Intelligence and add bounded proactive judgment."""

    from app.services.career_tasks import start_career_task

    payload = event.payload_json if isinstance(event.payload_json, dict) else {}
    job_id = int(payload.get("job_id") or event.target_id or 0)
    if job_id <= 0:
        raise ValueError("JOB_SAVED 缺少有效 job_id")

    policy = rule.get("policy") if isinstance(rule.get("policy"), dict) else {}
    role_provider = str(
        payload.get("runtime_provider")
        or policy.get("runtime_provider")
        or "auto"
    )
    role_task = await start_career_task(
        task_type="role_intelligence",
        source="automation",
        target_type="job",
        target_id=str(job_id),
        runtime_provider=role_provider,
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
    director_task = await start_career_task(
        task_type="career_director",
        source="automation",
        target_type="job",
        target_id=str(job_id),
        runtime_provider="pi",
        input={
            "automation_event_id": event.event_id,
            "event_type": event.event_type,
            "job_id": job_id,
            **{
                key: payload[key]
                for key in (
                    "profile_id",
                    "replaces_proposal_id",
                    "affected_source_section_ids",
                    "accepted_observation_id",
                )
                if key in payload
            },
            "role_intelligence_runtime_provider": role_provider,
            "role_benchmark_context": {
                key: str(payload.get(key) or "")
                for key in ("role_family", "specialization", "seniority", "region", "industry")
                if payload.get(key)
            },
        },
        output_contract={"schema": "offeru.career_briefing.v1", "type": "object"},
        idempotency_key=f"automation:{event.event_id}:job-career-director",
    )
    await _upsert_inbox(
        item_id=f"automation_task_{role_task['task_id']}",
        category="fyi",
        event_id=event.event_id,
        task_id=role_task["task_id"],
        target_type="job",
        target_id=str(job_id),
        title="岗位情报后台任务已排队",
        body=(
            f"OfferU 已为岗位 #{job_id} 创建 Role Intelligence CareerTask。"
            "结果会先作为候选/提案进入收件箱，不会静默修改 Career Profile。"
        ),
        payload={"runtime_provider": role_provider, "task": role_task},
    )
    await _upsert_inbox(
        item_id=f"automation_task_{director_task['task_id']}",
        category="fyi",
        event_id=event.event_id,
        task_id=director_task["task_id"],
        target_type="job",
        target_id=str(job_id),
        title="OfferU 正在判断这个岗位接下来最值得做什么",
        body="内置 Career Director 会读取岗位与职业证据，生成有界的岗位行动计划；它不会替你确认写操作。",
        payload={"runtime_provider": "pi", "task": director_task, "event_type": "JOB_SAVED"},
    )
    return {
        "task": role_task,
        "role_intelligence_task": role_task,
        "career_director_task": director_task,
        "task_ids": [role_task["task_id"], director_task["task_id"]],
        "job_id": job_id,
        "runtime_provider": role_provider,
        "career_director_provider": "pi",
    }


def _job_assessment_recommends_role_intelligence(assessment: dict[str, Any]) -> bool:
    need = assessment.get("role_intelligence") if isinstance(assessment.get("role_intelligence"), dict) else {}
    recommendations = assessment.get("recommended_operations")
    return need.get("relevance") in {"needed", "useful"} and isinstance(recommendations, list) and (
        "build_role_benchmark" in recommendations
    )


async def _dispatch_profile_baseline(
    event: AutomationEvent,
    rule: dict[str, Any],
) -> dict[str, Any]:
    from app.services.career_tasks import start_career_task

    payload = event.payload_json if isinstance(event.payload_json, dict) else {}
    policy = rule.get("policy") if isinstance(rule.get("policy"), dict) else {}
    provider = str(payload.get("runtime_provider") or policy.get("runtime_provider") or "pi")
    if provider in {"codex", "codex-app-server", "auto", "embedded", "builtin", "pi-sdk", "pi-sdk-worker"}:
        provider = "pi"
    if provider != "pi":
        raise ValueError("Profile Discovery 需要 embedded Pi Career Director")
    if event.target_type != "profile" or not str(event.target_id or "").isdigit():
        raise ValueError("PROFILE_BASELINE_REQUIRED 缺少 Profile 目标")
    task = await start_career_task(
        task_type="career_director",
        source="automation",
        target_type="profile",
        target_id=event.target_id,
        runtime_provider=provider,
        input={
            "automation_event_id": event.event_id,
            "event_type": event.event_type,
            "profile_id": int(event.target_id),
        },
        output_contract={"schema": "offeru.career_briefing.v1", "type": "object"},
        idempotency_key=f"automation:{event.event_id}:career-director",
    )
    await _upsert_inbox(
        item_id=f"automation_task_{task['task_id']}",
        category="fyi",
        event_id=event.event_id,
        task_id=task["task_id"],
        target_type="profile",
        target_id=event.target_id,
        title="正在了解你的职业方向",
        body="OfferU 会先读取已保存的职业经历和目标，再准备一份可审核的方向建议。",
        payload={"runtime_provider": provider, "task": task, "autonomy_level": "L1"},
    )
    return {"task": task, "profile_id": int(event.target_id), "runtime_provider": provider}


async def _dispatch_daily_review(
    event: AutomationEvent,
    rule: dict[str, Any],
) -> dict[str, Any]:
    from datetime import date

    from app.services.career_tasks import start_career_task

    payload = event.payload_json if isinstance(event.payload_json, dict) else {}
    policy = rule.get("policy") if isinstance(rule.get("policy"), dict) else {}
    provider = str(payload.get("runtime_provider") or policy.get("runtime_provider") or "pi")
    if provider in {"codex", "codex-app-server", "auto", "embedded", "builtin", "pi-sdk", "pi-sdk-worker"}:
        provider = "pi"
    if provider != "pi":
        raise ValueError("Daily Career Brief 需要 embedded Pi Career Director")
    if event.target_type != "profile" or not str(event.target_id or "").isdigit():
        raise ValueError("DAILY_REVIEW 缺少 Profile 目标")
    review_date = str(payload.get("review_date") or "")
    date.fromisoformat(review_date)
    profile_id = int(event.target_id)
    elapsed_interviews = await _dispatch_elapsed_interviews()
    task = await start_career_task(
        task_type="career_director",
        source="automation",
        target_type="profile",
        target_id=event.target_id,
        runtime_provider=provider,
        input={
            "automation_event_id": event.event_id,
            "event_type": event.event_type,
            "profile_id": profile_id,
            "review_date": review_date,
        },
        output_contract={"schema": "offeru.career_briefing.v1", "type": "object"},
        idempotency_key=f"automation:{event.event_id}:career-director",
    )
    await _upsert_inbox(
        item_id=f"automation_task_{task['task_id']}",
        category="fyi",
        event_id=event.event_id,
        task_id=task["task_id"],
        target_type="career_brief",
        target_id=review_date,
        title="正在整理今天最重要的求职行动",
        body="OfferU 正在结合面试、跟进、岗位进展和待确认事项重新排序。",
        payload={"runtime_provider": provider, "task": task, "event_type": "DAILY_REVIEW"},
    )
    return {
        "task": task,
        "profile_id": profile_id,
        "review_date": review_date,
        "elapsed_interviews": elapsed_interviews,
    }


async def _dispatch_interview_event(
    event: AutomationEvent,
    rule: dict[str, Any],
) -> dict[str, Any]:
    from app.services.career_tasks import start_career_task

    payload = event.payload_json if isinstance(event.payload_json, dict) else {}
    calendar_event_id = int(payload.get("calendar_event_id") or event.target_id or 0)
    if calendar_event_id <= 0:
        raise ValueError(f"{event.event_type} 缺少有效日历面试 ID")
    job_id = int(payload.get("job_id") or 0) or None
    provider = str(payload.get("runtime_provider") or rule.get("policy", {}).get("runtime_provider") or "pi")
    if provider in {"codex", "codex-app-server", "auto", "embedded", "builtin", "pi-sdk", "pi-sdk-worker"}:
        provider = "pi"
    if provider != "pi":
        raise ValueError("Interview Career Director 需要 embedded Pi Career Director")
    # Keep the CareerTask target identical to its AutomationEvent target so
    # task creation remains bound to the exact triggering interview.
    target_type = event.target_type
    target_id = event.target_id
    task = await start_career_task(
        task_type="career_director",
        source="automation",
        target_type=target_type,
        target_id=target_id,
        runtime_provider=provider,
        input={
            "automation_event_id": event.event_id,
            "event_type": event.event_type,
            "calendar_event_id": calendar_event_id,
            "job_id": job_id,
            "profile_id": int(payload["profile_id"]) if str(payload.get("profile_id") or "").isdigit() else None,
        },
        output_contract={"schema": "offeru.career_briefing.v1", "type": "object"},
        idempotency_key=f"automation:{event.event_id}:career-director",
    )
    titles = {
        "INTERVIEW_INVITATION_DETECTED": "OfferU 正在准备这场面试",
        "INTERVIEW_COMPLETED": "OfferU 正在准备面试复盘问题",
        "INTERVIEW_DEBRIEF_CREATED": "OfferU 正在整理可复核的面试学习",
    }
    bodies = {
        "INTERVIEW_INVITATION_DETECTED": "职业 Agent 正在对照岗位证据、面试时间和以往学习，决定值得练习的重点。",
        "INTERVIEW_COMPLETED": "日历显示面试时间已过；OfferU 会先问你实际经历，再整理候选学习。",
        "INTERVIEW_DEBRIEF_CREATED": "职业 Agent 正在从你提交的复盘中提炼有来源的学习候选；确认前不会更新档案。",
    }
    await _upsert_inbox(
        item_id=f"automation_task_{task['task_id']}",
        category="fyi",
        event_id=event.event_id,
        task_id=task["task_id"],
        target_type=target_type,
        target_id=target_id,
        title=titles[event.event_type],
        body=bodies[event.event_type],
        payload={
            "runtime_provider": provider,
            "task": task,
            "event_type": event.event_type,
            "calendar_event_id": calendar_event_id,
            "job_id": job_id,
            "autonomy_level": "L1",
            "changes_career_truth": False,
        },
    )
    return {
        "task": task,
        "calendar_event_id": calendar_event_id,
        "job_id": job_id,
        "runtime_provider": provider,
    }


async def _dispatch_resume_updated(
    event: AutomationEvent,
    rule: dict[str, Any],
) -> dict[str, Any]:
    from app.services.career_tasks import _task_view, start_career_task

    payload = event.payload_json if isinstance(event.payload_json, dict) else {}
    resume_id = int(payload.get("resume_id") or event.target_id or 0)
    version_id = int(payload.get("resume_version_id") or 0)
    version_number = int(payload.get("version_number") or 0)
    if resume_id <= 0 or version_id <= 0 or version_number <= 0:
        raise ValueError("RESUME_UPDATED 缺少有效简历版本引用")
    if event.target_type != "resume" or event.target_id != str(resume_id):
        raise ValueError("RESUME_UPDATED 目标必须是本次简历")
    policy = rule.get("policy") if isinstance(rule.get("policy"), dict) else {}
    provider = str(payload.get("runtime_provider") or policy.get("runtime_provider") or "pi")
    if provider in {"codex", "codex-app-server", "auto", "embedded", "builtin", "pi-sdk", "pi-sdk-worker"}:
        provider = "pi"
    if provider != "pi":
        raise ValueError("Resume Career Director 需要 embedded Pi Career Director")
    task = await start_career_task(
        task_type="career_director",
        source="automation",
        target_type="resume",
        target_id=str(resume_id),
        runtime_provider=provider,
        input={
            "automation_event_id": event.event_id,
            "event_type": event.event_type,
            "resume_id": resume_id,
            "resume_version_id": version_id,
            "version_number": version_number,
        },
        output_contract={"schema": "offeru.career_briefing.v1", "type": "object"},
        idempotency_key=f"automation:{event.event_id}:career-director",
    )
    await _upsert_inbox(
        item_id=f"automation_task_{task['task_id']}",
        category="fyi",
        event_id=event.event_id,
        task_id=task["task_id"],
        target_type="resume",
        target_id=str(resume_id),
        title="OfferU 正在重新评估旧岗位机会",
        body="Career Director 会比较新旧简历证据和仍有效的岗位进展，只准备候选，不会联系任何人。",
        payload={
            "runtime_provider": provider,
            "task": task,
            "event_type": event.event_type,
            "resume_id": resume_id,
            "resume_version_id": version_id,
            "version_number": version_number,
            "autonomy_level": "L1",
            "external_action": False,
        },
    )
    # The bounded task may finish before the initial FYI Inbox row is written.
    # Re-project a terminal task after that write so the result cannot be
    # overwritten by the startup placeholder.
    async with async_session() as db:
        current_row = await db.get(CareerTask, task["task_id"])
        current_task = _task_view(current_row) if current_row is not None else None
    if current_task and current_task["status"] in {"completed", "failed", "blocked", "cancelled"}:
        await _project_career_director_task(current_task)
    return {
        "task": task,
        "resume_id": resume_id,
        "resume_version_id": version_id,
        "version_number": version_number,
        "runtime_provider": provider,
    }


async def _dispatch_elapsed_interviews() -> dict[str, int]:
    """Turn recent passed interview calendar events into idempotent debrief tasks."""

    now = _now()
    cutoff = now - timedelta(days=7)
    async with async_session() as db:
        events = (
            await db.execute(
                select(CalendarEvent)
                .where(CalendarEvent.event_type == "interview")
                .where(CalendarEvent.start_time >= cutoff)
                .where(CalendarEvent.start_time <= now)
                .order_by(CalendarEvent.start_time.desc())
                .limit(8)
            )
        ).scalars().all()
    dispatched = 0
    skipped = 0
    for calendar_event in events:
        start_time = calendar_event.start_time
        end_time = calendar_event.end_time or (start_time + timedelta(hours=1))
        if end_time.tzinfo is not None:
            end_time = end_time.astimezone(timezone.utc).replace(tzinfo=None)
        if end_time > now:
            skipped += 1
            continue
        result = await record_automation_event(
            event_type="INTERVIEW_COMPLETED",
            source="calendar_elapsed",
            target_type="interview",
            target_id=str(calendar_event.id),
            payload={
                "calendar_event_id": calendar_event.id,
                "job_id": calendar_event.related_job_id,
                "runtime_provider": "pi",
            },
            dedupe_key=f"calendar-interview-completed:{calendar_event.id}",
        )
        if result.get("reused"):
            skipped += 1
        else:
            dispatched += 1
    return {"dispatched": dispatched, "skipped": skipped}


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
        "status": "ready" if proposal.get("proposal_id") and proposal.get("status") in {"ready", "in_review"} else "blocked",
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


async def enqueue_automation_event_in_transaction(
    db: Any,
    *,
    event_type: str,
    source: str,
    target_type: str,
    target_id: str,
    payload: dict[str, Any],
    dedupe_key: str,
) -> str:
    """Add an AutomationEvent to a caller's business transaction.

    The caller commits the event together with its domain write, then invokes
    ``process_queued_automation_event``. This is the small transactional-outbox
    boundary for mutations that must never lose their automation signal.
    """

    clean_type = str(event_type or "").strip().upper()
    if clean_type not in AUTOMATION_EVENT_TYPES:
        raise ValueError(f"不支持的 AutomationEvent: {clean_type}")
    clean_payload = redact_secret_value(payload if isinstance(payload, dict) else {})
    clean_key = str(dedupe_key or "").strip() or _dedupe_key(
        event_type=clean_type,
        source=str(source or "system"),
        target_type=str(target_type or ""),
        target_id=str(target_id or ""),
        payload=clean_payload,
    )
    stored_key = clean_key[:180]
    existing = (
        await db.execute(select(AutomationEvent).where(AutomationEvent.dedupe_key == stored_key))
    ).scalar_one_or_none()
    if existing is not None:
        return existing.event_id
    event = AutomationEvent(
        event_id=f"automation_evt_{uuid.uuid4().hex[:24]}",
        event_type=clean_type,
        source=str(source or "system").strip()[:80],
        target_type=str(target_type or "").strip()[:80],
        target_id=str(target_id or "").strip()[:160],
        payload_json=_bounded(clean_payload),
        dedupe_key=stored_key,
        status="queued",
    )
    db.add(event)
    await db.flush()
    return event.event_id


async def process_queued_automation_event(event_id: str) -> dict[str, Any]:
    """Dispatch an event already committed by a transactional outbox caller."""

    return await _process_automation_event(str(event_id or ""))


async def record_calendar_interview_invitation(
    *, calendar_event_id: int, source: str = "calendar"
) -> dict[str, Any]:
    """Emit one prep trigger for a future canonical interview calendar event."""

    async with async_session() as db:
        calendar_event = await db.get(CalendarEvent, int(calendar_event_id))
    if calendar_event is None or calendar_event.event_type != "interview":
        raise ValueError("Interview calendar event does not exist")
    start_time = calendar_event.start_time
    if start_time.tzinfo is not None:
        start_time = start_time.astimezone(timezone.utc).replace(tzinfo=None)
    if start_time <= _now():
        return {"status": "not_upcoming", "calendar_event_id": calendar_event.id}
    return await record_automation_event(
        event_type="INTERVIEW_INVITATION_DETECTED",
        source=source,
        target_type="interview",
        target_id=str(calendar_event.id),
        payload={
            "calendar_event_id": calendar_event.id,
            "job_id": calendar_event.related_job_id,
            "runtime_provider": "pi",
        },
        dedupe_key=f"calendar-interview-invitation:{calendar_event.id}",
    )


async def _process_automation_event(event_id: str) -> dict[str, Any]:
    """Process one queued signal exactly once within this backend process.

    Exactly-once is guaranteed by ``_claim_automation_event``'s atomic
    conditional UPDATE (``queued`` -> ``processing``): the loser claims 0
    rows and re-reads the current state, so a global process lock is not
    needed and would only serialize unrelated events.
    """

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
    dispatchers = {
        "JOB_SAVED": _dispatch_job_saved,
        "PROFILE_BASELINE_REQUIRED": _dispatch_profile_baseline,
        "DAILY_REVIEW": _dispatch_daily_review,
        "INTERVIEW_INVITATION_DETECTED": _dispatch_interview_event,
        "INTERVIEW_COMPLETED": _dispatch_interview_event,
        "INTERVIEW_DEBRIEF_CREATED": _dispatch_interview_event,
        "RESUME_UPDATED": _dispatch_resume_updated,
    }
    dispatch = dispatchers.get(event.event_type)
    if dispatch is None:
        return await _update_event(event.event_id, status="completed", result={"rule": rule})
    try:
        result = await dispatch(event, rule)
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
    if task["task_type"] == "career_director":
        return await _project_career_director_task(task)
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
        "请查看岗位证据和 Resume Proposal。"
        + (
            "专项训练 Focus Plan 已准备好。"
            if focus_plan.get("focuses")
            else "当前岗位基准尚不满足专项训练生成条件。"
        )
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


async def _project_interview_learning_candidates(
    *, task: dict[str, Any], briefing: dict[str, Any], event_id: str
) -> list[dict[str, Any]]:
    lifecycle = briefing.get("interview_lifecycle")
    candidates = lifecycle.get("learning_candidates") if isinstance(lifecycle, dict) else []
    if not isinstance(candidates, list) or not candidates:
        return []
    async with async_session() as db:
        event = await db.get(AutomationEvent, event_id)
    if event is None or event.event_type != "INTERVIEW_DEBRIEF_CREATED":
        raise ValueError("Interview learning candidates are not linked to a debrief event")
    payload = event.payload_json if isinstance(event.payload_json, dict) else {}
    answers = payload.get("answers") if isinstance(payload.get("answers"), list) else []
    calendar_event_id = int(payload.get("calendar_event_id") or event.target_id or 0)
    job_id = int(payload.get("job_id") or 0) or None
    proposals: list[dict[str, Any]] = []
    from app.ops import execute_operation

    for index, candidate in enumerate(candidates[:5]):
        if not isinstance(candidate, dict):
            continue
        answer_index = int(candidate.get("answer_index", -1))
        if answer_index < 0 or answer_index >= len(answers) or not isinstance(answers[answer_index], dict):
            continue
        answer = answers[answer_index]
        answer_text = redact_sensitive_text(str(answer.get("answer") or ""), max_length=5000)
        source_excerpt = redact_sensitive_text(str(candidate.get("source_excerpt") or ""), max_length=400)
        if not source_excerpt or source_excerpt.casefold() not in answer_text.casefold():
            # Model conclusions without an exact excerpt from the user's answer
            # remain suggestions only and are not inserted into memory.
            continue
        summary = redact_sensitive_text(str(candidate.get("summary") or ""), max_length=500).strip()
        title = redact_sensitive_text(str(candidate.get("title") or ""), max_length=180).strip()
        if not summary or not title:
            continue
        observation_result = await execute_operation(
            "record_learning_observation",
            {
                "source_type": "interview_debrief",
                "source_external_id": str(calendar_event_id),
                "source_title": "OfferU 真实面试复盘",
                "source_locator": f"calendar_interview:{calendar_event_id}/answer:{answer_index}",
                "source_metadata": {
                    "calendar_event_id": calendar_event_id,
                    "job_id": job_id,
                    "answer_index": answer_index,
                },
                "observation_type": "interview_debrief_candidate",
                "content": {
                    "title": title,
                    "summary": summary,
                    "candidate_type": str(candidate.get("candidate_type") or "potential_strength"),
                    "source_excerpt": source_excerpt,
                    "calendar_event_id": calendar_event_id,
                    "job_id": job_id,
                    "career_task_id": task.get("task_id"),
                },
                "idempotency_key": (
                    f"interview-debrief:{event_id}:{index}:"
                    f"{hashlib.sha256(summary.encode('utf-8')).hexdigest()}"
                ),
            },
            surface="automation",
        )
        if not observation_result.get("ok") or not isinstance(observation_result.get("outputs"), dict):
            raise RuntimeError("Interview learning observation could not be recorded")
        observation = observation_result["outputs"]
        proposal_result = await execute_operation(
            "create_memory_proposal",
            {
                "observation_id": int(observation.get("id") or 0),
                "target_tier": "career_hypothesis",
                "section_type": "skill",
                "title": title,
                "after": {"bullet": summary, "description": summary},
                "reason": redact_sensitive_text(
                    str(candidate.get("review_reason") or "来自一场真实面试的学习观察；接受前不会成为职业事实。"),
                    max_length=1000,
                ),
                "impact": ["作为后续岗位准备和面试训练的参考；须由你审核"],
            },
            surface="automation",
        )
        if not proposal_result.get("ok") or not isinstance(proposal_result.get("outputs"), dict):
            raise RuntimeError("Interview learning proposal could not be created")
        proposal = proposal_result["outputs"]
        proposals.append(
            {
                "observation_id": observation.get("id"),
                "proposal_id": proposal.get("id"),
                "title": title,
                "target_tier": "career_hypothesis",
                "status": proposal.get("status", "pending"),
            }
        )
    return proposals


async def _project_career_director_task(task: dict[str, Any]) -> dict[str, Any] | None:
    input_payload = task.get("input") if isinstance(task.get("input"), dict) else {}
    event_id = str(input_payload.get("automation_event_id") or "")
    if not event_id:
        return None
    task_result = task.get("result") if isinstance(task.get("result"), dict) else {}
    briefing = task_result.get("briefing") if isinstance(task_result.get("briefing"), dict) else {}
    event_type = str(input_payload.get("event_type") or "PROFILE_BASELINE_REQUIRED").upper()
    is_daily = event_type == "DAILY_REVIEW"
    is_job_saved = event_type == "JOB_SAVED"
    is_interview = event_type in {
        "INTERVIEW_INVITATION_DETECTED",
        "INTERVIEW_COMPLETED",
        "INTERVIEW_DEBRIEF_CREATED",
    }
    is_resume_updated = event_type == "RESUME_UPDATED"
    completed = task["status"] == "completed" and bool(briefing)
    resume_update = briefing.get("resume_update") if isinstance(briefing.get("resume_update"), dict) else {}
    reengagement_candidates = [
        candidate
        for candidate in resume_update.get("candidates", [])
        if isinstance(candidate, dict)
        and candidate.get("worth_reengaging") is True
        and candidate.get("urgency") != "skip"
    ]
    category = (
        "needs_review"
        if completed and (not is_resume_updated or reengagement_candidates)
        else "completed"
        if completed
        else "failed"
    )
    interview_titles = {
        "INTERVIEW_INVITATION_DETECTED": "面试准备计划已准备",
        "INTERVIEW_COMPLETED": "面试复盘问题已准备",
        "INTERVIEW_DEBRIEF_CREATED": "面试学习候选已准备",
    }
    title = (
        "今天的求职行动简报已准备"
        if completed and is_daily
        else "岗位匹配评估计划已准备"
        if completed and is_job_saved
        else "旧岗位重新联系候选已准备"
        if completed and is_resume_updated and reengagement_candidates
        else "新简历已评估：暂时没有合适的旧岗位"
        if completed and is_resume_updated
        else interview_titles[event_type]
        if completed and is_interview
        else "你的职业方向建议已准备"
        if completed
        else "每日职业简报需要处理"
        if is_daily
        else "岗位匹配评估需要处理"
        if is_job_saved
        else "职业方向分析需要处理"
    )
    summary = str(briefing.get("situation_summary") or "")
    learning_proposals: list[dict[str, Any]] = []
    if completed and event_type == "INTERVIEW_DEBRIEF_CREATED":
        learning_proposals = await _project_interview_learning_candidates(
            task=task,
            briefing=briefing,
            event_id=event_id,
        )
    lifecycle = briefing.get("interview_lifecycle") if isinstance(briefing.get("interview_lifecycle"), dict) else {}
    body = (
        summary or (
            "OfferU 已根据当前求职状态准备今日行动排序，等待你查看。"
            if is_daily
            else "OfferU 已比较岗位要求与你的职业证据，并整理了匹配依据和准备优先级。"
            if is_job_saved
            else (
                f"{resume_update.get('summary') or 'OfferU 已比较新旧简历证据与仍有效的申请。'} "
                f"发现 {len(reengagement_candidates)} 个值得查看的旧岗位候选；没有联系任何人。"
                if reengagement_candidates
                else str(resume_update.get("summary") or "OfferU 没有发现当前值得重新联系的旧岗位。")
            )
            if is_resume_updated
            else str(lifecycle.get("summary") or "OfferU 已结合这场面试的岗位证据准备下一步。")
            if is_interview
            else "OfferU 已准备职业阶段、证据强弱和下一步问题，等待你查看。"
        )
        if completed
        else f"OfferU 没能完成这次分析：{task.get('error') or '任务失败'}"
    )
    if completed and event_type == "INTERVIEW_DEBRIEF_CREATED":
        body += (
            f" 已整理 {len(learning_proposals)} 条学习候选，均需你在 Profile 记忆收件箱复核。"
            if learning_proposals
            else " 这次复盘没有形成有直接回答证据的学习候选。"
        )
    review_date = str(input_payload.get("review_date") or "")
    role_intelligence_task: dict[str, Any] | None = None
    role_intelligence_error = ""
    if completed and is_job_saved:
        assessment = briefing.get("job_assessment") if isinstance(briefing.get("job_assessment"), dict) else {}
        if _job_assessment_recommends_role_intelligence(assessment):
            from app.ops import execute_operation

            role_context = input_payload.get("role_benchmark_context") if isinstance(input_payload.get("role_benchmark_context"), dict) else {}
            start_result = await execute_operation(
                "start_career_task",
                {
                    "task_type": "role_intelligence",
                    "source": "automation",
                    "target_type": "job",
                    "target_id": str(input_payload.get("job_id") or task.get("target_id") or ""),
                    "runtime_provider": str(input_payload.get("role_intelligence_runtime_provider") or "auto"),
                    "input": {
                        "job_id": int(input_payload.get("job_id") or task.get("target_id") or 0),
                        "automation_event_id": event_id,
                        **{
                            key: str(role_context.get(key) or "")
                            for key in ("role_family", "specialization", "seniority", "region", "industry")
                            if role_context.get(key)
                        },
                    },
                    "output_contract": {"schema": "offeru.role_benchmark_result.v1", "type": "object"},
                    "idempotency_key": f"automation:{event_id}:role-intelligence",
                },
                surface="automation",
            )
            if start_result.get("ok") and isinstance(start_result.get("outputs"), dict):
                role_intelligence_task = start_result["outputs"]
                await _upsert_inbox(
                    item_id=f"automation_task_{role_intelligence_task['task_id']}",
                    category="fyi",
                    event_id=event_id,
                    task_id=role_intelligence_task["task_id"],
                    target_type="job",
                    target_id=str(input_payload.get("job_id") or task.get("target_id") or ""),
                    title="岗位情报准备已开始",
                    body="岗位评估认为市场样本有助于补充判断；结果会作为候选供你审核。",
                    payload={"runtime_provider": role_intelligence_task.get("runtime_provider", ""), "task": role_intelligence_task},
                )
            else:
                role_intelligence_error = "; ".join(str(error) for error in start_result.get("errors") or []) or "Role Intelligence task could not start"
                await _upsert_inbox(
                    item_id=f"automation_role_intelligence_start_failed_{event_id}",
                    category="failed",
                    event_id=event_id,
                    target_type="job",
                    target_id=str(input_payload.get("job_id") or task.get("target_id") or ""),
                    title="岗位情报准备没有开始",
                    body=role_intelligence_error,
                    payload={"event_type": event_type, "error": role_intelligence_error},
                )
    item = await _upsert_inbox(
        item_id=f"automation_task_{task['task_id']}",
        category=category,
        event_id=event_id,
        task_id=task["task_id"],
        target_type="career_brief" if is_daily else task.get("target_type") or "profile",
        target_id=review_date if is_daily else task.get("target_id") or str(input_payload.get("profile_id") or ""),
        title=title,
        body=body,
        payload={
            "task": {
                key: task.get(key)
                for key in ("task_id", "task_type", "runtime_provider", "status", "progress", "error")
            },
            "briefing": briefing if completed else {},
            "job_assessment": briefing.get("job_assessment") if completed and is_job_saved else {},
            "interview_lifecycle": lifecycle if completed and is_interview else {},
            "resume_update": resume_update if completed and is_resume_updated else {},
            "reengagement_candidates": reengagement_candidates if completed and is_resume_updated else [],
            **(
                {
                    "resume_id": int(input_payload.get("resume_id") or task.get("target_id") or 0),
                    "resume_version_id": int(input_payload.get("resume_version_id") or 0),
                    "version_number": int(input_payload.get("version_number") or 0),
                }
                if is_resume_updated
                else {}
            ),
            "learning_proposals": learning_proposals,
            "event_type": event_type,
            "review_date": review_date,
            "autonomy_level": "L1",
            "changes_career_truth": False,
        },
    )
    await _update_event(
        event_id,
        status="completed" if completed else task["status"],
        result={
            "task_id": task["task_id"],
            "briefing_schema": briefing.get("schema") if completed else None,
            "inbox_item_id": item["item_id"],
            "role_intelligence_task_id": role_intelligence_task.get("task_id") if role_intelligence_task else None,
            "role_intelligence_error": role_intelligence_error or None,
            "learning_proposal_count": len(learning_proposals),
            "reengagement_candidate_count": len(reengagement_candidates),
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
    "record_calendar_interview_invitation",
    "resolve_automation_inbox_item",
]
