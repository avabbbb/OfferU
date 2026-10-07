from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock
import uuid

import httpx
import pytest
from sqlalchemy import select
from fastapi import FastAPI

import app.database as app_database
from app.database import async_session, init_db
from app.models.models import AgentRunRecord, AgentWorkspaceState, OperationAuditLog
from app.routes import bridge as bridge_module
from app.routes.bridge import (
    ProposalDecisionRequest,
    confirm_proposal_endpoint,
    list_pending_proposals,
    router as bridge_router,
)
from app.ops import execute_operation
from app.services.agent_run_state import create_agent_run, load_agent_run
from app.services.agent_skill_registry import resolve_skill
from app.services.operation_projection import execute_or_propose_operation
from app.services import ui_approval_capability


_UI_AUTHORIZATION = "Bearer test-offeru-ui-capability"


def _authorize_ui(monkeypatch) -> None:
    accepts_fixture_token = lambda value: value == _UI_AUTHORIZATION
    monkeypatch.setattr(ui_approval_capability, "accepts_authorization", accepts_fixture_token)
    monkeypatch.setattr(bridge_module, "accepts_authorization", accepts_fixture_token)


@pytest.fixture
def proposal_v2_database(tmp_path, monkeypatch):
    from proposal_v2_fixtures import make_db

    database = make_db(tmp_path, monkeypatch)
    asyncio.run(database.start(create_schema=True))
    # Bridge's read route imports this handle dynamically; all Plan, source,
    # guard, Registry and Run modules are patched by ProposalV2Database to the
    # same file-backed sessionmaker.
    monkeypatch.setattr(app_database, "async_session", database.sessions)
    yield database
    asyncio.run(database.close())


async def _pending_projection_run(*, goal: str, scope: str | None = None, database=None) -> dict:
    scope = scope or f"proposal-ui-{uuid.uuid4().hex}"
    run = await create_agent_run(
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
    sessions = database.sessions if database is not None else async_session
    async with sessions() as db:
        row = (
            await db.execute(select(AgentRunRecord).where(AgentRunRecord.run_id == run["id"]))
        ).scalar_one()
        steps = [dict(step) for step in row.steps_json or []]
        steps[0]["status"] = "waiting_confirmation"
        row.steps_json = steps
        row.status = "waiting_confirmation"
        await db.commit()
    return await load_agent_run(run["id"]) or run


async def _review_plan_for_run(database, monkeypatch, suffix: str, *, action: str = "accept") -> tuple[dict, dict, dict, dict, dict, dict]:
    from proposal_v2_fixtures import seed_reviewable_resume_proposal

    from app.services import proposal_plan_store, resume_workspace

    seed = await seed_reviewable_resume_proposal(database, suffix)
    monkeypatch.setattr(
        resume_workspace,
        "get_pre_application_state",
        AsyncMock(return_value={"stage": "resume_proposal_ready"}),
    )
    workspace = await resume_workspace.ensure_resume_workspace(
        job_id=seed["job_id"], proposal_id=seed["proposal_id"]
    )
    skill = resolve_skill("tailor_resume")
    assert skill is not None
    run = await create_agent_run(
        conversation_id=f"bridge-review-{suffix}",
        goal="Review the displayed resume change for this role.",
        mode="ui_operation_request",
        skill_id=skill.id,
        skill_version=skill.version,
        skill_snapshot={
            "id": skill.id,
            "version": skill.version,
            "allowed_tools": sorted(skill.allowed_tools),
        },
        actions=[],
        llm_runtime={"runtime": "none", "reason": "explicit_ui_operation_request"},
    )
    staged = await execute_or_propose_operation(
        "review_resume_proposal_items",
        {
            "proposal_id": seed["proposal_id"],
            "resume_id": workspace["resume"]["id"],
            "change_ids": [seed["change_id"]],
            "action": action,
        },
        surface="agent_runtime_ui",
        run_id=run["id"],
    )
    assert staged["ok"], staged
    plans = await proposal_plan_store.list_plans(run_id=run["id"])
    assert len(plans) == 1
    plan = plans[0]
    assert len(plan["groups"]) == 1 and len(plan["groups"][0]["nodes"]) == 1
    group = plan["groups"][0]
    node = group["nodes"][0]
    assert node["operation"] == "review_resume_proposal_items"
    return seed, workspace, run, plan, group, node


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


def test_workbench_singleton_adapter_requires_displayed_digests_and_executes_registry_once(
    monkeypatch, proposal_v2_database
) -> None:
    _authorize_ui(monkeypatch)

    async def run() -> tuple[dict, dict, dict, dict, list[OperationAuditLog], dict, list[dict]]:
        seed, workspace, run, plan, group, node = await _review_plan_for_run(
            proposal_v2_database, monkeypatch, f"approve-{uuid.uuid4().hex}"
        )
        digestless = await confirm_proposal_endpoint(
            run["id"],
            ProposalDecisionRequest(approve=True, action_id=node["id"]),
            authorization=_UI_AUTHORIZATION,
        )
        assert digestless["approved"] is False
        assert digestless["completed"] is False
        assert "Plan snapshot" in digestless["errors"][0]
        before = await load_agent_run(run["id"])
        assert before is not None and before["proposal_plans"][0]["groups"][0]["status"] == "pending"
        async with proposal_v2_database.sessions() as db:
            no_audit = list((await db.execute(
                select(OperationAuditLog).where(OperationAuditLog.idempotency_key == node["idempotency_key"])
            )).scalars().all())
        assert no_audit == []
        decision = ProposalDecisionRequest(
            approve=True,
            action_id=node["id"],
            plan_digest=plan["digest"],
            group_digest=group["digest"],
            decision_id=f"decision_{uuid.uuid4().hex}",
        )
        accepted = await confirm_proposal_endpoint(run["id"], decision, authorization=_UI_AUTHORIZATION)
        replay = await confirm_proposal_endpoint(run["id"], decision, authorization=_UI_AUTHORIZATION)
        async with proposal_v2_database.sessions() as db:
            audit = list((await db.execute(
                select(OperationAuditLog).where(OperationAuditLog.idempotency_key == node["idempotency_key"])
            )).scalars().all())
            from app.models.models import ResumeOptimizationProposal
            proposal_row = await db.get(ResumeOptimizationProposal, seed["proposal_id"])
            from app.models.models import ResumeSection
            sections = list((await db.execute(
                select(ResumeSection).where(ResumeSection.resume_id == workspace["resume"]["id"])
            )).scalars().all())
        from app.services.proposal_plan_store import get_node_authorization
        authorization = await get_node_authorization(node["id"])
        review_actions = {
            seed["change_id"]: proposal_row.item_reviews_json[seed["change_id"]]["action"]
        }
        section_content = [section.content_json for section in sections]
        return accepted, replay, await load_agent_run(run["id"]), authorization, audit, review_actions, section_content

    accepted, replay, persisted, authorization, audit, review_actions, section_content = asyncio.run(run())

    assert accepted["approved"] is True
    assert accepted["completed"] is True
    assert accepted["continuation"]["status"] == "delivered"
    assert replay["approved"] is True
    assert persisted is not None and persisted["status"] == "completed"
    assert len(audit) == 1
    assert audit[0].operation == "review_resume_proposal_items"
    assert audit[0].surface == "agent_runtime_ui"
    assert len(review_actions) == 1 and set(review_actions.values()) == {"accept"}
    assert any("new evidence" in str(content) for content in section_content)
    assert authorization["decision"]["authorization_source"] == "desktop-ui"
    assert _UI_AUTHORIZATION.split(" ", 1)[1] not in str(authorization)


def test_workbench_action_only_rejection_does_not_decide_a_plan_group(monkeypatch, proposal_v2_database) -> None:
    _authorize_ui(monkeypatch)

    async def run() -> tuple[dict, str, list[OperationAuditLog], str, str]:
        from app.services import proposal_plan_store

        seed, workspace, run, plan, group, node = await _review_plan_for_run(
            proposal_v2_database, monkeypatch, f"reject-{uuid.uuid4().hex}"
        )
        result = await confirm_proposal_endpoint(
            run["id"],
            ProposalDecisionRequest(approve=False, action_id=node["id"]),
            authorization=_UI_AUTHORIZATION,
        )
        plans = await proposal_plan_store.list_plans(run_id=run["id"])
        async with proposal_v2_database.sessions() as db:
            audit = list((await db.execute(
                select(OperationAuditLog).where(OperationAuditLog.idempotency_key == node["idempotency_key"])
            )).scalars().all())
            from app.models.models import ResumeOptimizationProposal, ResumeSection
            proposal_row = await db.get(ResumeOptimizationProposal, seed["proposal_id"])
            section = (await db.execute(
                select(ResumeSection).where(ResumeSection.resume_id == workspace["resume"]["id"])
            )).scalars().first()
        return result, plans[0]["groups"][0]["status"], audit, str(proposal_row.item_reviews_json or {}), str(section.content_json)

    result, group_status, audit, reviews, section_content = asyncio.run(run())

    assert result["approved"] is False
    assert result["completed"] is False
    assert "Plan snapshot" in result["errors"][0]
    assert group_status == "pending"
    assert audit == []
    assert reviews == "{}"
    assert "old evidence" in section_content


def test_bridge_http_rejects_missing_capability_and_digestless_action_decisions(
    monkeypatch, proposal_v2_database
) -> None:
    _authorize_ui(monkeypatch)

    async def run() -> tuple[int, int, int, bool, str, list[OperationAuditLog]]:
        from app.services import proposal_plan_store

        _seed, _workspace, run, plan, group, node = await _review_plan_for_run(
            proposal_v2_database, monkeypatch, f"http-{uuid.uuid4().hex}"
        )
        test_app = FastAPI()
        test_app.include_router(bridge_router, prefix="/api/bridge")
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=test_app),
            base_url="http://127.0.0.1:8766",
        ) as client:
            denied = await client.post(
                f"/api/bridge/proposals/{run['id']}/confirm",
                json={"approve": True, "action_id": node["id"]},
            )
            spoofed = await client.post(
                f"/api/bridge/proposals/{run['id']}/confirm",
                headers={"Authorization": "Bearer guessed-token"},
                json={"approve": True, "action_id": node["id"]},
            )
            accepted = await client.post(
                f"/api/bridge/proposals/{run['id']}/confirm",
                headers={"Authorization": _UI_AUTHORIZATION},
                json={"approve": True, "action_id": node["id"]},
            )
        plans = await proposal_plan_store.list_plans(run_id=run["id"])
        async with proposal_v2_database.sessions() as db:
            audit = list((await db.execute(
                select(OperationAuditLog).where(OperationAuditLog.idempotency_key == node["idempotency_key"])
            )).scalars().all())
        return (
            denied.status_code,
            spoofed.status_code,
            accepted.status_code,
            accepted.json()["approved"],
            plans[0]["groups"][0]["status"],
            audit,
        )

    (
        status,
        spoofed_status,
        accepted_status,
        approved,
        group_status,
        audit,
    ) = asyncio.run(run())

    assert status == 422
    assert spoofed_status == 403
    assert accepted_status == 200
    assert approved is False
    assert group_status == "pending"
    assert audit == []


def test_pending_workbench_queue_marks_plan_and_legacy_runs_unavailable_for_action_approval(
    monkeypatch, proposal_v2_database
) -> None:
    async def run() -> tuple[list[str], str, list[dict], int]:
        run_ids = []
        for index in range(6):
            proposal = await _pending_projection_run(
                goal=f"External proposal {index}", database=proposal_v2_database
            )
            run_ids.append(proposal["id"])
            if index == 0:
                async with proposal_v2_database.sessions() as db:
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
        _seed, _workspace, plan_run, plan, _group, _node = await _review_plan_for_run(
            proposal_v2_database, monkeypatch, f"queue-{uuid.uuid4().hex}"
        )
        result = await list_pending_proposals()
        return run_ids, plan_run["id"], result["unavailable"], result["total"]

    expected_ids, plan_run_id, unavailable, total = asyncio.run(run())
    unavailable_ids = {item["runId"] for item in unavailable}

    assert set(expected_ids).issubset(unavailable_ids)
    assert plan_run_id in unavailable_ids
    plan_item = next(item for item in unavailable if item["runId"] == plan_run_id)
    assert "PlanReview" in plan_item["reason"]
    assert all(item["reason"] for item in unavailable)
    assert total == 0


def test_bridge_action_only_decision_does_not_delegate_confirmation_to_an_agent_provider(
    monkeypatch, proposal_v2_database
):
    _authorize_ui(monkeypatch)
    from app.services import agent_runtime
    from types import SimpleNamespace
    confirm = AsyncMock(return_value={"ok": True, "run": {"status": "completed"}, "continuation": {"ok": True}})
    monkeypatch.setattr(agent_runtime, "get_agent_run_provider", lambda name: SimpleNamespace(confirm_run=confirm))
    async def flow():
        scope = f"legacy-no-authority-{uuid.uuid4().hex}"
        legacy = await _pending_projection_run(
            goal="Fixture old action remains for historical display only",
            scope=scope,
            database=proposal_v2_database,
        )
        response = await confirm_proposal_endpoint(
            legacy["id"],
            ProposalDecisionRequest(approve=True, action_id="set-view:1"),
            authorization=_UI_AUTHORIZATION,
        )
        persisted = await load_agent_run(legacy["id"])
        async with proposal_v2_database.sessions() as db:
            view = (await db.execute(
                select(AgentWorkspaceState).where(AgentWorkspaceState.scope == scope)
            )).scalar_one_or_none()
            audits = list((await db.execute(
                select(OperationAuditLog).where(OperationAuditLog.operation == "set_current_view")
            )).scalars().all())
        assert persisted is not None
        return response, persisted, view, audits

    response, persisted, view, audits = asyncio.run(flow())
    assert response["approved"] is False
    assert response["completed"] is False
    assert "Plan snapshot" in response["errors"][0]
    assert persisted["status"] != "completed"
    assert persisted.get("proposal_authority") != "proposal-plan-v2"
    assert view is None
    assert audits == []
    confirm.assert_not_awaited()
