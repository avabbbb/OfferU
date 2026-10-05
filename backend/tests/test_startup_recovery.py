from __future__ import annotations

import asyncio
import time

import pytest
from app.services import startup_recovery

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


def test_hanging_stage_times_out_unwinds_and_allows_next_fast_recovery(monkeypatch) -> None:
    monkeypatch.setattr(startup_recovery, "RECOVERY_STAGE_TIMEOUT_SECONDS", 0.02)
    unwound = []

    async def hanging():
        try:
            await asyncio.Event().wait()
        finally:
            unwound.append(True)

    async def run():
        reset_startup_recovery()
        assert await run_startup_recovery("stale_task", hanging) is None
        assert unwound == [True]
        assert await run_startup_recovery("fast_task", lambda: asyncio.sleep(0, result="done")) == "done"

    asyncio.run(run())
    status = finish_startup_recovery()
    assert status["status"] == "degraded"
    assert status["checks"]["stale_task"]["reason"] == "timeout"
    assert status["checks"]["fast_task"]["status"] == "ready"


def test_shared_budget_caps_serial_stages_and_skips_remaining_operations(monkeypatch) -> None:
    monkeypatch.setattr(startup_recovery, "STARTUP_RECOVERY_BUDGET_SECONDS", 0.06)
    monkeypatch.setattr(startup_recovery, "RECOVERY_STAGE_TIMEOUT_SECONDS", 0.04)
    invoked = []

    async def hanging():
        invoked.append(True)
        await asyncio.Event().wait()

    async def run():
        reset_startup_recovery()
        started = time.monotonic()
        for name in ("first", "second", "third"):
            assert await run_startup_recovery(name, hanging) is None
        return time.monotonic() - started

    elapsed = asyncio.run(run())
    # Diagnostic overhead also consumes the shared wall-clock budget.
    assert 1 <= len(invoked) <= 2
    assert elapsed < 0.5
    status = finish_startup_recovery()
    assert status["status"] == "degraded"
    assert status["failed_checks"] == ["first", "second", "third"]
    assert all(check["reason"] == "timeout" for check in status["checks"].values())


def test_external_cancellation_propagates_after_cleanup_without_claiming_recovered():
    entered = asyncio.Event()
    unwound = []

    async def operation():
        try:
            entered.set()
            await asyncio.Event().wait()
        finally:
            unwound.append(True)

    async def run():
        reset_startup_recovery()
        task = asyncio.create_task(run_startup_recovery("cancelled_task", operation))
        await entered.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(run())
    assert unwound == [True]
    status = finish_startup_recovery()
    assert status["status"] == "degraded"
    assert status["checks"]["cancelled_task"] == {"status": "cancelled"}
