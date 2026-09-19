from __future__ import annotations

import asyncio
from datetime import datetime
from pathlib import Path
import sys
import tempfile
import unittest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.database import Base
from app.models.models import InterviewNotification  # noqa: F401  (register table)
from app.routes.email import ack_notification, list_notifications
from app.services.email_sync import acknowledge_notification


class NotificationAckTests(unittest.TestCase):
    """InterviewNotification acknowledged_at 语义：ack 翻转标记，pending 视图排除已处理信号。"""

    def setUp(self) -> None:
        self._temp_dir = tempfile.TemporaryDirectory()
        database_path = Path(self._temp_dir.name) / "notifications.db"
        self._engine = create_async_engine(
            f"sqlite+aiosqlite:///{database_path.as_posix()}"
        )
        self._session = async_sessionmaker(
            self._engine, class_=AsyncSession, expire_on_commit=False
        )
        asyncio.run(self._create_schema())

    async def _create_schema(self) -> None:
        async with self._engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    def tearDown(self) -> None:
        asyncio.run(self._engine.dispose())
        self._temp_dir.cleanup()

    async def _seed(self) -> tuple[int, int, int]:
        async with self._session() as db:
            actionable = InterviewNotification(
                email_subject="面试邀请", action_required="确认面试时间"
            )
            done = InterviewNotification(
                email_subject="已处理通知", action_required="回复邮件"
            )
            done.acknowledged_at = __import__("datetime").datetime(2026, 9, 1)
            passive = InterviewNotification(email_subject="录用通知", action_required="")
            db.add_all([actionable, done, passive])
            await db.flush()
            done.acknowledged_at = datetime(2026, 9, 1)
            await db.commit()
            return actionable.id, done.id, passive.id

    def test_ack_flips_flag_and_pending_view_excludes_acked(self) -> None:
        actionable_id, done_id, passive_id = asyncio.run(self._seed())

        async def run() -> None:
            async with self._session() as db:
                # pending 视图：只含未处理且 action_required 非空的行
                pending = await list_notifications(pending=True, db=db)
                pending_ids = {row["id"] for row in pending}
                self.assertEqual(pending_ids, {actionable_id})

                # 全量列表包含 acknowledged_at 字段
                all_rows = await list_notifications(pending=False, db=db)
                self.assertEqual(len(all_rows), 3)
                by_id = {row["id"]: row for row in all_rows}
                self.assertIsNone(by_id[actionable_id]["acknowledged_at"])
                self.assertIsNotNone(by_id[done_id]["acknowledged_at"])

                # ack 端点翻转标记
                result = await ack_notification(actionable_id, db=db)
                self.assertTrue(result["ok"])
                self.assertEqual(result["id"], actionable_id)
                self.assertIsNotNone(result["acknowledged_at"])

            async with self._session() as db:
                pending_after = await list_notifications(pending=True, db=db)
                self.assertEqual(pending_after, [])
                # acked 行仍在收件箱全量列表中，且携带 acknowledged_at
                all_after = await list_notifications(pending=False, db=db)
                acked = {row["id"]: row for row in all_after}[actionable_id]
                self.assertIsNotNone(acked["acknowledged_at"])

        asyncio.run(run())

    def test_ack_missing_notification_returns_404(self) -> None:
        async def run() -> None:
            async with self._session() as db:
                with pytest.raises(Exception) as excinfo:
                    await ack_notification(999999, db=db)
                self.assertEqual(getattr(excinfo.value, "status_code", None), 404)

        asyncio.run(run())

    def test_ack_is_idempotent(self) -> None:
        actionable_id, _, _ = asyncio.run(self._seed())

        async def run() -> None:
            async with self._session() as db:
                first = await acknowledge_notification(actionable_id, db)
                await db.commit()
                first_ts = first.acknowledged_at
                second = await acknowledge_notification(actionable_id, db)
                self.assertEqual(second.acknowledged_at, first_ts)

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
