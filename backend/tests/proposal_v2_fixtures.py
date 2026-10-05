"""Real Registry inputs and isolated persistence helpers for Proposal v2 faults.

All records created here are synthetic test data in a file-backed SQLite DB.
Business effects still pass through app.ops.execute_operation.
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine


@dataclass
class ProposalV2Database:
    url: str
    engine: Any
    sessions: Any
    monkeypatch: Any

    def _patch_sessions(self) -> None:
        import app.ops as ops
        from app.services import agent_run_state
        from app.services import agent_run_coordinator
        from app.services import operation_projection
        from app.services import proposal_plan_continuation
        from app.services import proposal_plan_execution
        from app.services import proposal_plan_store
        from app.services import proposal_plan_sources
        from app.services import resume_route_operations
        from app.services import resume_workspace

        for module in (
            ops,
            agent_run_coordinator,
            agent_run_state,
            operation_projection,
            proposal_plan_continuation,
            proposal_plan_execution,
            proposal_plan_store,
            proposal_plan_sources,
            resume_route_operations,
            resume_workspace,
        ):
            if hasattr(module, "async_session"):
                self.monkeypatch.setattr(module, "async_session", self.sessions)

    async def start(self, *, create_schema: bool = False) -> None:
        self.engine = create_async_engine(self.url, connect_args={"timeout": 10})

        @event.listens_for(self.engine.sync_engine, "connect")
        def _sqlite_test_pragmas(connection, _record):  # noqa: ANN001
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA busy_timeout=10000")

        self.sessions = async_sessionmaker(
            self.engine, class_=AsyncSession, expire_on_commit=False
        )
        self._patch_sessions()
        if create_schema:
            from app.database import Base, CURRENT_SCHEMA_VERSION, run_schema_migrations
            import app.models.models  # noqa: F401

            async with self.engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
                result = await connection.run_sync(run_schema_migrations)
                if result.get("to_version") != CURRENT_SCHEMA_VERSION:
                    raise RuntimeError("isolated Proposal v2 DB did not reach the current schema")

    async def restart(self) -> None:
        await self.engine.dispose()
        await self.start()

    async def close(self) -> None:
        await self.engine.dispose()


async def seed_resume(database: ProposalV2Database) -> dict[str, Any]:
    """Create one canonical Resume and three real sections in the test DB."""

    from app.models.models import Profile, Resume, ResumeSection

    async with database.sessions() as db:
        profile = Profile(name="Proposal v2 isolated fixture", is_default=True)
        db.add(profile)
        await db.flush()
        resume = Resume(
            user_name=profile.name,
            title="Proposal v2 isolated resume",
            source_mode="manual",
            is_primary=True,
            source_profile_id=profile.id,
            summary="Original summary",
        )
        db.add(resume)
        await db.flush()
        sections = [
            ResumeSection(
                resume_id=resume.id,
                section_type=section_type,
                title=title,
                sort_order=position,
                visible=True,
                content_json=[{"description": f"Original {title} evidence"}],
            )
            for position, (section_type, title) in enumerate(
                (("education", "Education"), ("workExperiences", "Experience"), ("skills", "Skills"))
            )
        ]
        db.add_all(sections)
        await db.commit()
        return {
            "profile_id": profile.id,
            "resume_id": resume.id,
            "section_ids": [section.id for section in sections],
            "source_revision": int(resume.workspace_revision or 0),
        }


async def seed_reviewable_resume_proposal(
    database: ProposalV2Database, suffix: str
) -> dict[str, Any]:
    """Seed the same real domain objects as test_resume_workspace._seed."""

    from app.models.models import (
        Job,
        Profile,
        ProfileSection,
        Resume,
        ResumeOptimizationProposal,
    )
    from app.services.resume_optimization import _profile_snapshot_hash, _sha256

    async with database.sessions() as db:
        profile = Profile(name=f"Proposal v2 review {suffix}", is_default=True)
        job = Job(
            title="AI Product Manager",
            company=f"OfferU Proposal Review {suffix}",
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
        source = ProfileSection(
            profile_id=profile.id,
            section_type="experience",
            title="项目经历",
            tier="verified_fact",
            status="active",
            content_json={"normalized": {"description": "old evidence"}},
        )
        db.add_all([master_resume, source])
        await db.flush()
        before = {
            "section_type": "experience",
            "title": "工作经历",
            "sort_order": 0,
            "visible": True,
            "content_json": [{"company": "Example", "description": "old evidence"}],
            "source_section_ids": [source.id],
        }
        after = {
            **before,
            "content_json": [{"company": "Example", "description": "new evidence"}],
        }
        proposal_id = f"resume_opt_proposal_v2_{suffix}"
        change_id = f"change-{suffix}"
        db.add(
            ResumeOptimizationProposal(
                proposal_id=proposal_id,
                job_id=job.id,
                profile_id=profile.id,
                research_run_id=None,
                status="ready",
                source_section_ids_json=[source.id],
                source_snapshot_hash=_profile_snapshot_hash([source]),
                research_snapshot_hash="isolated-review-fixture",
                original_rows_json=[before],
                proposed_rows_json=[after],
                diff_json=[
                    {
                        "change_id": change_id,
                        "change_type": "modified",
                        "section_key": "experience:工作经历",
                        "section_type": "experience",
                        "title": "工作经历",
                        "source_section_ids": [source.id],
                        "before": before,
                        "after": after,
                    }
                ],
                fact_gates_json={"status": "passed"},
                strategy_json={
                    "job_description_sha256": _sha256(job.raw_description),
                },
            )
        )
        await db.commit()
        return {
            "job_id": job.id,
            "profile_id": profile.id,
            "proposal_id": proposal_id,
            "change_id": change_id,
            "master_resume_id": master_resume.id,
            "source_section_id": source.id,
        }


def resume_mutation_intents(seed: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Build 18 schema-valid Registry mutations in four supplied semantic groups."""

    resume_id = int(seed["resume_id"])
    section_ids = [int(value) for value in seed["section_ids"]]
    intents: list[dict[str, Any]] = []

    def add(operation: str, args: dict[str, Any], summary: str, before: str, after: str) -> None:
        number = len(intents) + 1
        intents.append(
            {
                "id": f"resume-intent-{number:02d}",
                "operation": operation,
                "args": args,
                "summary": summary,
                "source_versions": {"resume_id": resume_id, "workspace_revision": seed["source_revision"]},
                "display": {"before": before, "after": after, "evidence_refs": [f"fixture://resume/{resume_id}/section/{number}"]},
            }
        )

    for index in range(5):
        add(
            "create_resume_section",
            {
                "resume_id": resume_id,
                "section_type": "project",
                "title": f"Role evidence {index + 1}",
                "sort_order": 3 + index,
                "visible": True,
                "content_json": [{"name": f"Fixture project {index + 1}", "description": f"Reviewed evidence item {index + 1}"}],
            },
            f"Add reviewed role evidence section {index + 1}",
            "No role-specific section",
            f"Role evidence {index + 1}",
        )

    for index in range(5):
        section_id = section_ids[index % len(section_ids)]
        add(
            "update_resume_section",
            {
                "resume_id": resume_id,
                "section_id": section_id,
                "update_data": {
                    "title": f"Reviewed section revision {index + 1}",
                    "content_json": [{"description": f"Evidence-backed fixture revision {index + 1}"}],
                },
            },
            f"Revise existing resume section {index + 1}",
            "Original section wording",
            f"Evidence-backed fixture revision {index + 1}",
        )

    for index in range(4):
        add(
            "create_resume_section",
            {
                "resume_id": resume_id,
                "section_type": "custom",
                "title": f"Supporting detail {index + 1}",
                "sort_order": 8 + index,
                "visible": True,
                "content_json": [{"subtitle": f"Fixture detail {index + 1}", "description": "Synthetic acceptance evidence"}],
            },
            f"Add supporting detail {index + 1}",
            "No supporting detail",
            f"Supporting detail {index + 1}",
        )

    add(
        "update_resume_record",
        {"resume_id": resume_id, "update_data": {"title": "Role-focused fixture resume"}},
        "Name the role-focused resume",
        "Proposal v2 isolated resume",
        "Role-focused fixture resume",
    )
    add(
        "update_resume_record",
        {"resume_id": resume_id, "update_data": {"summary": "Summary from reviewed fixture evidence"}},
        "Update the summary from reviewed evidence",
        "Original summary",
        "Summary from reviewed fixture evidence",
    )
    add(
        "reorder_resume_sections",
        {
            "resume_id": resume_id,
            "items": [
                {"id": section_ids[1], "sort_order": 0},
                {"id": section_ids[0], "sort_order": 1},
                {"id": section_ids[2], "sort_order": 2},
            ],
        },
        "Order the role-relevant sections first",
        "Original section order",
        "Experience, education, skills",
    )
    add(
        "create_resume_version_record",
        {"resume_id": resume_id, "change_summary": "Reviewed Proposal v2 fixture changes", "created_by": "user"},
        "Save the reviewed resume version",
        "No version for this review",
        "Versioned reviewed resume",
    )
    assert len(intents) == 18

    labels = [intent["id"] for intent in intents]
    groups = []
    ranges = ((0, 5, "Role evidence additions"), (5, 10, "Existing section revisions"),
              (10, 14, "Supporting details"), (14, 18, "Resume order and snapshot"))
    for start, end, title in ranges:
        groups.append(
            {
                "id": title.lower().replace(" ", "-"),
                "title": title,
                "rationale": f"The user reviews the concrete {title.lower()} as one bounded resume decision.",
                "summary": title,
                "node_ids": labels[start:end],
                "display": {"before": "Original resume state", "after": title},
            }
        )
    return intents, groups


def make_db(tmp_path: Path, monkeypatch: Any) -> ProposalV2Database:
    if os.name == "nt" and tmp_path.drive.upper() != "H:":
        raise RuntimeError("Proposal v2 acceptance DBs must stay under H:\\tmp\\offeru")
    runtime_dir = tmp_path / "proposal-v2-runtime"
    runtime_dir.mkdir(parents=True, exist_ok=True)
    path = runtime_dir / "djm.db"
    return ProposalV2Database(
        url=f"sqlite+aiosqlite:///{path.as_posix()}",
        engine=None,
        sessions=None,
        monkeypatch=monkeypatch,
    )


async def seed_legacy_v5_run_statuses(
    database: ProposalV2Database, resume_id: int
) -> dict[str, str]:
    """Persist old operation-step states into an actual schema-v5 fixture DB."""

    from sqlalchemy import select

    from app.models.models import AgentRunRecord
    from app.services import agent_run_state

    fixtures = {
        "pending": ("waiting_confirmation", "waiting_confirmation"),
        "executing": ("executing", "executing"),
        "completed": ("completed", "completed"),
        "failed": ("failed", "failed"),
        "rejected": ("completed", "rejected"),
        "uncertain": ("needs_reconciliation", "uncertain"),
    }
    run_ids: dict[str, str] = {}
    for label, (run_status, step_status) in fixtures.items():
        run_id = f"run_{uuid4().hex[:16]}"
        await agent_run_state.create_agent_run(
            conversation_id=f"proposal-v2-legacy-{label}",
            goal=f"Legacy fixture {label}",
            mode="operation_projection",
            skill_id="tailor_resume",
            actions=[
                {
                    "id": f"legacy-{label}",
                    "tool": "update_resume_record",
                    "args": {"resume_id": resume_id, "update_data": {"summary": f"legacy-{label}"}},
                    "summary": f"Legacy resume update {label}",
                }
            ],
            run_id=run_id,
        )
        async with database.sessions() as db:
            row = (await db.execute(select(AgentRunRecord).where(AgentRunRecord.run_id == run_id))).scalar_one()
            steps = [dict(step) for step in row.steps_json]
            steps[0]["status"] = step_status
            if step_status == "completed":
                steps[0]["result"] = {"resume_id": resume_id, "committed": True}
                steps[0]["completed_at"] = "2026-10-01T10:00:00+00:00"
            elif step_status in {"failed", "uncertain"}:
                steps[0]["error"] = f"legacy-{step_status} fixture"
            row.steps_json = steps
            row.status = run_status
            await db.commit()
        run_ids[label] = run_id
    return run_ids
