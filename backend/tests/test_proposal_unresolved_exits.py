"""User exits for a group whose execution outcome is unknown.

Before this, a ``needs_reconciliation`` group disabled both approve and reject
and the only resolver needed evidence the UI could not supply, so the review
panel dead-locked. Now:

* retry = the system reconciles from durable Audit rows only, then continues
  the remaining nodes under the original approval (no effect is replayed);
* abandon = the group closes as is; remaining nodes never run and every
  unresolved node keeps an ``abandoned`` receipt.
"""

from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import func, select

from app.models.models import ProposalExecutionReceipt, ResumeSection
from test_proposal_v2_fault_acceptance import (  # noqa: F401 - fixture reuse
    _audit_rows,
    _confirm,
    _five_create_group,
    _permit_test_ui_capability,
    _scenario,
    proposal_v2_db,
)


async def _crash(monkeypatch, plan, group, crash_point):
    import app.ops as ops
    from app.services import proposal_plan_store

    if crash_point == "audit_finalize":
        async def fail_after_business_commit(*_args, **_kwargs):
            raise ops.OperationAuditError("fault after commit before completed audit")

        with monkeypatch.context() as fault:
            fault.setattr(ops, "_complete_authorized_audit", fail_after_business_commit)
            assert (await _confirm(plan, group))["ok"] is False
        return
    real_checkpoint = proposal_plan_store.checkpoint_node

    async def fail_before_receipt(*args, **kwargs):
        if kwargs.get("status") == "completed":
            raise RuntimeError("fault after completed audit before receipt")
        return await real_checkpoint(*args, **kwargs)

    with monkeypatch.context() as fault:
        fault.setattr(proposal_plan_store, "checkpoint_node", fail_before_receipt)
        execution = __import__("app.services.proposal_plan_execution", fromlist=["*"])
        fault.setattr(execution, "checkpoint_node", fail_before_receipt)
        with pytest.raises(RuntimeError):
            await _confirm(plan, group)


async def _section_count(database, resume_id, title):
    async with database.sessions() as db:
        return await db.scalar(select(func.count()).select_from(ResumeSection).where(
            ResumeSection.resume_id == resume_id, ResumeSection.title == title))


def test_retry_reconciles_from_completed_audit_and_releases_the_rest_without_replay(proposal_v2_db, monkeypatch):
    async def run():
        from app.services import proposal_plan_store
        from app.services.proposal_plan_execution import resolve_unresolved_group

        _permit_test_ui_capability(monkeypatch)
        seed, _intents, _groups, run_id, plan = await _scenario(proposal_v2_db)
        group = _five_create_group(plan)
        await _crash(monkeypatch, plan, group, "receipt_checkpoint")
        await proposal_v2_db.restart()
        await proposal_plan_store.recover_executing_nodes(run_id=run_id)
        first = group["nodes"][0]
        assert (await proposal_plan_store.get_node_authorization(first["id"]))["group"]["status"] == "needs_reconciliation"

        result = await resolve_unresolved_group(
            plan["id"], group["id"], action="retry", group_digest=group["digest"], surface="agent_runtime_ui")
        assert result["ok"] is True and result["resolved"] is True, result
        # The crashed node is proven by its Audit row and never re-executed;
        # the rest cannot chain onto an effect without a source witness, so
        # they are released (not run) for a fresh proposal.
        assert result["group"]["status"] == "rejected"
        assert result["group"]["pause_reason"].startswith("Reconciled")
        statuses = {node["id"]: node["status"] for node in result["group"]["nodes"]}
        assert statuses[first["id"]] == "completed"
        assert first["id"] in result["resolved_node_ids"]
        assert await _section_count(proposal_v2_db, seed["resume_id"], first["args"]["title"]) == 1
        for node in group["nodes"][1:]:
            assert statuses[node["id"]] == "rejected"
            if node["operation"] == "create_resume_section":
                assert await _section_count(proposal_v2_db, seed["resume_id"], node["args"]["title"]) == 0
        assert len(await _audit_rows(proposal_v2_db, group["nodes"])) == 1
        async with proposal_v2_db.sessions() as db:
            reconciled = (await db.execute(select(ProposalExecutionReceipt).where(
                ProposalExecutionReceipt.node_id == first["id"],
                ProposalExecutionReceipt.status == "reconciled",
                ProposalExecutionReceipt.effect_state == "committed"))).scalars().all()
        assert len(reconciled) == 1
        # Retrying again is a no-op on the closed group.
        again = await resolve_unresolved_group(
            plan["id"], group["id"], action="retry", group_digest=group["digest"], surface="agent_runtime_ui")
        assert again["group"]["status"] == "rejected"
        assert len(await _audit_rows(proposal_v2_db, group["nodes"])) == 1

    asyncio.run(run())


def test_retry_without_trustworthy_evidence_stays_unresolved_then_abandon_keeps_state(proposal_v2_db, monkeypatch):
    async def run():
        from app.services import proposal_plan_store
        from app.services.proposal_plan_execution import resolve_unresolved_group

        _permit_test_ui_capability(monkeypatch)
        seed, _intents, _groups, run_id, plan = await _scenario(proposal_v2_db)
        group = _five_create_group(plan)
        first, sibling = group["nodes"][:2]
        await _crash(monkeypatch, plan, group, "audit_finalize")
        await proposal_v2_db.restart()
        await proposal_plan_store.recover_executing_nodes(run_id=run_id)

        retry = await resolve_unresolved_group(
            plan["id"], group["id"], action="retry", group_digest=group["digest"], surface="agent_runtime_ui")
        assert retry["ok"] is True and retry["resolved"] is False
        assert retry["group"]["status"] == "needs_reconciliation"
        assert first["id"] in retry["unresolved_node_ids"]

        abandon = await resolve_unresolved_group(
            plan["id"], group["id"], action="abandon", group_digest=group["digest"], surface="agent_runtime_ui")
        assert abandon["ok"] is True and abandon["resolved"] is True
        assert abandon["group"]["status"] == "rejected"
        assert first["id"] in abandon["abandoned_node_ids"]
        # Current data is kept as is: the first effect stays, siblings never ran.
        assert await _section_count(proposal_v2_db, seed["resume_id"], first["args"]["title"]) == 1
        assert await _section_count(proposal_v2_db, seed["resume_id"], sibling["args"]["title"]) == 0
        statuses = {node["id"]: node["status"] for node in abandon["group"]["nodes"]}
        assert statuses[first["id"]] == "uncertain"
        assert statuses[sibling["id"]] == "rejected"
        async with proposal_v2_db.sessions() as db:
            receipts = (await db.execute(select(ProposalExecutionReceipt).where(
                ProposalExecutionReceipt.node_id == first["id"],
                ProposalExecutionReceipt.status == "abandoned"))).scalars().all()
        assert len(receipts) == 1

        # Abandon is idempotent; a later retry cannot revive the group.
        again = await resolve_unresolved_group(
            plan["id"], group["id"], action="abandon", group_digest=group["digest"], surface="agent_runtime_ui")
        assert again["ok"] is True and again["group"]["status"] == "rejected"
        revived = await resolve_unresolved_group(
            plan["id"], group["id"], action="retry", group_digest=group["digest"], surface="agent_runtime_ui")
        assert revived["group"]["status"] == "rejected"
        assert await _section_count(proposal_v2_db, seed["resume_id"], sibling["args"]["title"]) == 0

    asyncio.run(run())


def test_exits_refuse_a_pending_group_and_a_changed_digest(proposal_v2_db, monkeypatch):
    async def run():
        from app.services.proposal_plan_execution import resolve_unresolved_group

        _permit_test_ui_capability(monkeypatch)
        _seed, _intents, _groups, _run_id, plan = await _scenario(proposal_v2_db)
        group = _five_create_group(plan)
        pending = await resolve_unresolved_group(
            plan["id"], group["id"], action="abandon", group_digest=group["digest"], surface="agent_runtime_ui")
        assert pending["ok"] is False
        stale = await resolve_unresolved_group(
            plan["id"], group["id"], action="retry", group_digest="0" * 64, surface="agent_runtime_ui")
        assert stale["ok"] is False

    asyncio.run(run())


def test_reconciliation_route_requires_desktop_capability():
    from fastapi.testclient import TestClient

    from app.main import app

    client = TestClient(app)
    response = client.post(
        f"/api/agent/plans/plan_{'a' * 32}/groups/group_{'b' * 32}/reconciliation",
        json={"action": "abandon", "group_digest": "c" * 64},
        headers={"Authorization": "Bearer not-the-desktop"},
    )
    assert response.status_code == 403
