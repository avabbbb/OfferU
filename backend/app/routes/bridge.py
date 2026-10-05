"""Workbench-facing Bridge confirmation endpoints (Slice 3).

The OfferU workbench overlay polls pending proposal Runs and posts the human
decision. Approval authority stays with the workbench (ADR-0052): the Bridge
and the model can only read state, never self-approve.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from app.services.agent_bridge.errors import BridgeProtocolError
from app.services.agent_bridge.operation_gateway import load_proposal_state
from app.services.security_redaction import redact_sensitive_value
from app.services.ui_approval_capability import accepts_authorization

router = APIRouter()


@router.get("/proposals/pending")
async def list_pending_proposals() -> dict[str, Any]:
    """Legacy queue is read-only; Plan groups use the dedicated Plan endpoint."""
    from sqlalchemy import select

    from app.database import async_session
    from app.models.models import AgentRunRecord
    from app.services.agent_run_state import load_agent_run, proposal_execution_blocker

    async with async_session() as db:
        run_ids = (
            (
                await db.execute(
                    select(AgentRunRecord.run_id)
                    .order_by(AgentRunRecord.updated_at.desc())
                    .limit(200)
                )
            )
            .scalars()
            .all()
        )
    items: list[dict[str, Any]] = []
    unavailable: list[dict[str, Any]] = []
    for run_id in run_ids:
        run = await load_agent_run(str(run_id))
        if run is None:
            continue
        if run.get("proposal_authority") == "proposal-plan-v2":
            if any(
                group.get("status") in {"pending", "approved", "executing", "paused", "stale", "needs_reconciliation"}
                for plan in run.get("proposal_plans") or []
                if plan.get("status") != "replaced"
                for group in plan.get("groups") or []
            ):
                unavailable.append({
                    "runId": run["id"],
                    "goal": redact_sensitive_value(run.get("goal") or "", max_length=4000),
                    "reason": "This Run is governed by Proposal Plan groups. Review it in PlanReview; action-level approval is disabled.",
                    "planIds": [
                        str(plan.get("id") or "")
                        for plan in run.get("proposal_plans") or []
                        if plan.get("status") != "replaced"
                    ],
                })
            continue

        pending_legacy_steps = any(
            isinstance(step, dict) and step.get("status") == "waiting_confirmation"
            for step in run.get("steps") or []
        )
        runtime = run.get("llm_runtime") if isinstance(run.get("llm_runtime"), dict) else {}
        if not pending_legacy_steps and not run.get("needs_review") and not runtime.get("needs_review"):
            continue
        reason = proposal_execution_blocker(run) or (
            "Legacy action data does not bind a displayed Plan snapshot. Open PlanReview and prepare a new Plan."
        )
        unavailable.append({
            "runId": run["id"],
            "goal": redact_sensitive_value(run.get("goal") or "", max_length=4000),
            "reason": reason,
        })
    return {"total": len(items), "items": items, "unavailable": unavailable, "unavailable_total": len(unavailable)}


@router.get("/proposals/{run_id}")
async def get_proposal(run_id: str) -> dict[str, Any]:
    """Full confirmation state of one proposal Run."""
    try:
        return await load_proposal_state(run_id=run_id)
    except BridgeProtocolError as exc:
        if exc.code == "run_not_found":
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        raise HTTPException(status_code=409, detail=str(exc)) from exc


class ProposalDecisionRequest(BaseModel):
    approve: bool = Field(description="true=只批准目标动作执行一次；false=只拒绝目标动作（零执行）")
    action_id: str = Field(default="", max_length=200)
    plan_digest: str = Field(default="", pattern=r"^(?:[a-f0-9]{64})?$")
    group_digest: str = Field(default="", pattern=r"^(?:[a-f0-9]{64})?$")
    decision_id: str = Field(default="", pattern=r"^(?:decision_[a-f0-9]{32})?$")


@router.post("/proposals/{run_id}/confirm")
async def confirm_proposal_endpoint(
    run_id: str,
    body: ProposalDecisionRequest,
    authorization: str = Header(...),
) -> dict[str, Any]:
    """Human decision from the workbench overlay.

    approve=true executes only the selected action once; approve=false rejects
    only the selected action, leaving sibling actions available for review.
    """
    if not accepts_authorization(authorization):
        raise HTTPException(status_code=403, detail="该决定只能由 OfferU 桌面工作区提交")
    from app.services.embedded_agent_host import (
        confirm_embedded_agent_action,
        reject_embedded_agent_action,
    )

    decision_args = {"action_id": body.action_id, "authorization_source": authorization,
                     "plan_digest": body.plan_digest, "group_digest": body.group_digest,
                     "decision_id": body.decision_id}
    if body.approve:
        result = await confirm_embedded_agent_action(run_id, **decision_args)
    else:
        result = await reject_embedded_agent_action(run_id, **decision_args)
    return {
        "approved": bool(body.approve and result.get("ok")),
        "completed": bool(result.get("ok")),
        "runStatus": (result.get("run") or {}).get("status"),
        "errors": list(result.get("errors") or []),
        "warnings": list(result.get("warnings") or []),
        "continuation": result.get("continuation"),
    }
