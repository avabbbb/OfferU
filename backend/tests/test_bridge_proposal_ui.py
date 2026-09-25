from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import uuid

import httpx
from sqlalchemy import select
from fastapi import FastAPI

from app.database import async_session, init_db
from app.models.models import AgentRunRecord, AgentWorkspaceState, OperationAuditLog
from app.routes.bridge import (
    ProposalDecisionRequest,
    confirm_proposal_endpoint,
    list_pending_proposals,
    router as bridge_router,
)
from app.ops import execute_operation
from app.services.agent_run_state import create_agent_run, load_agent_run
from app.services import ui_approval_capability


_UI_AUTHORIZATION = "Bearer test-offeru-ui-capability"


def _authorize_ui(monkeypatch) -> None:
    monkeypatch.setattr(
        ui_approval_capability,
        "_APPROVAL_TOKEN",
        "test-offeru-ui-capability",
    )


async def _pending_projection_run(*, goal: str, scope: str | None = None) -> dict:
    scope = scope or f"proposal-ui-{uuid.uuid4().hex}"
    return await create_agent_run(
        conversation_id="",
        goal=goal,
        mode="operation_projection",
        skill_id="operation_registry",
        actions=[
            {
                "id": "set-view:1",
                "tool": "set_current_view",
                "args": {
                    "scope": scope,
                    "route": "/jobs/42",
                    "title": "Example role",
                },
                "summary": "打开岗位工作区",
                "requires_confirmation": True,
            }
        ],
        llm_runtime={"runtime": "none", "reason": "test_fixture"},
    )


def test_agent_runtime_ui_cannot_execute_mutation_without_proposal_authorization() -> None:
    async def run() -> tuple[dict, AgentWorkspaceState | None]:
        await init_db()
        scope = f"proposal-ui-unguarded-{uuid.uuid4().hex}"
        result = await execute_operation(
            "set_current_view",
            {"scope": scope, "route": "/jobs/42"},
            surface="agent_runtime_ui",
        )
        async with async_session() as db:
            view = (
                await db.execute(
                    select(AgentWorkspaceState).where(AgentWorkspaceState.scope == scope)
                )
            ).scalar_one_or_none()
        return result, view

    result, view = asyncio.run(run())

    assert result["ok"] is False
    assert "提案" in "；".join(result["errors"])
    assert view is None


def test_workbench_approval_executes_registry_action_once_with_ui_audit(monkeypatch) -> None:
    _authorize_ui(monkeypatch)

    async def run() -> tuple[dict, dict, dict, list[OperationAuditLog], AgentWorkspaceState | None]:
        await init_db()
        scope = f"proposal-ui-approve-{uuid.uuid4().hex}"
        proposal = await _pending_projection_run(
            goal="Open this job workspace",
            scope=scope,
        )
        first = await confirm_proposal_endpoint(
            proposal["id"],
            ProposalDecisionRequest(approve=True, action_id="set-view:1"),
            authorization=_UI_AUTHORIZATION,
        )
        replay = await confirm_proposal_endpoint(
            proposal["id"],
            ProposalDecisionRequest(approve=True, action_id="set-view:1"),
            authorization=_UI_AUTHORIZATION,
        )
        async with async_session() as db:
            audit = list(
                (
                    await db.execute(
                        select(OperationAuditLog).where(
                            OperationAuditLog.confirmation_ref
                            == f"agent-run:{proposal['id']}:set-view:1"
                        )
                    )
                ).scalars()
            )
            view = (
                await db.execute(
                    select(AgentWorkspaceState).where(AgentWorkspaceState.scope == scope)
                )
            ).scalar_one_or_none()
        persisted = await load_agent_run(proposal["id"])
        assert persisted is not None
        return first, replay, persisted, audit, view

    first, replay, persisted, audit, view = asyncio.run(run())

    assert first["approved"] is True
    assert first["completed"] is True
    assert replay["approved"] is True
    assert persisted["steps"][0]["status"] == "completed"
    assert view is not None and view.version == 1
    assert len(audit) == 1
    assert audit[0].operation == "set_current_view"
    assert audit[0].surface == "agent_runtime_ui"
    assert audit[0].idempotency_key == f"{persisted['id']}:set-view:1"


def test_workbench_rejection_records_decision_without_running_proposed_operation(monkeypatch) -> None:
    _authorize_ui(monkeypatch)

    async def run() -> tuple[dict, dict, list[OperationAuditLog], AgentWorkspaceState | None]:
        await init_db()
        scope = f"proposal-ui-reject-{uuid.uuid4().hex}"
        proposal = await _pending_projection_run(
            goal="Open this job workspace",
            scope=scope,
        )
        result = await confirm_proposal_endpoint(
            proposal["id"],
            ProposalDecisionRequest(approve=False, action_id="set-view:1"),
            authorization=_UI_AUTHORIZATION,
        )
        persisted = await load_agent_run(proposal["id"])
        async with async_session() as db:
            audit = list(
                (
                    await db.execute(
                        select(OperationAuditLog).where(
                            OperationAuditLog.confirmation_ref
                            == f"agent-run:{proposal['id']}:set-view:1"
                        )
                    )
                ).scalars()
            )
            view = (
                await db.execute(
                    select(AgentWorkspaceState).where(AgentWorkspaceState.scope == scope)
                )
            ).scalar_one_or_none()
        assert persisted is not None
        return result, persisted, audit, view

    result, persisted, audit, view = asyncio.run(run())

    assert result["approved"] is False
    assert persisted["steps"][0]["status"] == "rejected"
    assert not any(row.operation == "set_current_view" for row in audit)
    assert view is None


def test_bridge_http_rejects_decision_without_desktop_capability(monkeypatch) -> None:
    _authorize_ui(monkeypatch)

    async def run() -> tuple[int, int, str, int, str, dict]:
        await init_db()
        proposal = await _pending_projection_run(goal="Reject an unauthenticated decision")
        test_app = FastAPI()
        test_app.include_router(bridge_router, prefix="/api/bridge")
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=test_app),
            base_url="http://127.0.0.1:8766",
        ) as client:
            denied = await client.post(
                f"/api/bridge/proposals/{proposal['id']}/confirm",
                json={"approve": True, "action_id": "set-view:1"},
            )
            spoofed = await client.post(
                f"/api/bridge/proposals/{proposal['id']}/confirm",
                headers={"Authorization": "Bearer guessed-token"},
                json={"approve": True, "action_id": "set-view:1"},
            )
            after_denial = await load_agent_run(proposal["id"])
            assert after_denial is not None
            accepted = await client.post(
                f"/api/bridge/proposals/{proposal['id']}/confirm",
                headers={"Authorization": _UI_AUTHORIZATION},
                json={"approve": True, "action_id": "set-view:1"},
            )
        persisted = await load_agent_run(proposal["id"])
        assert persisted is not None
        return (
            denied.status_code,
            spoofed.status_code,
            after_denial["steps"][0]["status"],
            accepted.status_code,
            persisted["steps"][0]["status"],
            spoofed.json(),
        )

    (
        status,
        spoofed_status,
        status_after_denial,
        accepted_status,
        final_status,
        payload,
    ) = asyncio.run(run())

    assert status == 422
    assert spoofed_status == 403
    assert status_after_denial == "waiting_confirmation"
    assert accepted_status == 200
    assert final_status == "completed"
    assert "桌面工作区" in payload["detail"]


def test_pending_workbench_queue_includes_old_and_detached_runs() -> None:
    async def run() -> tuple[list[str], list[str], int]:
        await init_db()
        run_ids = []
        for index in range(6):
            proposal = await _pending_projection_run(goal=f"External proposal {index}")
            run_ids.append(proposal["id"])
            if index == 0:
                async with async_session() as db:
                    row = (
                        await db.execute(
                            select(AgentRunRecord).where(
                                AgentRunRecord.run_id == proposal["id"]
                            )
                        )
                    ).scalar_one()
                    row.created_at = (
                        datetime.now(timezone.utc).replace(tzinfo=None)
                        - timedelta(days=2)
                    )
                    await db.commit()
        result = await list_pending_proposals()
        return run_ids, [item["runId"] for item in result["items"]], result["total"]

    expected_ids, returned_ids, total = asyncio.run(run())

    assert set(expected_ids).issubset(returned_ids)
    assert total >= len(expected_ids)
