"""Read-only privacy hygiene checks and explicitly confirmed legacy cleanup."""

from __future__ import annotations

from typing import Any

from sqlalchemy import delete, func, or_, select, update

from app.database import async_session
from app.models.models import (
    ApplicationProgressCandidate,
    ApplicationStageEvent,
    CalendarEvent,
    EmailAccount,
    EmailSyncRun,
    ExternalProgressSignal,
    InterviewNotification,
)
from app.services.credential_store import delete_secret


def _legacy_email_body_filter():
    return func.length(func.trim(InterviewNotification.email_body)) > 0


def _synthetic_email_account_filter():
    return or_(
        EmailAccount.email_address.like("gmail-%@example.com"),
        EmailAccount.email_address.like("imap-%@qq.com"),
    )


async def _synthetic_email_rows() -> tuple[
    list[EmailAccount],
    list[ExternalProgressSignal],
    int,
    int,
]:
    async with async_session() as db:
        accounts = (
            await db.execute(
                select(EmailAccount).where(_synthetic_email_account_filter())
            )
        ).scalars().all()
        account_refs = [account.signal_account_ref for account in accounts]
        signals = (
            await db.execute(
                select(ExternalProgressSignal).where(
                    ExternalProgressSignal.account_ref.in_(account_refs)
                )
                if account_refs
                else select(ExternalProgressSignal).where(False)
            )
        ).scalars().all()
        signal_ids = [signal.id for signal in signals]
        stage_event_count = int(
            (
                await db.execute(
                    select(func.count(ApplicationStageEvent.id)).where(
                        ApplicationStageEvent.signal_id.in_(signal_ids)
                    )
                    if signal_ids
                    else select(func.count(ApplicationStageEvent.id)).where(False)
                )
            ).scalar_one()
            or 0
        )
        calendar_event_count = int(
            (
                await db.execute(
                    select(func.count(CalendarEvent.id)).where(
                        CalendarEvent.related_signal_id.in_(signal_ids)
                    )
                    if signal_ids
                    else select(func.count(CalendarEvent.id)).where(False)
                )
            ).scalar_one()
            or 0
        )
    return accounts, signals, stage_event_count, calendar_event_count


async def get_synthetic_email_test_data_status() -> dict[str, Any]:
    """Return counts for the exact test-fixture account namespace only."""

    accounts, signals, stage_event_count, calendar_event_count = (
        await _synthetic_email_rows()
    )
    async with async_session() as db:
        account_ids = [account.id for account in accounts]
        candidate_count = int(
            (
                await db.execute(
                    select(func.count(ApplicationProgressCandidate.id)).where(
                        ApplicationProgressCandidate.signal_id.in_(
                            [signal.id for signal in signals]
                        )
                    )
                    if signals
                    else select(func.count(ApplicationProgressCandidate.id)).where(False)
                )
            ).scalar_one()
            or 0
        )
        sync_run_count = int(
            (
                await db.execute(
                    select(func.count(EmailSyncRun.run_id)).where(
                        EmailSyncRun.email_account_id.in_(account_ids)
                    )
                    if account_ids
                    else select(func.count(EmailSyncRun.run_id)).where(False)
                )
            ).scalar_one()
            or 0
        )
    return {
        "accounts": len(accounts),
        "sync_runs": sync_run_count,
        "signals": len(signals),
        "candidates": candidate_count,
        "stage_events": stage_event_count,
        "calendar_events": calendar_event_count,
        "credential_refs": sum(bool(account.credential_ref) for account in accounts),
    }


async def get_privacy_hygiene_status() -> dict[str, Any]:
    """Return counts only; never expose legacy message content."""

    async with async_session() as db:
        row = (
            await db.execute(
                select(
                    func.count(InterviewNotification.id),
                    func.coalesce(func.sum(func.length(InterviewNotification.email_body)), 0),
                ).where(_legacy_email_body_filter())
            )
        ).one()
    records = int(row[0] or 0)
    characters = int(row[1] or 0)
    synthetic = await get_synthetic_email_test_data_status()
    needs_attention = records > 0 or any(synthetic.values())
    return {
        "schema_version": "offeru.privacy_hygiene.v1",
        "status": "attention_required" if needs_attention else "clear",
        "legacy_email_notification_bodies": {
            "records": records,
            "characters": characters,
        },
        "synthetic_email_test_data": synthetic,
        "safe_to_publish": records == 0 and not any(synthetic.values()),
    }


async def scrub_legacy_email_notification_bodies(
    *,
    user_confirmed: bool = False,
) -> dict[str, Any]:
    """Clear redundant legacy email bodies after explicit user confirmation."""

    if user_confirmed is not True:
        raise ValueError("清理旧邮件正文前必须明确确认；该操作不可恢复")
    async with async_session() as db:
        result = await db.execute(
            update(InterviewNotification)
            .where(_legacy_email_body_filter())
            .values(email_body="")
        )
        await db.commit()
    status = await get_privacy_hygiene_status()
    return {
        "scrubbed_records": int(result.rowcount or 0),
        "status": status,
    }


async def purge_synthetic_email_test_data(
    *,
    user_confirmed: bool = False,
) -> dict[str, Any]:
    """Remove only the known test account namespace after explicit confirmation."""

    if user_confirmed is not True:
        raise ValueError("清理合成邮箱测试数据前必须明确确认")
    accounts, signals, stage_event_count, calendar_event_count = (
        await _synthetic_email_rows()
    )
    if stage_event_count or calendar_event_count:
        raise ValueError("合成邮箱数据已关联正式时间线，拒绝自动清理")

    account_ids = [account.id for account in accounts]
    signal_ids = [signal.id for signal in signals]
    sync_run_count = await _count_synthetic_sync_runs(account_ids)
    credential_refs = sorted(
        {account.credential_ref for account in accounts if account.credential_ref}
    )
    for reference in credential_refs:
        await delete_secret(reference)

    async with async_session() as db:
        if signal_ids:
            await db.execute(
                delete(ApplicationProgressCandidate).where(
                    ApplicationProgressCandidate.signal_id.in_(signal_ids)
                )
            )
            await db.execute(
                delete(ExternalProgressSignal).where(
                    ExternalProgressSignal.id.in_(signal_ids)
                )
            )
        if account_ids:
            await db.execute(
                delete(EmailSyncRun).where(EmailSyncRun.email_account_id.in_(account_ids))
            )
            await db.execute(
                delete(EmailAccount).where(EmailAccount.id.in_(account_ids))
            )
        await db.commit()
    return {
        "purged": {
            "accounts": len(accounts),
            "sync_runs": sync_run_count,
            "signals": len(signals),
            "candidates": 0,
            "credential_refs": len(credential_refs),
        },
        "status": await get_synthetic_email_test_data_status(),
    }


async def _count_synthetic_sync_runs(account_ids: list[int]) -> int:
    """Kept for a stable zero-after-purge result without returning old rows."""

    if not account_ids:
        return 0
    async with async_session() as db:
        return int(
            (
                await db.execute(
                    select(func.count(EmailSyncRun.run_id)).where(
                        EmailSyncRun.email_account_id.in_(account_ids)
                    )
                )
            ).scalar_one()
            or 0
        )


__all__ = [
    "get_privacy_hygiene_status",
    "get_synthetic_email_test_data_status",
    "purge_synthetic_email_test_data",
    "scrub_legacy_email_notification_bodies",
]
