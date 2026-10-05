"""Refresh-time fault acceptance for Proposal Plan revisions.

These cases use real resume Operations and persistent receipts/audits. They do
not create a replacement reasoning session or authorize the refreshed groups.
"""

from __future__ import annotations

import asyncio
import copy
from datetime import datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import func, select

from app.models.models import (
    AgentRunRecord,
    OperationAuditLog,
    ProposalConfirmationDecision,
    ProposalExecutionReceipt,
    Resume,
    ResumeSection,
)
from app.services.proposal_plan_builder import PlanValidationError, build_plan
from proposal_v2_fixtures import make_db, resume_mutation_intents, seed_resume


@pytest.fixture
def refresh_db(tmp_path, monkeypatch):
    database = make_db(tmp_path, monkeypatch)
    asyncio.run(database.start(create_schema=True))
    yield database
    asyncio.run(database.close())


def _permit_test_ui(monkeypatch) -> None:
    import importlib

    capability = importlib.import_module("app.services.ui_approval_capability")
    allow = lambda value: value == "Bearer proposal-refresh-test-capability"
    monkeypatch.setattr(capability, "accepts_authorization", allow)
    execution = importlib.import_module("app.services.proposal_plan_execution")
    if hasattr(execution, "accepts_authorization"):
        monkeypatch.setattr(execution, "accepts_authorization", allow)


async def _plan(database):
    from app.services import agent_run_state, proposal_plan_sources, proposal_plan_store

    seed = await seed_resume(database)
    intents, groups = resume_mutation_intents(seed)
    run_id = f"run_{uuid4().hex[:16]}"
    await agent_run_state.create_agent_run(
        conversation_id=f"proposal-refresh-{run_id}",
        goal="Review and update the isolated resume",
        mode="proposal_plan_refresh_fault_fixture",
        skill_id="tailor_resume",
        actions=[],
        run_id=run_id,
    )
    captured = await proposal_plan_sources.capture_sources(intents)
    plan = build_plan(captured, run_id=run_id, title="Refreshable resume plan", groups=groups)
    plan = await proposal_plan_store.create_plan(plan)
    await agent_run_state.sync_proposal_plan_state(
        run_id, event_type="proposal.plan_ready", payload={"plan_id": plan["id"]}
    )
    return seed, run_id, plan


async def _two_resume_plan(database):
    from app.models.models import Profile, Resume, ResumeSection
    from app.services import agent_run_state, proposal_plan_sources, proposal_plan_store

    seed = await seed_resume(database)
    async with database.sessions() as db:
        profile = await db.get(Profile, seed["profile_id"])
        other_resume = Resume(
            user_name=profile.name,
            title="Independent refresh race resume",
            source_mode="manual",
            is_primary=False,
            source_profile_id=profile.id,
        )
        db.add(other_resume)
        await db.flush()
        db.add(
            ResumeSection(
                resume_id=other_resume.id,
                section_type="project",
                title="Independent baseline section",
                sort_order=0,
                content_json=[{"name": "Baseline", "description": "Unchanged source"}],
            )
        )
        await db.commit()
        other_resume_id = other_resume.id
    intents = [
        {
            "id": "resume-a-completed-node",
            "operation": "create_resume_section",
            "args": {
                "resume_id": seed["resume_id"],
                "section_type": "project",
                "title": "Completed prefix changes Resume A",
                "sort_order": 8,
                "visible": True,
                "content_json": [{"name": "Prefix A", "description": "Real completed prefix"}],
            },
            "summary": "Write Resume A",
        },
        {
            "id": "resume-b-pending-node",
            "operation": "create_resume_section",
            "args": {
                "resume_id": other_resume_id,
                "section_type": "project",
                "title": "Pending group targets Resume B",
                "sort_order": 1,
                "visible": True,
                "content_json": [{"name": "Pending B", "description": "Independent source"}],
            },
            "summary": "Write Resume B",
        },
    ]
    groups = [
        {
            "id": "resume-a-prefix",
            "title": "Completed Resume A prefix",
            "rationale": "The first group changes only Resume A.",
            "node_ids": [intents[0]["id"]],
        },
        {
            "id": "resume-b-pending",
            "title": "Review independent Resume B change",
            "rationale": "This group binds a different untouched Resume source.",
            "node_ids": [intents[1]["id"]],
        },
    ]
    run_id = f"run_{uuid4().hex[:16]}"
    await agent_run_state.create_agent_run(
        conversation_id=f"proposal-refresh-race-{run_id}",
        goal="Race a pending group decision against source refresh",
        mode="proposal_plan_refresh_fault_fixture",
        skill_id="tailor_resume",
        actions=[],
        run_id=run_id,
    )
    captured = await proposal_plan_sources.capture_sources(intents)
    plan = build_plan(captured, run_id=run_id, title="Independent Resume refresh race", groups=groups)
    plan = await proposal_plan_store.create_plan(plan)
    await agent_run_state.sync_proposal_plan_state(
        run_id, event_type="proposal.plan_ready", payload={"plan_id": plan["id"]}
    )
    return seed, other_resume_id, run_id, plan


def _decision(plan: dict, group: dict) -> dict:
    decision_id = f"decision_{uuid4().hex}"
    return {
        "id": decision_id,
        "event_id": decision_id,
        "plan_id": plan["id"],
        "group_id": group["id"],
        "plan_digest": plan["digest"],
        "group_digest": group["digest"],
        "decision": "approve",
        "authorization_source": "desktop-ui",
        "surface": "agent_runtime_ui",
    }


async def _record_test_approval(plan: dict, group: dict) -> dict:
    from app.services.proposal_plan_store import record_decision
    from app.services.ui_approval_capability import accepts_authorization

    assert accepts_authorization("Bearer proposal-refresh-test-capability")
    return await record_decision(_decision(plan, group))


async def _approve(plan: dict, group: dict, decision_id: str | None = None) -> dict:
    from app.services.proposal_plan_execution import confirm_group

    return await confirm_group(
        plan["id"],
        group["id"],
        plan_digest=plan["digest"],
        group_digest=group["digest"],
        decision_id=decision_id or f"decision_{uuid4().hex}",
        authorization_source="Bearer proposal-refresh-test-capability",
        surface="agent_runtime_ui",
    )


def _pause_automatic_refresh(monkeypatch):
    from app.services import proposal_plan_refresh

    original = proposal_plan_refresh.refresh_unexecuted_groups

    async def hold_for_fault_injection(_plan_id):
        return None

    monkeypatch.setattr(
        proposal_plan_refresh, "refresh_unexecuted_groups", hold_for_fault_injection
    )
    return proposal_plan_refresh, original


async def _audit_rows(database, nodes: list[dict]) -> list[OperationAuditLog]:
    keys = [node["idempotency_key"] for node in nodes]
    async with database.sessions() as db:
        return list(
            (
                await db.execute(
                    select(OperationAuditLog).where(OperationAuditLog.idempotency_key.in_(keys))
                )
            ).scalars().all()
        )


async def _completed_first_group(database, monkeypatch):
    _permit_test_ui(monkeypatch)
    seed, run_id, plan = await _plan(database)
    group = plan["groups"][0]
    result = await _approve(plan, group)
    assert result["ok"] is True, result
    successor_id = result.get("successor_plan_id")
    assert successor_id, "A completed prefix should refresh its untouched remainder"
    from app.services.proposal_plan_store import get_plan

    successor = await get_plan(successor_id)
    assert successor is not None
    return seed, run_id, plan, group, result, successor


def test_refresh_creates_new_pending_revision_without_decisions_and_preserves_run_lease(
    refresh_db, monkeypatch
):
    async def run():
        from app.models.models import AgentRunRecord
        from app.services import agent_run_state, proposal_plan_refresh, proposal_plan_store
        from app.services.proposal_plan_builder import canonical_json_bytes

        _permit_test_ui(monkeypatch)
        seed, run_id, plan = await _plan(refresh_db)
        original_completed = plan["groups"][0]
        old_pending_groups = plan["groups"][1:]
        old_pending_intents = sorted(
            (node["operation"], canonical_json_bytes(node["args"]))
            for group in old_pending_groups
            for node in group["nodes"]
        )
        old_first_pending_versions = copy.deepcopy(old_pending_groups[0]["nodes"][0]["source_versions"])
        automatic_refresh, original_refresh = _pause_automatic_refresh(monkeypatch)
        result = await _approve(plan, original_completed)
        assert result["ok"] is True, result
        assert result.get("successor_plan_id") is None
        monkeypatch.setattr(
            automatic_refresh, "refresh_unexecuted_groups", original_refresh
        )

        # The original reasoning host may still own a valid Run lease while the
        # completed prefix refreshes only the never-authorized remainder.
        lease_expiry = datetime.now() + timedelta(minutes=10)
        async with refresh_db.sessions() as db:
            run_row = await db.get(AgentRunRecord, plan["run_id"])
            run_row.lease_id = "reasoning-lease-preserved"
            run_row.lease_expires_at = lease_expiry
            run_row.harness_name = "codex"
            run_row.harness_session_id = "original-session-preserved"
            await db.commit()
        # Capture persisted completed effects before refresh; compare these
        # exact IDs against the successor replacement transaction afterward.
        old_plan_before = await proposal_plan_store.get_plan(plan["id"])
        completed_before = old_plan_before["groups"][0]
        pre_refresh_effects = {
            node["id"]: (
                node["idempotency_key"],
                node["effect_identity"],
                node["receipt_id"],
                tuple(node["receipt_ids"]),
            )
            for node in completed_before["nodes"]
        }
        before_decisions = {
            node["id"]: (await proposal_plan_store.get_node_authorization(node["id"]))[
                "decision"
            ]["id"]
            for node in completed_before["nodes"]
        }
        before_audits = await _audit_rows(refresh_db, completed_before["nodes"])
        successor = await proposal_plan_refresh.refresh_unexecuted_groups(plan["id"])
        assert successor is not None
        successor_id = successor["id"]
        successor = await proposal_plan_store.get_plan(successor_id)
        assert successor["run_id"] == plan["run_id"]
        assert successor["revision"] == plan["revision"] + 1
        assert successor["lineage_id"] == plan["lineage_id"]
        assert successor["parent_plan_id"] == plan["id"]
        assert successor["status"] == "sealed"
        assert len(successor["groups"]) == 3
        assert all(group["status"] == "pending" for group in successor["groups"])
        successor_nodes = [node for group in successor["groups"] for node in group["nodes"]]
        new_pending_intents = sorted(
            (node["operation"], canonical_json_bytes(node["args"])) for node in successor_nodes
        )
        assert new_pending_intents == old_pending_intents
        assert all(node["status"] == "pending" and node["attempt_count"] == 0 for node in successor_nodes)
        assert all(node.get("receipt_id") is None for node in successor_nodes)
        assert successor_nodes[0]["source_versions"] != old_first_pending_versions

        old_plan = await proposal_plan_store.get_plan(plan["id"])
        assert old_plan["status"] == "completed"
        completed_old = old_plan["groups"][0]
        assert completed_old["status"] == "completed"
        after_effects = {
            node["id"]: (node["idempotency_key"], node["effect_identity"], node["receipt_id"])
            for node in old_plan["groups"][0]["nodes"]
        }
        assert after_effects == {
            node_id: effect[:3] for node_id, effect in pre_refresh_effects.items()
        }
        assert {
            node["id"]: tuple(node["receipt_ids"])
            for node in completed_old["nodes"]
        } == {
            node_id: effect[3] for node_id, effect in pre_refresh_effects.items()
        }
        after_decisions = {
            node["id"]: (await proposal_plan_store.get_node_authorization(node["id"]))[
                "decision"
            ]["id"]
            for node in completed_old["nodes"]
        }
        assert after_decisions == before_decisions
        after_audits = await _audit_rows(refresh_db, completed_old["nodes"])
        assert sorted((row.id, row.status, row.idempotency_key) for row in after_audits) == sorted(
            (row.id, row.status, row.idempotency_key) for row in before_audits
        )
        for node in successor_nodes:
            binding = await proposal_plan_store.get_node_authorization(node["id"])
            assert binding["decision"] is None
            assert binding["node"]["receipt_id"] is None
        async with refresh_db.sessions() as db:
            run_row = await db.get(AgentRunRecord, run_id)
            assert run_row.lease_id == "reasoning-lease-preserved"
            assert run_row.lease_expires_at == lease_expiry
            assert run_row.harness_name == "codex"
            assert run_row.harness_session_id == "original-session-preserved"

        await refresh_db.restart()
        projected = await agent_run_state.load_agent_run(run_id)
        assert projected["proposal_authority"] == "proposal-plan-v2"
        projected_successor = next(
            item for item in projected["proposal_plans"] if item["id"] == successor_id
        )
        assert all(group["status"] == "pending" for group in projected_successor["groups"])
        assert len(await _audit_rows(refresh_db, original_completed["nodes"])) == 5
        assert len(await proposal_plan_store.list_plans(run_id=run_id)) == 2

    asyncio.run(run())


def test_old_pending_group_digest_cannot_approve_after_refresh(refresh_db, monkeypatch):
    async def run():
        from app.services import proposal_plan_store

        seed, _run_id, original, _completed, result, successor = await _completed_first_group(
            refresh_db, monkeypatch
        )
        old_pending = original["groups"][1]
        new_section_count = await _resume_section_count(refresh_db, seed["resume_id"])
        original_audits = await _audit_rows(refresh_db, original["groups"][0]["nodes"])
        rejected = await _approve(original, old_pending)
        assert rejected["ok"] is False
        assert rejected.get("successor_plan_id") in {None, successor["id"]}
        old_group = await _group_by_id(proposal_plan_store, original["id"], old_pending["id"])
        assert old_group["status"] in {"replaced", "stale", "blocked"}
        async with refresh_db.sessions() as db:
            pending_decisions = await db.scalar(
                select(func.count()).select_from(ProposalConfirmationDecision).where(
                    ProposalConfirmationDecision.plan_id == original["id"],
                    ProposalConfirmationDecision.group_id == old_pending["id"],
                )
            )
        assert pending_decisions == 0
        assert await _resume_section_count(refresh_db, seed["resume_id"]) == new_section_count
        assert len(await _audit_rows(refresh_db, old_pending["nodes"])) == 0
        assert len(await _audit_rows(refresh_db, original["groups"][0]["nodes"])) == len(original_audits)
        assert result["successor_plan_id"] == successor["id"]

    asyncio.run(run())


def test_concurrent_refresh_and_approve_have_one_store_cas_winner(refresh_db, monkeypatch):
    async def run():
        from app.services import proposal_plan_execution, proposal_plan_refresh, proposal_plan_store

        _permit_test_ui(monkeypatch)
        _seed, other_resume_id, run_id, plan = await _two_resume_plan(refresh_db)
        automatic_refresh, original_refresh = _pause_automatic_refresh(monkeypatch)
        first = await _approve(plan, plan["groups"][0])
        assert first["ok"] is True
        monkeypatch.setattr(
            automatic_refresh, "refresh_unexecuted_groups", original_refresh
        )
        pending_group = plan["groups"][1]

        # Resume B is untouched by the completed Resume A prefix, so this
        # displayed decision and refresh may race the same durable pending CAS.
        async def stop_before_registry_dispatch(plan_id, group_id, *, surface):
            current = await proposal_plan_store.get_plan(plan_id)
            group = next(item for item in current["groups"] if item["id"] == group_id)
            return {
                "ok": False,
                "plan": current,
                "group": group,
                "receipts": [],
                "errors": ["refresh race fixture stops after the decision CAS"],
                "duplicate": False,
            }

        monkeypatch.setattr(
            proposal_plan_execution, "dispatch_approved_group", stop_before_registry_dispatch
        )

        async def refresh_race():
            try:
                return await proposal_plan_refresh.refresh_unexecuted_groups(plan["id"])
            except Exception as exc:
                return exc

        async def approve_race():
            try:
                return await _approve(
                    plan, pending_group, decision_id=f"decision_{uuid4().hex}"
                )
            except Exception as exc:
                return exc

        outcomes = await asyncio.gather(
            refresh_race(), approve_race(), return_exceptions=True
        )
        refresh_outcome, approve_outcome = outcomes
        assert not isinstance(approve_outcome, Exception)
        successor_candidates = [
            item
            for item in await proposal_plan_store.list_plans(run_id=run_id)
            if item.get("parent_plan_id") == plan["id"]
        ]
        binding = await proposal_plan_store.get_node_authorization(
            pending_group["nodes"][0]["id"]
        )
        refresh_won = len(successor_candidates) == 1
        approve_won = (
            isinstance(binding.get("decision"), dict)
            and binding["decision"].get("decision") == "approve"
        )
        assert refresh_won != approve_won
        if isinstance(refresh_outcome, dict):
            assert refresh_won is True
            assert refresh_outcome["id"] == successor_candidates[0]["id"]
        else:
            assert refresh_won is False
        assert len(await proposal_plan_store.list_plans(run_id=run_id)) == (2 if refresh_won else 1)
        assert len(await _audit_rows(refresh_db, pending_group["nodes"])) == 0
        assert len(await _audit_rows(refresh_db, plan["groups"][0]["nodes"])) == 1
        assert await _resume_section_count(refresh_db, other_resume_id) == 1

    asyncio.run(run())


async def _resume_section_count(database, resume_id: int) -> int:
    async with database.sessions() as db:
        return int(
            await db.scalar(
                select(func.count()).select_from(ResumeSection).where(ResumeSection.resume_id == resume_id)
            )
            or 0
        )


async def _group_by_id(store, plan_id: str, group_id: str) -> dict:
    plan = await store.get_plan(plan_id)
    return next(group for group in plan["groups"] if group["id"] == group_id)


def test_foreign_resume_edit_prevents_refresh_and_is_never_overwritten(refresh_db, monkeypatch):
    async def run():
        from app.models.models import Resume
        from app.services import proposal_plan_store

        _permit_test_ui(monkeypatch)
        seed, _run_id, plan = await _plan(refresh_db)
        proposal_plan_refresh, original_refresh = _pause_automatic_refresh(monkeypatch)
        confirmed = await _approve(plan, plan["groups"][0])
        assert confirmed["ok"] is True
        assert confirmed.get("successor_plan_id") is None
        monkeypatch.setattr(
            proposal_plan_refresh, "refresh_unexecuted_groups", original_refresh
        )
        old_pending_versions = copy.deepcopy(plan["groups"][1]["nodes"][0]["source_versions"])
        async with refresh_db.sessions() as db:
            resume = await db.get(Resume, seed["resume_id"])
            resume.summary = "Foreign user edit after the completed prefix"
            await db.commit()

        with pytest.raises(PlanValidationError):
            await proposal_plan_refresh.refresh_unexecuted_groups(plan["id"])
        assert len(await proposal_plan_store.list_plans(run_id=plan["run_id"])) == 1
        unchanged_plan = await proposal_plan_store.get_plan(plan["id"])
        assert unchanged_plan["groups"][1]["nodes"][0]["source_versions"] == old_pending_versions
        async with refresh_db.sessions() as db:
            resume = await db.get(Resume, seed["resume_id"])
            assert resume.summary == "Foreign user edit after the completed prefix"
        assert len(await _audit_rows(refresh_db, plan["groups"][0]["nodes"])) == 5
        assert len(await _audit_rows(refresh_db, plan["groups"][1]["nodes"])) == 0

    asyncio.run(run())


@pytest.mark.parametrize(
    "terminal_status", ["cancelled", "failed", "completed", "needs_reconciliation"]
)
def test_terminal_or_reconciliation_run_cannot_create_a_successor(refresh_db, monkeypatch, terminal_status):
    async def run():
        from app.models.models import AgentRunRecord
        from app.services import proposal_plan_refresh, proposal_plan_store

        _permit_test_ui(monkeypatch)
        seed, run_id, plan = await _plan(refresh_db)
        _refresh_module, original_refresh = _pause_automatic_refresh(monkeypatch)
        confirmed = await _approve(plan, plan["groups"][0])
        assert confirmed["ok"] is True
        monkeypatch.setattr(
            proposal_plan_refresh, "refresh_unexecuted_groups", original_refresh
        )
        async with refresh_db.sessions() as db:
            run_row = await db.get(AgentRunRecord, run_id)
            run_row.status = terminal_status
            await db.commit()

        try:
            successor = await proposal_plan_refresh.refresh_unexecuted_groups(plan["id"])
        except (
            PlanValidationError,
            proposal_plan_store.ProposalPlanConflictError,
            proposal_plan_store.ProposalStaleSnapshotError,
        ):
            successor = None
        assert successor is None
        assert len(await proposal_plan_store.list_plans(run_id=run_id)) == 1
        old = await proposal_plan_store.get_plan(plan["id"])
        assert old["groups"][0]["status"] == "completed"
        assert all(group["status"] == "pending" for group in old["groups"][1:])
        assert len(await _audit_rows(refresh_db, plan["groups"][0]["nodes"])) == 5
        assert await _resume_section_count(refresh_db, seed["resume_id"]) == 8

    asyncio.run(run())


@pytest.mark.parametrize("remainder_state", ["claimed", "unknown", "partial"])
def test_claimed_or_uncertain_remainder_cannot_refresh_to_a_new_effect_key(
    refresh_db, monkeypatch, remainder_state
):
    async def run():
        from app.services import proposal_plan_refresh, proposal_plan_store

        _permit_test_ui(monkeypatch)
        seed, run_id, plan = await _plan(refresh_db)
        _refresh_module, original_refresh = _pause_automatic_refresh(monkeypatch)
        completed = await _approve(plan, plan["groups"][0])
        assert completed["ok"] is True
        monkeypatch.setattr(
            proposal_plan_refresh, "refresh_unexecuted_groups", original_refresh
        )
        pending_group = plan["groups"][1]
        pending_node = pending_group["nodes"][0]
        before = await proposal_plan_store.get_node_authorization(pending_node["id"])
        await _record_test_approval(plan, pending_group)
        claim = await proposal_plan_store.claim_node(
            pending_node["id"], claim_id=f"refresh-fault-{uuid4().hex}", lease_seconds=60
        )
        assert claim is not None
        if remainder_state in {"unknown", "partial"}:
            checkpoint = await proposal_plan_store.checkpoint_node(
                pending_node["id"],
                claim_id=claim["claim_id"],
                status="uncertain",
                effect_state=remainder_state,
                result={"fault_fixture": remainder_state},
                audit_ref="",
            )
            assert checkpoint["receipt"]["effect_state"] == remainder_state

        successor = await proposal_plan_refresh.refresh_unexecuted_groups(plan["id"])
        assert successor is None
        assert len(await proposal_plan_store.list_plans(run_id=run_id)) == 1
        after = await proposal_plan_store.get_node_authorization(pending_node["id"])
        assert after["node"]["idempotency_key"] == before["node"]["idempotency_key"]
        assert after["node"]["effect_identity"] == before["node"]["effect_identity"]
        assert len(await _audit_rows(refresh_db, pending_group["nodes"])) == 0
        assert await _resume_section_count(refresh_db, seed["resume_id"]) == 8

    asyncio.run(run())


@pytest.mark.parametrize("corruption", ["receipt", "audit"])
def test_refresh_refuses_corrupt_completed_receipt_or_audit(refresh_db, monkeypatch, corruption):
    async def run():
        from app.models.models import OperationAuditLog, ProposalExecutionReceipt
        from app.services import proposal_plan_refresh, proposal_plan_store

        _permit_test_ui(monkeypatch)
        seed, _run_id, plan = await _plan(refresh_db)
        _refresh_module, original_refresh = _pause_automatic_refresh(monkeypatch)
        confirmed = await _approve(plan, plan["groups"][0])
        assert confirmed["ok"] is True
        monkeypatch.setattr(
            proposal_plan_refresh, "refresh_unexecuted_groups", original_refresh
        )
        node = plan["groups"][0]["nodes"][0]
        binding = await proposal_plan_store.get_node_authorization(node["id"])
        async with refresh_db.sessions() as db:
            if corruption == "receipt":
                receipt = await db.get(ProposalExecutionReceipt, binding["node"]["receipt_id"])
                receipt.audit_ref = "999999999"
            else:
                audit = await db.get(OperationAuditLog, int(binding["node"]["audit_ref"]))
                audit.status = "failed"
                audit.ok = False
            await db.commit()

        try:
            successor = await proposal_plan_refresh.refresh_unexecuted_groups(plan["id"])
        except PlanValidationError:
            successor = None
        assert successor is None
        assert len(await proposal_plan_store.list_plans(run_id=plan["run_id"])) == 1
        assert await _resume_section_count(refresh_db, seed["resume_id"]) == 8
        assert len(await _audit_rows(refresh_db, plan["groups"][1]["nodes"])) == 0

    asyncio.run(run())
