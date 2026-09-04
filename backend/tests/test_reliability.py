from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.database import Base  # noqa: E402
from app.models.models import (  # noqa: E402
    AutomationEvent,
    AutomationInboxItem,
    CareerTask,
    CareerTaskEvent,
    Interview,
    InterviewEvaluationRun,
    Job,
    JobResearchRun,
    ResearchDossier,
    RoleBenchmarkRun,
)
from app.services import ai_interviews, automation, career_tasks, diagnostics  # noqa: E402


async def _await_career_task(task_id: str) -> dict:
    """Wait through the public durable state when the in-memory handle raced away."""

    worker = career_tasks._LIVE_TASKS.get(task_id)
    if worker is not None:
        await worker
    for _ in range(300):
        snapshot = await career_tasks.get_career_task(task_id)
        if snapshot["status"] in career_tasks.TERMINAL_STATUSES:
            return snapshot
        await asyncio.sleep(0.01)
    raise AssertionError(f"CareerTask {task_id} did not reach a terminal state")


class ReliabilityTests(unittest.TestCase):
    def tearDown(self) -> None:
        career_tasks._LIVE_TASKS.clear()
        career_tasks._TASK_LOCKS.clear()

    def test_concurrent_career_task_start_is_exactly_once(self) -> None:
        async def flow(database_path: Path) -> tuple[list[dict], list[CareerTask]]:
            engine = create_async_engine(
                f"sqlite+aiosqlite:///{database_path.as_posix()}",
                connect_args={"timeout": 30},
            )
            session = async_sessionmaker(engine, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                with patch.object(career_tasks, "async_session", session):
                    results = await asyncio.gather(
                        *(
                            career_tasks.start_career_task(
                                task_type="agent_turn",
                                source="reliability-test",
                                runtime_provider="replay",
                                input={"prompt": "concurrent fixture"},
                                idempotency_key="reliability:career-task:concurrent",
                            )
                            for _ in range(8)
                        )
                    )
                    await _await_career_task(results[0]["task_id"])
                    async with session() as db:
                        rows = (
                            await db.execute(select(CareerTask))
                        ).scalars().all()
                    return results, rows
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            results, rows = asyncio.run(flow(Path(directory) / "career-task-concurrent.db"))
        self.assertEqual(len(rows), 1)
        self.assertEqual({item["task_id"] for item in results}, {rows[0].task_id})
        self.assertEqual(sum(not item["reused"] for item in results), 1)
        self.assertEqual(sum(item["reused"] for item in results), 7)
        self.assertEqual(rows[0].status, "completed")

    def test_replay_task_soak_100_cycles_has_bounded_queue_and_events(self) -> None:
        async def flow(database_path: Path) -> tuple[int, int, int, int]:
            engine = create_async_engine(
                f"sqlite+aiosqlite:///{database_path.as_posix()}",
                connect_args={"timeout": 30},
            )
            session = async_sessionmaker(engine, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                with patch.object(career_tasks, "async_session", session):
                    for cycle in range(100):
                        key = f"reliability:soak:{cycle}"
                        first = await career_tasks.start_career_task(
                            task_type="agent_turn",
                            source="reliability-soak",
                            runtime_provider="replay",
                            input={"prompt": f"soak cycle {cycle}"},
                            idempotency_key=key,
                        )
                        duplicate_while_queued = await career_tasks.start_career_task(
                            task_type="agent_turn",
                            source="reliability-soak",
                            runtime_provider="replay",
                            input={"prompt": f"soak cycle {cycle}"},
                            idempotency_key=key,
                        )
                        await _await_career_task(first["task_id"])
                        duplicate_after_completion = await career_tasks.start_career_task(
                            task_type="agent_turn",
                            source="reliability-soak",
                            runtime_provider="replay",
                            input={"prompt": f"soak cycle {cycle}"},
                            idempotency_key=key,
                        )
                        self.assertFalse(first["reused"])
                        self.assertTrue(duplicate_while_queued["reused"])
                        self.assertTrue(duplicate_after_completion["reused"])
                    await asyncio.sleep(0)
                    async with session() as db:
                        task_count = len((await db.execute(select(CareerTask))).scalars().all())
                        event_count = len(
                            (await db.execute(select(CareerTaskEvent))).scalars().all()
                        )
                        completed_count = len(
                            (
                                await db.execute(
                                    select(CareerTask).where(CareerTask.status == "completed")
                                )
                            )
                            .scalars()
                            .all()
                        )
                    return task_count, event_count, completed_count, len(career_tasks._LIVE_TASKS)
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            task_count, event_count, completed_count, live_count = asyncio.run(
                flow(Path(directory) / "career-task-soak.db")
            )
        self.assertEqual(task_count, 100)
        self.assertEqual(completed_count, 100)
        self.assertEqual(event_count, 500)
        self.assertEqual(live_count, 0)

    def test_concurrent_automation_event_is_exactly_once(self) -> None:
        async def flow(database_path: Path) -> tuple[list[dict], list[AutomationEvent]]:
            engine = create_async_engine(
                f"sqlite+aiosqlite:///{database_path.as_posix()}",
                connect_args={"timeout": 30},
            )
            session = async_sessionmaker(engine, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                with patch.object(automation, "async_session", session):
                    results = await asyncio.gather(
                        *(
                            automation.record_automation_event(
                                event_type="CAREER_FILE_CHANGED",
                                source="reliability-test",
                                target_type="profile",
                                target_id="profile",
                                payload={"path": "fixture/profile.json"},
                                dedupe_key="reliability:automation-event:concurrent",
                            )
                            for _ in range(8)
                        )
                    )
                    async with session() as db:
                        rows = (
                            await db.execute(select(AutomationEvent))
                        ).scalars().all()
                    return results, rows
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            results, rows = asyncio.run(
                flow(Path(directory) / "automation-event-concurrent.db")
            )
        self.assertEqual(len(rows), 1)
        self.assertEqual({item["event_id"] for item in results}, {rows[0].event_id})
        self.assertEqual(sum(not item["reused"] for item in results), 1)
        self.assertEqual(sum(item["reused"] for item in results), 7)
        self.assertEqual(rows[0].status, "skipped")

    def test_automation_inbox_projects_live_career_task_snapshot(self) -> None:
        async def flow(database_path: Path) -> dict:
            engine = create_async_engine(
                f"sqlite+aiosqlite:///{database_path.as_posix()}",
                connect_args={"timeout": 30},
            )
            session = async_sessionmaker(engine, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                async with session() as db:
                    db.add_all(
                        [
                            CareerTask(
                                task_id="career_task_inbox_projection",
                                task_type="role_intelligence",
                                source="reliability-test",
                                target_type="job",
                                target_id="42",
                                runtime_provider="replay",
                                input_json={"job_id": 42},
                                output_contract_json={},
                                status="running",
                                progress_json={
                                    "stage": "role_benchmark_running",
                                    "percent": 25,
                                },
                                idempotency_key="reliability:inbox-projection",
                                retryable=True,
                                attempt_count=1,
                                max_attempts=3,
                            ),
                            AutomationInboxItem(
                                item_id="automation_task_inbox_projection",
                                category="fyi",
                                status="pending",
                                task_id="career_task_inbox_projection",
                                target_type="job",
                                target_id="42",
                                title="岗位情报后台任务已排队",
                            ),
                        ]
                    )
                    await db.commit()
                with patch.object(automation, "async_session", session):
                    return (await automation.list_automation_inbox())["items"][0]
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            item = asyncio.run(
                flow(Path(directory) / "automation-inbox-projection.db")
            )
        self.assertEqual(item["task_status"], "running")
        self.assertEqual(item["task_progress"], {"stage": "role_benchmark_running", "percent": 25})
        self.assertEqual(item["task_attempt_count"], 1)
        self.assertEqual(item["task_max_attempts"], 3)
        self.assertTrue(item["task_retryable"])

    def test_career_task_recovery_handles_queued_running_and_waiting(self) -> None:
        async def flow(database_path: Path) -> tuple[dict, dict[str, CareerTask], list[CareerTaskEvent]]:
            engine = create_async_engine(
                f"sqlite+aiosqlite:///{database_path.as_posix()}",
                connect_args={"timeout": 30},
            )
            session = async_sessionmaker(engine, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                async with session() as db:
                    db.add_all(
                        [
                            CareerTask(
                                task_id="career_task_queued_recovery",
                                task_type="agent_turn",
                                source="reliability-test",
                                runtime_provider="replay",
                                input_json={"prompt": "recovered fixture"},
                                output_contract_json={},
                                status="queued",
                                progress_json={"stage": "queued", "percent": 0},
                                idempotency_key="reliability:recovery:queued",
                                retryable=True,
                                max_attempts=3,
                            ),
                            CareerTask(
                                task_id="career_task_running_recovery",
                                task_type="agent_turn",
                                source="reliability-test",
                                runtime_provider="replay",
                                input_json={"prompt": "interrupted fixture"},
                                output_contract_json={},
                                status="running",
                                progress_json={"stage": "running", "percent": 10},
                                idempotency_key="reliability:recovery:running",
                                retryable=True,
                                max_attempts=3,
                            ),
                            CareerTask(
                                task_id="career_task_waiting_recovery",
                                task_type="agent_turn",
                                source="reliability-test",
                                runtime_provider="replay",
                                input_json={"prompt": "approval fixture"},
                                output_contract_json={},
                                status="waiting_for_approval",
                                progress_json={"stage": "waiting_for_approval", "percent": 50},
                                idempotency_key="reliability:recovery:waiting",
                                retryable=False,
                                max_attempts=3,
                            ),
                        ]
                    )
                    await db.commit()
                with patch.object(career_tasks, "async_session", session):
                    recovery = await career_tasks.recover_career_tasks()
                    await _await_career_task("career_task_queued_recovery")
                    async with session() as db:
                        rows = {
                            row.task_id: row
                            for row in (await db.execute(select(CareerTask))).scalars().all()
                        }
                        events = (
                            await db.execute(
                                select(CareerTaskEvent).order_by(CareerTaskEvent.task_id)
                            )
                        ).scalars().all()
                return recovery, rows, events
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            recovery, rows, events = asyncio.run(
                flow(Path(directory) / "career-task-recovery.db")
            )
        self.assertEqual(recovery, {"blocked": 1, "rescheduled": 1, "waiting_for_approval": 1})
        self.assertEqual(rows["career_task_queued_recovery"].status, "completed")
        self.assertEqual(rows["career_task_running_recovery"].status, "blocked")
        self.assertTrue(rows["career_task_running_recovery"].retryable)
        self.assertEqual(rows["career_task_waiting_recovery"].status, "waiting_for_approval")
        event_types = {(event.task_id, event.event_type) for event in events}
        self.assertIn(("career_task_queued_recovery", "task.recovered"), event_types)
        self.assertIn(("career_task_queued_recovery", "task.completed"), event_types)
        self.assertIn(("career_task_running_recovery", "task.blocked"), event_types)
        self.assertIn(("career_task_waiting_recovery", "task.recovered"), event_types)

    def test_processing_automation_event_is_requeued_after_restart(self) -> None:
        async def flow(database_path: Path) -> tuple[dict, AutomationEvent]:
            engine = create_async_engine(
                f"sqlite+aiosqlite:///{database_path.as_posix()}",
                connect_args={"timeout": 30},
            )
            session = async_sessionmaker(engine, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                async with session() as db:
                    db.add(
                        AutomationEvent(
                            event_id="automation_evt_processing_recovery",
                            event_type="CAREER_FILE_CHANGED",
                            source="reliability-test",
                            payload_json={"path": "fixture/profile.json"},
                            dedupe_key="reliability:automation:processing-recovery",
                            status="processing",
                            processed_at=datetime.now(timezone.utc).replace(tzinfo=None),
                        )
                    )
                    await db.commit()
                with patch.object(automation, "async_session", session):
                    recovery = await automation.recover_automation_events()
                    async with session() as db:
                        event = await db.get(
                            AutomationEvent,
                            "automation_evt_processing_recovery",
                        )
                assert event is not None
                return recovery, event
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            recovery, event = asyncio.run(
                flow(Path(directory) / "automation-processing-recovery.db")
            )
        self.assertEqual(recovery, {"recovered": 1, "completed": 1, "failed": 0})
        self.assertEqual(event.status, "skipped")

    def test_cancel_wins_over_late_provider_result(self) -> None:
        async def flow(database_path: Path) -> tuple[dict, dict, list[CareerTaskEvent]]:
            engine = create_async_engine(
                f"sqlite+aiosqlite:///{database_path.as_posix()}",
                connect_args={"timeout": 30},
            )
            session = async_sessionmaker(engine, expire_on_commit=False)
            provider_started = asyncio.Event()

            async def late_provider(_task: dict) -> dict:
                provider_started.set()
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    return {"late": True}
                return {"late": True}

            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                with (
                    patch.object(career_tasks, "async_session", session),
                    patch.object(career_tasks, "_run_agent_turn", late_provider),
                ):
                    created = await career_tasks.start_career_task(
                        task_type="agent_turn",
                        source="reliability-test",
                        runtime_provider="replay",
                        input={"prompt": "late result"},
                        idempotency_key="reliability:cancel:late-result",
                    )
                    worker = career_tasks._LIVE_TASKS.get(created["task_id"])
                    self.assertIsNotNone(worker)
                    assert worker is not None
                    await provider_started.wait()
                    cancelled = await career_tasks.cancel_career_task(created["task_id"])
                    await worker
                    final = await career_tasks.get_career_task(created["task_id"])
                    events = (
                        await career_tasks.list_career_task_events(created["task_id"])
                    )["events"]
                return cancelled, final, events
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            cancelled, final, events = asyncio.run(
                flow(Path(directory) / "career-task-cancel.db")
            )
        self.assertEqual(cancelled["status"], "cancelled")
        self.assertEqual(final["status"], "cancelled")
        self.assertEqual(final["result"], {})
        self.assertEqual([event["type"] for event in events].count("task.completed"), 0)
        self.assertEqual([event["type"] for event in events].count("task.cancelled"), 1)

    def test_projection_cancellation_does_not_rewrite_completed_task(self) -> None:
        async def flow(database_path: Path) -> tuple[dict, list[CareerTaskEvent]]:
            engine = create_async_engine(
                f"sqlite+aiosqlite:///{database_path.as_posix()}",
                connect_args={"timeout": 30},
            )
            session = async_sessionmaker(engine, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                with (
                    patch.object(career_tasks, "async_session", session),
                    patch.object(
                        career_tasks,
                        "_notify_automation",
                        side_effect=asyncio.CancelledError(),
                    ),
                ):
                    created = await career_tasks.start_career_task(
                        task_type="agent_turn",
                        source="reliability-test",
                        runtime_provider="replay",
                        input={"prompt": "projection cancellation"},
                        idempotency_key="reliability:task:projection-cancel",
                    )
                    worker = career_tasks._LIVE_TASKS.get(created["task_id"])
                    self.assertIsNotNone(worker)
                    assert worker is not None
                    with self.assertRaises(asyncio.CancelledError):
                        await worker
                    final = await career_tasks.get_career_task(created["task_id"])
                    events = (
                        await career_tasks.list_career_task_events(created["task_id"])
                    )["events"]
                return final, events
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            final, events = asyncio.run(
                flow(Path(directory) / "career-task-projection-cancel.db")
            )
        self.assertEqual(final["status"], "completed")
        self.assertEqual(
            [event["type"] for event in events].count("task.completed"),
            1,
        )
        self.assertEqual([event["type"] for event in events].count("task.blocked"), 0)

    def test_projection_failure_is_visible_without_rewriting_completed_task(self) -> None:
        async def flow(database_path: Path) -> tuple[dict, dict, dict]:
            engine = create_async_engine(
                f"sqlite+aiosqlite:///{database_path.as_posix()}",
                connect_args={"timeout": 30},
            )
            session = async_sessionmaker(engine, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                async with session() as db:
                    db.add_all(
                        [
                            CareerTask(
                                task_id="career_task_projection_failure",
                                task_type="role_intelligence",
                                source="reliability-test",
                                target_type="job",
                                target_id="7",
                                runtime_provider="replay",
                                input_json={
                                    "job_id": 7,
                                    "automation_event_id": "automation_evt_projection_failure",
                                },
                                output_contract_json={},
                                status="completed",
                                result_json={},
                                progress_json={"stage": "completed", "percent": 100},
                                idempotency_key="reliability:task:projection-failure",
                                retryable=False,
                                attempt_count=1,
                                max_attempts=3,
                            ),
                            AutomationEvent(
                                event_id="automation_evt_projection_failure",
                                event_type="JOB_SAVED",
                                source="reliability-test",
                                target_type="job",
                                target_id="7",
                                payload_json={"job_id": 7},
                                dedupe_key="reliability:automation:projection-failure",
                                status="dispatched",
                            ),
                        ]
                    )
                    await db.commit()
                with (
                    patch.object(automation, "async_session", session),
                    patch.object(career_tasks, "async_session", session),
                ):
                    item = await automation.handle_career_task_projection_failure(
                        "career_task_projection_failure",
                        RuntimeError("projection fixture failed"),
                    )
                    task = await career_tasks.get_career_task(
                        "career_task_projection_failure"
                    )
                    async with session() as db:
                        event = await db.get(
                            AutomationEvent,
                            "automation_evt_projection_failure",
                        )
                assert item is not None
                assert event is not None
                return task, event.__dict__, item
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            task, event, item = asyncio.run(
                flow(Path(directory) / "automation-projection-failure.db")
            )
        self.assertEqual(task["status"], "completed")
        self.assertEqual(event["status"], "failed")
        self.assertEqual(item["category"], "failed")
        self.assertEqual(item["task_id"], "career_task_projection_failure")
        self.assertRegex(item["payload"]["projection_error_id"], r"^err_[0-9a-f]{16}$")
        self.assertEqual(event["result_json"]["error_id"], item["payload"]["projection_error_id"])

    def test_automation_dispatch_failure_persists_error_id(self) -> None:
        async def flow(database_path: Path) -> tuple[dict, AutomationEvent]:
            engine = create_async_engine(
                f"sqlite+aiosqlite:///{database_path.as_posix()}",
                connect_args={"timeout": 30},
            )
            session = async_sessionmaker(engine, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                with (
                    patch.object(automation, "async_session", session),
                    patch.object(
                        automation,
                        "_dispatch_job_saved",
                        new=AsyncMock(side_effect=RuntimeError("dispatch fixture failed")),
                    ),
                ):
                    result = await automation.record_automation_event(
                        event_type="JOB_SAVED",
                        source="reliability-test",
                        target_type="job",
                        target_id="7",
                        payload={"runtime_provider": "replay"},
                        dedupe_key="reliability:automation:dispatch-failure",
                    )
                    async with session() as db:
                        event = await db.get(
                            AutomationEvent,
                            result["event_id"],
                        )
                assert event is not None
                return result, event
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            result, event = asyncio.run(
                flow(Path(directory) / "automation-dispatch-failure.db")
            )
        self.assertEqual(result["status"], "failed")
        self.assertRegex(result["result"]["error_id"], r"^err_[0-9a-f]{16}$")
        self.assertEqual(event.status, "failed")
        self.assertEqual(event.result_json["error_id"], result["result"]["error_id"])

    def test_diagnostic_bundle_keeps_durable_failures_bounded_and_redacted(self) -> None:
        canary = "OFFERU_DURABLE_DIAGNOSTIC_CANARY_20260902"

        async def flow(database_path: Path) -> dict:
            engine = create_async_engine(
                f"sqlite+aiosqlite:///{database_path.as_posix()}",
                connect_args={"timeout": 30},
            )
            session = async_sessionmaker(engine, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                async with session() as db:
                    job = Job(
                        title="Diagnostic Role",
                        company="Diagnostic Co",
                        source="reliability-test",
                        raw_description="A diagnostic fixture role.",
                        hash_key="reliability:diagnostic:role",
                    )
                    db.add(job)
                    await db.flush()
                    company_dossier = ResearchDossier(
                        dossier_key="company:diagnostic",
                        dossier_type="company",
                        company_name="Diagnostic Co",
                    )
                    db.add(company_dossier)
                    await db.flush()
                    role_dossier = ResearchDossier(
                        dossier_key="role:diagnostic",
                        dossier_type="role",
                        company_name="Diagnostic Co",
                        job_id=job.id,
                        parent_dossier_id=company_dossier.id,
                    )
                    db.add(role_dossier)
                    await db.flush()
                    db.add_all(
                        [
                            CareerTask(
                                task_id="diagnostic_failed_task",
                                task_type="role_intelligence",
                                source="reliability-test",
                                runtime_provider="replay",
                                status="failed",
                                progress_json={"error_id": "err_0123456789abcdef", "secret": canary},
                                result_json={"answer": canary},
                                error=f"provider failed api_token={canary}",
                                idempotency_key="reliability:diagnostic:task",
                            ),
                            AutomationEvent(
                                event_id="diagnostic_failed_event",
                                event_type="JOB_SAVED",
                                source="reliability-test",
                                payload_json={"body": canary},
                                result_json={"error_id": "err_fedcba9876543210", "body": canary},
                                error=f"projection failed token={canary}",
                                dedupe_key="reliability:diagnostic:event",
                                status="failed",
                            ),
                            RoleBenchmarkRun(
                                run_id="diagnostic_failed_benchmark",
                                target_job_id=job.id,
                                runtime_id="replay",
                                status="failed",
                                trace_json={"error_id": "err_0011223344556677", "raw": canary},
                                error=f"benchmark failed token={canary}",
                            ),
                            JobResearchRun(
                                run_id="diagnostic_failed_research",
                                job_id=job.id,
                                company_dossier_id=company_dossier.id,
                                role_dossier_id=role_dossier.id,
                                runtime_id="replay",
                                status="failed",
                                trace_json={"error_id": "err_8899aabbccddeeff", "raw": canary},
                                error=f"research failed token={canary}",
                            ),
                        ]
                    )
                    await db.commit()
                with (
                    patch("app.database.async_session", session),
                    patch(
                        "app.services.agent_provider_health.list_provider_health",
                        new=AsyncMock(return_value={"providers": []}),
                    ),
                    patch(
                        "app.services.data_safety.get_data_safety_status",
                        new=AsyncMock(return_value={}),
                    ),
                    patch(
                        "app.services.data_safety.check_database_integrity",
                        new=AsyncMock(return_value={"status": "ok", "foreign_key_violations": []}),
                    ),
                    patch(
                        "app.services.privacy_hygiene.get_privacy_hygiene_status",
                        new=AsyncMock(return_value={}),
                    ),
                ):
                    return await diagnostics.export_diagnostic_bundle()
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            bundle = asyncio.run(flow(Path(directory) / "diagnostic-durable-failure.db"))
        durable = bundle["durable_failures"]
        raw = json.dumps(durable, ensure_ascii=False)
        self.assertNotIn(canary, raw)
        self.assertNotIn("input_json", raw)
        self.assertNotIn("payload_json", raw)
        self.assertNotIn("result_json", raw)
        self.assertEqual(durable["status"], "ok")
        self.assertEqual(
            durable["counts"],
            {
                "career_tasks": 1,
                "automation_events": 1,
                "role_benchmarks": 1,
                "job_research": 1,
            },
        )
        self.assertEqual(durable["career_tasks"][0]["error_id"], "err_0123456789abcdef")
        self.assertEqual(durable["automation_events"][0]["error_id"], "err_fedcba9876543210")
        self.assertEqual(durable["role_benchmarks"][0]["error_id"], "err_0011223344556677")
        self.assertEqual(durable["job_research"][0]["error_id"], "err_8899aabbccddeeff")

    def test_duplicate_retry_is_reused(self) -> None:
        async def flow(database_path: Path) -> tuple[list[object], dict]:
            engine = create_async_engine(
                f"sqlite+aiosqlite:///{database_path.as_posix()}",
                connect_args={"timeout": 30},
            )
            session = async_sessionmaker(engine, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                with patch.object(career_tasks, "async_session", session):
                    created = await career_tasks.start_career_task(
                        task_type="agent_turn",
                        source="reliability-test",
                        runtime_provider="missing-provider",
                        input={"prompt": "retry fixture"},
                        idempotency_key="reliability:retry:duplicate",
                        max_attempts=2,
                    )
                    await _await_career_task(created["task_id"])
                    failed = await career_tasks.get_career_task(created["task_id"])
                    self.assertEqual(failed["status"], "failed")
                    retries = await asyncio.gather(
                        career_tasks.retry_career_task(created["task_id"]),
                        career_tasks.retry_career_task(created["task_id"]),
                    )
                    await _await_career_task(created["task_id"])
                    final = await career_tasks.get_career_task(created["task_id"])
                return retries, final
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            retries, final = asyncio.run(flow(Path(directory) / "career-task-retry.db"))
        self.assertEqual({item["task_id"] for item in retries}, {final["task_id"]})
        self.assertEqual(sum(not item["reused"] for item in retries), 1)
        self.assertEqual(sum(item["reused"] for item in retries), 1)
        self.assertEqual(final["status"], "failed")
        self.assertEqual(final["attempt_count"], 2)

    def test_queued_automation_event_is_recovered(self) -> None:
        async def flow(database_path: Path) -> tuple[dict, AutomationEvent]:
            engine = create_async_engine(
                f"sqlite+aiosqlite:///{database_path.as_posix()}",
                connect_args={"timeout": 30},
            )
            session = async_sessionmaker(engine, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                async with session() as db:
                    db.add(
                        AutomationEvent(
                            event_id="automation_evt_recovery",
                            event_type="CAREER_FILE_CHANGED",
                            source="reliability-test",
                            payload_json={"path": "fixture/profile.json"},
                            dedupe_key="reliability:automation:recovery",
                            status="queued",
                        )
                    )
                    await db.commit()
                with patch.object(automation, "async_session", session):
                    result = await automation.recover_automation_events()
                    async with session() as db:
                        event = await db.get(AutomationEvent, "automation_evt_recovery")
                assert event is not None
                return result, event
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            result, event = asyncio.run(
                flow(Path(directory) / "automation-event-recovery.db")
            )
        self.assertEqual(result, {"recovered": 1, "completed": 1, "failed": 0})
        self.assertEqual(event.status, "skipped")

    def test_interrupted_interview_state_is_recoverable(self) -> None:
        async def flow(database_path: Path) -> tuple[dict, dict, dict, list[int]]:
            engine = create_async_engine(
                f"sqlite+aiosqlite:///{database_path.as_posix()}",
                connect_args={"timeout": 30},
            )
            session = async_sessionmaker(engine, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                async with session() as db:
                    active = Interview(
                        title="中断中的模拟面试",
                        status="active",
                        questions_json=[{"question": "请说明一个项目。"}],
                        current_question_index=0,
                    )
                    completed = Interview(
                        title="已完成但未交接学习",
                        status="completed",
                        report_json={"content_score": 80},
                    )
                    db.add_all([active, completed])
                    await db.flush()
                    db.add(
                        InterviewEvaluationRun(
                            evaluation_id="evaluation-recovery",
                            idempotency_key="answer:recovery",
                            interview_id=active.id,
                            scope="content_only",
                            scoring_skill_id="evidence-interview-score",
                            scoring_skill_version=1,
                            input_hash="a" * 64,
                            status="running",
                        )
                    )
                    await db.commit()

                repaired_ids: list[int] = []

                async def fake_repair(interview_id: int) -> None:
                    repaired_ids.append(interview_id)

                with (
                    patch.object(ai_interviews, "async_session", session),
                    patch.object(
                        ai_interviews,
                        "_record_completion_observation",
                        new=AsyncMock(side_effect=fake_repair),
                    ),
                ):
                    result = await ai_interviews.recover_interrupted_interview_state()
                async with session() as db:
                    evaluation = await db.get(InterviewEvaluationRun, "evaluation-recovery")
                    stored_active = await db.get(Interview, active.id)
                assert evaluation is not None
                assert stored_active is not None
                return (
                    result,
                    {
                        "status": evaluation.status,
                        "error": evaluation.error,
                        "completed_at": evaluation.completed_at is not None,
                    },
                    {
                        "status": stored_active.status,
                        "question_index": stored_active.current_question_index,
                    },
                    repaired_ids,
                )
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            result, evaluation, active, repaired_ids = asyncio.run(
                flow(Path(directory) / "interview-recovery.db")
            )
        self.assertEqual(
            result,
            {
                "interrupted_evaluations": 1,
                "learning_repaired": 1,
                "learning_failed": 0,
            },
        )
        self.assertEqual(evaluation["status"], "failed")
        self.assertEqual(
            evaluation["error"],
            "面试评价在应用重启时中断，请重新提交该回答",
        )
        self.assertTrue(evaluation["completed_at"])
        self.assertEqual(active, {"status": "active", "question_index": 0})
        self.assertEqual(len(repaired_ids), 1)


if __name__ == "__main__":
    unittest.main()
