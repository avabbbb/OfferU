from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.database import Base  # noqa: E402
from app.models.models import AutomationEvent, CareerTask, CareerTaskEvent  # noqa: E402
from app.services import automation, career_tasks  # noqa: E402


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
                    worker = career_tasks._LIVE_TASKS.get(results[0]["task_id"])
                    self.assertIsNotNone(worker)
                    assert worker is not None
                    await worker
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
                        worker = career_tasks._LIVE_TASKS.get(first["task_id"])
                        self.assertIsNotNone(worker)
                        assert worker is not None
                        await worker
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
                    worker = career_tasks._LIVE_TASKS.get("career_task_queued_recovery")
                    self.assertIsNotNone(worker)
                    assert worker is not None
                    await worker
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
                    worker = career_tasks._LIVE_TASKS.get(created["task_id"])
                    self.assertIsNotNone(worker)
                    assert worker is not None
                    await worker
                    failed = await career_tasks.get_career_task(created["task_id"])
                    self.assertEqual(failed["status"], "failed")
                    retries = await asyncio.gather(
                        career_tasks.retry_career_task(created["task_id"]),
                        career_tasks.retry_career_task(created["task_id"]),
                    )
                    retry_worker = career_tasks._LIVE_TASKS.get(created["task_id"])
                    self.assertIsNotNone(retry_worker)
                    assert retry_worker is not None
                    await retry_worker
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


if __name__ == "__main__":
    unittest.main()
