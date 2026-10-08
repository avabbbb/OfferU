"""Behavioral fault acceptance for the Proposal v2 migration seam.

Intentional failure points exercised here:

* args, input-schema, source-version, display, and digest tampering must fail
  snapshot verification before a protected operation can execute;
* replaying one decision id with a changed payload must fail closed;
* a paused/uncertain group must block an old action_id confirmation path;
* concurrent group confirmation has one business effect per node, while an
  expired claim cannot publish a late receipt;
* business-commit/audit-finalize and audit/receipt crash windows recover as
  unknown and never replay automatically;
* continuation delivery failures preserve completed business outcomes and can
  retry only the original Run's receipt outbox;
* pending, executing, completed, failed, rejected, and uncertain old steps
  survive migration, backup/restore, and process-style database reopen.

All effects use app.ops.OPERATIONS against a temporary file-backed SQLite DB.
The fake UI capability and continuation callback are fault-boundary fixtures;
they are not human approval or real Agent-native acceptance.
"""

from __future__ import annotations

import asyncio
import copy
import json
import sqlite3
from contextlib import closing
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import OperationalError

from app.database import CURRENT_SCHEMA_VERSION
from app.models.models import OperationAuditLog, ResumeSection
from app.ops import OPERATIONS
from app.services.agent_skill_registry import resolve_skill
from app.services.proposal_plan_builder import PlanValidationError, build_plan, verify_plan_snapshot
from proposal_v2_fixtures import (
    make_db,
    resume_mutation_intents,
    seed_legacy_v5_run_statuses,
    seed_resume,
)


@pytest.fixture
def proposal_v2_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    database = make_db(tmp_path, monkeypatch)
    asyncio.run(database.start(create_schema=True))
    yield database
    asyncio.run(database.close())


def _permit_test_ui_capability(monkeypatch: pytest.MonkeyPatch) -> None:
    """Allow only a synthetic token; this does not simulate a human action."""

    import importlib

    capability = importlib.import_module("app.services.ui_approval_capability")
    allow = lambda value: value == "Bearer proposal-v2-test-capability"
    monkeypatch.setattr(capability, "accepts_authorization", allow)
    for module_name in (
        "app.services.proposal_plan_execution",
        "app.routes.main_agent",
        "app.routes.bridge",
    ):
        module = importlib.import_module(module_name)
        if hasattr(module, "accepts_authorization"):
            monkeypatch.setattr(module, "accepts_authorization", allow)


async def _scenario(database):
    seed = await seed_resume(database)
    intents, groups = resume_mutation_intents(seed)
    run_id, plan = await _persist_plan(
        database, intents, groups, title="Reviewed resume plan"
    )
    return seed, intents, groups, run_id, plan


async def _persist_plan(database, intents, groups, *, title: str):
    from app.services import agent_run_state, proposal_plan_sources, proposal_plan_store

    run_id = f"run_{uuid4().hex[:16]}"
    await agent_run_state.create_agent_run(
        conversation_id=f"proposal-v2-{run_id}",
        goal=title,
        mode="proposal_v2_fault_fixture",
        skill_id="tailor_resume",
        actions=[],
        run_id=run_id,
    )
    captured = await proposal_plan_sources.capture_sources(intents)
    plan = build_plan(captured, run_id=run_id, title=title, groups=groups)
    await proposal_plan_store.create_plan(plan)
    await agent_run_state.sync_proposal_plan_state(
        run_id, event_type="proposal.plan_ready", payload={"plan_id": plan["id"]}
    )
    return run_id, plan


def _five_create_group(plan: dict) -> dict:
    return next(
        group
        for group in plan["groups"]
        if len(group["nodes"]) >= 5
        and all(node["operation"] == "create_resume_section" for node in group["nodes"])
    )


def _confirm_args(plan: dict, group: dict, decision_id: str | None = None) -> dict:
    return {
        "plan_digest": plan["digest"],
        "group_digest": group["digest"],
        "decision_id": decision_id or f"decision_{uuid4().hex}",
        "authorization_source": "Bearer proposal-v2-test-capability",
        "surface": "agent_runtime_ui",
    }


async def _confirm(plan: dict, group: dict, *, decision_id: str | None = None) -> dict:
    from app.services.proposal_plan_execution import confirm_group

    return await confirm_group(plan["id"], group["id"], **_confirm_args(plan, group, decision_id))


async def _audit_rows(database, nodes: list[dict]) -> list[OperationAuditLog]:
    keys = [node["idempotency_key"] for node in nodes]
    async with database.sessions() as db:
        return list(
            (await db.execute(
                select(OperationAuditLog).where(OperationAuditLog.idempotency_key.in_(keys))
            )).scalars().all()
        )


async def _audit_attempt_rows(database, node: dict) -> list[OperationAuditLog]:
    async with database.sessions() as db:
        rows = list((await db.execute(select(OperationAuditLog))).scalars().all())
    key = str(node["idempotency_key"])
    return [
        row
        for row in rows
        if row.idempotency_key == key
        or str(row.idempotency_key or "").startswith(f"{key}:attempt:")
    ]


async def _record_test_approval(plan: dict, group: dict, decision_id: str) -> dict:
    from app.services.proposal_plan_store import record_decision
    from app.services.ui_approval_capability import accepts_authorization

    assert accepts_authorization("Bearer proposal-v2-test-capability")

    return await record_decision(
        {
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
    )


@pytest.mark.parametrize("field", ["args", "schema", "source", "display", "digest"])
def test_sealed_snapshot_rejects_tampered_material(tmp_path, monkeypatch, field):
    async def run():
        database = make_db(tmp_path, monkeypatch)
        await database.start(create_schema=True)
        try:
            seed = await seed_resume(database)
            intents, groups = resume_mutation_intents(seed)
            from app.services import agent_run_state, proposal_plan_sources

            run_id = f"run_{uuid4().hex[:16]}"
            await agent_run_state.create_agent_run(
                conversation_id="proposal-v2-tamper",
                goal="Tamper fixture",
                mode="proposal_v2_fault_fixture",
                actions=[],
                run_id=run_id,
            )
            captured = await proposal_plan_sources.capture_sources(intents)
            plan = build_plan(captured, run_id=run_id, title="Tamper test", groups=groups)
            tampered = copy.deepcopy(plan)
            node = tampered["groups"][0]["nodes"][0]
            if field == "args":
                node["args"]["title"] = "Changed after display"
            elif field == "schema":
                node["input_schema"]["properties"]["title"]["description"] = "Changed schema"
            elif field == "source":
                source_key = next(iter(node["source_versions"]))
                node["source_versions"][source_key] = "f" * 64
            elif field == "display":
                node["display"]["after"] = "Unreviewed display text"
            else:
                tampered["digest"] = "0" * 64
            with pytest.raises(PlanValidationError):
                verify_plan_snapshot(tampered)
        finally:
            await database.close()

    asyncio.run(run())


def test_eighteen_real_resume_intents_form_explicit_groups_and_confirm_five_registry_nodes(
    proposal_v2_db, monkeypatch
):
    async def run():
        from app.models.models import ResumeVersion
        from app.services import proposal_plan_store

        _permit_test_ui_capability(monkeypatch)
        seed, intents, groups, run_id, plan = await _scenario(proposal_v2_db)
        flattened = [node for group in plan["groups"] for node in group["nodes"]]

        assert len(intents) == 18
        assert [len(group["nodes"]) for group in plan["groups"]] == [5, 5, 4, 4]
        assert len(groups) == 4
        assert all(node["operation"] in OPERATIONS for node in flattened)
        assert all(OPERATIONS[node["operation"]].group == "resume" for node in flattened)
        assert all(node["risk"] == "protected" for node in flattened)
        verify_plan_snapshot(plan)

        group = _five_create_group(plan)
        result = await _confirm(plan, group)
        assert result["ok"] is True, result

        async with proposal_v2_db.sessions() as db:
            section_count = await db.scalar(
                select(func.count()).select_from(ResumeSection).where(ResumeSection.resume_id == seed["resume_id"])
            )
        assert section_count == len(seed["section_ids"]) + len(group["nodes"])
        audits = await _audit_rows(proposal_v2_db, group["nodes"])
        assert len(audits) == len(group["nodes"])
        assert {row.operation for row in audits} == {"create_resume_section"}
        assert all(row.ok and row.status == "completed" for row in audits)
        assert {row.idempotency_key for row in audits} == {node["idempotency_key"] for node in group["nodes"]}

        authorizations = [
            await proposal_plan_store.get_node_authorization(node["id"])
            for node in group["nodes"]
        ]
        decision_ids = {
            auth["decision"].get("id") or auth["decision"].get("event_id")
            for auth in authorizations
        }
        assert len(decision_ids) == 1
        assert None not in decision_ids

        async with proposal_v2_db.sessions() as db:
            versions = await db.scalar(
                select(func.count()).select_from(ResumeVersion).where(ResumeVersion.resume_id == seed["resume_id"])
            )
        assert versions == 0  # Other semantic groups remain pending until reviewed.
        assert (await proposal_plan_store.get_plan(plan["id"]))["run_id"] == run_id

    asyncio.run(run())


def test_decision_id_exact_replay_is_idempotent_and_changed_payload_is_rejected(
    proposal_v2_db, monkeypatch
):
    async def run():
        from app.services import proposal_plan_store

        _permit_test_ui_capability(monkeypatch)
        _seed, _intents, _groups, _run_id, plan = await _scenario(proposal_v2_db)
        group = _five_create_group(plan)
        decision_id = f"decision_{uuid4().hex}"
        first = await _confirm(plan, group, decision_id=decision_id)
        assert first["ok"] is True
        duplicate = await _confirm(plan, group, decision_id=decision_id)
        assert duplicate["ok"] is True
        assert duplicate["duplicate"] is True

        authorization = await proposal_plan_store.get_node_authorization(group["nodes"][0]["id"])
        approved = copy.deepcopy(authorization["decision"])
        assert (approved.get("id") or approved.get("event_id")) == decision_id
        exact_replay = await proposal_plan_store.record_decision(approved)
        assert exact_replay["duplicate"] is True
        changed = {**approved, "decision": "reject"}
        with pytest.raises(proposal_plan_store.ProposalDecisionConflictError):
            await proposal_plan_store.record_decision(changed)

        audits = await _audit_rows(proposal_v2_db, group["nodes"])
        assert len(audits) == 5

    asyncio.run(run())


def test_changed_resume_source_version_invalidates_the_reviewed_group_before_execution(
    proposal_v2_db, monkeypatch
):
    async def run():
        from app.models.models import Resume

        _permit_test_ui_capability(monkeypatch)
        seed, _intents, _groups, _run_id, plan = await _scenario(proposal_v2_db)
        group = _five_create_group(plan)
        async with proposal_v2_db.sessions() as db:
            resume = await db.get(Resume, seed["resume_id"])
            resume.summary = "User edited the resume after review"
            await db.commit()

        try:
            result = await _confirm(plan, group)
        except (PlanValidationError, ValueError):
            result = {"ok": False}
        assert result["ok"] is False
        assert len(await _audit_rows(proposal_v2_db, group["nodes"])) == 0
        async with proposal_v2_db.sessions() as db:
            section_count = await db.scalar(
                select(func.count()).select_from(ResumeSection).where(ResumeSection.resume_id == seed["resume_id"])
            )
        assert section_count == len(seed["section_ids"])

    asyncio.run(run())


def test_proven_no_effect_transient_retry_keeps_original_effect_key_and_failed_audit(
    proposal_v2_db, monkeypatch
):
    async def run():
        import app.ops as ops
        from app.models.models import ProposalExecutionReceipt
        from app.services import proposal_plan_store

        _permit_test_ui_capability(monkeypatch)
        seed = await seed_resume(proposal_v2_db)
        intents, _ = resume_mutation_intents(seed)
        intent = copy.deepcopy(intents[0])
        groups = [
            {
                "id": "one-reviewed-role-section",
                "title": "One reviewed role section",
                "rationale": "Add the displayed section after transient no-effect retry.",
                "node_ids": [intent["id"]],
            }
        ]
        _run_id, plan = await _persist_plan(
            proposal_v2_db, [intent], groups, title="Retry one resume operation"
        )
        group = plan["groups"][0]
        node = group["nodes"][0]
        decision_id = f"decision_{uuid4().hex}"
        await _record_test_approval(plan, group, decision_id)
        before = await proposal_plan_store.get_node_authorization(node["id"])
        original = ops.OPERATIONS["create_resume_section"]
        calls = 0

        async def fail_once(**kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise OperationalError(
                    "injected transient before commit", {}, RuntimeError("database is busy")
                )
            return await original.fn(**kwargs)

        monkeypatch.setitem(
            ops.OPERATIONS,
            "create_resume_section",
            replace(original, fn=fail_once),
        )
        result = await _confirm(plan, group, decision_id=decision_id)
        assert result["ok"] is True, result
        assert calls == 2

        attempts = await _audit_attempt_rows(proposal_v2_db, node)
        assert len(attempts) == 2
        assert sorted(row.status for row in attempts) == ["completed", "failed"]
        assert all(row.operation == "create_resume_section" for row in attempts)
        assert node["idempotency_key"] in {row.idempotency_key for row in attempts}
        second_audit_key = next(
            row.idempotency_key
            for row in attempts
            if row.idempotency_key != node["idempotency_key"]
        )
        assert second_audit_key.startswith(f"{node['idempotency_key']}:attempt:")

        after = await proposal_plan_store.get_node_authorization(node["id"])
        assert after["node"]["idempotency_key"] == before["node"]["idempotency_key"]
        assert after["node"]["effect_identity"] == before["node"]["effect_identity"]
        assert after["decision"]["id"] == before["decision"]["id"]
        assert after["node"]["attempt_count"] == 2
        async with proposal_v2_db.sessions() as db:
            receipts = list(
                (
                    await db.execute(
                        select(ProposalExecutionReceipt)
                        .where(ProposalExecutionReceipt.node_id == node["id"])
                    .order_by(ProposalExecutionReceipt.completed_at, ProposalExecutionReceipt.id)
                    )
                ).scalars().all()
            )
        assert [receipt.effect_state for receipt in receipts] == [
            "no_effect",
            "no_effect",
            "committed",
        ]
        assert {receipt.effect_identity for receipt in receipts} == {
            before["node"]["effect_identity"]
        }
        async with proposal_v2_db.sessions() as db:
            created = await db.scalar(
                select(func.count()).select_from(ResumeSection).where(
                    ResumeSection.resume_id == seed["resume_id"],
                    ResumeSection.title == node["args"]["title"],
                )
            )
        assert created == 1

    asyncio.run(run())


@pytest.mark.parametrize("effect_state", ["unknown", "partial"])
def test_unknown_or_partial_effect_cannot_replan_or_reuse_the_approval(
    proposal_v2_db, monkeypatch, effect_state
):
    async def run():
        from app.services.proposal_plan_builder import revise_plan
        from app.services import proposal_plan_store

        _permit_test_ui_capability(monkeypatch)
        seed = await seed_resume(proposal_v2_db)
        intents, _ = resume_mutation_intents(seed)
        intent = copy.deepcopy(intents[0])
        groups = [
            {
                "id": "uncertain-resume-effect",
                "title": "Reconcile the resume effect",
                "rationale": "Unknown or partial output remains tied to the reviewed node.",
                "node_ids": [intent["id"]],
            }
        ]
        _run_id, plan = await _persist_plan(
            proposal_v2_db, [intent], groups, title="Uncertain resume effect"
        )
        group = plan["groups"][0]
        node = group["nodes"][0]
        decision_id = f"decision_{uuid4().hex}"
        await _record_test_approval(plan, group, decision_id)
        claim = await proposal_plan_store.claim_node(
            node["id"], claim_id=f"claim_{uuid4().hex}", lease_seconds=60
        )
        assert claim is not None
        checkpoint = await proposal_plan_store.checkpoint_node(
            node["id"],
            claim_id=claim["claim_id"],
            status="uncertain",
            effect_state=effect_state,
            result={"injected_effect_state": effect_state},
            audit_ref="unverified-audit-reference",
        )
        assert checkpoint["receipt"]["effect_state"] == effect_state
        before_reconciliation = await proposal_plan_store.get_node_authorization(node["id"])
        assert checkpoint["receipt"]["effect_identity"] == before_reconciliation["node"]["effect_identity"]
        candidate = revise_plan(plan, [intent], title="Do not replace uncertain history", groups=groups)
        with pytest.raises(proposal_plan_store.ProposalPlanConflictError):
            await proposal_plan_store.replace_plan(plan["id"], candidate)

        with pytest.raises(proposal_plan_store.ProposalNodeClaimConflictError):
            await proposal_plan_store.resolve_node_reconciliation(
                node["id"],
                effect_state="no_effect",
                evidence={"receipt_id": checkpoint["receipt"]["id"]},
            )
        current = await proposal_plan_store.get_node_authorization(node["id"])
        assert current["group"]["status"] == "needs_reconciliation"
        assert current["node"]["status"] == "uncertain"
        assert current["node"]["idempotency_key"] == node["idempotency_key"]
        assert current["node"]["effect_identity"] == before_reconciliation["node"]["effect_identity"]
        assert current["node"]["receipt_id"] == checkpoint["receipt"]["id"]

        duplicate = await _confirm(plan, group, decision_id=decision_id)
        assert duplicate["ok"] is False
        assert duplicate["group"]["status"] == "needs_reconciliation"
        assert len(await _audit_rows(proposal_v2_db, [node])) == 0

    asyncio.run(run())


@pytest.mark.parametrize("forgery", ["receipt", "audit_ref"])
def test_source_prefix_rejects_a_receipt_or_audit_from_another_real_node(
    proposal_v2_db, monkeypatch, forgery
):
    async def run():
        from app.models.models import ProposalExecutionReceipt, ProposalOperationNode
        from app.services import proposal_plan_execution, proposal_plan_store

        _permit_test_ui_capability(monkeypatch)
        seed = await seed_resume(proposal_v2_db)
        intents, _ = resume_mutation_intents(seed)

        donor_intent = copy.deepcopy(intents[0])
        donor_groups = [
            {
                "id": "donor-group",
                "title": "Produce a separate real receipt",
                "rationale": "The donor receipt is created by the real Registry in this isolated DB.",
                "node_ids": [donor_intent["id"]],
            }
        ]
        _donor_run, donor_plan = await _persist_plan(
            proposal_v2_db, [donor_intent], donor_groups, title="Donor operation"
        )
        donor_group = donor_plan["groups"][0]
        donor_node = donor_group["nodes"][0]
        donor_result = await _confirm(donor_plan, donor_group)
        assert donor_result["ok"] is True
        donor_binding = await proposal_plan_store.get_node_authorization(donor_node["id"])
        donor_receipt_id = donor_binding["node"]["receipt_id"]
        donor_audits = await _audit_rows(proposal_v2_db, [donor_node])
        assert len(donor_audits) == 1

        reviewed_intents = [copy.deepcopy(item) for item in intents[1:3]]
        reviewed_labels = [item["id"] for item in reviewed_intents]
        reviewed_groups = [
            {
                "id": "source-prefix-group",
                "title": "Continue only from the verified first receipt",
                "rationale": "The second node must verify receipt and audit provenance.",
                "node_ids": reviewed_labels,
            }
        ]
        _run_id, plan = await _persist_plan(
            proposal_v2_db, reviewed_intents, reviewed_groups, title="Verify source prefix"
        )
        group = plan["groups"][0]
        first_node, sibling = group["nodes"]
        real_checkpoint = proposal_plan_execution.checkpoint_node

        async def tamper_persisted_prefix(node_id, **kwargs):
            result = await real_checkpoint(node_id, **kwargs)
            if node_id == first_node["id"] and kwargs.get("status") == "completed":
                async with proposal_v2_db.sessions() as db:
                    if forgery == "receipt":
                        persisted = await db.get(ProposalOperationNode, node_id)
                        persisted.receipt_id = donor_receipt_id
                    else:
                        receipt = await db.get(
                            ProposalExecutionReceipt, result["receipt"]["id"]
                        )
                        receipt.audit_ref = str(donor_audits[0].id)
                    await db.commit()
            return result

        monkeypatch.setattr(
            proposal_plan_execution, "checkpoint_node", tamper_persisted_prefix
        )
        result = await _confirm(plan, group)
        assert result["ok"] is False, result
        assert result["group"]["status"] in {"stale", "needs_reconciliation", "paused"}
        assert result["group"]["nodes"][0]["status"] == "completed"
        assert result["group"]["nodes"][1]["status"] in {"failed", "blocked", "uncertain"}
        reviewed_audits = await _audit_rows(proposal_v2_db, [first_node, sibling])
        assert len(reviewed_audits) == 1
        assert reviewed_audits[0].operation == "create_resume_section"
        assert reviewed_audits[0].ok is True

        async with proposal_v2_db.sessions() as db:
            first_effect = await db.scalar(
                select(func.count()).select_from(ResumeSection).where(
                    ResumeSection.resume_id == seed["resume_id"],
                    ResumeSection.title == first_node["args"]["title"],
                )
            )
            sibling_effect = await db.scalar(
                select(func.count()).select_from(ResumeSection).where(
                    ResumeSection.resume_id == seed["resume_id"],
                    ResumeSection.title == sibling["args"]["title"],
                )
            )
        assert first_effect == 1
        assert sibling_effect == 0

    asyncio.run(run())


def test_batch_resume_review_is_one_registry_node_for_all_displayed_diffs(
    proposal_v2_db, monkeypatch
):
    async def run():
        from app.models.models import Resume, ResumeOptimizationProposal, ResumeSection
        from app.services import proposal_plan_store, resume_workspace

        from proposal_v2_fixtures import seed_reviewable_resume_proposal

        _permit_test_ui_capability(monkeypatch)
        seed = await seed_reviewable_resume_proposal(proposal_v2_db, "batch-first-slice")
        monkeypatch.setattr(
            resume_workspace,
            "get_pre_application_state",
            AsyncMock(return_value={"stage": "resume_proposal_ready"}),
        )
        workspace = await resume_workspace.ensure_resume_workspace(
            job_id=seed["job_id"], proposal_id=seed["proposal_id"]
        )
        async with proposal_v2_db.sessions() as db:
            proposal = await db.get(ResumeOptimizationProposal, seed["proposal_id"])
            first = proposal.diff_json[0]
            second = {
                **first,
                "change_id": "added-reviewed-project",
                "change_type": "added",
                "section_key": "project:已审核项目",
                "title": "已审核项目",
                "after": {
                    **first["after"],
                    "section_type": "project",
                    "title": "已审核项目",
                    "sort_order": 1,
                    "content_json": [{"name": "Fixture project", "description": "Reviewed project evidence"}],
                    "source_section_ids": [],
                },
            }
            proposal.diff_json = [first, second]
            await db.commit()

        intent = {
            "id": "batch-review-resume-diffs",
            "operation": "review_resume_proposal_items",
            "args": {
                "proposal_id": seed["proposal_id"],
                "resume_id": workspace["resume"]["id"],
                "change_ids": [seed["change_id"], "added-reviewed-project"],
                "action": "accept",
            },
            "summary": "Atomically accept both displayed resume changes",
            "display": {"rationale": "One displayed semantic decision covers the exact two diff IDs."},
        }
        groups = [
            {
                "id": "reviewed-resume-diff-set",
                "title": "Accept the displayed resume changes",
                "rationale": "The existing batch-review operation applies the exact displayed diff set atomically.",
                "node_ids": [intent["id"]],
            }
        ]
        _run_id, plan = await _persist_plan(
            proposal_v2_db, [intent], groups, title="Accept reviewed resume diffs"
        )
        group = plan["groups"][0]
        assert len(group["nodes"]) == 1
        assert group["nodes"][0]["operation"] == "review_resume_proposal_items"
        assert group["nodes"][0]["args"]["change_ids"] == [
            seed["change_id"],
            "added-reviewed-project",
        ]

        result = await _confirm(plan, group)
        assert result["ok"] is True, result
        authorization = await proposal_plan_store.get_node_authorization(
            group["nodes"][0]["id"]
        )
        assert authorization["decision"]["decision"] == "approve"

        async with proposal_v2_db.sessions() as db:
            proposal = await db.get(ResumeOptimizationProposal, seed["proposal_id"])
            resume = await db.get(Resume, workspace["resume"]["id"])
            review_actions = {
                review_id: item["action"]
                for review_id, item in (proposal.item_reviews_json or {}).items()
                if isinstance(item, dict) and "action" in item
            }
            assert review_actions == {
                seed["change_id"]: "accept",
                "added-reviewed-project": "accept",
            }
            assert resume.workspace_revision == workspace["resume"]["workspace_revision"] + 1
            assert len(workspace["resume"]["sections"]) == 1
            final_resume_sections = await db.execute(
                select(ResumeSection).where(ResumeSection.resume_id == resume.id)
            )
            sections = list(final_resume_sections.scalars().all())
            assert len(sections) == 2
            assert any(section.title == "已审核项目" for section in sections)

        audit = await _audit_rows(proposal_v2_db, group["nodes"])
        assert len(audit) == 1
        assert audit[0].operation == "review_resume_proposal_items"
        assert audit[0].ok is True

    asyncio.run(run())


def test_concurrent_group_confirmation_runs_each_real_operation_once(proposal_v2_db, monkeypatch):
    async def run():
        _permit_test_ui_capability(monkeypatch)
        seed, _intents, _groups, _run_id, plan = await _scenario(proposal_v2_db)
        group = _five_create_group(plan)
        decision_id = f"decision_{uuid4().hex}"
        outcomes = await asyncio.gather(
            _confirm(plan, group, decision_id=decision_id),
            _confirm(plan, group, decision_id=decision_id),
            return_exceptions=True,
        )
        assert not [outcome for outcome in outcomes if isinstance(outcome, Exception)]
        assert all(outcome["ok"] for outcome in outcomes)
        assert sum(bool(outcome.get("duplicate")) for outcome in outcomes) == 1

        async with proposal_v2_db.sessions() as db:
            section_count = await db.scalar(
                select(func.count()).select_from(ResumeSection).where(ResumeSection.resume_id == seed["resume_id"])
            )
        assert section_count == len(seed["section_ids"]) + 5
        assert len(await _audit_rows(proposal_v2_db, group["nodes"])) == 5

    asyncio.run(run())


def test_expired_claim_cannot_publish_after_recovery_fences_the_node(proposal_v2_db):
    async def run():
        from app.services import proposal_plan_store
        from app.services import ui_approval_capability

        _permit_test_ui_capability(proposal_v2_db.monkeypatch)
        assert ui_approval_capability.accepts_authorization(
            "Bearer proposal-v2-test-capability"
        )
        _seed, _intents, _groups, run_id, plan = await _scenario(proposal_v2_db)
        group = _five_create_group(plan)
        decision_id = f"decision_{uuid4().hex}"
        decision = {
            "id": decision_id,
            "event_id": decision_id,
            "plan_id": plan["id"],
            "group_id": group["id"],
            "plan_digest": plan["digest"],
            "group_digest": group["digest"],
            "decision": "approve",
            "authorization_source": "desktop-ui",
        }
        await proposal_plan_store.record_decision(decision)
        node_id = group["nodes"][0]["id"]
        first = await proposal_plan_store.claim_node(node_id, claim_id="claim-owner-a", lease_seconds=1)
        assert first is not None
        await asyncio.sleep(1.05)
        await proposal_plan_store.recover_executing_nodes(run_id=run_id)

        try:
            await proposal_plan_store.checkpoint_node(
                node_id,
                claim_id="claim-owner-a",
                status="completed",
                effect_state="committed",
                result={"stale_owner": True},
                audit_ref="stale-claim",
            )
        except (ValueError, RuntimeError):
            pass

        authorization = await proposal_plan_store.get_node_authorization(node_id)
        assert authorization["node"]["status"] in {"uncertain", "blocked"}
        assert authorization["group"]["status"] in {"needs_reconciliation", "paused"}
        assert authorization["node"].get("result") != {"stale_owner": True}

    asyncio.run(run())


@pytest.mark.parametrize("crash_point", ["audit_finalize", "receipt_checkpoint"])
def test_commit_audit_receipt_crash_recovers_as_unknown_without_replay(
    proposal_v2_db, monkeypatch, crash_point
):
    async def run():
        import app.ops as ops
        from app.services import embedded_agent_host, proposal_plan_store

        _permit_test_ui_capability(monkeypatch)
        seed, _intents, _groups, run_id, plan = await _scenario(proposal_v2_db)
        group = _five_create_group(plan)
        first_node, sibling = group["nodes"][:2]

        if crash_point == "audit_finalize":
            async def fail_after_business_commit(*_args, **_kwargs):
                raise ops.OperationAuditError("fault after resume commit before completed audit")

            with monkeypatch.context() as fault:
                fault.setattr(ops, "_complete_authorized_audit", fail_after_business_commit)
                result = await _confirm(plan, group)
                assert result["ok"] is False
        else:
            real_checkpoint = proposal_plan_store.checkpoint_node

            async def fail_before_receipt(*args, **kwargs):
                if kwargs.get("status") == "completed":
                    raise RuntimeError("fault after completed Registry audit before receipt")
                return await real_checkpoint(*args, **kwargs)

            with monkeypatch.context() as fault:
                fault.setattr(proposal_plan_store, "checkpoint_node", fail_before_receipt)
                execution = __import__("app.services.proposal_plan_execution", fromlist=["*"])
                if hasattr(execution, "checkpoint_node"):
                    fault.setattr(execution, "checkpoint_node", fail_before_receipt)
                try:
                    await _confirm(plan, group)
                except RuntimeError as exc:
                    assert "before receipt" in str(exc)

        async with proposal_v2_db.sessions() as db:
            first_effects = await db.scalar(
                select(func.count()).select_from(ResumeSection).where(
                    ResumeSection.resume_id == seed["resume_id"],
                    ResumeSection.title == first_node["args"]["title"],
                )
            )
        assert first_effects == 1
        first_audit_rows = await _audit_rows(proposal_v2_db, [first_node])
        assert len(first_audit_rows) == 1

        # A process-style close/reopen proves reconciliation comes from disk.
        await proposal_v2_db.restart()
        await proposal_plan_store.recover_executing_nodes(run_id=run_id)
        authorization = await proposal_plan_store.get_node_authorization(first_node["id"])
        assert authorization["group"]["status"] == "needs_reconciliation"
        assert authorization["node"]["status"] in {"uncertain", "blocked"}

        # The old action_id surface cannot revive a sibling after group failure.
        old_entry = await embedded_agent_host.confirm_embedded_agent_action(
            run_id,
            action_id=sibling["id"],
            authorization_source="Bearer proposal-v2-test-capability",
        )
        assert old_entry["ok"] is False
        old_rejection = await embedded_agent_host.reject_embedded_agent_action(
            run_id,
            action_id=sibling["id"],
            authorization_source="Bearer proposal-v2-test-capability",
        )
        assert old_rejection["ok"] is False
        async with proposal_v2_db.sessions() as db:
            sibling_effects = await db.scalar(
                select(func.count()).select_from(ResumeSection).where(
                    ResumeSection.resume_id == seed["resume_id"],
                    ResumeSection.title == sibling["args"].get("title", ""),
                )
            )
        assert sibling_effects == 0
        assert len(await _audit_rows(proposal_v2_db, [first_node, sibling])) == 1

        # Re-confirmation after restart remains reconciliation-only.
        saved_decision = authorization["decision"]
        retry = await _confirm(
            plan,
            group,
            decision_id=saved_decision.get("id") or saved_decision.get("event_id"),
        )
        assert retry["ok"] is False
        assert len(await _audit_rows(proposal_v2_db, [first_node, sibling])) == 1

    asyncio.run(run())


def test_continuation_delivery_failure_keeps_business_success_and_retries_same_run(
    proposal_v2_db, monkeypatch
):
    async def run():
        from app.services import proposal_plan_continuation, proposal_plan_store

        _permit_test_ui_capability(monkeypatch)
        _seed, _intents, _groups, run_id, plan = await _scenario(proposal_v2_db)
        group = _five_create_group(plan)
        decision_id = f"decision_{uuid4().hex}"
        confirmed = await _confirm(plan, group, decision_id=decision_id)
        assert confirmed["ok"] is True
        audits_before = await _audit_rows(proposal_v2_db, group["nodes"])
        assert len(audits_before) == 5

        async def model_resume_fails(*_args, **_kwargs):
            raise RuntimeError("injected model continuation startup failure")

        failed = await proposal_plan_continuation.deliver_continuations(
            run_id, resume_agent=model_resume_fails
        )
        assert failed["failed"] >= 1
        assert failed["run"]["id"] == run_id
        plan_after_failure = await proposal_plan_store.get_plan(plan["id"])
        group_after_failure = next(item for item in plan_after_failure["groups"] if item["id"] == group["id"])
        assert group_after_failure["status"] == "completed"
        continuations = await proposal_plan_store.list_continuations(run_id=run_id)
        assert len(continuations) == 1
        outbox = continuations[0]
        assert outbox["run_id"] == run_id
        assert set(outbox["receipt_ids"])

        accepted_payloads = []

        async def accept_same_run(*args, **kwargs):
            accepted_payloads.append((args, kwargs))
            return {"ok": True, "run_id": run_id}

        retried = await proposal_plan_continuation.deliver_continuations(
            run_id, resume_agent=accept_same_run
        )
        assert retried["delivered"] == 1
        assert retried["run"]["id"] == run_id
        assert accepted_payloads
        delivered_call = repr(accepted_payloads[0])
        assert run_id in delivered_call
        assert all(receipt_id in delivered_call for receipt_id in outbox["receipt_ids"])
        delivered_again = await proposal_plan_continuation.deliver_continuations(
            run_id, resume_agent=accept_same_run
        )
        assert delivered_again["delivered"] == 0
        assert len(accepted_payloads) == 1
        assert len(await _audit_rows(proposal_v2_db, group["nodes"])) == len(audits_before)

    asyncio.run(run())


def test_pending_ask_defers_receipt_delivery_until_answer_without_replaying_effects(proposal_v2_db, monkeypatch):
    async def run():
        from app.services import agent_run_state, proposal_plan_continuation

        _permit_test_ui_capability(monkeypatch)
        _seed, _intents, _groups, run_id, plan = await _scenario(proposal_v2_db)
        request = await agent_run_state.create_agent_input_request(
            run_id, question="突出产品还是技术经历？"
        )
        group = _five_create_group(plan)
        assert (await _confirm(plan, group))["ok"]
        model_resume = AsyncMock(return_value={"ok": True, "run_id": run_id})
        deferred = await proposal_plan_continuation.deliver_continuations(run_id, resume_agent=model_resume)
        assert deferred["pending"] == 1
        model_resume.assert_not_awaited()
        assert deferred["run"]["status"] == "waiting_input"
        answer = await agent_run_state.answer_agent_input_request(
            run_id, request["request_id"],
            answer={"answer_id": "answer-fixture", "selected_option_ids": [], "free_text": "产品"},
        )
        assert answer["ok"]
        current = await agent_run_state.load_agent_run(run_id)
        current["status"] = "executing"
        await agent_run_state.save_agent_run(current)
        delivered = await proposal_plan_continuation.deliver_continuations(run_id, resume_agent=model_resume)
        assert delivered["delivered"] == 1
        await proposal_plan_continuation.deliver_continuations(run_id, resume_agent=model_resume)
        model_resume.assert_awaited_once()
        assert len(await _audit_rows(proposal_v2_db, group["nodes"])) == 5

    asyncio.run(run())


def test_all_semantic_groups_execute_without_reproposing_authorized_changes(proposal_v2_db, monkeypatch):
    """The whole tailoring plan must work, not only its first review group."""
    async def run():
        _permit_test_ui_capability(monkeypatch)
        _seed, _intents, _groups, _run_id, plan = await _scenario(proposal_v2_db)
        receipts, executed, decisions = [], [], 0
        original = [(node["operation"], node["args"]) for group in plan["groups"] for node in group["nodes"]]
        while any(group["status"] == "pending" for group in plan["groups"]):
            group = next(group for group in plan["groups"] if group["status"] == "pending")
            result = await _confirm(plan, group)
            assert result["ok"], {"group": group["title"], "errors": result.get("errors"), "status": (result.get("group") or {}).get("status")}
            receipts.extend(result["receipts"])
            executed.extend(group["nodes"])
            decisions += 1
            from app.services.proposal_plan_store import get_plan
            plan = await get_plan(result["successor_plan_id"] or plan["id"])
        assert decisions == 4
        from app.models.models import ProposalConfirmationDecision, ProposalExecutionPlan
        async with proposal_v2_db.sessions() as db:
            stored_decisions = (await db.execute(select(ProposalConfirmationDecision).join(ProposalExecutionPlan,
                ProposalConfirmationDecision.plan_id == ProposalExecutionPlan.id).where(ProposalExecutionPlan.run_id == _run_id))).scalars().all()
            assert len(stored_decisions) == 4
            assert all(item.authorization_source == "desktop-ui" for item in stored_decisions)
        assert len(receipts) == 18
        assert all(receipt["effect_state"] == "committed" for receipt in receipts)
        assert len(await _audit_rows(proposal_v2_db, executed)) == 18
        from app.services.proposal_plan_builder import canonical_json_bytes
        assert sorted(canonical_json_bytes(list(item)) for item in original) == sorted(canonical_json_bytes([node["operation"], node["args"]]) for node in executed)
    asyncio.run(run())


def test_delivered_continuation_merges_new_receipts_and_fences_expired_consumer(
    proposal_v2_db, monkeypatch
):
    async def run():
        from app.models.models import ProposalExecutionReceipt
        from app.services import proposal_plan_continuation, proposal_plan_store

        _permit_test_ui_capability(monkeypatch)
        _seed, _intents, _groups, run_id, plan = await _scenario(proposal_v2_db)
        group = _five_create_group(plan)
        confirmed = await _confirm(plan, group)
        assert confirmed["ok"] is True
        initial_receipts = {str(item["id"]) for item in confirmed["receipts"]}
        assert initial_receipts

        deliveries = []

        async def accept_receipts(*, run, continuation, receipts, delivery_id):
            deliveries.append(
                {
                    "run_id": run["id"],
                    "continuation_id": continuation["id"],
                    "receipt_ids": [str(item["id"]) for item in receipts],
                    "delivery_id": delivery_id,
                }
            )
            return {"ok": True, "run_id": run["id"]}

        first_delivery = await proposal_plan_continuation.deliver_continuations(
            run_id, resume_agent=accept_receipts
        )
        assert first_delivery["delivered"] == 1
        assert deliveries[0]["run_id"] == run_id
        assert set(deliveries[0]["receipt_ids"]) == initial_receipts

        outbox = (await proposal_plan_store.list_continuations(run_id=run_id))[0]
        assert outbox["status"] == "delivered"
        outbox_id = outbox["id"]
        prior_delivery_id = deliveries[0]["delivery_id"]

        async def add_outbox_fixture_receipt(label: str) -> str:
            """Persist real receipt rows for outbox testing, not Agent/business proof."""

            receipt_id = f"receipt_{uuid4().hex}"
            node = group["nodes"][0]
            binding = await proposal_plan_store.get_node_authorization(node["id"])
            persisted_node = binding["node"]
            async with proposal_v2_db.sessions() as db:
                db.add(
                    ProposalExecutionReceipt(
                        id=receipt_id,
                        node_id=node["id"],
                        attempt_id=f"outbox-fixture-{label}-{uuid4().hex}",
                        effect_identity=persisted_node["effect_identity"],
                        idempotency_key=f"outbox-fixture:{label}:{receipt_id}",
                        status="test_fixture",
                        effect_state="unknown",
                        result_json={"test_fixture": label},
                        audit_ref="",
                        error_json={},
                    )
                )
                await db.commit()
            return receipt_id

        late_receipt_a = await add_outbox_fixture_receipt("callback")
        merged = await proposal_plan_store.create_continuation(
            {"run_id": run_id, "group_id": group["id"], "receipt_ids": [late_receipt_a]}
        )
        assert merged["continuation"]["id"] == outbox_id
        assert merged["continuation"]["status"] == "pending"
        assert set(merged["continuation"]["delivered_receipt_ids"]) == initial_receipts

        new_delivery = await proposal_plan_continuation.deliver_continuations(
            run_id, resume_agent=accept_receipts
        )
        assert new_delivery["delivered"] == 1
        assert deliveries[1]["continuation_id"] == outbox_id
        assert deliveries[1]["receipt_ids"] == [late_receipt_a]
        assert deliveries[1]["delivery_id"] != prior_delivery_id
        after_new_receipt = (await proposal_plan_store.list_continuations(run_id=run_id))[0]
        assert set(after_new_receipt["delivered_receipt_ids"]) == initial_receipts | {late_receipt_a}

        late_receipt_b = await add_outbox_fixture_receipt("lease-a")
        late_receipt_c = await add_outbox_fixture_receipt("lease-b")
        await proposal_plan_store.create_continuation(
            {"run_id": run_id, "group_id": group["id"], "receipt_ids": [late_receipt_b]}
        )
        old_consumer = await proposal_plan_store.claim_continuation(
            outbox_id, claim_id="claim_old_consumer", lease_seconds=1
        )
        assert old_consumer is not None
        assert old_consumer["claimed_receipt_ids"] == [late_receipt_b]
        old_delivery_key = old_consumer["delivery_key"]
        old_delivery_id = proposal_plan_continuation._delivery_id(
            outbox_id, old_consumer["claimed_receipt_ids"]
        )
        assert old_delivery_id != deliveries[1]["delivery_id"]

        appended = await proposal_plan_store.create_continuation(
            {"run_id": run_id, "group_id": group["id"], "receipt_ids": [late_receipt_c]}
        )
        assert appended["continuation"]["status"] == "delivering"
        await asyncio.sleep(1.05)
        new_consumer = await proposal_plan_store.claim_continuation(
            outbox_id, claim_id="claim_new_consumer", lease_seconds=60
        )
        assert new_consumer is not None
        assert set(new_consumer["claimed_receipt_ids"]) == {late_receipt_b, late_receipt_c}
        assert new_consumer["delivery_key"] != old_delivery_key
        new_delivery_id = proposal_plan_continuation._delivery_id(
            outbox_id, new_consumer["claimed_receipt_ids"]
        )
        assert new_delivery_id != old_delivery_id
        with pytest.raises(proposal_plan_store.ProposalNodeClaimConflictError):
            await proposal_plan_store.finish_continuation(
                outbox_id, claim_id="claim_old_consumer", status="delivered"
            )

        still_owned = (await proposal_plan_store.list_continuations(run_id=run_id))[0]
        assert still_owned["claim_id"] == "claim_new_consumer"
        assert set(still_owned["delivered_receipt_ids"]) == initial_receipts | {late_receipt_a}
        finished = await proposal_plan_store.finish_continuation(
            outbox_id, claim_id="claim_new_consumer", status="delivered"
        )
        assert finished["status"] == "delivered"
        assert set(finished["delivered_receipt_ids"]) == {
            *initial_receipts,
            late_receipt_a,
            late_receipt_b,
            late_receipt_c,
        }
        assert len(await _audit_rows(proposal_v2_db, group["nodes"])) == len(group["nodes"])

    asyncio.run(run())


def test_legacy_fixture_a_b_current_have_distinct_schema_and_preserve_step_history(
    proposal_v2_db, tmp_path
):
    async def run():
        from sqlalchemy import create_engine

        from app.database import (
            Base,
            prepare_schema_migration,
            run_schema_migrations,
            schema_migration_status,
        )
        from app.models.models import AgentRunRecord
        from app.services import proposal_plan_store
        from app.services.data_safety import (
            DataSafetyLayout,
            create_backup,
            database_integrity_report,
            list_backups,
        )

        # Fixture A is the repository's real v0 upgrade shape: only legacy
        # jobs/pools exist. Its table set is materially different from B/current.
        schema_a_root = tmp_path / "legacy-schema-a"
        schema_a_backend = schema_a_root / "backend"
        schema_a_backend.mkdir(parents=True)
        schema_a_path = schema_a_backend / "djm.db"
        with closing(sqlite3.connect(schema_a_path)) as connection:
            connection.executescript(
                """
                CREATE TABLE pools (id INTEGER PRIMARY KEY, name TEXT NOT NULL, scope TEXT NOT NULL);
                INSERT INTO pools(id, name, scope) VALUES (1, 'legacy pool A', 'screened');
                CREATE TABLE jobs (
                    id INTEGER PRIMARY KEY, title TEXT NOT NULL, company TEXT NOT NULL,
                    triage_status TEXT NOT NULL, hash_key TEXT NOT NULL UNIQUE
                );
                INSERT INTO jobs(id, title, company, triage_status, hash_key)
                    VALUES (1, 'legacy job A', 'fixture company', 'screened', 'legacy-a-job');
                PRAGMA user_version=0;
                """
            )
        schema_a_url = f"sqlite+aiosqlite:///{schema_a_path.as_posix()}"
        schema_a_layout = DataSafetyLayout(
            backend_dir=schema_a_backend, database_path=schema_a_path
        )
        with closing(sqlite3.connect(schema_a_path)) as connection:
            old_tables_a = {
                row[0]
                for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
            old_version_a = connection.execute("PRAGMA user_version").fetchone()[0]
        assert old_version_a == 0
        assert old_tables_a == {"jobs", "pools"}
        prepared_a = await prepare_schema_migration(
            schema_a_url, backend_dir=schema_a_backend
        )
        assert prepared_a["from_version"] == 0
        assert prepared_a["required"] is True
        assert len(list_backups(schema_a_layout)["items"]) == 1
        schema_a_engine = create_engine(schema_a_url.replace("+aiosqlite", ""))
        try:
            with schema_a_engine.begin() as connection:
                Base.metadata.create_all(connection)
                migration_a = run_schema_migrations(connection)
        finally:
            schema_a_engine.dispose()
        assert migration_a == {"from_version": 0, "to_version": CURRENT_SCHEMA_VERSION}
        with closing(sqlite3.connect(schema_a_path)) as connection:
            assert connection.execute("PRAGMA user_version").fetchone()[0] == CURRENT_SCHEMA_VERSION
            assert connection.execute("SELECT title FROM jobs WHERE id=1").fetchone()[0] == "legacy job A"
            tables_a_current = {
                row[0]
                for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
        assert "agent_runs" in tables_a_current
        assert {
            "proposal_plans",
            "proposal_confirmation_groups",
            "proposal_operation_nodes",
            "proposal_confirmation_decisions",
            "proposal_execution_receipts",
            "proposal_continuations",
        }.issubset(tables_a_current)
        assert database_integrity_report(schema_a_layout)["status"] == "ok"

        # Fixture B is the actual v5 boundary immediately before Proposal v2:
        # AgentRun.steps_json exists with old pending/executing/history records,
        # while all six v2 authority tables are absent. The current database
        # after migration is schema v6 with those tables present.
        seed = await seed_resume(proposal_v2_db)
        run_ids = await seed_legacy_v5_run_statuses(proposal_v2_db, seed["resume_id"])
        database_path = Path(proposal_v2_db.url.split("///", 1)[1])
        layout = DataSafetyLayout(backend_dir=database_path.parent, database_path=database_path)
        await proposal_v2_db.close()
        proposal_tables = (
            "proposal_continuations",
            "proposal_execution_receipts",
            "proposal_confirmation_decisions",
            "proposal_operation_nodes",
            "proposal_confirmation_groups",
            "proposal_plans",
        )
        with closing(sqlite3.connect(database_path)) as connection:
            legacy_steps = {
                label: connection.execute(
                    "SELECT steps_json FROM agent_runs WHERE run_id=?", (run_id,)
                ).fetchone()[0]
                for label, run_id in run_ids.items()
            }
            for table in proposal_tables:
                connection.execute(f'DROP TABLE "{table}"')
            connection.execute("PRAGMA user_version=5")
            connection.commit()
            assert connection.execute("PRAGMA user_version").fetchone()[0] == 5
            tables_b = {
                row[0]
                for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
            run_columns_b = {
                row[1] for row in connection.execute("PRAGMA table_info(agent_runs)")
            }
        assert "agent_runs" in tables_b and "steps_json" in run_columns_b
        assert not set(proposal_tables).intersection(tables_b)

        backup_b = create_backup(layout, reason="pre_migration", app_version="proposal-v2-v5-fixture")
        assert backup_b["schema"]["user_version"] == 5
        schema_b_engine = create_engine(proposal_v2_db.url.replace("+aiosqlite", ""))
        try:
            with schema_b_engine.begin() as connection:
                migration_b = run_schema_migrations(connection)
        finally:
            schema_b_engine.dispose()
        assert migration_b == {"from_version": 5, "to_version": CURRENT_SCHEMA_VERSION}
        await proposal_v2_db.start()

        first = await proposal_plan_store.migrate_legacy_proposals()
        assert first["imported"] >= 1
        assert first["preserved"] >= 1
        assert first["reconciliation"] >= 2
        plans_after_first = {
            run_id: await proposal_plan_store.list_plans(run_id=run_id)
            for run_id in run_ids.values()
        }
        pending = plans_after_first[run_ids["pending"]]
        assert len(pending) == 1
        assert pending[0]["groups"][0]["status"] == "pending"
        pending_node = pending[0]["groups"][0]["nodes"][0]
        assert pending_node["operation"] == "update_resume_record"
        assert pending_node["args"] == {
            "resume_id": seed["resume_id"],
            "update_data": {"summary": "legacy-pending"},
        }
        assert len(plans_after_first[run_ids["executing"]]) == 1
        assert plans_after_first[run_ids["executing"]][0]["status"] == "needs_reconciliation"
        assert len(plans_after_first[run_ids["uncertain"]]) == 1
        assert plans_after_first[run_ids["uncertain"]][0]["status"] == "needs_reconciliation"
        for label in ("completed", "failed", "rejected"):
            assert plans_after_first[run_ids[label]] == []
        for label, run_id in run_ids.items():
            async with proposal_v2_db.sessions() as db:
                current_steps = (
                    await db.execute(select(AgentRunRecord.steps_json).where(AgentRunRecord.run_id == run_id))
                ).scalar_one()
            assert json.loads(legacy_steps[label]) == current_steps

        current_status = schema_migration_status(proposal_v2_db.url)
        assert current_status["current_version"] == CURRENT_SCHEMA_VERSION
        assert current_status["status"] == "ready"
        with closing(sqlite3.connect(database_path)) as connection:
            current_tables = {
                row[0]
                for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
        assert set(proposal_tables).issubset(current_tables)
        repeated = await proposal_plan_store.migrate_legacy_proposals()
        assert repeated["imported"] == 0
        for run_id in run_ids.values():
            assert len(await proposal_plan_store.list_plans(run_id=run_id)) == len(plans_after_first[run_id])

    asyncio.run(run())


def test_actual_resume_effect_backup_restore_restart_passes_three_consecutive_cycles(
    proposal_v2_db, monkeypatch
):
    async def run():
        from sqlalchemy import delete

        from app.models.models import OperationAuditLog, ProposalExecutionReceipt, ResumeSection
        from app.services import proposal_plan_store
        from app.services.data_safety import (
            DataSafetyLayout,
            apply_pending_restore_before_database_connect,
            create_backup,
            database_integrity_report,
            stage_restore,
        )

        _permit_test_ui_capability(monkeypatch)
        seed = await seed_resume(proposal_v2_db)
        database_path = Path(proposal_v2_db.url.split("///", 1)[1])
        layout = DataSafetyLayout(backend_dir=database_path.parent, database_path=database_path)
        effects: list[dict[str, str]] = []
        distinct_effect_keys: set[str] = set()
        distinct_audit_keys: set[str] = set()

        for cycle in range(1, 4):
            title = f"Restore verified Resume effect {cycle}"
            intent = {
                "id": f"restore-cycle-{cycle}",
                "operation": "create_resume_section",
                "args": {
                    "resume_id": seed["resume_id"],
                    "section_type": "project",
                    "title": title,
                    "sort_order": 10 + cycle,
                    "visible": True,
                    "content_json": [{"name": title, "description": f"Cycle {cycle} evidence"}],
                },
                "summary": title,
                "display": {"before": "Missing section", "after": title},
            }
            groups = [
                {
                    "id": f"restore-cycle-{cycle}-group",
                    "title": f"Restore cycle {cycle} review",
                    "rationale": "A real Registry resume write is restored from the verified archive.",
                    "node_ids": [intent["id"]],
                }
            ]
            _run_id, plan = await _persist_plan(
                proposal_v2_db,
                [intent],
                groups,
                title=f"Restore cycle {cycle} Registry effect",
            )
            group = plan["groups"][0]
            node = group["nodes"][0]
            confirmed = await _confirm(plan, group)
            assert confirmed["ok"] is True, confirmed
            binding = await proposal_plan_store.get_node_authorization(node["id"])
            assert binding["node"]["status"] == "completed"
            effect_identity = str(binding["node"]["effect_identity"])
            effect_key = str(binding["node"]["idempotency_key"])
            receipt_id = str(binding["node"]["receipt_id"])
            audits = await _audit_rows(proposal_v2_db, [node])
            assert len(audits) == 1
            audit = audits[0]
            assert audit.status == "completed" and audit.ok is True
            assert audit.idempotency_key == effect_key

            async with proposal_v2_db.sessions() as db:
                section = (
                    await db.execute(
                        select(ResumeSection).where(
                            ResumeSection.resume_id == seed["resume_id"],
                            ResumeSection.title == title,
                        )
                    )
                ).scalar_one()
                receipt = await db.get(ProposalExecutionReceipt, receipt_id)
                assert receipt is not None
                assert receipt.status == "completed" and receipt.effect_state == "committed"
                assert receipt.effect_identity == effect_identity
            distinct_effect_keys.add(effect_identity)
            distinct_audit_keys.add(effect_key)
            assert len(distinct_effect_keys) == cycle
            assert len(distinct_audit_keys) == cycle
            effects.append(
                {
                    "title": title,
                    "node_id": node["id"],
                    "receipt_id": receipt_id,
                    "effect_identity": effect_identity,
                    "audit_idempotency_key": effect_key,
                    "audit_id": str(audit.id),
                    "section_id": str(section.id),
                }
            )

            # Each cycle backs up a real completed Registry effect, then deletes
            # its Resume row, successful AuditLog and immutable Receipt.
            backup = create_backup(
                layout,
                reason="pre_restore",
                app_version=f"proposal-v2-restore-cycle-{cycle}",
            )
            assert backup["schema"]["user_version"] == CURRENT_SCHEMA_VERSION
            async with proposal_v2_db.sessions() as db:
                await db.execute(
                    delete(ResumeSection).where(ResumeSection.id == section.id)
                )
                await db.execute(
                    delete(OperationAuditLog).where(OperationAuditLog.id == audit.id)
                )
                await db.execute(
                    delete(ProposalExecutionReceipt).where(ProposalExecutionReceipt.id == receipt_id)
                )
                await db.commit()
            async with proposal_v2_db.sessions() as db:
                assert await db.get(ProposalExecutionReceipt, receipt_id) is None
                assert await db.get(OperationAuditLog, audit.id) is None
                assert await db.get(ResumeSection, section.id) is None

            staged = stage_restore(layout, backup_id=backup["backup_id"])
            assert staged["pending_restart"] is True and staged["database_replaced"] is False
            await proposal_v2_db.close()
            applied = apply_pending_restore_before_database_connect(
                database_url=proposal_v2_db.url,
                backend_dir=layout.backend_dir,
            )
            assert applied["applied"] is True
            await proposal_v2_db.start()

            integrity = database_integrity_report(layout)
            assert integrity["status"] == "ok"
            with closing(sqlite3.connect(database_path)) as connection:
                assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
                assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
                assert connection.execute("PRAGMA user_version").fetchone()[0] == CURRENT_SCHEMA_VERSION

            # Prior effects remain once each and the current effect is restored
            # with its committed audit, receipt and exact business identity.
            for expected in effects:
                async with proposal_v2_db.sessions() as db:
                    section_count = await db.scalar(
                        select(func.count()).select_from(ResumeSection).where(
                            ResumeSection.id == int(expected["section_id"]),
                            ResumeSection.title == expected["title"],
                        )
                    )
                    audit_rows = (
                        await db.execute(
                            select(OperationAuditLog).where(
                                OperationAuditLog.idempotency_key == expected["audit_idempotency_key"]
                            )
                        )
                    ).scalars().all()
                    receipt_rows = (
                        await db.execute(
                            select(ProposalExecutionReceipt).where(
                                ProposalExecutionReceipt.id == expected["receipt_id"]
                            )
                        )
                    ).scalars().all()
                    effect_rows = (
                        await db.execute(
                            select(ProposalExecutionReceipt).where(
                                ProposalExecutionReceipt.effect_identity == expected["effect_identity"]
                            )
                        )
                    ).scalars().all()
                assert section_count == 1
                assert len(audit_rows) == 1
                assert audit_rows[0].status == "completed" and audit_rows[0].ok is True
                assert audit_rows[0].id == int(expected["audit_id"])
                assert len(receipt_rows) == 1
                assert receipt_rows[0].effect_state == "committed"
                assert len(effect_rows) == 1
                assert effect_rows[0].effect_identity == expected["effect_identity"]

    asyncio.run(run())


def test_tailor_resume_fixture_runs_ask_plan_receipts_and_workspace_on_one_run(
    proposal_v2_db, monkeypatch
):
    """Deterministic CI proof for one canonical resume-tailoring Run.

    This is a fixture reasoner boundary, not live-model or human acceptance.
    It verifies Ask -> same Run -> semantic Proposal v2 groups -> real Registry
    receipts -> same-Run continuation -> accepted job Resume Version.
    """

    async def run():
        from app.models.models import ResumeOptimizationProposal, ResumeVersion
        from app.ops import set_operation_run_context
        from app.services import (
            agent_run_state,
            proposal_plan_continuation,
            proposal_plan_store,
            resume_decision_plans,
            resume_workspace,
        )
        from proposal_v2_fixtures import seed_reviewable_resume_proposal

        _permit_test_ui_capability(monkeypatch)
        monkeypatch.setattr(
            resume_decision_plans, "async_session", proposal_v2_db.sessions
        )
        seed = await seed_reviewable_resume_proposal(
            proposal_v2_db, "tailor-runtime-loop"
        )

        async with proposal_v2_db.sessions() as db:
            proposal = await db.get(ResumeOptimizationProposal, seed["proposal_id"])
            source_id = seed["source_section_id"]
            before_rows, after_rows, changes = [], [], []
            for index, (section_type, title) in enumerate(
                (("experience", "工作经历"), ("project", "项目经历"), ("skills", "技能"))
            ):
                before = {
                    "section_type": section_type,
                    "title": title,
                    "sort_order": index,
                    "visible": True,
                    "content_json": [{"description": f"原始 {title} 证据"}],
                    "source_section_ids": [source_id],
                }
                after = {
                    **before,
                    "content_json": [{"description": f"岗位化 {title} 证据"}],
                }
                change_id = f"tailor-runtime-{index}"
                before_rows.append(before)
                after_rows.append(after)
                changes.append(
                    {
                        "change_id": change_id,
                        "change_type": "modified",
                        "section_key": f"{section_type}:{title}",
                        "section_type": section_type,
                        "title": title,
                        "source_section_ids": [source_id],
                        "before": before,
                        "after": after,
                    }
                )
            proposal.original_rows_json = before_rows
            proposal.proposed_rows_json = after_rows
            proposal.diff_json = changes
            await db.commit()

        monkeypatch.setattr(
            resume_workspace,
            "get_pre_application_state",
            AsyncMock(return_value={"stage": "resume_proposal_ready"}),
        )
        workspace = await resume_workspace.ensure_resume_workspace(
            job_id=seed["job_id"], proposal_id=seed["proposal_id"]
        )
        resume_id = workspace["resume"]["id"]

        run_id = f"run_{uuid4().hex[:16]}"
        await agent_run_state.create_agent_run(
            conversation_id=f"tailor-runtime-{run_id}",
            goal=f"Tailor resume for Job #{seed['job_id']}",
            mode="resume_workflow",
            skill_id="tailor_resume",
            # Real runs always carry the resolved Skill snapshot; plan
            # preparation fails closed without its allowed_tools scope.
            skill_snapshot=resolve_skill("tailor_resume").summary(),
            actions=[],
            run_id=run_id,
        )

        ask = await agent_run_state.create_agent_input_request(
            run_id,
            question="这份简历更应该突出产品判断还是技术实现？",
            reason="定位会改变摘要与经历排序。",
            options=[
                {
                    "option_id": "recommended-product",
                    "label": "产品判断（推荐）",
                    "description": "岗位要求更偏产品 ownership。",
                },
                {
                    "option_id": "technical",
                    "label": "技术实现",
                    "description": "更强调工程深度。",
                },
            ],
            allow_free_text=True,
        )
        waiting = await agent_run_state.load_agent_run(run_id)
        assert waiting["status"] == "waiting_input"

        answered = await agent_run_state.answer_agent_input_request(
            run_id,
            ask["request_id"],
            answer={
                "answer_id": "tailor-runtime-answer",
                "selected_option_ids": ["recommended-product"],
                "free_text": "",
            },
        )
        assert answered["ok"] is True
        assert await agent_run_state.consume_agent_input_request(ask["request_id"])
        same_run = await agent_run_state.load_agent_run(run_id)
        same_run["status"] = "executing"
        await agent_run_state.save_agent_run(
            same_run,
            event_type="continuation.requested",
            event_payload={"source": "fixture_ask_answer"},
        )

        groups = [
            {
                "title": "定位与工作经历",
                "summary": "采用与岗位最相关的工作经历表达",
                "change_ids": ["tailor-runtime-0"],
                "dependency_indices": [],
                "display": {
                    "why": "对应岗位的 ownership 要求",
                    "evidence": [f"profile:{seed['source_section_id']}"],
                },
            },
            {
                "title": "项目经历",
                "summary": "采用岗位相关项目表达",
                "change_ids": ["tailor-runtime-1"],
                "dependency_indices": [0],
                "display": {
                    "why": "补强项目证据",
                    "evidence": [f"profile:{seed['source_section_id']}"],
                },
            },
            {
                "title": "技能",
                "summary": "采用与 JD 对齐的技能表达",
                "change_ids": ["tailor-runtime-2"],
                "dependency_indices": [1],
                "display": {
                    "why": "只保留有证据的技能",
                    "evidence": [f"profile:{seed['source_section_id']}"],
                },
            },
        ]
        with set_operation_run_context(run_id):
            prepared = await resume_decision_plans.propose_resume_decision_plan(
                proposal_id=seed["proposal_id"],
                resume_id=resume_id,
                groups=groups,
            )
        plan = prepared["plan"]
        assert plan["run_id"] == run_id
        assert len(plan["groups"]) == 3

        receipt_ids: list[str] = []
        current_plan = plan
        while any(group["status"] == "pending" for group in current_plan["groups"]):
            group = next(
                group for group in current_plan["groups"] if group["status"] == "pending"
            )
            result = await _confirm(current_plan, group)
            assert result["ok"] is True, result
            receipt_ids.extend(
                str(receipt["id"]) for receipt in result.get("receipts") or []
            )
            next_plan_id = result.get("successor_plan_id") or current_plan["id"]
            current_plan = await proposal_plan_store.get_plan(next_plan_id)

        assert receipt_ids
        async with proposal_v2_db.sessions() as db:
            proposal = await db.get(ResumeOptimizationProposal, seed["proposal_id"])
            assert proposal.status == "accepted"
            assert proposal.accepted_resume_id == resume_id
            assert proposal.accepted_resume_version_id is not None
            version = await db.get(ResumeVersion, proposal.accepted_resume_version_id)
            assert version is not None
            accepted_version_id = proposal.accepted_resume_version_id

        continuation_calls: list[dict] = []

        async def resume_same_run(*, run, continuation, receipts, delivery_id):
            assert run["id"] == run_id
            continuation_calls.append(
                {
                    "continuation_id": continuation["id"],
                    "receipt_ids": [str(item["id"]) for item in receipts],
                    "delivery_id": delivery_id,
                }
            )
            latest = await agent_run_state.load_agent_run(run_id)
            latest["status"] = "completed"
            latest["final_result"] = {
                "accepted_resume_id": resume_id,
                "accepted_resume_version_id": accepted_version_id,
            }
            await agent_run_state.save_agent_run(
                latest,
                event_type="run.completed",
                event_payload={"source": "fixture_receipt_continuation"},
            )
            return {"ok": True, "run_id": run_id}

        delivery = await proposal_plan_continuation.deliver_continuations(
            run_id, resume_agent=resume_same_run
        )
        assert delivery["delivered"] >= 1
        assert continuation_calls
        assert all(call["receipt_ids"] for call in continuation_calls)

        final_run = await agent_run_state.load_agent_run(run_id)
        assert final_run["id"] == run_id
        assert final_run["status"] == "completed"
        assert final_run["final_result"]["accepted_resume_id"] == resume_id
        assert final_run["final_result"]["accepted_resume_version_id"] == accepted_version_id

    asyncio.run(run())

