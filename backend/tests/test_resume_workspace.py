from __future__ import annotations

import asyncio
import hashlib
import tempfile
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import selectinload

from app.database import Base
from app.models.models import (
    AutomationEvent,
    Job,
    Profile,
    ProfileSection,
    Resume,
    ResumeOptimizationProposal,
)
from app.services import resume_route_operations, resume_workspace
from app.services import automation


class ResumeWorkspaceTests(unittest.TestCase):
    def test_workspace_is_idempotent_and_reviews_one_change(self) -> None:
        async def run() -> dict:
            engine = create_async_engine("sqlite+aiosqlite:///:memory:")
            sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            fixture = await _seed(sessions, "accept")
            with patch.object(resume_workspace, "async_session", sessions), patch.object(
                resume_route_operations, "async_session", sessions
            ), patch.object(
                resume_workspace,
                "get_pre_application_state",
                new=AsyncMock(return_value={"stage": "resume_proposal_ready"}),
            ), patch.object(
                automation, "async_session", sessions
            ), patch.object(
                automation,
                "process_queued_automation_event",
                new=AsyncMock(
                    return_value={
                        "status": "completed",
                        "result": {"task_id": "career_task_fast_resume_update"},
                    }
                ),
            ):
                first = await resume_workspace.ensure_resume_workspace(
                    job_id=fixture["job_id"], proposal_id=fixture["proposal_id"]
                )
                second = await resume_workspace.ensure_resume_workspace(
                    job_id=fixture["job_id"], proposal_id=fixture["proposal_id"]
                )
                reviewed = await resume_workspace.review_resume_proposal_item(
                    proposal_id=fixture["proposal_id"],
                    resume_id=first["resume"]["id"],
                    change_id=fixture["change_id"],
                    action="accept",
                )
                version = await resume_route_operations.create_resume_version_record(
                    first["resume"]["id"],
                    change_summary="Workspace review",
                    created_by="user",
                )
            async with sessions() as db:
                stored = (
                    await db.execute(
                        select(ResumeOptimizationProposal).where(
                            ResumeOptimizationProposal.proposal_id == fixture["proposal_id"]
                        )
                    )
                ).scalar_one()
                resume = (
                    await db.execute(
                        select(Resume)
                        .where(Resume.id == first["resume"]["id"])
                        .options(selectinload(Resume.sections))
                    )
                ).scalar_one_or_none()
                section = resume.sections[0] if resume else None
                events = (
                    await db.execute(
                        select(AutomationEvent).where(AutomationEvent.event_type == "RESUME_UPDATED")
                    )
                ).scalars().all()
            await engine.dispose()
            return {
                "first": first,
                "second": second,
                "reviewed": reviewed,
                "version": version,
                "proposal": stored,
                "section": section,
                "automation_events": events,
                "master_resume_id": fixture["master_resume_id"],
            }

        result = asyncio.run(run())
        self.assertEqual(result["first"]["resume"]["id"], result["second"]["resume"]["id"])
        self.assertEqual(result["first"]["resume"]["source_resume_id"], result["master_resume_id"])
        self.assertEqual(len(result["second"]["versions"]), 1)
        self.assertEqual(result["reviewed"]["resume"]["sections"][0]["content_json"][0]["description"], "new evidence")
        self.assertEqual(result["proposal"].status, "accepted")
        self.assertEqual(result["proposal"].accepted_resume_version_id, result["version"]["id"])
        self.assertEqual(result["section"].content_json[0]["description"], "new evidence")
        self.assertEqual(
            result["version"]["automation"]["task_id"],
            "career_task_fast_resume_update",
        )
        self.assertEqual(len(result["automation_events"]), 1)
        self.assertEqual(result["automation_events"][0].payload_json["resume_version_id"], result["version"]["id"])

    def test_manual_edit_elsewhere_keeps_the_suggestion_acceptable(self) -> None:
        """人工修改优先，冲突按段落：改了别处，这条建议仍可采用。"""
        async def run() -> tuple[str, str, str]:
            engine = create_async_engine("sqlite+aiosqlite:///:memory:")
            sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            fixture = await _seed(sessions, "elsewhere")
            with patch.object(resume_workspace, "async_session", sessions), patch.object(
                resume_route_operations, "async_session", sessions
            ), patch.object(
                resume_workspace,
                "get_pre_application_state",
                new=AsyncMock(return_value={"stage": "resume_proposal_ready"}),
            ):
                workspace = await resume_workspace.ensure_resume_workspace(
                    job_id=fixture["job_id"], proposal_id=fixture["proposal_id"]
                )
                await resume_route_operations.update_resume_record(
                    workspace["resume"]["id"], {"summary": "用户自己的最新修改"}
                )
                reviewed = await resume_workspace.review_resume_proposal_item(
                    proposal_id=fixture["proposal_id"],
                    resume_id=workspace["resume"]["id"],
                    change_id=fixture["change_id"],
                    action="accept",
                )
            async with sessions() as db:
                proposal = await db.get(ResumeOptimizationProposal, fixture["proposal_id"])
            await engine.dispose()
            return (
                proposal.status if proposal else "missing",
                reviewed["resume"]["summary"],
                reviewed["resume"]["sections"][0]["content_json"][0]["description"],
            )

        status, summary, description = asyncio.run(run())
        self.assertNotEqual(status, "stale")
        self.assertEqual(summary, "用户自己的最新修改")
        self.assertEqual(description, "new evidence")

    def test_manual_edit_of_the_target_section_blocks_only_that_suggestion(self) -> None:
        """建议要改的那一段被用户改过：不覆盖用户版本，提案整体也不失效。"""
        async def run() -> tuple[str, str]:
            engine = create_async_engine("sqlite+aiosqlite:///:memory:")
            sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            fixture = await _seed(sessions, "target-edit")
            with patch.object(resume_workspace, "async_session", sessions), patch.object(
                resume_route_operations, "async_session", sessions
            ), patch.object(
                resume_workspace,
                "get_pre_application_state",
                new=AsyncMock(return_value={"stage": "resume_proposal_ready"}),
            ):
                workspace = await resume_workspace.ensure_resume_workspace(
                    job_id=fixture["job_id"], proposal_id=fixture["proposal_id"]
                )
                sections = [dict(item) for item in workspace["resume"]["sections"]]
                sections[0]["content_json"] = [{"company": "Example", "description": "用户亲手写的版本"}]
                await resume_route_operations.update_resume_record(
                    workspace["resume"]["id"], {"sections": sections}
                )
                with self.assertRaisesRegex(ValueError, "改过"):
                    await resume_workspace.review_resume_proposal_item(
                        proposal_id=fixture["proposal_id"],
                        resume_id=workspace["resume"]["id"],
                        change_id=fixture["change_id"],
                        action="accept",
                    )
                current = await resume_workspace.get_resume_workspace(workspace["resume"]["id"])
            async with sessions() as db:
                proposal = await db.get(ResumeOptimizationProposal, fixture["proposal_id"])
            await engine.dispose()
            return (
                proposal.status if proposal else "missing",
                current["resume"]["sections"][0]["content_json"][0]["description"],
            )

        status, description = asyncio.run(run())
        self.assertNotEqual(status, "stale")
        self.assertEqual(description, "用户亲手写的版本")

    def test_edit_then_accept_replaces_only_suggested_text(self) -> None:
        async def run() -> str:
            engine = create_async_engine("sqlite+aiosqlite:///:memory:")
            sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            fixture = await _seed(sessions, "edited")
            with patch.object(
                resume_workspace,
                "async_session",
                sessions,
            ), patch.object(
                resume_workspace,
                "get_pre_application_state",
                new=AsyncMock(return_value={"stage": "resume_proposal_ready"}),
            ):
                workspace = await resume_workspace.ensure_resume_workspace(
                    job_id=fixture["job_id"], proposal_id=fixture["proposal_id"]
                )
                reviewed = await resume_workspace.review_resume_proposal_item(
                    proposal_id=fixture["proposal_id"],
                    resume_id=workspace["resume"]["id"],
                    change_id=fixture["change_id"],
                    action="accept",
                    edited_text="用户确认后的描述",
                )
            await engine.dispose()
            return reviewed["resume"]["sections"][0]["content_json"][0]["description"]

        self.assertEqual(asyncio.run(run()), "用户确认后的描述")

    def test_edited_text_with_fabricated_claim_requires_confirmation(self) -> None:
        async def run() -> dict:
            engine = create_async_engine("sqlite+aiosqlite:///:memory:")
            sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            fixture = await _seed(sessions, "fabricated")
            with patch.object(
                resume_workspace,
                "async_session",
                sessions,
            ), patch.object(
                resume_workspace,
                "get_pre_application_state",
                new=AsyncMock(return_value={"stage": "resume_proposal_ready"}),
            ):
                workspace = await resume_workspace.ensure_resume_workspace(
                    job_id=fixture["job_id"], proposal_id=fixture["proposal_id"]
                )
                fabricated = "Scaled Kubernetes platform, improved throughput by 80%."
                with self.assertRaisesRegex(ValueError, "确认"):
                    await resume_workspace.review_resume_proposal_item(
                        proposal_id=fixture["proposal_id"],
                        resume_id=workspace["resume"]["id"],
                        change_id=fixture["change_id"],
                        action="accept",
                        edited_text=fabricated,
                    )
                # Same text submitted again = explicit confirmation → applied.
                reviewed = await resume_workspace.review_resume_proposal_item(
                    proposal_id=fixture["proposal_id"],
                    resume_id=workspace["resume"]["id"],
                    change_id=fixture["change_id"],
                    action="accept",
                    edited_text=fabricated,
                )
            await engine.dispose()
            return {
                "description": reviewed["resume"]["sections"][0]["content_json"][0]["description"],
            }

        result = asyncio.run(run())
        self.assertEqual(
            result["description"],
            "Scaled Kubernetes platform, improved throughput by 80%.",
        )

    def test_edited_text_grounded_in_source_applies_directly(self) -> None:
        async def run() -> dict:
            engine = create_async_engine("sqlite+aiosqlite:///:memory:")
            sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            fixture = await _seed(sessions, "grounded")
            with patch.object(
                resume_workspace,
                "async_session",
                sessions,
            ), patch.object(
                resume_workspace,
                "get_pre_application_state",
                new=AsyncMock(return_value={"stage": "resume_proposal_ready"}),
            ):
                workspace = await resume_workspace.ensure_resume_workspace(
                    job_id=fixture["job_id"], proposal_id=fixture["proposal_id"]
                )
                reviewed = await resume_workspace.review_resume_proposal_item(
                    proposal_id=fixture["proposal_id"],
                    resume_id=workspace["resume"]["id"],
                    change_id=fixture["change_id"],
                    action="accept",
                    edited_text="old evidence refined",
                )
            await engine.dispose()
            return {
                "description": reviewed["resume"]["sections"][0]["content_json"][0]["description"],
                "duplicate": reviewed["duplicate"],
            }

        result = asyncio.run(run())
        self.assertEqual(result["description"], "old evidence refined")
        self.assertFalse(result["duplicate"])

    def test_batch_review_is_atomic_and_retry_is_idempotent(self) -> None:
        async def run(invalid_target: bool) -> dict:
            engine = create_async_engine("sqlite+aiosqlite:///:memory:")
            sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            fixture = await _seed(sessions, "batch")
            with patch.object(resume_workspace, "async_session", sessions), patch.object(
                resume_workspace, "get_pre_application_state",
                new=AsyncMock(return_value={"stage": "resume_proposal_ready"}),
            ):
                workspace = await resume_workspace.ensure_resume_workspace(
                    job_id=fixture["job_id"], proposal_id=fixture["proposal_id"]
                )
                async with sessions() as db:
                    proposal = await db.get(ResumeOptimizationProposal, fixture["proposal_id"])
                    first = proposal.diff_json[0]
                    second = {**first, "change_id": "second"}
                    if invalid_target:
                        second = {**second, "before": {"title": "missing", "section_type": "education"}, "after": {"title": "missing"}}
                    else:
                        second = {**second, "change_type": "added", "after": {**first["after"], "title": "新增项目", "source_section_ids": []}}
                    proposal.diff_json = [first, second]
                    await db.commit()
                args = dict(proposal_id=fixture["proposal_id"], resume_id=workspace["resume"]["id"],
                            change_ids=[fixture["change_id"], "second"], action="accept")
                if invalid_target:
                    with self.assertRaisesRegex(ValueError, "目标段落"):
                        await resume_workspace.review_resume_proposal_items(**args)
                else:
                    await resume_workspace.review_resume_proposal_items(**args)
                    retry = await resume_workspace.review_resume_proposal_items(**args)
                    self.assertTrue(retry["duplicate"])
                    with self.assertRaisesRegex(ValueError, "不同审核"):
                        await resume_workspace.review_resume_proposal_items(**{**args, "action": "reject"})
                async with sessions() as db:
                    proposal = await db.get(ResumeOptimizationProposal, fixture["proposal_id"])
                    resume = await resume_workspace._load_resume(db, workspace["resume"]["id"])
                    result = {"reviews": proposal.item_reviews_json or {}, "revision": resume.workspace_revision,
                              "sections": len(resume.sections), "description": resume.sections[0].content_json[0]["description"],
                              "initial_revision": workspace["resume"]["workspace_revision"]}
            await engine.dispose()
            return result

        for invalid in [False, True]:
            with self.subTest(invalid_target=invalid):
                result = asyncio.run(run(invalid))
                self.assertEqual(result["revision"], result["initial_revision"] + (0 if invalid else 1))
                self.assertEqual(len(result["reviews"]), 0 if invalid else 2)
                self.assertEqual(result["sections"], 1 if invalid else 2)
                self.assertEqual(result["description"], "old evidence" if invalid else "new evidence")

    def test_concurrent_batch_retry_changes_resume_once(self) -> None:
        async def run(database_path: Path) -> None:
            engine = create_async_engine(f"sqlite+aiosqlite:///{database_path.as_posix()}")
            sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            fixture = await _seed(sessions, "concurrent-batch")
            with patch.object(resume_workspace, "async_session", sessions), patch.object(
                resume_workspace, "get_pre_application_state", new=AsyncMock(return_value={"stage": "resume_proposal_ready"}),
            ):
                workspace = await resume_workspace.ensure_resume_workspace(job_id=fixture["job_id"], proposal_id=fixture["proposal_id"])
                args = dict(proposal_id=fixture["proposal_id"], resume_id=workspace["resume"]["id"], change_ids=[fixture["change_id"]], action="accept")
                results = await asyncio.gather(*[resume_workspace.review_resume_proposal_items(**args) for _ in range(2)])
                self.assertEqual(sorted(result["duplicate"] for result in results), [False, True])
                async with sessions() as db:
                    resume = await db.get(Resume, workspace["resume"]["id"])
                    self.assertEqual(resume.workspace_revision, workspace["resume"]["workspace_revision"] + 1)
            await engine.dispose()
        Path("H:/tmp/offeru").mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir="H:/tmp/offeru") as temp_dir:
            asyncio.run(run(Path(temp_dir) / "batch.db"))

    def test_batch_review_reject_does_not_refresh_stale_workspace_hash(self) -> None:
        async def run() -> None:
            engine = create_async_engine("sqlite+aiosqlite:///:memory:")
            sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            fixture = await _seed(sessions, "reject-stale")
            with patch.object(resume_workspace, "async_session", sessions), patch.object(
                resume_workspace, "get_pre_application_state", new=AsyncMock(return_value={"stage": "resume_proposal_ready"}),
            ):
                workspace = await resume_workspace.ensure_resume_workspace(job_id=fixture["job_id"], proposal_id=fixture["proposal_id"])
                async with sessions() as db:
                    proposal = await db.get(ResumeOptimizationProposal, fixture["proposal_id"])
                    proposal.diff_json = [*proposal.diff_json, {**proposal.diff_json[0], "change_id": "other"}]
                    from app.models.models import ResumeSection
                    section = (await db.execute(select(ResumeSection).where(ResumeSection.resume_id == workspace["resume"]["id"]))).scalars().first()
                    section.content_json = [{"company": "Example", "description": "manual edit"}]
                    await db.commit()
                await resume_workspace.review_resume_proposal_items(fixture["proposal_id"], workspace["resume"]["id"], ["other"], "reject")
                # A reject must not launder a manual edit of the target section.
                with self.assertRaisesRegex(ValueError, "改过"):
                    await resume_workspace.review_resume_proposal_items(fixture["proposal_id"], workspace["resume"]["id"], [fixture["change_id"]], "accept")
            await engine.dispose()
        asyncio.run(run())

    def test_workspace_requires_confirmed_pre_application_decision(self) -> None:
        async def run() -> None:
            with patch.object(
                resume_workspace,
                "get_pre_application_state",
                new=AsyncMock(return_value={"stage": "needs_decision"}),
            ), patch.object(
                resume_workspace,
                "_has_live_director_proposal",
                new=AsyncMock(return_value=False),
            ):
                with self.assertRaisesRegex(ValueError, "确认投或有条件投"):
                    await resume_workspace.ensure_resume_workspace(job_id=7)

        asyncio.run(run())


async def _seed(sessions, suffix: str) -> dict[str, int | str]:
    async with sessions() as db:
        profile = Profile(name=f"测试候选人-{suffix}", is_default=True)
        job = Job(
            title="AI Product Manager",
            company=f"OfferU Test {suffix}",
            raw_description="Build product evaluation workflows.",
            hash_key=hashlib.sha256(suffix.encode()).hexdigest(),
        )
        db.add_all([profile, job])
        await db.flush()
        master_resume = Resume(
            user_name=profile.name,
            title="Master Resume",
            source_mode="manual",
            is_primary=True,
            source_profile_id=profile.id,
        )
        db.add(master_resume)
        await db.flush()
        source = ProfileSection(
            profile_id=profile.id,
            section_type="experience",
            title="项目经历",
            tier="verified_fact",
            status="active",
            content_json={"normalized": {"description": "old evidence"}},
        )
        db.add(source)
        await db.flush()
        before = {
            "section_type": "experience",
            "title": "工作经历",
            "sort_order": 0,
            "visible": True,
            "content_json": [{"company": "Example", "description": "old evidence"}],
            "source_section_ids": [source.id],
        }
        after = {**before, "content_json": [{"company": "Example", "description": "new evidence"}]}
        proposal_id = f"resume_opt_workspace_{suffix}"
        from app.services.resume_optimization import _profile_snapshot_hash, _sha256

        proposal = ResumeOptimizationProposal(
            proposal_id=proposal_id,
            job_id=job.id,
            profile_id=profile.id,
            research_run_id=f"run-{suffix}",
            status="ready",
            source_section_ids_json=[source.id],
            source_snapshot_hash=_profile_snapshot_hash([source]),
            research_snapshot_hash="research-hash",
            original_rows_json=[before],
            proposed_rows_json=[after],
            diff_json=[{
                "change_id": f"change-{suffix}",
                "change_type": "modified",
                "section_key": "experience:工作经历",
                "section_type": "experience",
                "title": "工作经历",
                "source_section_ids": [source.id],
                "before": before,
                "after": after,
            }],
            fact_gates_json={"status": "passed"},
            strategy_json={"job_description_sha256": _sha256(job.raw_description)},
        )
        db.add(proposal)
        await db.commit()
        return {
            "job_id": job.id,
            "proposal_id": proposal_id,
            "change_id": f"change-{suffix}",
            "master_resume_id": master_resume.id,
        }
