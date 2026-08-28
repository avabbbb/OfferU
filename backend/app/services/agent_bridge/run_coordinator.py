"""Agent Bridge RunCoordinator (Slice 1).

Binds an external Harness session to an existing Agent Run, issues the
single-writer lease, and tracks the context version. Reuses AgentRunRecord /
AgentRunEvent as the only persistence; adds no second write path.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select

from app.database import async_session
from app.models.models import AgentRunRecord, BridgePairing
from app.services.agent_run_state import (
    ACTIVE_STATUSES,
    TERMINAL_STATUSES,
    load_agent_run,
)

LEASE_TTL_SECONDS = 120


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


async def create_bridge_pairing(*, run_id: str) -> dict[str, Any]:
    """Issue a one-shot bootstrap token bound to exactly one Run."""
    run = await load_agent_run(run_id)
    if run is None:
        raise ValueError(f"Agent Run {run_id} does not exist")
    if run.get("status") in TERMINAL_STATUSES:
        raise ValueError(f"Agent Run {run_id} is terminal ({run.get('status')})")
    token = f"obt_{secrets.token_urlsafe(32)}"
    pairing_id = f"pair_{secrets.token_hex(12)}"
    async with async_session() as db:
        db.add(
            BridgePairing(
                pairing_id=pairing_id,
                token_hash=_hash_token(token),
                run_id=run_id,
                status="pending",
            )
        )
        await db.commit()
    return {"pairingId": pairing_id, "bootstrapToken": token, "runId": run_id}


async def consume_bootstrap_token(token: str) -> dict[str, Any] | None:
    """Redeem a bootstrap token exactly once; returns pairing row or None."""
    clean = str(token or "").strip()
    if not clean:
        return None
    digest = _hash_token(clean)
    async with async_session() as db:
        row = (
            await db.execute(
                select(BridgePairing).where(BridgePairing.token_hash == digest)
            )
        ).scalar_one_or_none()
        if row is None or row.status != "pending":
            return None
        row.status = "consumed"
        row.consumed_at = _now()
        await db.commit()
        return {
            "pairingId": row.pairing_id,
            "runId": str(row.run_id or ""),
        }


class LeaseLostError(RuntimeError):
    pass


class RunCoordinator:
    """Owns attach, single-writer lease renewal, and context version."""

    async def attach(
        self,
        *,
        run_id: str,
        harness: dict[str, Any],
        adapter: dict[str, Any],
        harness_session_id: str,
        last_event_seq: int = 0,
    ) -> dict[str, Any]:
        run = await load_agent_run(run_id)
        if run is None:
            raise LookupError(f"Agent Run {run_id} does not exist")
        if run.get("status") in TERMINAL_STATUSES:
            raise ValueError(f"Agent Run {run_id} is terminal ({run.get('status')})")
        lease_id = f"lease_{secrets.token_hex(12)}"
        expires = _now() + timedelta(seconds=LEASE_TTL_SECONDS)
        async with async_session() as db:
            row = (
                await db.execute(
                    select(AgentRunRecord).where(AgentRunRecord.run_id == run_id)
                )
            ).scalar_one()
            current_lease = str(row.lease_id or "")
            current_expires = row.lease_expires_at
            if (
                current_lease
                and current_lease != lease_id
                and (current_expires is None or current_expires > _now())
            ):
                raise LeaseLostError(run_id)
            row.harness_name = str(harness.get("name") or "")
            row.harness_version = str(harness.get("version") or "")
            row.adapter_name = str(adapter.get("name") or "")
            row.adapter_version = str(adapter.get("version") or "")
            row.harness_session_id = str(harness_session_id or "")
            row.lease_id = lease_id
            row.lease_expires_at = expires
            await db.commit()
        event_type = "run.resumed" if last_event_seq > 0 else "run.attached"
        from app.services.agent_run_state import append_agent_run_event

        await append_agent_run_event(
            run_id,
            event_type=event_type,
            payload={
                "harness": harness,
                "adapter": adapter,
                "harnessSessionId": harness_session_id,
                "leaseId": lease_id,
                "lastEventSeq": int(last_event_seq),
            },
        )
        return {
            "leaseId": lease_id,
            "leaseExpiresAt": expires.isoformat(),
            "contextVersion": int(run.get("context_version") or 0),
            "eventSequence": int(run.get("event_sequence") or 0),
        }

    async def assert_lease(self, *, run_id: str, lease_id: str) -> None:
        async with async_session() as db:
            row = (
                await db.execute(
                    select(AgentRunRecord).where(AgentRunRecord.run_id == run_id)
                )
            ).scalar_one_or_none()
        if row is None:
            raise LookupError(f"Agent Run {run_id} does not exist")
        stored = str(row.lease_id or "")
        expires = row.lease_expires_at
        expired = expires is not None and expires <= _now()
        if not stored or stored != lease_id or expired:
            raise LeaseLostError(run_id)

    async def renew_lease(
        self, *, run_id: str, lease_id: str | None
    ) -> dict[str, Any]:
        current = await load_agent_run(run_id)
        if current is None:
            raise LookupError(f"Agent Run {run_id} does not exist")
        stored = str(current.get("lease_id") or "")
        if stored and lease_id and stored != lease_id:
            raise LeaseLostError(run_id)
        new_lease = lease_id or stored or f"lease_{secrets.token_hex(12)}"
        expires = _now() + timedelta(seconds=LEASE_TTL_SECONDS)
        async with async_session() as db:
            row = (
                await db.execute(
                    select(AgentRunRecord).where(AgentRunRecord.run_id == run_id)
                )
            ).scalar_one()
            row.lease_id = new_lease
            row.lease_expires_at = expires
            await db.commit()
        return {"leaseId": new_lease, "leaseExpiresAt": expires.isoformat()}

    async def release_lease(self, *, run_id: str, lease_id: str) -> None:
        async with async_session() as db:
            row = (
                await db.execute(
                    select(AgentRunRecord).where(AgentRunRecord.run_id == run_id)
                )
            ).scalar_one_or_none()
            if row is not None and str(row.lease_id or "") == lease_id:
                row.lease_id = ""
                row.lease_expires_at = None
                await db.commit()

    async def bump_context_version(self, *, run_id: str) -> int:
        async with async_session() as db:
            row = (
                await db.execute(
                    select(AgentRunRecord).where(AgentRunRecord.run_id == run_id)
                )
            ).scalar_one()
            row.context_version = int(row.context_version or 0) + 1
            await db.commit()
            return int(row.context_version)


__all__ = [
    "LEASE_TTL_SECONDS",
    "LeaseLostError",
    "RunCoordinator",
    "consume_bootstrap_token",
    "create_bridge_pairing",
]
