"""Workbench-facing Bridge confirmation endpoints (Slice 3).

The OfferU workbench overlay polls pending proposal Runs and posts the human
decision. Approval authority stays with the workbench (ADR-0052): the Bridge
and the model can only read state, never self-approve.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.ops import execute_operation
from app.services.agent_bridge.operation_gateway import (
    confirm_proposal,
    load_proposal_state,
)
from app.services.security_redaction import redact_sensitive_value

router = APIRouter()


@router.get("/proposals/pending")
async def list_pending_proposals() -> dict[str, Any]:
    """Newest Run per conversation waiting on confirmation, for the overlay."""
    from sqlalchemy import select

    from app.database import async_session
    from app.models.models import AgentRunRecord

    from datetime import datetime, timedelta

    from sqlalchemy import select

    from app.database import async_session
    from app.models.models import AgentRunRecord

    since = datetime.utcnow() - timedelta(hours=24)
    async with async_session() as db:
        rows = (
            (
                await db.execute(
                    select(AgentRunRecord)
                    .where(AgentRunRecord.status == "waiting_confirmation")
                    .where(AgentRunRecord.created_at >= since)
                    .order_by(AgentRunRecord.created_at.desc())
                    .limit(5)
                )
            )
            .scalars()
            .all()
        )
    items = []
    for row in rows:
        steps = [
            {
                "actionId": str(step.get("id") or ""),
                "operation": str(step.get("tool") or ""),
                "args": redact_sensitive_value(step.get("args") or {}),
                "summary": str(step.get("summary") or ""),
            }
            for step in (row.steps_json or [])
            if isinstance(step, dict) and step.get("status") == "waiting_confirmation"
        ]
        if not steps:
            continue
        items.append(
            {
                "runId": row.run_id,
                "goal": row.goal or "",
                "steps": steps,
                "createdAt": str(row.created_at),
            }
        )
    return {"total": len(items), "items": items}


@router.get("/proposals/{run_id}")
async def get_proposal(run_id: str) -> dict[str, Any]:
    """Full confirmation state of one proposal Run."""
    return await load_proposal_state(run_id=run_id)


class ProposalDecisionRequest(BaseModel):
    approve: bool = Field(description="true=批准执行一次；false=拒绝（零执行）")


@router.post("/proposals/{run_id}/confirm")
async def confirm_proposal_endpoint(
    run_id: str, body: ProposalDecisionRequest
) -> dict[str, Any]:
    """Human decision from the workbench overlay.

    approve=true executes exactly once (idempotent replay-safe); approve=false
    fails the proposal Run so it can never execute later.
    """
    if body.approve:
        result = await confirm_proposal(run_id=run_id)
        return {"approved": True, **result}
    result = await execute_operation(
        "reject_agent_run",
        {"run_id": run_id},
        surface="bridge_user",
    )
    if not result.get("ok"):
        return {"approved": False, "errors": list(result.get("errors") or [])}
    outputs = result.get("outputs") if isinstance(result.get("outputs"), dict) else {}
    return {
        "approved": False,
        **outputs,
    }
