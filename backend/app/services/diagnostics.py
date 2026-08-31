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
    with _recent_errors_lock:
        _recent_errors.append(record)


def recent_errors(*, limit: int = 40) -> list[dict[str, Any]]:
    safe_limit = max(1, min(int(limit or 40), _MAX_RECENT_ERRORS))
    with _recent_errors_lock:
        records = list(_recent_errors)[-safe_limit:]
    return [dict(record) for record in records]


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


async def export_diagnostic_bundle() -> dict[str, Any]:
    """Return metadata only; profile, job, resume and provider credentials stay out."""

    from app.services.agent_provider_health import list_provider_health
    from app.services.data_safety import (
        check_database_integrity,
        get_data_safety_status,
    )

    captured = await asyncio.gather(
        _capture("providers", list_provider_health()),
        _capture("data_safety", get_data_safety_status()),
        _capture("integrity", check_database_integrity()),
    )
    captured_by_label = dict(captured)
    integrity = captured_by_label.get("integrity", {})
    data_safety = captured_by_label.get("data_safety", {})

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
        "agent_providers": _provider_summary(captured_by_label.get("providers")),
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
