"""Non-safety gates are advisory or have a fallback; hard safety still blocks."""
from __future__ import annotations

import asyncio
import os
import sys
import uuid
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.chdir(BACKEND_DIR)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.services.agent_skill_registry import resolve_skill, run_allowed_tools
from app.services.agentic_interaction_policy import assess_group
from app.services.proposal_plan_preparation import OUTSIDE_SKILL_SCOPE, outside_scope_allowed


def test_run_scope_falls_back_to_registry_skill_when_snapshot_is_empty() -> None:
    skill = resolve_skill("evaluate_job")
    assert run_allowed_tools({"skill_id": "evaluate_job", "skill_snapshot": {}}) == skill.allowed_tools
    # A frozen snapshot is authoritative and never widened.
    assert run_allowed_tools({"skill_id": "evaluate_job", "skill_snapshot": {"allowed_tools": ["get_job"]}}) == {"get_job"}
    assert run_allowed_tools({"skill_id": "", "skill_snapshot": {}}) == frozenset()
    assert run_allowed_tools(None) == frozenset()


def test_outside_scope_fallback_excludes_external_and_destructive() -> None:
    assert outside_scope_allowed("update_job")
    assert not outside_scope_allowed("delete_target_role")
    assert not outside_scope_allowed("reset_local_business_data")
    assert not outside_scope_allowed("start_job_research")  # external
    assert not outside_scope_allowed("no_such_operation")


def _group(**display):
    return {"status": "pending", "risk": "protected", "source_versions": {"job:1": "v1"},
            "display": {"before": "a", "after": "b", "why": "c"},
            "nodes": [{"status": "pending", "operation": "update_job", "display": display}]}


def test_outside_scope_marker_is_an_advisory_hint_not_a_block() -> None:
    result = assess_group(_group(scope_advisory=OUTSIDE_SKILL_SCOPE))
    assert result["reviewability"]["status"] == "ready"
    assert OUTSIDE_SKILL_SCOPE in result["reviewability"]["advisory_codes"]
    assert result["interaction_state"] == "needs_user_review"


def test_stale_source_still_blocks_approval_readiness() -> None:
    result = assess_group(_group(), source_current=False)
    assert result["reviewability"]["status"] == "needs_preparation"
    assert "source_changed_or_unavailable" in result["reviewability"]["reason_codes"]


async def _plan_flow(tmp: Path, case: str) -> None:
    import pytest
    from sqlalchemy import select
    from app.models.models import AgentRunRecord, Job
    from app.services.agent_run_state import create_agent_run
    from app.services.proposal_plan_builder import PlanValidationError
    from app.services.proposal_plan_preparation import prepare_proposal_plan
    from app.services import proposal_plan_execution as execution, proposal_plan_store as store
    from tests.proposal_v2_fixtures import make_db

    with pytest.MonkeyPatch.context() as patches:
        database = make_db(tmp, patches)
        await database.start(create_schema=True)
        try:
            patches.setattr("app.services.ui_approval_capability.accepts_authorization",
                            lambda token: token == "Bearer unblock-test")
            async with database.sessions() as db:
                job = Job(title="Role", company="Fixture", hash_key=uuid.uuid4().hex)
                db.add(job)
                await db.commit()
            skill = resolve_skill("evaluate_job")
            snapshot = {} if case == "no_snapshot" else skill.summary()
            run = await create_agent_run(conversation_id=uuid.uuid4().hex, goal="Review", mode=skill.mode,
                                         skill_id=skill.id, skill_snapshot=snapshot, actions=[])
            if case == "destructive_outside":
                with pytest.raises(PlanValidationError, match="allowlist"):
                    await prepare_proposal_plan(run_id=run["id"], title="Remove",
                        intents=[{"id": "x", "operation": "delete_target_role", "args": {"role_id": 1}, "summary": "x"}])
                return
            operation, args = ("update_job", {"job_id": job.id, "triage_status": "picked"}) if case == "outside" \
                else ("triage_job", {"job_id": job.id, "status": "picked"})
            prepared = await prepare_proposal_plan(run_id=run["id"], title="Keep role",
                intents=[{"id": "a", "operation": operation, "args": args, "summary": "Keep the role"}])
            plan = prepared["plan"]
            group = plan["groups"][0]
            if case == "outside":
                assert group["nodes"][0]["display"]["scope_advisory"] == OUTSIDE_SKILL_SCOPE
                assert OUTSIDE_SKILL_SCOPE in assess_group(group)["reviewability"]["advisory_codes"]
                return
            if case == "no_snapshot":
                assert group["nodes"][0]["operation"] == "triage_job"
                return
            async with database.sessions() as db:
                if case == "reject_stale":
                    # The reviewed source changed after the Plan was sealed.
                    (await db.get(Job, job.id)).title = "Role (edited)"
                else:
                    # reject_after_run_ended: the Run finished, its group is still pending.
                    row = (await db.execute(select(AgentRunRecord).where(AgentRunRecord.run_id == run["id"]))).scalar_one()
                    row.status = "completed"
                await db.commit()
            kwargs = dict(plan_digest=plan["digest"], group_digest=group["digest"],
                          authorization_source="Bearer unblock-test", surface="agent_runtime_ui")
            approve = await execution.confirm_group(plan["id"], group["id"], decision_id="decision_" + uuid.uuid4().hex, **kwargs)
            assert not approve["ok"]
            result = await execution.reject_group(plan["id"], group["id"], decision_id="decision_" + uuid.uuid4().hex, **kwargs)
            assert result["ok"], result
            if case != "reject_stale":
                assert result["continuation"] is None
            assert (await store.get_plan(plan["id"]))["groups"][0]["status"] == "rejected"
            async with database.sessions() as db:
                assert (await db.get(Job, job.id)).triage_status != "picked"
        finally:
            await database.close()


def test_plan_preparation_uses_registry_scope_for_run_without_snapshot(tmp_path: Path) -> None:
    asyncio.run(_plan_flow(tmp_path, "no_snapshot"))


def test_plain_local_write_outside_skill_is_staged_with_advisory(tmp_path: Path) -> None:
    asyncio.run(_plan_flow(tmp_path, "outside"))


def test_destructive_operation_outside_skill_is_still_refused(tmp_path: Path) -> None:
    asyncio.run(_plan_flow(tmp_path, "destructive_outside"))


def test_pending_group_can_be_rejected_after_run_ended(tmp_path: Path) -> None:
    asyncio.run(_plan_flow(tmp_path, "reject_after_run_ended"))


def test_stale_group_cannot_be_approved_but_can_be_rejected(tmp_path: Path) -> None:
    asyncio.run(_plan_flow(tmp_path, "reject_stale"))
