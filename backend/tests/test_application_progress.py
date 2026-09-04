from __future__ import annotations

import asyncio
from datetime import datetime
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
from unittest.mock import AsyncMock, patch

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.database import Base
from app.models.models import (
    ApplicationAttempt,
    ApplicationProgressCandidate,
    ApplicationRecord,
    ApplicationStageEvent,
    ExternalProgressSignal,
    Job,
)
from app.routes.email import ProgressReviewRequest, review_progress_candidate
from app.services.application_events import application_event_store
from app.services.application_progress import (
    APPLICATION_STAGES,
    _STAGE_ORDER,
    _classify_stage,
    _next_action,
    _workspace_status_for_stage,
    get_application_progress_board,
    get_application_progress_overview,
    review_application_progress,
)


def _signal(token: str, received_at: datetime) -> ExternalProgressSignal:
    return ExternalProgressSignal(
        signal_id=f"progress_signal_{token}",
        channel="email",
        account_ref=f"account-{token}",
        external_message_id=f"message-{token}",
        external_thread_id=f"thread-{token}",
        sender="recruiter@example.com",
        received_at=received_at,
        subject="技术面试邀请",
        snippet="我们希望邀请你参加技术面试。",
        body_sha256=token.ljust(64, "0")[:64],
        classification_json={"suggested_stage": "interview_1"},
        status="active",
    )


def _candidate(
    token: str,
    signal_id: int,
    *,
    stage: str,
    match_state: str,
    attempt_id: int | None = None,
) -> ApplicationProgressCandidate:
    return ApplicationProgressCandidate(
        candidate_id=f"progress_candidate_{token}",
        signal_id=signal_id,
        suggested_attempt_id=attempt_id,
        suggested_stage=stage,
        match_state=match_state,
        match_candidates_json=[],
        reasons_json=[],
        llm_extracted_json={
            "company": f"Example {token}",
            "job_title": "Agent Engineer",
        },
        status="pending",
    )


class ApplicationProgressTests(unittest.TestCase):
    def test_deterministic_signal_keywords_cover_each_external_stage(self) -> None:
        examples = {
            "感谢投递": "applied",
            "笔试邀请": "written_test",
            "在线测评邀请": "assessment",
            "技术面试邀请": "interview_1",
            "二面安排": "interview_2",
            "HR面安排": "interview_hr",
            "正式录用通知": "offer",
            "很遗憾未通过": "rejected",
        }

        for text, expected_stage in examples.items():
            stage, evidence = _classify_stage(text)
            self.assertEqual(stage, expected_stage, text)
            self.assertEqual(evidence["method"], "deterministic_keyword", text)

        self.assertEqual(APPLICATION_STAGES - {"prepared", "unknown"}, set(examples.values()))

    def test_all_external_stages_project_to_timeline_board_and_workspace(self) -> None:
        stages = [
            "applied",
            "written_test",
            "assessment",
            "interview_1",
            "interview_2",
            "interview_hr",
            "offer",
            "rejected",
        ]

        async def run(database_path: Path) -> tuple[list[dict], dict, dict, list[dict]]:
            engine = create_async_engine(
                f"sqlite+aiosqlite:///{database_path.as_posix()}"
            )
            session = async_sessionmaker(
                engine,
                class_=AsyncSession,
                expire_on_commit=False,
            )
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                token = uuid.uuid4().hex[:10]
                candidate_ids: list[str] = []
                async with session() as db:
                    for index, stage in enumerate(stages):
                        job = Job(
                            title=f"{stage} Role",
                            company=f"Stage Company {index}",
                            source="stage-matrix-test",
                            hash_key=uuid.uuid4().hex,
                        )
                        db.add(job)
                        await db.flush()
                        attempt = ApplicationAttempt(job_id=job.id, status="applied")
                        db.add(attempt)
                        await db.flush()
                        signal = _signal(
                            f"{token}-{index}",
                            datetime(2026, 8, 13, 9 + index, 0, 0),
                        )
                        signal.subject = f"stage={stage}"
                        db.add(signal)
                        await db.flush()
                        candidate = _candidate(
                            f"{token}-{index}",
                            signal.id,
                            stage=stage,
                            match_state="suggested",
                            attempt_id=attempt.id,
                        )
                        db.add(candidate)
                        candidate_ids.append(candidate.candidate_id)
                    await db.commit()

                with patch(
                    "app.services.application_progress.async_session",
                    session,
                ):
                    results = [
                        await review_application_progress(
                            candidate_id=candidate_id,
                            action="accept",
                            add_calendar=False,
                        )
                        for candidate_id in candidate_ids
                    ]
                    board = await get_application_progress_board(
                        status="all",
                        include_timeline=True,
                    )
                    overview = await get_application_progress_overview(
                        disclosure="detail",
                        limit=100,
                    )

                async with session() as db:
                    records = [
                        {
                            "stage": event.stage,
                            "previous_stage": event.previous_stage,
                        }
                        for event in (
                            await db.execute(
                                select(ApplicationStageEvent).order_by(
                                    ApplicationStageEvent.id.asc()
                                )
                            )
                        ).scalars().all()
                    ]
                return results, board, overview, records
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory, patch.object(
            application_event_store,
            "directory",
            Path(directory) / "events",
        ):
            results, board, overview, events = asyncio.run(
                run(Path(directory) / "stage-matrix.db")
            )

        self.assertEqual([item["stage_event"]["stage"] for item in results], stages)
        self.assertEqual(
            [item["workspace_record"]["status"] for item in results],
            [_workspace_status_for_stage(stage) for stage in stages],
        )
        self.assertEqual([item["stage"] for item in events], stages)
        self.assertTrue(all(item["previous_stage"] == "applied" for item in events))

        board_rows = [
            record
            for company in board["companies"]
            for record in company["records"]
        ]
        self.assertEqual(
            {record["current_stage"] for record in board_rows},
            set(stages),
        )
        self.assertEqual(
            {record["current_stage"] for record in overview["items"]},
            set(stages),
        )
        self.assertTrue(all(_next_action(stage) for stage in _STAGE_ORDER))

    def test_review_route_forwards_record_and_calendar_options(self) -> None:
        execute = AsyncMock(
            return_value={
                "ok": True,
                "outputs": {"candidate_id": "progress_candidate_route"},
            }
        )
        with patch("app.ops.execute_operation", new=execute):
            result = asyncio.run(
                review_progress_candidate(
                    "progress_candidate_route",
                    ProgressReviewRequest(
                        action="accept",
                        stage="interview_1",
                        add_calendar=False,
                        create_record=True,
                    ),
                )
            )

        self.assertEqual(result["candidate_id"], "progress_candidate_route")
        execute.assert_awaited_once_with(
            "review_application_progress",
            {
                "candidate_id": "progress_candidate_route",
                "action": "accept",
                "application_attempt_id": None,
                "stage": "interview_1",
                "note": "",
                "add_calendar": False,
                "create_record": True,
            },
            surface="email_api",
        )

    def test_unassigned_candidate_is_visible_then_creates_one_record(self) -> None:
        async def run(database_path: Path) -> tuple[dict, dict, dict, tuple[int, int, int, int]]:
            engine = create_async_engine(
                f"sqlite+aiosqlite:///{database_path.as_posix()}"
            )
            session = async_sessionmaker(
                engine,
                class_=AsyncSession,
                expire_on_commit=False,
            )
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                token = uuid.uuid4().hex[:12]
                async with session() as db:
                    signal = _signal(token, datetime(2026, 8, 13, 9, 0, 0))
                    db.add(signal)
                    await db.flush()
                    candidate = _candidate(
                        token,
                        signal.id,
                        stage="unknown",
                        match_state="unassigned",
                    )
                    db.add(candidate)
                    await db.commit()
                    candidate_id = candidate.candidate_id

                with patch(
                    "app.services.application_progress.async_session",
                    session,
                ):
                    before = await get_application_progress_board()
                    first = await review_application_progress(
                        candidate_id=candidate_id,
                        action="accept",
                        stage="interview_1",
                        add_calendar=False,
                        create_record=True,
                    )
                    second = await review_application_progress(
                        candidate_id=candidate_id,
                        action="accept",
                        stage="interview_1",
                        add_calendar=False,
                        create_record=True,
                    )

                async with session() as db:
                    count_items: list[int] = []
                    for model in (
                        Job,
                        ApplicationAttempt,
                        ApplicationRecord,
                        ApplicationStageEvent,
                    ):
                        count_items.append(
                            int(
                                (
                                    await db.execute(
                                        select(func.count()).select_from(model)
                                    )
                                ).scalar_one()
                            )
                        )
                    counts = tuple(count_items)
                    record = (await db.execute(select(ApplicationRecord))).scalar_one()
                    self.assertEqual(
                        (record.custom_values or {}).get("apply_status"),
                        "面试中",
                    )
                return before, first, second, counts
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory, patch.object(
            application_event_store,
            "directory",
            Path(directory) / "events",
        ):
            before, first, second, counts = asyncio.run(
                run(Path(directory) / "progress-create.db")
            )

        self.assertEqual(before["summary"]["pending_review"], 1)
        self.assertEqual(len(before["unlinked_candidates"]), 1)
        self.assertTrue(before["unlinked_candidates"][0]["can_create_record"])
        self.assertEqual(first["status"], "confirmed")
        self.assertTrue(first["created_record"]["application_attempt_created"])
        self.assertTrue(second["duplicate"])
        self.assertEqual(counts, (1, 1, 1, 1))

    def test_ambiguous_candidate_cannot_create_a_duplicate_attempt(self) -> None:
        async def run(database_path: Path) -> int:
            engine = create_async_engine(
                f"sqlite+aiosqlite:///{database_path.as_posix()}"
            )
            session = async_sessionmaker(
                engine,
                class_=AsyncSession,
                expire_on_commit=False,
            )
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                token = uuid.uuid4().hex[:12]
                async with session() as db:
                    signal = _signal(token, datetime(2026, 8, 13, 10, 0, 0))
                    db.add(signal)
                    await db.flush()
                    db.add(
                        _candidate(
                            token,
                            signal.id,
                            stage="interview_1",
                            match_state="ambiguous",
                        )
                    )
                    await db.commit()
                with patch(
                    "app.services.application_progress.async_session",
                    session,
                ):
                    with self.assertRaisesRegex(ValueError, "无匹配投递"):
                        await review_application_progress(
                            candidate_id=f"progress_candidate_{token}",
                            action="accept",
                            create_record=True,
                            add_calendar=False,
                        )
                async with session() as db:
                    return int(
                        (
                            await db.execute(
                                select(func.count()).select_from(ApplicationAttempt)
                            )
                        ).scalar_one()
                    )
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            attempts = asyncio.run(run(Path(directory) / "progress-ambiguous.db"))
        self.assertEqual(attempts, 0)

    def test_out_of_order_signal_repairs_the_stage_chain(self) -> None:
        async def run(database_path: Path) -> tuple[list[tuple[str, str]], str]:
            engine = create_async_engine(
                f"sqlite+aiosqlite:///{database_path.as_posix()}"
            )
            session = async_sessionmaker(
                engine,
                class_=AsyncSession,
                expire_on_commit=False,
            )
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                token = uuid.uuid4().hex[:10]
                async with session() as db:
                    job = Job(
                        title="Agent Engineer",
                        company="Example Timeline",
                        source="unit-test",
                        hash_key=uuid.uuid4().hex,
                    )
                    db.add(job)
                    await db.flush()
                    attempt = ApplicationAttempt(job_id=job.id, status="applied")
                    db.add(attempt)
                    await db.flush()
                    later_signal = _signal(f"{token}later", datetime(2026, 8, 13, 12, 0, 0))
                    earlier_signal = _signal(f"{token}early", datetime(2026, 8, 13, 11, 0, 0))
                    db.add_all([later_signal, earlier_signal])
                    await db.flush()
                    later = _candidate(
                        f"{token}later",
                        later_signal.id,
                        stage="offer",
                        match_state="suggested",
                        attempt_id=attempt.id,
                    )
                    earlier = _candidate(
                        f"{token}early",
                        earlier_signal.id,
                        stage="interview_1",
                        match_state="suggested",
                        attempt_id=attempt.id,
                    )
                    db.add_all([later, earlier])
                    await db.commit()
                    later_id = later.candidate_id
                    earlier_id = earlier.candidate_id

                with patch(
                    "app.services.application_progress.async_session",
                    session,
                ):
                    await review_application_progress(
                        candidate_id=later_id,
                        action="accept",
                        add_calendar=False,
                    )
                    await review_application_progress(
                        candidate_id=earlier_id,
                        action="accept",
                        add_calendar=False,
                    )

                async with session() as db:
                    events = (
                        await db.execute(
                            select(ApplicationStageEvent).order_by(
                                ApplicationStageEvent.occurred_at.asc(),
                                ApplicationStageEvent.id.asc(),
                            )
                        )
                    ).scalars().all()
                    record = (await db.execute(select(ApplicationRecord))).scalar_one()
                    return (
                        [(event.previous_stage, event.stage) for event in events],
                        str((record.custom_values or {}).get("apply_status")),
                    )
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory, patch.object(
            application_event_store,
            "directory",
            Path(directory) / "events",
        ):
            chain, workspace_status = asyncio.run(
                run(Path(directory) / "progress-order.db")
            )
        self.assertEqual(
            chain,
            [("applied", "interview_1"), ("interview_1", "offer")],
        )
        self.assertEqual(workspace_status, "已录用")


if __name__ == "__main__":
    unittest.main()
