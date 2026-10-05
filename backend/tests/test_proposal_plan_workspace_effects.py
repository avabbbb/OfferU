"""Read-back proof tests for the existing Resume Workspace Registry operation."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.database import Base
from app.models.models import (
    Job,
    Profile,
    Resume,
    ResumeOptimizationProposal,
    ResumeSection,
    ResumeVersion,
)
from app.ops import OPERATIONS
from app.services import proposal_plan_sources, proposal_plan_source_guard, resume_workspace
from app.services.proposal_plan_workspace_effects import verify_workspace_effect


@pytest.fixture
def workspace_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    if os.name == "nt" and tmp_path.drive.upper() != "H:":
        raise RuntimeError("Workspace proof tests require an isolated H: temporary database")
    database_path = tmp_path / "workspace-proof.db"
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{database_path.as_posix()}",
        connect_args={"timeout": 10},
    )

    @event.listens_for(engine.sync_engine, "connect")
    def _sqlite_test_pragmas(connection, _record):
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=10000")

    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    database = SimpleNamespace(sessions=sessions, engine=engine)

    async def create_schema() -> None:
        import app.models.models  # noqa: F401

        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.run(create_schema())
    monkeypatch.setattr(proposal_plan_sources, "async_session", database.sessions)
    monkeypatch.setattr(resume_workspace, "async_session", database.sessions)
    monkeypatch.setattr(proposal_plan_source_guard.sources, "async_session", database.sessions)
    monkeypatch.setattr(
        resume_workspace,
        "_require_resume_proposal_gate",
        _allow_workspace_for_isolated_test,
    )
    yield database
    asyncio.run(engine.dispose())


async def _allow_workspace_for_isolated_test(*_args, **_kwargs) -> None:
    return None


async def _seed_job_profile_resume(database) -> dict[str, int]:
    async with database.sessions() as db:
        profile = Profile(name="Synthetic workspace profile", is_default=True)
        job = Job(
            title="Synthetic analyst role",
            company="Synthetic company",
            hash_key=f"workspace-{uuid4().hex}",
            raw_description="Synthetic role description",
        )
        db.add_all([profile, job])
        await db.flush()
        master = Resume(
            user_name=profile.name,
            title="Synthetic master resume",
            source_mode="manual",
            is_primary=True,
            source_profile_id=profile.id,
            summary="Synthetic summary",
        )
        master.sections.append(
            ResumeSection(
                section_type="workExperiences",
                title="Synthetic experience",
                sort_order=0,
                visible=True,
                content_json=[{"description": "Synthetic evidence"}],
            )
        )
        db.add(master)
        await db.commit()
        return {"job_id": job.id, "profile_id": profile.id, "master_id": master.id}


async def _captured_node(ids: dict[str, int], *, proposal_id: str | None = None) -> dict:
    args = {"job_id": ids["job_id"], "reference_resume_id": ids["master_id"]}
    if proposal_id:
        args["proposal_id"] = proposal_id
    intent = {
        "id": f"workspace-node-{uuid4().hex}",
        "operation": "ensure_resume_workspace",
        "args": args,
        "summary": "Prepare the reviewed role-specific Resume Workspace",
    }
    captured = (await proposal_plan_sources.capture_sources([intent]))[0]
    captured["operation_version"] = OPERATIONS["ensure_resume_workspace"].version
    return captured


async def _execute_with_witness(node: dict) -> tuple[dict, dict]:
    async with proposal_plan_source_guard.observe_node_sources(
        node, expected_versions=node["source_versions"]
    ) as guard:
        outputs = await resume_workspace.ensure_resume_workspace(**node["args"])
        envelope = {
            "ok": True,
            "operation": node["operation"],
            "operation_version": node["operation_version"],
            "outputs": outputs,
        }
        witness = await guard.finish(envelope)
    return envelope, witness


def test_proves_real_registry_business_rows_for_new_workspace(workspace_db) -> None:
    async def scenario():
        ids = await _seed_job_profile_resume(workspace_db)
        node = await _captured_node(ids)
        result, witness = await _execute_with_witness(node)
        proof = await verify_workspace_effect(node, result, witness)
        assert proof["verified"] is True, proof
        assert proof["effect_state"] == "committed"
        assert proof["mode"] == "created"
        assert proof["source_resume_id"] == ids["master_id"]
        assert proof["source_evidence"]["complete"] is True
        assert proof["source_evidence"]["workspace_effect"]["kind"] == "resume_workspace"
        async with workspace_db.sessions() as db:
            resume = await db.get(Resume, proof["workspace_id"])
            assert resume is not None
            assert resume.target_job_id == ids["job_id"]
            assert resume.source_profile_id == ids["profile_id"]
            assert resume.source_resume_id == ids["master_id"]
            assert resume.current_version_id is not None
            assert await db.get(ResumeVersion, resume.current_version_id) is not None

    asyncio.run(scenario())


def test_proves_idempotent_reuse_of_the_reviewed_workspace(workspace_db) -> None:
    async def scenario():
        ids = await _seed_job_profile_resume(workspace_db)
        first_node = await _captured_node(ids)
        first_result, first_witness = await _execute_with_witness(first_node)
        first = await verify_workspace_effect(first_node, first_result, first_witness)
        assert first["verified"] is True, first

        second_node = await _captured_node(ids)
        assert second_node["display"]["before"]["workspace_resume_id"] == first["workspace_id"]
        second_result, second_witness = await _execute_with_witness(second_node)
        second = await verify_workspace_effect(second_node, second_result, second_witness)
        assert second["verified"] is True, second
        assert second["effect_state"] == "committed"
        assert second["mode"] == "reused"
        assert second["workspace_id"] == first["workspace_id"]
        assert second_witness["source_evidence"]["unbound_effects"] == []

    asyncio.run(scenario())


def test_does_not_trust_success_output_without_a_persisted_workspace(workspace_db) -> None:
    async def scenario():
        ids = await _seed_job_profile_resume(workspace_db)
        node = await _captured_node(ids)
        fake = {
            "ok": True,
            "operation": node["operation"],
            "operation_version": node["operation_version"],
            "outputs": {
                "job": {"id": ids["job_id"]},
                "resume": {"id": 999999, "target_job_id": ids["job_id"]},
            },
        }
        async with proposal_plan_source_guard.observe_node_sources(node) as guard:
            witness = await guard.finish(fake)
        proof = await verify_workspace_effect(node, fake, witness)
        assert proof["verified"] is False
        assert proof["effect_state"] == "unknown"

    asyncio.run(scenario())


def test_rejects_registry_sections_that_differ_from_canonical_readback(workspace_db) -> None:
    async def scenario():
        ids = await _seed_job_profile_resume(workspace_db)
        node = await _captured_node(ids)
        result, witness = await _execute_with_witness(node)
        result["outputs"]["resume"]["sections"][0]["content_json"] = [
            {"description": "unpersisted forged section"}
        ]
        proof = await verify_workspace_effect(node, result, witness)
        assert proof["verified"] is False
        assert proof["effect_state"] == "unknown"

    asyncio.run(scenario())


def test_rejects_missing_sealed_source_hash_instead_of_making_one(workspace_db) -> None:
    async def scenario():
        ids = await _seed_job_profile_resume(workspace_db)
        node = await _captured_node(ids)
        result, witness = await _execute_with_witness(node)
        del node["source_versions"][f"resume:{ids['master_id']}"]
        proof = await verify_workspace_effect(node, result, witness)
        assert proof["verified"] is False
        assert proof["effect_state"] == "unknown"

    asyncio.run(scenario())


def test_proposal_link_proves_workspace_binding_without_claiming_acceptance(workspace_db) -> None:
    async def scenario():
        ids = await _seed_job_profile_resume(workspace_db)
        proposal_id = f"proposal-{uuid4().hex}"
        async with workspace_db.sessions() as db:
            db.add(
                ResumeOptimizationProposal(
                    proposal_id=proposal_id,
                    job_id=ids["job_id"],
                    profile_id=ids["profile_id"],
                    reference_resume_id=ids["master_id"],
                    status="ready",
                    source_snapshot_hash="a" * 64,
                    research_snapshot_hash="b" * 64,
                    original_rows_json=[
                        {
                            "section_type": "workExperiences",
                            "title": "Reviewed baseline",
                            "sort_order": 0,
                            "content_json": [{"description": "Synthetic proposal baseline"}],
                        }
                    ],
                    proposed_rows_json=[],
                    diff_json=[],
                    trace_json={"source_mode": "external_agent"},
                )
            )
            await db.commit()

        node = await _captured_node(ids, proposal_id=proposal_id)
        result, witness = await _execute_with_witness(node)
        proof = await verify_workspace_effect(node, result, witness)
        assert proof["verified"] is True, proof
        assert proof["proposal_id"] == proposal_id
        assert "accepted_resume_id" not in proof
        async with workspace_db.sessions() as db:
            proposal = await db.get(ResumeOptimizationProposal, proposal_id)
            assert proposal is not None
            assert proposal.workspace_resume_id == proof["workspace_id"]
            assert proposal.accepted_resume_id is None

    asyncio.run(scenario())
