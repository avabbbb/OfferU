from __future__ import annotations

import asyncio
import inspect
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.database import Base
from app.models.models import (
    ApplicationProgressCandidate,
    EmailAccount,
    EmailSyncRun,
    ExternalProgressSignal,
    InterviewNotification,
)
from app.ops import OPERATIONS
from app.services.privacy_hygiene import (
    get_privacy_hygiene_status,
    get_synthetic_email_test_data_status,
    purge_synthetic_email_test_data,
    scrub_legacy_email_notification_bodies,
)


class PrivacyHygieneTests(unittest.TestCase):
    def test_status_and_confirmed_scrub_never_return_legacy_content(self) -> None:
        async def run(database_path: Path) -> tuple[dict, dict, list[InterviewNotification]]:
            engine = create_async_engine(f"sqlite+aiosqlite:///{database_path.as_posix()}")
            session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                async with session() as db:
                    db.add_all(
                        [
                            InterviewNotification(
                                email_subject="面试通知",
                                email_from="recruiter@example.com",
                                email_body="PRIVATE_LEGACY_BODY_A",
                                company="测试公司",
                                position="产品经理",
                            ),
                            InterviewNotification(
                                email_subject="笔试通知",
                                email_from="hr@example.com",
                                email_body="PRIVATE_LEGACY_BODY_B",
                                company="另一家公司",
                                position="AI PM",
                            ),
                            InterviewNotification(email_body=""),
                        ]
                    )
                    await db.commit()
                with patch("app.services.privacy_hygiene.async_session", session):
                    before = await get_privacy_hygiene_status()
                    with self.assertRaisesRegex(ValueError, "明确确认"):
                        await scrub_legacy_email_notification_bodies()
                    scrubbed = await scrub_legacy_email_notification_bodies(
                        user_confirmed=True
                    )
                    after = await get_privacy_hygiene_status()
                async with session() as db:
                    rows = (
                        await db.execute(
                            select(InterviewNotification).order_by(InterviewNotification.id)
                        )
                    ).scalars().all()
                return before, scrubbed | {"after": after}, rows
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            before, result, rows = asyncio.run(run(Path(directory) / "privacy.db"))

        self.assertEqual(before["status"], "attention_required")
        self.assertEqual(before["legacy_email_notification_bodies"], {"records": 2, "characters": 42})
        self.assertEqual(result["scrubbed_records"], 2)
        self.assertEqual(result["after"]["status"], "clear")
        self.assertTrue(result["after"]["safe_to_publish"])
        self.assertEqual([row.email_body for row in rows], ["", "", ""])
        self.assertEqual(rows[0].company, "测试公司")
        self.assertEqual(rows[1].position, "AI PM")
        self.assertNotIn("PRIVATE_LEGACY_BODY", str(result))

    def test_registry_exposes_read_only_status_and_confirmed_cleanup(self) -> None:
        status = OPERATIONS["get_privacy_hygiene_status"].schema()
        scrub = OPERATIONS["scrub_legacy_email_notification_bodies"].schema()
        self.assertEqual(status["side_effects"], ["read"])
        self.assertTrue(scrub["requires_confirmation"])
        self.assertEqual(scrub["parameters"]["user_confirmed"]["type"], "boolean")
        self.assertIn("不可恢复", OPERATIONS["scrub_legacy_email_notification_bodies"].description)

    def test_settings_privacy_routes_use_registry_boundary(self) -> None:
        from app.routes.main_agent import (
            privacy_hygiene_status,
            purge_synthetic_privacy_data,
            scrub_privacy_hygiene,
        )

        self.assertEqual(inspect.getsource(privacy_hygiene_status).count("_ui_operation_outputs"), 1)
        self.assertEqual(inspect.getsource(scrub_privacy_hygiene).count("_ui_operation_outputs"), 1)
        self.assertEqual(inspect.getsource(purge_synthetic_privacy_data).count("_ui_operation_outputs"), 1)
        self.assertIn("get_privacy_hygiene_status", inspect.getsource(privacy_hygiene_status))
        self.assertIn("scrub_legacy_email_notification_bodies", inspect.getsource(scrub_privacy_hygiene))
        self.assertIn("purge_synthetic_email_test_data", inspect.getsource(purge_synthetic_privacy_data))

    def test_purge_only_removes_strict_synthetic_email_namespace(self) -> None:
        async def run(database_path: Path) -> tuple[dict, dict, dict, int]:
            engine = create_async_engine(f"sqlite+aiosqlite:///{database_path.as_posix()}")
            session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                async with session() as db:
                    account = EmailAccount(
                        account_id="test-gmail-account",
                        account_key="test-gmail-key",
                        signal_account_ref="test-gmail-signal",
                        provider="gmail",
                        email_address="gmail-fixture@example.com",
                        credential_ref="email:test-credential",
                    )
                    db.add(account)
                    await db.flush()
                    db.add(
                        EmailSyncRun(
                            run_id="test-gmail-run",
                            email_account_id=account.id,
                            provider="gmail",
                        )
                    )
                    signal = ExternalProgressSignal(
                        signal_id="test-gmail-signal-row",
                        channel="email",
                        account_ref=account.signal_account_ref,
                        external_message_id="fixture-message",
                        body_sha256="a" * 64,
                    )
                    db.add(signal)
                    await db.flush()
                    db.add(
                        ApplicationProgressCandidate(
                            candidate_id="test-gmail-candidate",
                            signal_id=signal.id,
                        )
                    )
                    await db.commit()
                with patch("app.services.privacy_hygiene.async_session", session), patch(
                    "app.services.privacy_hygiene.delete_secret",
                    new=AsyncMock(),
                ) as delete_secret:
                    before = await get_synthetic_email_test_data_status()
                    with self.assertRaisesRegex(ValueError, "明确确认"):
                        await purge_synthetic_email_test_data()
                    purged = await purge_synthetic_email_test_data(user_confirmed=True)
                    after = await get_synthetic_email_test_data_status()
                return before, purged, after, delete_secret.await_count
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            before, purged, after, delete_count = asyncio.run(
                run(Path(directory) / "synthetic-email.db")
            )

        self.assertEqual(before["accounts"], 1)
        self.assertEqual(before["sync_runs"], 1)
        self.assertEqual(before["signals"], 1)
        self.assertEqual(before["candidates"], 1)
        self.assertEqual(purged["purged"], {
            "accounts": 1,
            "sync_runs": 1,
            "signals": 1,
            "candidates": 0,
            "credential_refs": 1,
        })
        self.assertEqual(after, {
            "accounts": 0,
            "sync_runs": 0,
            "signals": 0,
            "candidates": 0,
            "stage_events": 0,
            "calendar_events": 0,
            "credential_refs": 0,
        })
        self.assertEqual(delete_count, 1)


if __name__ == "__main__":
    unittest.main()
