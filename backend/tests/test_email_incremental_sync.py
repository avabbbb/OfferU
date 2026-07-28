from __future__ import annotations

import asyncio
from pathlib import Path
import secrets
import sys
import unittest
from unittest.mock import AsyncMock, patch

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import select

from app.database import async_session, init_db
from app.models.models import (
    ApplicationProgressCandidate,
    EmailAccount,
    EmailSyncRun,
    ExternalProgressSignal,
)
from app.ops import OPERATIONS
from app.services.agent_skill_registry import resolve_skill
from app.services.email_sync import (
    GmailHistoryExpired,
    _fetch_gmail_delta,
    connect_imap_account,
    revoke_email_account,
    sync_email_account,
)
from app.services.harness_agent import (
    CONFIRM_TOOLS,
    READ_TOOLS,
    REGISTRY_OPERATION_TOOLS,
)


_SALT = secrets.token_hex(8)


def _unique(label: str) -> str:
    return f"{label}-{_SALT}-{secrets.token_hex(4)}"


def _message(message_id: str, body: str = "面试邀请，请确认时间。") -> dict:
    return {
        "provider_id": message_id,
        "message_id": message_id,
        "thread_id": f"thread-{message_id}",
        "received_at": "2026-07-26T08:00:00+00:00",
        "subject": "技术面试邀请",
        "from": "recruiting@example.com",
        "body": body,
    }


async def _gmail_account(cursor: dict | None = None) -> EmailAccount:
    key = secrets.token_hex(32)
    async with async_session() as db:
        account = EmailAccount(
            account_id=f"email-{secrets.token_hex(16)}",
            account_key=key,
            signal_account_ref=secrets.token_hex(32),
            provider="gmail",
            email_address=f"{_unique('gmail')}@example.com",
            host="gmail.googleapis.com",
            port=443,
            auth_type="oauth2_pkce",
            scopes_json=["https://www.googleapis.com/auth/gmail.readonly"],
            credential_ref=f"email:{secrets.token_urlsafe(24)}",
            sync_cursor_json=cursor or {"type": "gmail_history"},
            status="active",
            sync_enabled=True,
        )
        db.add(account)
        await db.commit()
        await db.refresh(account)
        return account


class EmailIncrementalSyncTests(unittest.TestCase):
    def test_registry_skill_and_audit_contracts_do_not_expose_connection_secrets(self) -> None:
        expected = {
            "email_connection_status",
            "list_email_accounts",
            "sync_email_notifications",
            "list_email_sync_runs",
            "get_email_sync_run",
            "revoke_email_account",
        }
        self.assertTrue(expected.issubset(OPERATIONS))
        self.assertTrue(
            {
                "email_connection_status",
                "list_email_accounts",
                "list_email_sync_runs",
                "get_email_sync_run",
            }.issubset(READ_TOOLS)
        )
        self.assertTrue(
            {"sync_email_notifications", "revoke_email_account"}.issubset(
                CONFIRM_TOOLS
            )
        )
        self.assertTrue(expected.issubset(REGISTRY_OPERATION_TOOLS))
        self.assertIn(
            "password",
            OPERATIONS["connect_imap_account"].audit_redacted_parameters,
        )
        self.assertIn(
            "auth_url",
            OPERATIONS["begin_gmail_oauth"].audit_redacted_output_parameters,
        )
        skill = resolve_skill("回复识别")
        self.assertIsNotNone(skill)
        assert skill is not None
        self.assertTrue(expected.issubset(skill.allowed_tools))

    def test_imap_connection_persists_only_metadata_and_opaque_reference(self) -> None:
        async def run() -> tuple[dict, EmailAccount]:
            await init_db()
            with patch(
                "app.services.email_sync._probe_imap",
                return_value={"uidvalidity": 77, "uidnext": 10},
            ), patch(
                "app.services.email_sync.store_secret",
                new=AsyncMock(return_value=None),
            ) as store:
                payload = await connect_imap_account(
                    user=f"{_unique('imap')}@qq.com",
                    password="never-store-this-password",
                    provider="qq",
                )
            self.assertEqual(store.await_count, 1)
            async with async_session() as db:
                account = (
                    await db.execute(
                        select(EmailAccount).where(
                            EmailAccount.account_id == payload["account_id"]
                        )
                    )
                ).scalar_one()
            return payload, account

        payload, account = asyncio.run(run())
        self.assertNotIn("credential_ref", payload)
        self.assertNotIn("password", payload)
        self.assertTrue(account.credential_ref.startswith("email:"))
        self.assertEqual(account.sync_cursor_json["uidvalidity"], 77)
        self.assertFalse(
            any(
                "never-store-this-password" in str(value)
                for value in (
                    account.email_address,
                    account.host,
                    account.credential_ref,
                    account.sync_cursor_json,
                )
            )
        )

    def test_expired_gmail_history_recovers_with_full_backfill_cursor(self) -> None:
        async def run() -> tuple[list[dict], dict, dict]:
            with patch(
                "app.services.email_sync._gmail_history_message_ids",
                new=AsyncMock(side_effect=GmailHistoryExpired("expired")),
            ), patch(
                "app.services.email_sync._gmail_json",
                new=AsyncMock(return_value={"historyId": "200"}),
            ), patch(
                "app.services.email_sync._gmail_full_message_ids",
                new=AsyncMock(return_value=["m-1"]),
            ), patch(
                "app.services.email_sync._gmail_message",
                new=AsyncMock(return_value=_message("m-1")),
            ):
                return await _fetch_gmail_delta(
                    token="transient-token",
                    cursor={"type": "gmail_history", "history_id": "100"},
                )

        messages, cursor, trace = asyncio.run(run())
        self.assertEqual([item["message_id"] for item in messages], ["m-1"])
        self.assertEqual(cursor["history_id"], "200")
        self.assertEqual(trace["mode"], "full_backfill_30d")
        self.assertTrue(trace["history_expired_recovered"])

    def test_success_advances_cursor_and_duplicate_poll_does_not_duplicate_signal(self) -> None:
        async def run() -> tuple[dict, dict, int, ExternalProgressSignal, dict]:
            await init_db()
            account = await _gmail_account(
                {"type": "gmail_history", "history_id": "100"}
            )
            fetch = AsyncMock(
                side_effect=[
                    (
                        [_message("gmail-message-1")],
                        {"type": "gmail_history", "history_id": "101"},
                        {"mode": "history_incremental"},
                    ),
                    (
                        [_message("gmail-message-1")],
                        {"type": "gmail_history", "history_id": "102"},
                        {"mode": "history_incremental"},
                    ),
                ]
            )
            with patch(
                "app.services.email_sync._gmail_access_token",
                new=AsyncMock(return_value="transient-token"),
            ), patch(
                "app.services.email_sync._fetch_gmail_delta",
                new=fetch,
            ):
                first = await sync_email_account(account.account_id)
                second = await sync_email_account(account.account_id)
            async with async_session() as db:
                stored = (
                    await db.execute(
                        select(EmailAccount).where(EmailAccount.id == account.id)
                    )
                ).scalar_one()
                signals = (
                    await db.execute(
                        select(ExternalProgressSignal).where(
                            ExternalProgressSignal.account_ref
                            == account.signal_account_ref
                        )
                    )
                ).scalars().all()
            return first, second, len(signals), signals[0], stored.sync_cursor_json

        first, second, signal_count, signal, cursor = asyncio.run(run())
        self.assertEqual(first["synced"], 1)
        self.assertEqual(second["duplicates"], 1)
        self.assertEqual(signal_count, 1)
        self.assertEqual(cursor["history_id"], "102")
        self.assertLessEqual(len(signal.snippet), 700)
        self.assertFalse(first["trace"]["full_body_stored"])
        self.assertNotIn("transient-token", str(first))

    def test_failed_ingest_does_not_advance_cursor(self) -> None:
        async def run() -> tuple[dict, EmailSyncRun]:
            await init_db()
            account = await _gmail_account(
                {"type": "gmail_history", "history_id": "300"}
            )
            with patch(
                "app.services.email_sync._gmail_access_token",
                new=AsyncMock(return_value="transient-token"),
            ), patch(
                "app.services.email_sync._fetch_gmail_delta",
                new=AsyncMock(
                    return_value=(
                        [_message("gmail-message-fail")],
                        {"type": "gmail_history", "history_id": "301"},
                        {"mode": "history_incremental"},
                    )
                ),
            ), patch(
                "app.services.email_sync.ingest_application_signal",
                new=AsyncMock(side_effect=RuntimeError("database interrupted")),
            ):
                with self.assertRaises(RuntimeError):
                    await sync_email_account(account.account_id)
            async with async_session() as db:
                stored = (
                    await db.execute(
                        select(EmailAccount).where(EmailAccount.id == account.id)
                    )
                ).scalar_one()
                run = (
                    await db.execute(
                        select(EmailSyncRun)
                        .where(EmailSyncRun.email_account_id == account.id)
                        .order_by(EmailSyncRun.created_at.desc())
                    )
                ).scalars().first()
            return stored.sync_cursor_json, run

        cursor, run = asyncio.run(run())
        self.assertEqual(cursor["history_id"], "300")
        self.assertEqual(run.status, "failed")
        self.assertNotIn("database interrupted", run.error)

    def test_revoke_deletes_keychain_secret_and_invalidates_unconfirmed_signal(self) -> None:
        async def run() -> tuple[dict, EmailAccount, ExternalProgressSignal, ApplicationProgressCandidate]:
            await init_db()
            account = await _gmail_account(
                {"type": "gmail_history", "history_id": "400"}
            )
            with patch(
                "app.services.email_sync._gmail_access_token",
                new=AsyncMock(return_value="transient-token"),
            ), patch(
                "app.services.email_sync._fetch_gmail_delta",
                new=AsyncMock(
                    return_value=(
                        [_message("gmail-message-revoke")],
                        {"type": "gmail_history", "history_id": "401"},
                        {"mode": "history_incremental"},
                    )
                ),
            ):
                await sync_email_account(account.account_id)
            with patch(
                "app.services.email_sync.delete_secret",
                new=AsyncMock(return_value=None),
            ) as delete:
                result = await revoke_email_account(
                    account_id=account.account_id,
                    reason="使用者撤销邮箱授权",
                )
            self.assertEqual(delete.await_count, 1)
            async with async_session() as db:
                stored_account = (
                    await db.execute(
                        select(EmailAccount).where(EmailAccount.id == account.id)
                    )
                ).scalar_one()
                signal = (
                    await db.execute(
                        select(ExternalProgressSignal).where(
                            ExternalProgressSignal.account_ref
                            == account.signal_account_ref
                        )
                    )
                ).scalars().one()
                candidate = (
                    await db.execute(
                        select(ApplicationProgressCandidate).where(
                            ApplicationProgressCandidate.signal_id == signal.id
                        )
                    )
                ).scalar_one()
            return result, stored_account, signal, candidate

        result, account, signal, candidate = asyncio.run(run())
        self.assertTrue(result["revoked"])
        self.assertEqual(account.status, "revoked")
        self.assertEqual(account.credential_ref, "")
        self.assertEqual(account.sync_cursor_json, {})
        self.assertEqual(signal.status, "invalidated")
        self.assertEqual(signal.snippet, "")
        self.assertEqual(candidate.status, "invalidated")


if __name__ == "__main__":
    unittest.main()
