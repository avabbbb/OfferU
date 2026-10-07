from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from copy import deepcopy
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.database import Base
from app.models.models import CareerTask, Job, Profile, ProfileSection, Resume, ResumeSection, ResumeOptimizationProposal, ResumeVersion
from app.services import pre_application_decisions, resume_optimization, resume_workspace


def test_external_draft_registry_prepares_without_self_approving(tmp_path):
    from app.ops import OPERATIONS, execute_operation
    from app.services.operation_projection import execute_or_propose_operation
    from app.services.agent_skill_registry import resolve_skill

    async def run():
        async with _fixture(tmp_path) as (sessions, job_id, _, _, preparation):
            with patch("app.ops.async_session", sessions):
                result = await execute_or_propose_operation(
                    "persist_external_resume_proposal",
                    {"job_id": job_id, "request_id": "registry-1", "preparation": preparation},
                    surface="cli",
                )
                assert result["ok"], result
                proposal_id = result["outputs"]["proposal_id"]
                assert "proposal" not in result["outputs"]
                workspace = await execute_or_propose_operation(
                    "ensure_resume_workspace", {"job_id": job_id, "proposal_id": proposal_id}, surface="mcp"
                )
                assert workspace["ok"], workspace
                denied = await execute_operation(
                    "review_resume_optimization", {"proposal_id": proposal_id, "action": "accept"}, surface="cli"
                )
                assert not denied["ok"]
                assert denied["outputs"]["requires_confirmation"]
                unaudited = await execute_operation(
                    "persist_external_resume_proposal",
                    {"job_id": job_id, "request_id": "no-audit", "preparation": preparation},
                    surface="mcp", audit=False,
                )
                assert not unaudited["ok"]
                assert {name for name, op in OPERATIONS.items() if op.preparation_only} == {
                    "persist_external_resume_proposal", "ensure_resume_workspace",
                    "prepare_proposal_plan", "propose_resume_decision_plan"
                }
                assert "persist_external_resume_proposal" in resolve_skill("tailor_resume").allowed_tools
                assert "review_resume_proposal_items" in resolve_skill("tailor_resume").allowed_tools
                assert OPERATIONS["review_resume_proposal_items"].requires_confirmation
                async with sessions() as db:
                    proposal = (await db.execute(select(ResumeOptimizationProposal))).scalar_one()
                    assert proposal.status != "accepted"
    asyncio.run(run())


def test_omitted_profile_evidence_is_compared_and_stale_checked(tmp_path):
    async def run():
        async with _fixture(tmp_path) as (sessions, job_id, profile_id, section_id, preparation):
            from app import ops
            from app.services import agent_run_state, proposal_plan_execution, proposal_plan_sources, proposal_plan_store

            with (
                patch.object(agent_run_state, "async_session", sessions),
                patch.object(ops, "async_session", sessions),
                patch.object(proposal_plan_execution, "async_session", sessions),
                patch.object(proposal_plan_sources, "async_session", sessions),
                patch.object(proposal_plan_store, "async_session", sessions),
            ):
                async with sessions() as db:
                    extra = ProfileSection(profile_id=profile_id, section_type="project", title="Game project",
                        sort_order=1, tier="verified_fact", status="active", source="manual",
                        content_json={"normalized": {"name": "Puzzle", "description": "Built a puzzle game."}})
                    db.add(extra)
                    await db.commit()
                    extra_id = extra.id
                context = await resume_optimization.get_resume_preparation_context(job_id)
                preparation["source_fingerprint"] = context["source_fingerprint"]
                preparation["rationale"].append({"source_section_ids": [extra_id],
                    "requirement": "Build reliable Python services.", "why": "Omit the game project for this services role."})
                saved = await resume_optimization.persist_external_resume_proposal(job_id, preparation, "omit-game")
                omitted = next(change for change in saved["diff"]
                               if change["change_type"] == "removed" and extra_id in change["source_section_ids"])
                workspace = await resume_workspace.ensure_resume_workspace(job_id, saved["proposal_id"])
                run, plan = await _prepare_resume_adoption(
                    proposal_id=saved["proposal_id"],
                    resume_id=workspace["resume"]["id"],
                    change_ids=[omitted["change_id"]],
                )
                async with sessions() as db:
                    resume_before = await db.get(Resume, workspace["resume"]["id"])
                    sections = (await db.execute(select(ResumeSection).where(
                        ResumeSection.resume_id == resume_before.id
                    ))).scalars().all()
                    section_ids = [section.id for section in sections]
                    sections_before = {section.id: deepcopy(section.content_json) for section in sections}

            async with sessions() as db:
                extra = await db.get(ProfileSection, extra_id)
                extra.content_json = {"normalized": {"name": "Puzzle", "description": "Updated the game project."}}
                await db.commit()
            group = plan["groups"][0]
            reviewed = await _approve_resume_group(plan, group)
            assert not reviewed["ok"], reviewed
            # Source validation rejects before a decision/claim/domain write;
            # no uncertain execution or fake receipt should be manufactured.
            assert reviewed["group"]["status"] == "pending"
            assert reviewed["errors"] and "changed" in " ".join(reviewed["errors"])
            assert not reviewed["receipts"]
            assert reviewed["group"]["nodes"][0]["attempt_count"] == 0
            assert run["id"] == plan["run_id"]
            async with sessions() as db:
                proposal = await db.get(ResumeOptimizationProposal, saved["proposal_id"])
                resume = await db.get(Resume, workspace["resume"]["id"])
                sections = (await db.execute(select(ResumeSection).where(
                    ResumeSection.resume_id == resume.id
                ))).scalars().all()
                assert proposal.status != "accepted"
                assert resume.workspace_revision == 0
                assert {section.id: section.content_json for section in sections} == sections_before
                assert set(section_ids) == {section.id for section in sections}
            replay = await _approve_resume_group(plan, group)
            assert not replay["ok"]
            assert not replay.get("tool_calls")
    asyncio.run(run())


@asynccontextmanager
async def _fixture(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'external-resume.sqlite'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as db:
        profile = Profile(name="Fixture", is_default=True, base_info_json={})
        db.add(profile)
        await db.flush()
        section = ProfileSection(
            profile_id=profile.id, section_type="experience", title="Experience",
            sort_order=0, tier="verified_fact", status="active", source="manual",
            content_json={"normalized": {
                "company": "Example", "position": "Backend Engineer",
                "description": "Built a Python service for internal workflows.",
            }},
        )
        job = Job(title="Backend Engineer", company="Target", source="test",
                  hash_key="external-draft", raw_description="Build reliable Python services.")
        db.add_all([section, job])
        await db.commit()
    with patch.object(resume_optimization, "async_session", sessions), \
         patch("app.services.resume_decision_plans.async_session", sessions), \
         patch("app.services.agent_run_state.async_session", sessions), \
         patch("app.services.proposal_plan_sources.async_session", sessions), \
         patch("app.services.proposal_plan_store.async_session", sessions), \
         patch("app.services.proposal_plan_execution.async_session", sessions), \
         patch("app.ops.async_session", sessions), \
         patch.object(resume_workspace, "async_session", sessions), \
         patch.object(pre_application_decisions, "async_session", sessions), \
         patch.object(resume_optimization, "_generate_candidate", AsyncMock(
             side_effect=AssertionError("external drafts must never invoke embedded reasoning"))):
        try:
            context = await resume_optimization.get_resume_preparation_context(job.id)
            preparation = {
                "job_id": job.id, "source_fingerprint": context["source_fingerprint"],
                "rows": deepcopy(context["baseline_rows"]),
                "rationale": [{"source_section_ids": [section.id],
                               "requirement": "Build reliable Python services.",
                               "why": "Lead with the verified Python delivery experience."}],
                "user_decisions": [{"question": "Which emphasis?", "answer": "Python delivery"}],
            }
            preparation["rows"][0]["title"] = "Relevant experience"
            yield sessions, job.id, profile.id, section.id, preparation
        finally:
            await engine.dispose()


async def _prepare_resume_adoption(*, proposal_id, resume_id, change_ids):
    from app.ops import set_operation_run_context
    from app.services.agent_run_state import create_agent_run
    from app.services.agent_skill_registry import resolve_skill
    from app.services.resume_decision_plans import propose_resume_decision_plan

    skill = resolve_skill("tailor_resume")
    run = await create_agent_run(
        conversation_id=f"external-resume-{uuid4().hex}",
        goal="Review the evidence-backed job resume draft",
        mode="resume_workflow",
        skill_id=skill.id,
        skill_version=skill.version,
        skill_snapshot=skill.summary(),
        actions=[],
    )
    with set_operation_run_context(run["id"]):
        prepared = await propose_resume_decision_plan(
            proposal_id=proposal_id,
            resume_id=resume_id,
            groups=[{
                "title": "Relevant experience",
                "summary": "Review the displayed evidence-backed experience change",
                "change_ids": list(change_ids),
                "display": {"rationale": "The user reviews this group before adoption."},
            }],
        )
    return run, prepared["plan"]


async def _approve_resume_group(plan, group, decision_id=None):
    from app.services.proposal_plan_execution import confirm_group
    from app.services import ui_approval_capability

    token = "Bearer external-resume-test-ui"
    with patch(
        "app.services.ui_approval_capability.accepts_authorization",
        side_effect=lambda value: value == token,
    ):
        assert ui_approval_capability.accepts_authorization(token)
        return await confirm_group(
            plan["id"],
            group["id"],
            plan_digest=plan["digest"],
            group_digest=group["digest"],
            decision_id=decision_id or f"decision_{uuid4().hex}",
            authorization_source=token,
            surface="agent_runtime_ui",
        )


def test_external_draft_replay_and_independent_adoption(tmp_path):
    async def run():
        async with _fixture(tmp_path) as (sessions, job_id, _, section_id, preparation):
            saved = await resume_optimization.persist_external_resume_proposal(job_id, preparation, "request-1")
            assert saved["status"] == "ready"
            assert saved["trace"]["source_mode"] == "external_agent"
            assert saved["trace"]["selection_origin"] == "external_agent_model"
            assert "task_id" not in saved["trace"]
            assert saved["strategy"]["user_decisions"] == preparation["user_decisions"]
            assert saved["accepted_resume_id"] is None
            async with sessions() as db:
                assert (await db.execute(select(Resume))).scalars().all() == []
                assert (await db.execute(select(CareerTask))).scalars().all() == []
                profile_before = deepcopy((await db.get(ProfileSection, section_id)).content_json)
            replay = await resume_optimization.persist_external_resume_proposal(job_id, preparation, "request-1")
            assert replay["duplicate"] is True
            assert replay["proposal_id"] == saved["proposal_id"]
            changed = deepcopy(preparation)
            changed["user_decisions"][0]["answer"] = "Different emphasis"
            with pytest.raises(ValueError, match="request_id"):
                await resume_optimization.persist_external_resume_proposal(job_id, changed, "request-1")
            accepted = await resume_optimization.review_resume_optimization(
                proposal_id=saved["proposal_id"], action="accept"
            )
            assert accepted["status"] == "accepted"
            async with sessions() as db:
                assert (await db.get(ProfileSection, section_id)).content_json == profile_before
                resume = await db.get(Resume, accepted["accepted_resume_id"])
                assert resume.source_mode == "external_agent"
                version = await db.get(ResumeVersion, accepted["accepted_resume_version_id"])
                assert version.content_snapshot["provenance"]["source_mode"] == "external_agent"
                assert version.content_snapshot["provenance"]["request_id"] == "request-1"
    asyncio.run(run())


@pytest.mark.parametrize("damage,match", [
    ("snapshot", "source_fingerprint"),
    ("unknown_source", "已验证档案"),
    ("unsupported_metric", "所有段落"),
    ("missing_rationale", "rationale"),
    ("invented_requirement", "原文摘录"),
])
def test_external_draft_fails_closed(tmp_path, damage, match):
    async def run():
        async with _fixture(tmp_path) as (_, job_id, _, _, preparation):
            if damage == "snapshot":
                preparation["source_fingerprint"] = "stale"
            elif damage == "unknown_source":
                preparation["rows"][0]["source_section_ids"] = [99999]
            elif damage == "unsupported_metric":
                preparation["rows"][0]["content_json"][0]["description"] = "Increased revenue by 999%."
            elif damage == "missing_rationale":
                preparation["rationale"] = []
            else:
                preparation["rationale"][0]["requirement"] = "Invented hiring requirement"
            with pytest.raises(ValueError, match=match):
                await resume_optimization.persist_external_resume_proposal(job_id, preparation, "bad-request")
    asyncio.run(run())


def test_director_provenance_stays_separate(tmp_path):
    async def run():
        async with _fixture(tmp_path) as (sessions, job_id, _, _, preparation):
            async with sessions() as db:
                task = CareerTask(task_id="not-automation", task_type="career_director", source="agent",
                                  status="running", input_json={"job_id": job_id}, idempotency_key="task-1")
                db.add(task)
                await db.commit()
            with pytest.raises(ValueError, match="AutomationEvent"):
                await resume_optimization.persist_director_resume_proposal(job_id, "not-automation", preparation)
            async with sessions() as db:
                task = await db.get(CareerTask, "not-automation")
                task.source = "automation"
                await db.commit()
            saved = await resume_optimization.persist_director_resume_proposal(job_id, "not-automation", preparation)
            assert saved["trace"]["source_mode"] == "career_director"
            assert saved["trace"]["task_id"] == "not-automation"
            assert "user_decisions" not in saved["strategy"]
            replay = await resume_optimization.persist_director_resume_proposal(job_id, "not-automation", preparation)
            assert replay["duplicate"] is True
    asyncio.run(run())


def test_external_draft_opens_canonical_workspace(tmp_path):
    async def run():
        async with _fixture(tmp_path) as (sessions, job_id, _, _, preparation):
            saved = await resume_optimization.persist_external_resume_proposal(job_id, preparation, "workspace-1")
            workspace = await resume_workspace.ensure_resume_workspace(job_id, saved["proposal_id"])
            async with sessions() as db:
                resume = await db.get(Resume, workspace["resume"]["id"])
                assert job_id in resume.source_job_ids
            assert saved["proposal_id"] in {item["proposal_id"] for item in workspace["proposals"]}
            reread = await resume_workspace.get_resume_workspace(workspace["resume"]["id"])
            assert reread["job"]["id"] == job_id
    asyncio.run(run())


def test_concurrent_external_replay_persists_one_draft(tmp_path):
    async def run():
        async with _fixture(tmp_path) as (sessions, job_id, _, _, preparation):
            first, second = await asyncio.gather(*(
                resume_optimization.persist_external_resume_proposal(
                    job_id, deepcopy(preparation), "concurrent-request"
                ) for _ in range(2)
            ))
            assert first["proposal_id"] == second["proposal_id"]
            assert {first["duplicate"], second["duplicate"]} == {False, True}
            async with sessions() as db:
                proposals = (await db.execute(select(ResumeOptimizationProposal))).scalars().all()
                assert len(proposals) == 1
    asyncio.run(run())
