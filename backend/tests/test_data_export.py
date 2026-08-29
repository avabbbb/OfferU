from __future__ import annotations

import asyncio
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
from app.models.models import CareerTask, Job, Profile
from app.ops import OPERATIONS
from app.services.data_export import export_user_data


class DataExportTests(unittest.TestCase):
    def test_export_contains_core_state_and_redacts_secret_keys(self) -> None:
        async def run(database_path: Path) -> dict:
            engine = create_async_engine(f"sqlite+aiosqlite:///{database_path.as_posix()}")
            session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                async with session() as db:
                    db.add(
                        Profile(
                            name="导出测试档案",
                            email="user@example.com",
                            base_info_json={"api_key": "should-not-leak"},
                        )
                    )
                    db.add(
                        Job(
                            title="导出测试岗位",
                            company="内测公司",
                            raw_description="真实岗位描述",
                            hash_key="export-test-job",
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
                with patch("app.services.data_export.async_session", session):
                    return await export_user_data()
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            payload = asyncio.run(run(Path(directory) / "export.db"))

        self.assertEqual(payload["schema_version"], "offeru.internal-beta.export.v1")
        self.assertEqual(payload["data"]["profiles"][0]["name"], "导出测试档案")
        self.assertEqual(payload["data"]["profiles"][0]["base_info_json"]["api_key"], "[redacted]")
        self.assertEqual(payload["data"]["career_tasks"][0]["input_json"]["api_token"], "[redacted]")
        self.assertGreaterEqual(payload["counts"]["jobs"], 1)
        self.assertIn("data", OPERATIONS["export_user_data"].audit_redacted_output_parameters)


if __name__ == "__main__":
    unittest.main()
