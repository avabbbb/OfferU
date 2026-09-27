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

from sqlalchemy import select, update

from app.database import async_session
from app.models.models import AgentRunEvent, AgentRunRecord, BridgePairing
from app.services.agent_run_state import (
    TERMINAL_STATUSES,
    load_agent_run,
    safe_result_preview,
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
        lease_id: str | None = None,
        last_event_seq: int = 0,
    ) -> dict[str, Any]:
        session_id = str(harness_session_id or "").strip()
        if not session_id:
            raise ValueError("Agent Bridge session identity is required")
        now = _now()
        expires = now + timedelta(seconds=LEASE_TTL_SECONDS)
        requested_harness = str(harness.get("name") or "")
        requested_adapter = str(adapter.get("name") or "")
        requested_harness_version = str(harness.get("version") or "")
        requested_adapter_version = str(adapter.get("version") or "")
        reconciled = False
        context_version = 0
        event_sequence = 0
        async with async_session() as db:
            row = (
                await db.execute(
                    select(AgentRunRecord).where(AgentRunRecord.run_id == run_id)
                )
            ).scalar_one_or_none()
            if row is None:
                raise LookupError(f"Agent Run {run_id} does not exist")
            if row.status in TERMINAL_STATUSES:
                raise ValueError(f"Agent Run {run_id} is terminal ({row.status})")
            stored_event_sequence = int(row.event_sequence or 0)
            if int(last_event_seq) > stored_event_sequence:
                raise ValueError("lastEventSeq exceeds the persisted Agent Run event sequence")
            current_lease = str(row.lease_id or "")
            current_expires = row.lease_expires_at
            lease_is_live = bool(current_lease) and (
                current_expires is None or current_expires > now
            )
            same_session = (
                row.harness_name == requested_harness
                and row.harness_version == requested_harness_version
                and row.adapter_name == requested_adapter
                and row.adapter_version == requested_adapter_version
                and row.harness_session_id == session_id
            )
            if lease_is_live and not same_session:
                raise LeaseLostError(run_id)
            if row.harness_session_id and not same_session:
                # A pairing token authorizes attaching to this run; it does not
                # silently authorize replacing the persisted Harness identity.
                raise LeaseLostError(run_id)
            if current_lease and (not lease_id or lease_id != current_lease):
                raise LeaseLostError(run_id)

            if lease_is_live:
                # A retry/reconnect from the exact active session reconciles to
                # its existing lease. Do not mint another identity or append a
                # duplicate run.attached event. leaseId is a bearer capability,
                # not a value that can be reconstructed from the session tuple.
                lease_id = current_lease
                reconciled = True
                values = {"lease_expires_at": expires}
            else:
                # The AgentRunRecord.run_id remains the canonical identity.
                # Only the already-bound external session can recover an
                # expired lease; changing providers/sessions needs a new Run.
                lease_id = f"lease_{secrets.token_hex(12)}"
                values = {
                    "harness_name": requested_harness,
                    "harness_version": requested_harness_version,
                    "adapter_name": requested_adapter,
                    "adapter_version": requested_adapter_version,
                    "harness_session_id": session_id,
                    "lease_id": lease_id,
                    "lease_expires_at": expires,
                }

            condition = [
                AgentRunRecord.run_id == run_id,
                AgentRunRecord.lease_id == current_lease,
                AgentRunRecord.status.notin_(TERMINAL_STATUSES),
            ]
            condition.append(
                AgentRunRecord.lease_expires_at.is_(None)
                if current_expires is None
                else AgentRunRecord.lease_expires_at == current_expires
            )
            if not reconciled:
                values["event_sequence"] = AgentRunRecord.event_sequence + 1
            result = await db.execute(
                update(AgentRunRecord)
                .where(*condition)
                .values(**values)
                .returning(AgentRunRecord.event_sequence)
                .execution_options(synchronize_session=False)
            )
            new_sequence = result.scalar_one_or_none()
            if new_sequence is None:
                await db.rollback()
                latest = await load_agent_run(run_id)
                if latest is not None and latest.get("status") in TERMINAL_STATUSES:
                    raise ValueError(f"Agent Run {run_id} is terminal ({latest['status']})")
                raise LeaseLostError(run_id)
            event_sequence = int(new_sequence)
            context_version = int(row.context_version or 0)
            if not reconciled:
                event_type = (
                    "run.resumed"
                    if int(last_event_seq) > 0 or stored_event_sequence > 0
                    else "run.attached"
                )
                payload = {
                    "harness": harness,
                    "adapter": adapter,
                    "harnessSessionId": session_id,
                    "leaseId": lease_id,
                    "lastEventSeq": int(last_event_seq),
                }
                db.add(
                    AgentRunEvent(
                        event_id=f"evt_{secrets.token_hex(16)}",
                        run_id=run_id,
                        sequence=event_sequence,
                        event_type=event_type,
                        payload_json=safe_result_preview(payload),
                    )
                )
            await db.commit()
        return {
            "leaseId": lease_id,
            "leaseExpiresAt": expires.isoformat(),
            "contextVersion": context_version,
            "eventSequence": event_sequence,
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
        capability = str(lease_id or "").strip()
        if not capability:
            raise LeaseLostError(run_id)
        now = _now()
        expires = now + timedelta(seconds=LEASE_TTL_SECONDS)
        async with async_session() as db:
            row = (
                await db.execute(
                    select(AgentRunRecord).where(AgentRunRecord.run_id == run_id)
                )
            ).scalar_one_or_none()
            if row is None:
                raise LookupError(f"Agent Run {run_id} does not exist")
            if row.status in TERMINAL_STATUSES:
                raise ValueError(f"Agent Run {run_id} is terminal ({row.status})")
            stored = str(row.lease_id or "")
            current_expires = row.lease_expires_at
            if (
                not stored
                or stored != capability
                or (current_expires is not None and current_expires <= now)
            ):
                raise LeaseLostError(run_id)
            condition = [
                AgentRunRecord.run_id == run_id,
                AgentRunRecord.lease_id == capability,
                AgentRunRecord.status.notin_(TERMINAL_STATUSES),
            ]
            condition.append(
                AgentRunRecord.lease_expires_at.is_(None)
                if current_expires is None
                else AgentRunRecord.lease_expires_at == current_expires
            )
            result = await db.execute(
                update(AgentRunRecord)
                .where(*condition)
                .values(lease_expires_at=expires)
                .returning(AgentRunRecord.lease_id)
                .execution_options(synchronize_session=False)
            )
            if result.scalar_one_or_none() is None:
                raise LeaseLostError(run_id)
            await db.commit()
        return {"leaseId": capability, "leaseExpiresAt": expires.isoformat()}

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
