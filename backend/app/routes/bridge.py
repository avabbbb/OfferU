"""Workbench-facing read endpoints for Agent writes waiting on the user.

Confirming happens only through /runtime/actions/{id}/confirm with the desktop
capability; the Bridge and the model can read state but never confirm.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from app.services.action_gate import list_actions
from app.services.agent_bridge.errors import BridgeProtocolError
from app.services.agent_bridge.operation_gateway import load_proposal_state

router = APIRouter()


@router.get("/proposals/pending")
async def list_pending_proposals() -> dict[str, Any]:
    items = await list_actions(status="pending")
    return {"total": len(items), "items": items}


@router.get("/proposals/{run_id}")
async def get_proposal(run_id: str) -> dict[str, Any]:
    try:
        return await load_proposal_state(run_id=run_id)
    except BridgeProtocolError as exc:
        if exc.code == "run_not_found":
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        raise HTTPException(status_code=409, detail=str(exc)) from exc
