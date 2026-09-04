from __future__ import annotations

import asyncio
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.database import Base  # noqa: E402
from app.models.models import (  # noqa: E402
    Application,
    CareerSource,
    EvidenceLink,
    Job,
    LearningObservation,
    MemoryProposal,
    Resume,
    ResumeSection,
)
from app.services import career_memory, legacy_operations, resume_route_operations  # noqa: E402


class Reliability06MutationTests(unittest.TestCase):
    def test_legacy_application_create_and_update_retry_are_idempotent(self) -> None:
        async def flow(database_path: Path) -> tuple[dict, dict, dict, dict, int, object]:
            engine = create_async_engine(
                f"sqlite+aiosqlite:///{database_path.as_posix()}",
                connect_args={"timeout": 30},
            )
            sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                async with sessions() as db:
                    job = Job(
                        title="Reliability-06 岗位",
                        company="Reliability-06 公司",
                        raw_description="验证投递重试。",
                        hash_key="reliability-06-legacy-application",
                    )
                    db.add(job)
                    await db.commit()
                    await db.refresh(job)
                    job_id = job.id

                with (
                    patch.object(legacy_operations, "async_session", sessions),
                    patch.object(
                        legacy_operations,
                        "auto_write_job_to_total",
                        new=AsyncMock(),
                    ),
                ):
                    first = await legacy_operations.create_legacy_application(
                        job_id=job_id,
                        notes="一次提交",
                    )
                    second = await legacy_operations.create_legacy_application(
                        job_id=job_id,
                        notes="一次提交",
                    )
                    submitted = await legacy_operations.update_legacy_application(
                        application_id=first["id"],
                        status="submitted",
                    )
                    async with sessions() as db:
                        before_retry = await db.get(Application, first["id"])
                    replayed = await legacy_operations.update_legacy_application(
                        application_id=first["id"],
                        status="submitted",
                    )
                    async with sessions() as db:
                        after_retry = await db.get(Application, first["id"])
                        count = int(
                            (await db.execute(select(func.count(Application.id)))).scalar_one()
                        )
                assert before_retry is not None
                assert after_retry is not None
                return first, second, submitted, replayed, count, (before_retry, after_retry)
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            first, second, submitted, replayed, count, timestamps = asyncio.run(
                flow(Path(directory) / "legacy-application.db")
            )

        before_retry, after_retry = timestamps
        self.assertFalse(first["duplicate"])
        self.assertTrue(second["duplicate"])
        self.assertEqual(first["id"], second["id"])
        self.assertFalse(submitted["duplicate"])
        self.assertTrue(replayed["duplicate"])
        self.assertEqual(count, 1)
        self.assertEqual(before_retry.submitted_at, after_retry.submitted_at)

    def test_resume_same_payload_retry_does_not_advance_revision(self) -> None:
        async def flow(database_path: Path) -> tuple[dict, dict, int, int]:
            engine = create_async_engine(f"sqlite+aiosqlite:///{database_path.as_posix()}")
            sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                async with sessions() as db:
                    resume = Resume(user_name="Reliability-06", title="主简历", summary="原始摘要")
                    db.add(resume)
                    await db.flush()
                    section = ResumeSection(
                        resume_id=resume.id,
                        section_type="experience",
                        sort_order=0,
                        title="经历",
                        content_json=[{"description": "已验证内容"}],
                    )
                    db.add(section)
                    await db.commit()
                    await db.refresh(resume)
                    await db.refresh(section)
                    resume_id = resume.id
                    section_id = section.id

                payload = {
                    "summary": "用户确认后的摘要",
                    "sections": [
                        {
                            "id": section_id,
                            "section_type": "experience",
                            "sort_order": 0,
                            "title": "经历",
                            "visible": True,
                            "content_json": [{"description": "已验证内容"}],
                        }
                    ],
                }
                with patch.object(resume_route_operations, "async_session", sessions):
                    first = await resume_route_operations.update_resume_record(resume_id, payload)
                    second = await resume_route_operations.update_resume_record(resume_id, payload)
                async with sessions() as db:
                    stored = await db.get(Resume, resume_id)
                    section_count = int(
                        (await db.execute(select(func.count(ResumeSection.id)))).scalar_one()
                    )
                assert stored is not None
                return first, second, int(stored.workspace_revision or 0), section_count
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            first, second, revision, section_count = asyncio.run(
                flow(Path(directory) / "resume-retry.db")
            )

        self.assertFalse(first["duplicate"])
        self.assertTrue(second["duplicate"])
        self.assertEqual(revision, 1)
        self.assertEqual(section_count, 1)

    def test_memory_reject_retry_returns_terminal_duplicate(self) -> None:
        async def flow(database_path: Path) -> tuple[dict, dict]:
            engine = create_async_engine(f"sqlite+aiosqlite:///{database_path.as_posix()}")
            sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                async with sessions() as db:
                    source = CareerSource(
                        source_type="manual",
                        external_id="reliability-06-memory-source",
                        title="Reliability-06 来源",
                        locator="manual:reliability-06",
                    )
                    db.add(source)
                    await db.flush()
                    observation = LearningObservation(
                        source_id=source.id,
                        observation_type="manual_signal",
                        content_json={"statement": "一条可审核观察"},
                        content_hash="a" * 64,
                        idempotency_key="reliability-06-memory-observation",
                    )
                    db.add(observation)
                    await db.flush()
                    proposal = MemoryProposal(
                        proposal_key="reliability-06-memory-proposal",
                        target_tier="career_hypothesis",
                        section_type="skill",
                        title="Reliability-06 提案",
                        after_json={"bullet": "一条可审核观察"},
                        reason="用于重试测试",
                        impact_json=[],
                        status="pending",
                    )
                    db.add(proposal)
                    await db.flush()
                    db.add(
                        EvidenceLink(
                            observation_id=observation.id,
                            target_type="memory_proposal",
                            target_id=proposal.id,
                            relation="supports",
                            is_active=True,
                        )
                    )
                    await db.commit()
                    proposal_id = proposal.id

                with patch.object(career_memory, "async_session", sessions):
                    first = await career_memory.review_memory_proposal(
                        proposal_id=proposal_id,
                        action="reject",
                    )
                    second = await career_memory.review_memory_proposal(
                        proposal_id=proposal_id,
                        action="reject",
                    )
                return first, second
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            first, second = asyncio.run(
                flow(Path(directory) / "memory-retry.db")
            )

        self.assertEqual(first["status"], "rejected")
        self.assertEqual(second["status"], "rejected")
        self.assertTrue(second["duplicate"])


if __name__ == "__main__":
    unittest.main()
