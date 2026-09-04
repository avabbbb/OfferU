from __future__ import annotations

import asyncio
import hashlib
import unittest
from unittest.mock import patch

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import selectinload

from app.database import Base
from app.models.models import (
    Job,
    Profile,
    ProfileSection,
    Resume,
    ResumeOptimizationProposal,
)
from app.services import resume_route_operations, resume_workspace


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
            await engine.dispose()
            return {
                "first": first,
                "second": second,
                "reviewed": reviewed,
                "version": version,
                "proposal": stored,
                "section": section,
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

    def test_manual_edit_makes_unreviewed_proposal_stale(self) -> None:
        async def run() -> str:
            engine = create_async_engine("sqlite+aiosqlite:///:memory:")
            sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            fixture = await _seed(sessions, "stale")
            with patch.object(resume_workspace, "async_session", sessions), patch.object(
                resume_route_operations, "async_session", sessions
            ):
                workspace = await resume_workspace.ensure_resume_workspace(
                    job_id=fixture["job_id"], proposal_id=fixture["proposal_id"]
                )
                await resume_route_operations.update_resume_record(
                    workspace["resume"]["id"], {"summary": "用户自己的最新修改"}
                )
                with self.assertRaisesRegex(ValueError, "过期"):
                    await resume_workspace.review_resume_proposal_item(
                        proposal_id=fixture["proposal_id"],
                        resume_id=workspace["resume"]["id"],
                        change_id=fixture["change_id"],
                        action="accept",
                    )
            async with sessions() as db:
                proposal = await db.get(ResumeOptimizationProposal, fixture["proposal_id"])
            await engine.dispose()
            return proposal.status if proposal else "missing"

        self.assertEqual(asyncio.run(run()), "stale")

    def test_edit_then_accept_replaces_only_suggested_text(self) -> None:
        async def run() -> str:
            engine = create_async_engine("sqlite+aiosqlite:///:memory:")
            sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            fixture = await _seed(sessions, "edited")
            with patch.object(resume_workspace, "async_session", sessions):
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
        proposal = ResumeOptimizationProposal(
            proposal_id=proposal_id,
            job_id=job.id,
            profile_id=profile.id,
            research_run_id=f"run-{suffix}",
            status="ready",
            source_section_ids_json=[source.id],
            source_snapshot_hash="source-hash",
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
        )
        db.add(proposal)
        await db.commit()
        return {
            "job_id": job.id,
            "proposal_id": proposal_id,
            "change_id": f"change-{suffix}",
            "master_resume_id": master_resume.id,
        }
