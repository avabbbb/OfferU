from __future__ import annotations

import asyncio

import pytest

from app.services.startup_recovery import (
    finish_startup_recovery,
    get_startup_recovery_status,
    reset_startup_recovery,
    run_startup_recovery,
)


def test_startup_recovery_reports_ready_checks() -> None:
    async def operation() -> dict[str, int]:
        return {"recovered": 2}

    reset_startup_recovery()
    result = asyncio.run(run_startup_recovery("career_tasks", operation))
    status = finish_startup_recovery()

    assert result == {"recovered": 2}
    assert status == {
        "status": "ready",
        "checks": {"career_tasks": {"status": "ready"}},
        "failed_checks": [],
    }


def test_startup_recovery_exposes_redacted_failure_and_error_id() -> None:
    async def operation() -> None:
        raise RuntimeError("provider token=OFFERU_RELEASE_CANARY_SECRET_123 failed")

    reset_startup_recovery()
    result = asyncio.run(run_startup_recovery("automation_events", operation))
    status = finish_startup_recovery()

    assert result is None
    assert status["status"] == "degraded"
    assert status["failed_checks"] == ["automation_events"]
    failure = status["checks"]["automation_events"]
    assert failure["status"] == "failed"
    assert failure["error_id"].startswith("err_")

    # The public status contains a correlation handle, not the exception text.
    assert "CANARY" not in str(status)
    assert get_startup_recovery_status() == status


@pytest.mark.parametrize("name", ["", " " * 4, "x" * 200])
def test_startup_recovery_names_are_bounded(name: str) -> None:
    async def operation() -> None:
        return None

    reset_startup_recovery()
    asyncio.run(run_startup_recovery(name, operation))
    status = finish_startup_recovery()

    assert len(status["checks"]) == 1
    assert all(len(key) <= 80 for key in status["checks"])
