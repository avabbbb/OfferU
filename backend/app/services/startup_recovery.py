"""Bounded startup-recovery status for the local runtime.

Recovery is deliberately best effort: a stale optional task must not keep the
desktop shell from opening.  It must still be observable, though, so health
and diagnostic output can distinguish a clean startup from a degraded one.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from copy import deepcopy
from typing import Any

from app.services.security_redaction import safe_error_message


_STATUS: dict[str, Any] = {
    "status": "not_started",
    "checks": {},
    "failed_checks": [],
}


def reset_startup_recovery() -> None:
    _STATUS.clear()
    _STATUS.update(
        {
            "status": "running",
            "checks": {},
            "failed_checks": [],
        }
    )


def get_startup_recovery_status() -> dict[str, Any]:
    """Return a copy safe for health and diagnostic responses."""

    return deepcopy(_STATUS)


async def run_startup_recovery(
    name: str,
    operation: Callable[[], Awaitable[Any]],
) -> Any | None:
    """Run one recovery operation and expose failures without raising them."""

    clean_name = str(name or "recovery").strip()[:80] or "recovery"
    try:
        result = await operation()
    except Exception as exc:  # recovery is non-critical but never silent
        from app.services.diagnostics import new_error_id, record_error

        error_id = new_error_id()
        record_error(
            error_id,
            method="STARTUP",
            path="/api/health",
            status_code=503,
            kind="startup_recovery",
            message=f"{clean_name}: {safe_error_message(exc)}",
        )
        checks = _STATUS.setdefault("checks", {})
        checks[clean_name] = {
            "status": "failed",
            "error_id": error_id,
        }
        failed_checks = _STATUS.setdefault("failed_checks", [])
        if clean_name not in failed_checks:
            failed_checks.append(clean_name)
        return None

    checks = _STATUS.setdefault("checks", {})
    checks[clean_name] = {"status": "ready"}
    return result


def finish_startup_recovery() -> dict[str, Any]:
    """Mark the aggregate startup recovery state after all checks ran."""

    failed_checks = list(_STATUS.get("failed_checks") or [])
    _STATUS["failed_checks"] = failed_checks
    _STATUS["status"] = "degraded" if failed_checks else "ready"
    return get_startup_recovery_status()


__all__ = [
    "finish_startup_recovery",
    "get_startup_recovery_status",
    "reset_startup_recovery",
    "run_startup_recovery",
]
