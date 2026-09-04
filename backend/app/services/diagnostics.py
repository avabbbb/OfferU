"""Local-only, redacted diagnostics for the Internal Beta feedback path."""

from __future__ import annotations

import asyncio
from collections import deque
from datetime import datetime, timezone
import os
import platform
from threading import RLock
from typing import Any
from uuid import uuid4

from app.services.security_redaction import redact_sensitive_text, safe_error_message


_MAX_RECENT_ERRORS = 80
_MAX_DURABLE_FAILURES = 40
_DURABLE_FAILURE_STATUSES = ("failed", "blocked", "interrupted")
_recent_errors: deque[dict[str, Any]] = deque(maxlen=_MAX_RECENT_ERRORS)
_recent_errors_lock = RLock()


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


def new_error_id() -> str:
    return f"err_{uuid4().hex[:16]}"


def _safe_text(value: Any, *, max_length: int = 300) -> str:
    return redact_sensitive_text(value, max_length=max_length).strip()


def record_error(
    error_id: str,
    *,
    method: str,
    path: str,
    status_code: int,
    kind: str,
    message: Any = "",
    run_id: Any = "",
    task_id: Any = "",
    operation_id: Any = "",
    provider_id: Any = "",
) -> None:
    """Keep only bounded request metadata and a redacted diagnostic message."""

    record = {
        "error_id": _safe_text(error_id, max_length=40),
        "occurred_at": _utc_now(),
        "method": _safe_text(method, max_length=12).upper(),
        "path": _safe_text(path, max_length=180),
        "status_code": int(status_code),
        "kind": _safe_text(kind, max_length=40),
        "message": _safe_text(message),
    }
    for field, value in (
        ("run_id", run_id),
        ("task_id", task_id),
        ("operation_id", operation_id),
        ("provider_id", provider_id),
    ):
        if value:
            record[field] = _safe_text(value, max_length=120)
    with _recent_errors_lock:
        _recent_errors.append(record)


def recent_errors(*, limit: int = 40) -> list[dict[str, Any]]:
    safe_limit = max(1, min(int(limit or 40), _MAX_RECENT_ERRORS))
    with _recent_errors_lock:
        records = list(_recent_errors)[-safe_limit:]
    return [dict(record) for record in records]


def _error_id_from_payload(value: Any) -> str:
    if not isinstance(value, dict):
        return ""
    return _safe_text(value.get("error_id"), max_length=40)


def _timestamp(value: Any) -> str:
    return _safe_text(value, max_length=60) if value else ""


async def _durable_failure_summary(*, limit: int = _MAX_DURABLE_FAILURES) -> dict[str, Any]:
    """Read bounded failure metadata without exposing durable task payloads."""

    from sqlalchemy import select

    from app.database import async_session
    from app.models.models import AutomationEvent, CareerTask, JobResearchRun, RoleBenchmarkRun

    safe_limit = max(1, min(int(limit or _MAX_DURABLE_FAILURES), _MAX_DURABLE_FAILURES))
    async with async_session() as db:
        task_rows = (
            await db.execute(
                select(CareerTask)
                .where(CareerTask.status.in_(_DURABLE_FAILURE_STATUSES))
                .order_by(CareerTask.updated_at.desc())
                .limit(safe_limit)
            )
        ).scalars().all()
        event_rows = (
            await db.execute(
                select(AutomationEvent)
                .where(AutomationEvent.status.in_(_DURABLE_FAILURE_STATUSES))
                .order_by(AutomationEvent.created_at.desc())
                .limit(safe_limit)
            )
        ).scalars().all()
        benchmark_rows = (
            await db.execute(
                select(RoleBenchmarkRun)
                .where(RoleBenchmarkRun.status.in_(_DURABLE_FAILURE_STATUSES))
                .order_by(RoleBenchmarkRun.updated_at.desc())
                .limit(safe_limit)
            )
        ).scalars().all()
        research_rows = (
            await db.execute(
                select(JobResearchRun)
                .where(JobResearchRun.status.in_(_DURABLE_FAILURE_STATUSES))
                .order_by(JobResearchRun.updated_at.desc())
                .limit(safe_limit)
            )
        ).scalars().all()

    tasks = []
    for row in task_rows:
        progress = row.progress_json if isinstance(row.progress_json, dict) else {}
        result = row.result_json if isinstance(row.result_json, dict) else {}
        tasks.append(
            {
                "task_id": _safe_text(row.task_id, max_length=80),
                "task_type": _safe_text(row.task_type, max_length=100),
                "status": _safe_text(row.status, max_length=32),
                "runtime_provider": _safe_text(row.runtime_provider, max_length=100),
                "run_id": _safe_text(row.run_id, max_length=160),
                "error_id": _error_id_from_payload(progress) or _error_id_from_payload(result),
                "error": _safe_text(row.error, max_length=300),
                "retryable": bool(row.retryable),
                "attempt_count": int(row.attempt_count or 0),
                "updated_at": _timestamp(row.updated_at),
                "finished_at": _timestamp(row.finished_at),
            }
        )

    events = []
    for row in event_rows:
        result = row.result_json if isinstance(row.result_json, dict) else {}
        events.append(
            {
                "event_id": _safe_text(row.event_id, max_length=100),
                "event_type": _safe_text(row.event_type, max_length=80),
                "status": _safe_text(row.status, max_length=32),
                "error_id": _error_id_from_payload(result),
                "error": _safe_text(row.error, max_length=300),
                "created_at": _timestamp(row.created_at),
                "processed_at": _timestamp(row.processed_at),
            }
        )

    benchmarks = []
    for row in benchmark_rows:
        trace = row.trace_json if isinstance(row.trace_json, dict) else {}
        benchmarks.append(
            {
                "run_id": _safe_text(row.run_id, max_length=64),
                "status": _safe_text(row.status, max_length=24),
                "runtime_id": _safe_text(row.runtime_id, max_length=40),
                "error_id": _error_id_from_payload(trace),
                "error": _safe_text(row.error, max_length=300),
                "attempts": int(row.attempts or 0),
                "updated_at": _timestamp(row.updated_at),
                "completed_at": _timestamp(row.completed_at),
            }
        )

    research = []
    for row in research_rows:
        trace = row.trace_json if isinstance(row.trace_json, dict) else {}
        research.append(
            {
                "run_id": _safe_text(row.run_id, max_length=64),
                "status": _safe_text(row.status, max_length=24),
                "runtime_id": _safe_text(row.runtime_id, max_length=40),
                "error_id": _error_id_from_payload(trace),
                "error": _safe_text(row.error, max_length=300),
                "attempts": int(row.attempts or 0),
                "updated_at": _timestamp(row.updated_at),
                "completed_at": _timestamp(row.completed_at),
            }
        )

    return {
        "status": "ok",
        "career_tasks": tasks,
        "automation_events": events,
        "role_benchmarks": benchmarks,
        "job_research": research,
        "counts": {
            "career_tasks": len(tasks),
            "automation_events": len(events),
            "role_benchmarks": len(benchmarks),
            "job_research": len(research),
        },
    }


async def _capture(label: str, awaitable: Any) -> tuple[str, Any]:
    try:
        return label, await awaitable
    except Exception as exc:
        return label, {
            "status": "unavailable",
            "error": safe_error_message(exc),
        }


def _provider_summary(payload: Any) -> list[dict[str, Any]]:
    providers = payload.get("providers") if isinstance(payload, dict) else None
    if not isinstance(providers, list):
        return []
    result: list[dict[str, Any]] = []
    for item in providers[:32]:
        if not isinstance(item, dict):
            continue
        capabilities = item.get("capabilities")
        capability_names = (
            sorted(str(key)[:80] for key in capabilities.keys())[:32]
            if isinstance(capabilities, dict)
            else []
        )
        result.append(
            {
                "provider_id": _safe_text(item.get("provider_id"), max_length=80),
                "status": _safe_text(item.get("status"), max_length=40),
                "available": bool(item.get("available")),
                "authenticated": item.get("authenticated"),
                "blocked": bool(item.get("blocked")),
                "version": _safe_text(item.get("version"), max_length=120),
                "auth_mode": _safe_text(item.get("auth_mode"), max_length=60),
                "protocol_version": _safe_text(
                    item.get("protocol_version"), max_length=80
                ),
                "capability_names": capability_names,
                "last_error": _safe_text(item.get("last_error")),
                "checked_at": _safe_text(item.get("checked_at"), max_length=60),
            }
        )
    return result


def _data_safety_summary(payload: Any, integrity: Any) -> dict[str, Any]:
    safety = payload if isinstance(payload, dict) else {}
    integrity_payload = integrity if isinstance(integrity, dict) else {}
    database = safety.get("database") if isinstance(safety.get("database"), dict) else {}
    return {
        "status": _safe_text(integrity_payload.get("status") or "unavailable", max_length=40),
        "database_exists": bool(database.get("exists")),
        "backup_count": int(safety.get("backup_count") or 0),
        "invalid_backup_count": int(safety.get("invalid_backup_count") or 0),
        "pending_restore": bool(safety.get("pending_restore")),
        "storage_mode": _safe_text(safety.get("storage_mode"), max_length=40),
        "foreign_key_violation_count": len(
            integrity_payload.get("foreign_key_violations") or []
        ),
    }


def _privacy_hygiene_summary(payload: Any) -> dict[str, Any]:
    value = payload if isinstance(payload, dict) else {}
    legacy = value.get("legacy_email_notification_bodies")
    legacy = legacy if isinstance(legacy, dict) else {}
    synthetic = value.get("synthetic_email_test_data")
    synthetic = synthetic if isinstance(synthetic, dict) else {}
    return {
        "status": _safe_text(value.get("status") or "unavailable", max_length=40),
        "legacy_email_body_records": int(legacy.get("records") or 0),
        "legacy_email_body_characters": int(legacy.get("characters") or 0),
        "synthetic_email_accounts": int(synthetic.get("accounts") or 0),
        "synthetic_email_sync_runs": int(synthetic.get("sync_runs") or 0),
        "synthetic_email_signals": int(synthetic.get("signals") or 0),
        "synthetic_email_candidates": int(synthetic.get("candidates") or 0),
        "safe_to_publish": bool(value.get("safe_to_publish")),
    }


async def export_diagnostic_bundle() -> dict[str, Any]:
    """Return metadata only; profile, job, resume and provider credentials stay out."""

    from app.services.agent_provider_health import list_provider_health
    from app.services.data_safety import (
        check_database_integrity,
        get_data_safety_status,
    )
    from app.services.privacy_hygiene import get_privacy_hygiene_status
    from app.services.startup_recovery import get_startup_recovery_status

    captured = await asyncio.gather(
        _capture("providers", list_provider_health()),
        _capture("data_safety", get_data_safety_status()),
        _capture("integrity", check_database_integrity()),
        _capture("privacy_hygiene", get_privacy_hygiene_status()),
        _capture("durable_failures", _durable_failure_summary()),
    )
    captured_by_label = dict(captured)
    integrity = captured_by_label.get("integrity", {})
    data_safety = captured_by_label.get("data_safety", {})
    privacy_hygiene = captured_by_label.get("privacy_hygiene", {})

    return {
        "schema_version": "offeru.internal-beta.diagnostics.v1",
        "created_at": _utc_now(),
        "app": {
            "version": _safe_text(os.getenv("OFFERU_VERSION", "0.4.0"), max_length=40),
            "build_mode": _safe_text(
                os.getenv("OFFERU_BUILD_MODE", "local-development"), max_length=60
            ),
            "runtime_mode": _safe_text(
                os.getenv("OFFERU_RUNTIME_MODE")
                or os.getenv("OFFERU_INTERVIEW_RUNTIME")
                or "local",
                max_length=60,
            ),
            "python": platform.python_version(),
            "platform": _safe_text(
                f"{platform.system()} {platform.machine()}", max_length=80
            ),
        },
        "database": _data_safety_summary(data_safety, integrity),
        "privacy_hygiene": _privacy_hygiene_summary(privacy_hygiene),
        "startup_recovery": get_startup_recovery_status(),
        "agent_providers": _provider_summary(captured_by_label.get("providers")),
        "durable_failures": captured_by_label.get("durable_failures", {}),
        "recent_errors": recent_errors(),
        "privacy": {
            "includes_profile_content": False,
            "includes_job_content": False,
            "includes_resume_content": False,
            "includes_credentials": False,
            "includes_request_headers": False,
            "note": "此诊断包只包含本地运行元数据、失败关联 ID 和脱敏错误摘要。",
        },
    }


__all__ = [
    "export_diagnostic_bundle",
    "new_error_id",
    "record_error",
    "recent_errors",
]
