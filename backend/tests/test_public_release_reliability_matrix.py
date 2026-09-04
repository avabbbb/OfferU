from __future__ import annotations

import asyncio
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, patch

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.models import Base, CareerTask, CareerTaskEvent
from app.services import career_tasks


def test_provider_auth_and_timeout_failures_are_durable_and_retryable() -> None:
    cases = [
        (
            "provider-auth",
            RuntimeError("401 invalid_api_key=RELEASE_CANARY_SECRET"),
            "blocked",
            "provider authentication failed",
            "task.blocked",
        ),
        (
            "provider-timeout",
            TimeoutError("provider network timeout"),
            "failed",
            "provider network timeout",
            "task.failed",
        ),
    ]

    async def flow(database_path: Path) -> list[dict]:
        engine = create_async_engine(
            f"sqlite+aiosqlite:///{database_path.as_posix()}",
            connect_args={"timeout": 30},
        )
        session = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            async with session() as db:
                for suffix, *_ in cases:
                    db.add(
                        CareerTask(
                            task_id=f"career_task_{suffix}",
                            task_type="agent_turn",
                            source="release-reliability",
                            runtime_provider="replay",
                            input_json={"prompt": suffix},
                            output_contract_json={},
                            status="queued",
                            progress_json={"stage": "queued", "percent": 0},
                            idempotency_key=f"release-reliability:{suffix}",
                            retryable=True,
                            attempt_count=0,
                            max_attempts=2,
                        )
                    )
                await db.commit()

            results: list[dict] = []
            with (
                patch.object(career_tasks, "async_session", session),
                patch.object(career_tasks, "_notify_automation", new=AsyncMock()),
            ):
                for suffix, failure, expected_status, expected_error, event_type in cases:
                    with patch.object(
                        career_tasks,
                        "_run_agent_turn",
                        new=AsyncMock(side_effect=failure),
                    ):
                        await career_tasks._run_task(f"career_task_{suffix}")
                    task = await career_tasks.get_career_task(f"career_task_{suffix}")
                    events = await career_tasks.list_career_task_events(
                        f"career_task_{suffix}"
                    )
                    results.append(
                        {
                            "task": task,
                            "event_types": [item["type"] for item in events["events"]],
                            "expected_status": expected_status,
                            "expected_error": expected_error,
                            "expected_event": event_type,
                        }
                    )

            async with session() as db:
                stored_events = (
                    await db.execute(select(CareerTaskEvent))
                ).scalars().all()
            assert len(stored_events) == 4
            return results
        finally:
            await engine.dispose()

    with TemporaryDirectory() as directory:
        results = asyncio.run(flow(Path(directory) / "provider-failure-matrix.db"))

    for result in results:
        task = result["task"]
        assert task["status"] == result["expected_status"]
        assert task["error"] == result["expected_error"]
        assert task["retryable"] is True
        assert task["attempt_count"] == 1
        assert result["expected_event"] in result["event_types"]
        assert "RELEASE_CANARY_SECRET" not in str(task)
