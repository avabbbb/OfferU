from __future__ import annotations

import asyncio
from datetime import datetime
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

BACKEND_DIR = Path(__file__).resolve().parents[1]
import sys

if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.database import Base
from app.models.models import (
    Application,
    ApplicationAttempt,
    ApplicationRecord,
    AutomationEvent,
    AutomationInboxItem,
    CalendarEvent,
    CareerTask,
    Interview,
    InterviewMessage,
    Job,
    Profile,
    Resume,
    ResumeSection,
    ResumeShare,
    ResumeVersion,
)
from app.ops import OPERATIONS, execute_operation
from app.services.career_artifacts import CareerArtifactStore
from app.services.data_safety import DataSafetyError
from app.services.demo_data import (
    DEMO_BATCH_ID,
    DEMO_JOB_SOURCE,
    reset_demo_data,
)


class DemoDataResetTests(unittest.TestCase):
    def test_reset_only_removes_explicit_demo_scope_and_preserves_real_data(self) -> None:
        async def run(database_path: Path, artifacts_dir: Path) -> dict:
            engine = create_async_engine(f"sqlite+aiosqlite:///{database_path.as_posix()}")
            session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
            artifact_store = CareerArtifactStore(artifacts_dir)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                    await connection.exec_driver_sql("PRAGMA foreign_keys=ON")
                async with session() as db:
                    profile = Profile(name="真实档案", email="real@example.com")
                    demo_job = Job(
                        title="Demo 岗位",
                        company="OfferU Demo",
                        source=DEMO_JOB_SOURCE,
                        batch_id=DEMO_BATCH_ID,
                        hash_key="demo-reset-job",
                    )
                    real_job = Job(
                        title="真实岗位",
                        company="真实公司",
                        source="boss",
                        batch_id="real-import",
                        hash_key="real-reset-job",
                    )
                    db.add_all([profile, demo_job, real_job])
                    await db.flush()

                    demo_resume = Resume(
                        user_name="真实档案",
                        title="Demo 简历",
                        source_mode="demo",
                        target_job_id=demo_job.id,
                        source_profile_id=profile.id,
                    )
                    real_resume = Resume(
                        user_name="真实档案",
                        title="真实简历",
                        source_mode="manual",
                        target_job_id=real_job.id,
                        source_profile_id=profile.id,
                    )
                    db.add_all([demo_resume, real_resume])
                    await db.flush()
                    db.add_all(
                        [
                            ResumeSection(resume_id=demo_resume.id, section_type="experience", title="Demo 经历"),
                            ResumeVersion(
                                resume_id=demo_resume.id,
                                version_number=1,
                                change_summary="Demo version",
                            ),
                            ResumeShare(
                                resume_id=demo_resume.id,
                                share_token="demo-reset-share-token",
                            ),
                        ]
                    )

                    demo_application = Application(
                        job_id=demo_job.id,
                        status="prepared",
                        notes="Demo application",
                    )
                    real_application = Application(
                        job_id=real_job.id,
                        status="submitted",
                        notes="Real application",
                    )
                    db.add_all([demo_application, real_application])
                    await db.flush()
                    db.add_all(
                        [
                            ApplicationAttempt(
                                job_id=demo_job.id,
                                resume_id=demo_resume.id,
                                status="prepared",
                            ),
                            ApplicationAttempt(
                                job_id=real_job.id,
                                resume_id=real_resume.id,
                                status="submitted",
                            ),
                            ApplicationRecord(
                                job_ref_id=demo_job.id,
                                company_name="OfferU Demo",
                                job_title="Demo 岗位",
                            ),
                            ApplicationRecord(
                                job_ref_id=real_job.id,
                                company_name="真实公司",
                                job_title="真实岗位",
                            ),
                        ]
                    )
                    demo_interview = Interview(
                        title="Demo 面试",
                        target_company="OfferU Demo",
                        target_position="Demo PM",
                        target_job_id=demo_job.id,
                        resume_id=demo_resume.id,
                        profile_id=profile.id,
                    )
                    real_interview = Interview(
                        title="真实面试",
                        target_company="真实公司",
                        target_position="真实岗位",
                        target_job_id=real_job.id,
                        resume_id=real_resume.id,
                        profile_id=profile.id,
                    )
                    db.add_all([demo_interview, real_interview])
                    await db.flush()
                    db.add_all(
                        [
                            InterviewMessage(
                                interview_id=demo_interview.id,
                                role="candidate",
                                content="Demo answer",
                            ),
                            InterviewMessage(
                                interview_id=real_interview.id,
                                role="candidate",
                                content="Real answer",
                            ),
                            CalendarEvent(
                                title="Demo interview",
                                start_time=datetime(2026, 8, 31, 10, 0),
                                related_job_id=demo_job.id,
                            ),
                            CalendarEvent(
                                title="Real interview",
                                start_time=datetime(2026, 8, 31, 11, 0),
                                related_job_id=real_job.id,
                            ),
                            CareerTask(
                                task_id="demo-reset-task",
                                task_type="role_intelligence",
                                source=DEMO_JOB_SOURCE,
                                target_type="job",
                                target_id=str(demo_job.id),
                                idempotency_key="demo-reset-task-key",
                            ),
                            CareerTask(
                                task_id="real-reset-task",
                                task_type="role_intelligence",
                                source="ui",
                                target_type="job",
                                target_id=str(real_job.id),
                                idempotency_key="real-reset-task-key",
                            ),
                            AutomationEvent(
                                event_id="demo-reset-event",
                                event_type="JOB_SAVED",
                                source=DEMO_JOB_SOURCE,
                                target_type="job",
                                target_id=str(demo_job.id),
                                dedupe_key="demo-reset-event-key",
                            ),
                            AutomationEvent(
                                event_id="real-reset-event",
                                event_type="JOB_SAVED",
                                source="ui",
                                target_type="job",
                                target_id=str(real_job.id),
                                dedupe_key="real-reset-event-key",
                            ),
                            AutomationInboxItem(
                                item_id="demo-reset-inbox",
                                target_type="job",
                                target_id=str(demo_job.id),
                                title="Demo review",
                            ),
                            AutomationInboxItem(
                                item_id="real-reset-inbox",
                                target_type="job",
                                target_id=str(real_job.id),
                                title="Real review",
                            ),
                        ]
                    )
                    await db.commit()
                    demo_job_id = demo_job.id
                    real_job_id = real_job.id
                    demo_resume_id = demo_resume.id
                    real_resume_id = real_resume.id
                    demo_interview_id = demo_interview.id
                    real_interview_id = real_interview.id

                demo_artifact = artifact_store.save(
                    artifact_type="interview_prep",
                    title="Demo artifact",
                    content_markdown="Demo content",
                    related_job_id=demo_job_id,
                )
                real_artifact = artifact_store.save(
                    artifact_type="interview_prep",
                    title="Real artifact",
                    content_markdown="Real content",
                    related_job_id=real_job_id,
                )
                with patch("app.services.demo_data.async_session", session), patch(
                    "app.services.demo_data.career_artifact_store", artifact_store
                ):
                    result = await reset_demo_data(user_confirmed=True)
                    second = await reset_demo_data(user_confirmed=True)

                async with session() as db:
                    remaining = {
                        "profile": await db.get(Profile, profile.id),
                        "demo_job": await db.get(Job, demo_job_id),
                        "real_job": await db.get(Job, real_job_id),
                        "demo_resume": await db.get(Resume, demo_resume_id),
                        "real_resume": await db.get(Resume, real_resume_id),
                        "demo_interview": await db.get(Interview, demo_interview_id),
                        "real_interview": await db.get(Interview, real_interview_id),
                    }
                return {
                    "result": result,
                    "second": second,
                    "remaining": {key: value is not None for key, value in remaining.items()},
                    "artifacts": {
                        "demo": artifact_store.get(demo_artifact["id"]),
                        "real": artifact_store.get(real_artifact["id"]),
                    },
                }
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            result = asyncio.run(
                run(Path(directory) / "demo.db", Path(directory) / "artifacts")
            )

        self.assertTrue(result["result"]["reset"])
        self.assertEqual(result["result"]["matched_jobs"], 1)
        self.assertTrue(result["result"]["real_data_preserved"])
        self.assertTrue(result["remaining"]["profile"])
        self.assertFalse(result["remaining"]["demo_job"])
        self.assertTrue(result["remaining"]["real_job"])
        self.assertFalse(result["remaining"]["demo_resume"])
        self.assertTrue(result["remaining"]["real_resume"])
        self.assertFalse(result["remaining"]["demo_interview"])
        self.assertTrue(result["remaining"]["real_interview"])
        self.assertIsNone(result["artifacts"]["demo"])
        self.assertIsNotNone(result["artifacts"]["real"])
        self.assertFalse(result["second"]["reset"])
        self.assertEqual(result["second"]["reason"], "no_marked_demo_data")

    def test_reset_requires_explicit_confirmation_and_registry_exposes_dry_run(self) -> None:
        self.assertIn("reset_demo_data", OPERATIONS)
        dry_run = asyncio.run(
            execute_operation(
                "reset_demo_data",
                {"user_confirmed": True},
                dry_run=True,
                audit=False,
            )
        )
        self.assertTrue(dry_run["ok"])
        self.assertEqual(dry_run["outputs"]["reason"], "dry_run")
        with self.assertRaises(DataSafetyError):
            asyncio.run(reset_demo_data(user_confirmed=False))


if __name__ == "__main__":
    unittest.main()
