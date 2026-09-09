"""Deterministic contract for Resume candidate review state projection."""

import asyncio

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.database import Base
from app.models import models as _models  # noqa: F401
from app.routes.profile import _fallback_resume_candidates
from app.services.profile_operations import (
    _resume_candidate_state,
    save_profile_resume_import,
)


def test_resume_candidate_state_preserves_reviewable_memory_statuses() -> None:
    assert _resume_candidate_state({"status": "pending"}) == "pending"
    assert _resume_candidate_state({"status": "deferred"}) == "deferred"
    assert _resume_candidate_state({"status": "accepted"}) == "accepted"
    assert _resume_candidate_state({"status": "rejected"}) == "rejected"


def test_resume_candidate_state_hides_non_reviewable_transitions() -> None:
    assert _resume_candidate_state({"status": "applying"}) == "pending_review"
    assert _resume_candidate_state({}) == "pending"


def test_mechanical_import_recognizes_english_resume_section_headings() -> None:
    candidates = _fallback_resume_candidates(
        """EDUCATION
Example University | Software Engineering | BSc | 2021-2025
EXPERIENCE
Example AI Co. | AI Application Engineering Intern | 2024-07 to 2024-12
PROJECTS
AI Video Workflow | Project Lead | 2024-10 to 2025-02
SKILLS
Python, FastAPI, Prompt Engineering
"""
    )

    assert [item["section_type"] for item in candidates] == [
        "education",
        "experience",
        "project",
        "skill",
    ]


def test_resume_import_keeps_observation_id_for_first_candidate(tmp_path, monkeypatch) -> None:
    async def run() -> None:
        database_path = tmp_path / "resume-import-review.db"
        engine = create_async_engine(
            f"sqlite+aiosqlite:///{database_path.as_posix()}"
        )
        session = async_sessionmaker(
            engine,
            class_=AsyncSession,
            expire_on_commit=False,
        )
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

        async def fake_record_resume_import_evidence(**kwargs):  # noqa: ANN003
            return {
                "source_external_id": "resume:test",
                "observation_count": 1,
                "proposal_count": 1,
                "observations": [{"id": 11, "candidate_index": 0}],
                "proposals": [
                    {"id": 12, "candidate_index": 0, "status": "pending"}
                ],
            }

        monkeypatch.setattr("app.services.profile_operations.async_session", session)
        monkeypatch.setattr(
            "app.services.career_memory.record_resume_import_evidence",
            fake_record_resume_import_evidence,
        )

        result = await save_profile_resume_import(
            filename="resume.pdf",
            parse_mode="mechanical",
            parsed_text="Project Atlas",
            parse_diagnostics={},
            base_info={},
            candidates=[
                {
                    "section_type": "project",
                    "title": "Project Atlas",
                    "content_json": {"bullet": "Project Atlas"},
                }
            ],
            agent_messages_json=[],
            memory_summary={"kind": "resume_parse_memory"},
        )

        assert result["bullets"][0]["memory_proposal_id"] == 12
        assert result["bullets"][0]["observation_id"] == 11
        assert result["bullets"][0]["candidate_state"] == "pending"
        await engine.dispose()

    asyncio.run(run())
