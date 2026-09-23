"""Imported AI claims remain reviewable hypotheses, including on retries."""

import asyncio
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.database import Base
from app.models.models import LearningObservation, MemoryProposal, ProfileSection
from app.services.memory_import import MemoryImportInput, import_memory_candidates
from app.services.memory_consolidation import consolidate_memory_observations


@pytest.mark.parametrize("consent", [False, None])
def test_memory_import_requires_explicit_consent(consent) -> None:
    with pytest.raises(ValidationError):
        MemoryImportInput(source_name="Selected export", excerpts=["Career note"], consent=consent)


def test_memory_import_rejects_empty_selected_content() -> None:
    with pytest.raises(ValueError, match="至少一条"):
        asyncio.run(import_memory_candidates("Selected export", ["   "], True))


def test_memory_import_reuses_proposals_without_writing_profile(tmp_path, monkeypatch) -> None:
    async def run() -> None:
        engine = create_async_engine(f"sqlite+aiosqlite:///{(tmp_path / 'memory.db').as_posix()}")
        session = async_sessionmaker(engine, expire_on_commit=False)
        monkeypatch.setattr("app.services.career_memory.async_session", session)
        monkeypatch.setattr("app.services.memory_consolidation.async_session", session)
        monkeypatch.setattr("app.services.career_memory._index_observation_vector", AsyncMock())
        try:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            excerpt = "AI 推测我可能适合产品设计"
            first = await import_memory_candidates("Selected export", [excerpt, f" {excerpt} "], True)
            retry = await import_memory_candidates("Selected export", [excerpt], True)
            assert first["imported"] == 1
            assert retry["duplicates"] == 1
            assert first["items"][0]["id"] == retry["items"][0]["id"]
            assert first["items"][0]["status"] == "pending"
            assert first["items"][0]["target_tier"] == "career_hypothesis"
            # Background consolidation uses the same custom-category contract
            # and cannot create a second proposal or upgrade an AI claim.
            consolidated = await consolidate_memory_observations()
            assert consolidated["errors"] == []
            assert consolidated["duplicates"] == 1
            assert consolidated["proposals"][0]["id"] == first["items"][0]["id"]
            async with session() as db:
                assert await db.scalar(select(func.count()).select_from(ProfileSection)) == 0
                assert await db.scalar(select(func.count()).select_from(MemoryProposal)) == 1
                observation = (await db.execute(select(LearningObservation))).scalar_one()
                assert observation.content_json["source_excerpt"] == excerpt
                assert observation.content_json["memory_candidates"][0]["target_tier"] == "career_hypothesis"
        finally:
            await engine.dispose()

    asyncio.run(run())
