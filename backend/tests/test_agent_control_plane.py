from __future__ import annotations

import asyncio
import os
import sys
import unittest
import uuid
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.chdir(BACKEND_DIR)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import func, select

from app.database import async_session, init_db
from app.mcp_server import operation_schema
from app.models.models import OperationAuditLog
from app.ops import OPERATIONS, execute_operation, get_operation_schema
import app.services.agent_run_state as agent_run_state
import app.services.operation_projection as operation_projection
from app.services.agent_run_state import (
    create_agent_run,
    list_agent_run_events,
    load_agent_run,
    save_agent_run,
)
from app.services.operation_projection import (
    confirm_operation_proposal,
    execute_or_propose_operation,
)


class AgentControlPlaneTests(unittest.TestCase):
    def test_selected_research_schema_is_shared_with_mcp(self) -> None:
        async def run() -> None:
            for name in {
                "get_job",
                "get_pre_application_state",
                "list_job_research_runs",
                "get_job_research",
                "start_job_research",
                "resume_job_research",
            }:
                registry_schema = get_operation_schema(name)
                mcp_schema = await operation_schema(name)
                self.assertEqual(mcp_schema["schema"], registry_schema)

        asyncio.run(run())

    def test_mcp_module_has_no_database_or_business_service_path(self) -> None:
        source = (BACKEND_DIR / "app" / "mcp_server.py").read_text(encoding="utf-8")

        self.assertNotIn("sqlalchemy", source)
        self.assertNotIn("async_session", source)
        self.assertNotIn("agent_operations", source)
        self.assertNotIn("app.models", source)

    def test_hosted_session_ui_is_a_thin_operation_projection(self) -> None:
        source = (BACKEND_DIR / "app" / "routes" / "main_agent.py").read_text(
            encoding="utf-8"
        )

        self.assertIn('"/runtime/hosted-sessions"', source)
        self.assertIn('"list_hosted_executor_sessions"', source)
        self.assertIn('"get_hosted_executor_session"', source)
        self.assertIn('"cancel_job_research"', source)
        self.assertIn('"resume_job_research"', source)
        self.assertIn('surface="hosted_session_ui"', source)
        self.assertNotIn("from app.services.coding_agent_runtime", source)
        self.assertNotIn("from app.services.job_research", source)

    def test_same_confirmed_research_action_executes_at_most_once(self) -> None:
        asyncio.run(_exercise_group_control("duplicate"))

    def test_interrupted_executing_step_requires_reconciliation(self) -> None:
        asyncio.run(_exercise_group_control("recovery"))

    def test_reject_one_action_preserves_siblings_and_audits_decision(self) -> None:
        asyncio.run(_exercise_group_control("reject"))

    def test_confirming_one_action_leaves_sibling_proposal_pending(self) -> None:
        asyncio.run(_exercise_group_control("sibling"))

    def test_confirm_and_reject_race_has_one_action_transition_winner(self) -> None:
        asyncio.run(_exercise_group_control("race"))



async def _exercise_group_control(case):
    """Real isolated Registry writes with synthetic independent native authorization.

    The former action tests now protect the same idempotency, recovery,
    sibling isolation and decision-CAS invariants at the v2 group boundary.
    """
    import tempfile
    import pytest
    from app.models.models import Job, ProposalConfirmationDecision
    from app.services.agent_skill_registry import resolve_skill
    from app.services.proposal_plan_preparation import prepare_proposal_plan
    from app.services import proposal_plan_execution as execution, proposal_plan_store as store
    from tests.proposal_v2_fixtures import make_db

    with tempfile.TemporaryDirectory() as directory, pytest.MonkeyPatch.context() as patches:
        database = make_db(Path(directory), patches)
        await database.start(create_schema=True)
        try:
            patches.setattr("app.services.ui_approval_capability.accepts_authorization", lambda token: token == "Bearer control-test")
            async with database.sessions() as db:
                jobs = [Job(title=f"Reviewed role {i}", company="Fixture", hash_key=uuid.uuid4().hex) for i in range(2)]
                db.add_all(jobs)
                await db.commit()
            skill = resolve_skill("evaluate_job")
            run = await create_agent_run(conversation_id=uuid.uuid4().hex, goal="Review two roles", mode=skill.mode,
                skill_id=skill.id, skill_snapshot=skill.summary(), actions=[])
            prepared = await prepare_proposal_plan(run_id=run["id"], title="Reviewed roles",
                intents=[{"id": f"job-{i}", "operation": "triage_job", "args": {"job_id": job.id, "status": "picked"},
                          "summary": "Keep the reviewed role"} for i, job in enumerate(jobs)],
                groups=[{"title": f"Review role {i}", "node_ids": [f"job-{i}"]} for i in range(2)])
            plan = prepared["plan"]
            first, sibling = plan["groups"]
            decision_id = "decision_" + uuid.uuid4().hex
            kwargs = dict(plan_digest=plan["digest"], group_digest=first["digest"], decision_id=decision_id,
                          authorization_source="Bearer control-test", surface="agent_runtime_ui")
            if case == "recovery":
                await store.record_decision({"id": decision_id, "event_id": decision_id, "plan_id": plan["id"],
                    "group_id": first["id"], "decision": "approve", **{**kwargs, "authorization_source": "desktop-ui"}})
                node = first["nodes"][0]
                assert await store.claim_node(node["id"], claim_id="interrupted-control-test")
                recovered = await store.recover_executing_nodes(run["id"])
                assert recovered["needs_reconciliation"] == 1
                binding = await store.get_node_authorization(node["id"])
                assert binding["node"]["status"] == "uncertain"
                assert binding["receipt"]["effect_state"] == "unknown"
                assert await store.claim_node(node["id"], claim_id="forbidden-replay") is None
                async with database.sessions() as db:
                    assert (await db.get(Job, jobs[0].id)).triage_status != "picked"
                return
            if case == "reject":
                result = await execution.reject_group(plan["id"], first["id"], **kwargs)
                assert result["ok"], result
                current = await store.get_plan(plan["id"])
                assert current["groups"][0]["status"] == "rejected"
                assert current["groups"][1]["status"] == "pending"
                assert current["groups"][1]["nodes"][0]["attempt_count"] == 0
                async with database.sessions() as db:
                    decisions = (await db.execute(select(ProposalConfirmationDecision).where(
                        ProposalConfirmationDecision.group_id == first["id"]))).scalars().all()
                    assert len(decisions) == 1 and decisions[0].decision == "reject"
                    assert (await db.get(Job, jobs[0].id)).triage_status != "picked"
                return
            if case == "race":
                results = await asyncio.gather(
                    execution.confirm_group(plan["id"], first["id"], **kwargs),
                    execution.reject_group(plan["id"], first["id"], **{**kwargs, "decision_id": "decision_" + uuid.uuid4().hex}),
                    return_exceptions=True)
                async with database.sessions() as db:
                    decisions = (await db.execute(select(ProposalConfirmationDecision).where(
                        ProposalConfirmationDecision.group_id == first["id"]))).scalars().all()
                    assert len(decisions) == 1
                    audits = (await db.execute(select(OperationAuditLog).where(
                        OperationAuditLog.idempotency_key == first["nodes"][0]["idempotency_key"]))).scalars().all()
                    if decisions[0].decision == "approve":
                        assert len(audits) == 1 and audits[0].ok
                        assert (await db.get(Job, jobs[0].id)).triage_status == "picked"
                    else:
                        assert not audits
                        assert (await db.get(Job, jobs[0].id)).triage_status != "picked"
                assert sum(isinstance(value, dict) and value.get("ok") is True for value in results) == 1
                return
            result = await execution.confirm_group(plan["id"], first["id"], **kwargs)
            assert result["ok"], result
            assert result["receipts"][0]["effect_state"] == "committed"
            if case == "duplicate":
                replay = await execution.confirm_group(plan["id"], first["id"], **kwargs)
                assert replay["ok"] and replay["duplicate"]
                async with database.sessions() as db:
                    audits = (await db.execute(select(OperationAuditLog).where(
                        OperationAuditLog.idempotency_key == first["nodes"][0]["idempotency_key"]))).scalars().all()
                    assert len(audits) == 1 and audits[0].ok
                    assert (await db.get(Job, jobs[0].id)).triage_status == "picked"
            else:
                current = result.get("successor_plan") or await store.get_plan(plan["id"])
                pending = [group for group in current["groups"] if group["status"] == "pending"]
                assert len(pending) == 1
                assert pending[0]["nodes"][0]["args"]["job_id"] == jobs[1].id
                assert pending[0]["nodes"][0]["attempt_count"] == 0
                async with database.sessions() as db:
                    assert (await db.get(Job, jobs[1].id)).triage_status != "picked"
        finally:
            await database.close()


if __name__ == "__main__":
    unittest.main()
