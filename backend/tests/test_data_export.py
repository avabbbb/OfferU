from __future__ import annotations

import asyncio
import json
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
    CareerTask,
    Interview,
    InterviewMessage,
    Job,
    Profile,
    Resume,
    ResumeSection,
)
from app.ops import OPERATIONS
from app.services.data_export import export_user_data
from app.services.career_artifacts import CareerArtifactStore


class DataExportTests(unittest.TestCase):
    def test_export_contains_core_state_and_redacts_secret_keys(self) -> None:
        async def run(database_path: Path, artifacts_dir: Path) -> dict:
            engine = create_async_engine(f"sqlite+aiosqlite:///{database_path.as_posix()}")
            session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
            artifact_store = CareerArtifactStore(artifacts_dir)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                async with session() as db:
                    profile = Profile(
                        name="导出测试档案",
                        email="user@example.com",
                        base_info_json={"api_key": "should-not-leak"},
                    )
                    job = Job(
                        title="导出测试岗位",
                        company="内测公司",
                        raw_description="真实岗位描述",
                        hash_key="export-test-job",
                    )
                    db.add_all([profile, job])
                    await db.flush()
                    resume = Resume(
                        user_name="导出测试档案",
                        title="岗位定制简历",
                        source_profile_id=profile.id,
                        target_job_id=job.id,
                        contact_json={"email": "user@example.com", "api_token": "should-not-leak"},
                    )
                    db.add(resume)
                    await db.flush()
                    db.add(
                        ResumeSection(
                            resume_id=resume.id,
                            section_type="experience",
                            title="经历",
                            content_json=[{"company": "内测公司", "description": "完成岗位项目"}],
                        )
                    )
                    application = Application(
                        job_id=job.id,
                        status="prepared",
                        notes="Application packet ready",
                    )
                    interview = Interview(
                        title="导出测试面试",
                        target_company="内测公司",
                        target_position="产品经理",
                        target_job_id=job.id,
                        resume_id=resume.id,
                        profile_id=profile.id,
                        model_runtime_json={"api_key": "should-not-leak"},
                    )
                    db.add_all([application, interview])
                    await db.flush()
                    db.add(
                        InterviewMessage(
                            interview_id=interview.id,
                            role="candidate",
                            content="我负责过一项真实项目。",
                        )
                    )
                    db.add(
                        CareerTask(
                            task_id="export-test-task",
                            task_type="role_intelligence",
                            target_type="job",
                            target_id="1",
                            input_json={"api_token": "should-not-leak", "job_id": 1},
                            idempotency_key="export-test-task-key",
                        )
                    )
                    await db.commit()
                artifact_store.save(
                    artifact_type="interview_debrief",
                    title="导出面试复盘",
                    content_markdown="面试复盘正文",
                    related_job_id=job.id,
                    metadata={"api_key": "should-not-leak"},
                )
                with patch("app.services.data_export.async_session", session), patch(
                    "app.services.data_export.career_artifact_store", artifact_store
                ):
                    return await export_user_data()
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            payload = asyncio.run(run(Path(directory) / "export.db", Path(directory) / "artifacts"))

        self.assertEqual(payload["schema_version"], "offeru.internal-beta.export.v1")
        self.assertEqual(payload["data"]["profiles"][0]["name"], "导出测试档案")
        self.assertEqual(payload["data"]["profiles"][0]["base_info_json"]["api_key"], "[redacted]")
        self.assertEqual(payload["data"]["resumes"][0]["contact_json"]["api_token"], "[redacted]")
        self.assertEqual(payload["data"]["interviews"][0]["model_runtime_json"]["api_key"], "[redacted]")
        self.assertEqual(payload["data"]["career_tasks"][0]["input_json"]["api_token"], "[redacted]")
        self.assertEqual(payload["counts"]["profiles"], 1)
        self.assertEqual(payload["counts"]["jobs"], 1)
        self.assertEqual(payload["counts"]["applications"], 1)
        self.assertEqual(payload["counts"]["resumes"], 1)
        self.assertEqual(payload["counts"]["resume_sections"], 1)
        self.assertEqual(payload["counts"]["interviews"], 1)
        self.assertEqual(payload["counts"]["interview_messages"], 1)
        self.assertEqual(payload["counts"]["career_artifacts"], 1)
        self.assertEqual(payload["data"]["career_artifacts"][0]["metadata"]["api_key"], "[redacted]")
        serialized = json.dumps(payload, ensure_ascii=False)
        self.assertNotIn("should-not-leak", serialized)
        self.assertIn("导出测试岗位", serialized)
        self.assertIn("Application packet ready", serialized)
        self.assertIn("我负责过一项真实项目", serialized)
        self.assertIn("data", OPERATIONS["export_user_data"].audit_redacted_output_parameters)


if __name__ == "__main__":
    unittest.main()
