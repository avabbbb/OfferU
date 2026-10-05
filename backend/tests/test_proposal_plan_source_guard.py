import asyncio

import pytest
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.database import Base
from app.models.models import Resume, ResumeSection
from app.services import proposal_plan_sources as sources, resume_route_operations
from app.services.proposal_plan_builder import PlanValidationError
from app.services.proposal_plan_source_guard import observe_node_sources


def test_observed_own_effect_advances_sources_but_foreign_edits_do_not(tmp_path, monkeypatch):
    async def run():
        engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'sources.db'}")
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        monkeypatch.setattr(sources, "async_session", sessions)
        monkeypatch.setattr(resume_route_operations, "async_session", sessions)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with sessions() as db:
            resume = Resume(title="Original", user_name="Fixture", source_mode="manual")
            db.add(resume)
            await db.commit()
            identity = resume.id
        intent = {"operation": "create_resume_section", "args": {"resume_id": identity, "section_type": "project", "title": "Reviewed"}}
        prepared = (await sources.capture_sources([intent]))[0]
        async with observe_node_sources(prepared) as guard:
            output = await resume_route_operations.create_resume_section(**intent["args"])
            witness = await guard.finish({"ok": True, "outputs": output})
        assert witness["effect_state"] == "committed"
        assert witness["source_evidence"]["complete"]
        next_versions = witness["source_evidence"]["after_versions"]
        async with observe_node_sources(prepared, expected_versions=next_versions) as next_guard:
            await resume_route_operations.create_resume_section(**{**intent["args"], "title": "Second reviewed"})
            second = await next_guard.finish({"ok": True})
        assert second["source_evidence"]["complete"]
        async with sessions() as db:
            row = await db.get(Resume, identity)
            row.summary = "A user edit outside this node"
            await db.commit()
        with pytest.raises(PlanValidationError, match="changed before execution"):
            async with observe_node_sources(prepared, expected_versions=second["source_evidence"]["after_versions"]):
                pytest.fail("Changed source was allowed to execute")
        await engine.dispose()
    asyncio.run(run())


def test_concurrent_user_write_cannot_be_claimed_as_own_source_progress(tmp_path, monkeypatch):
    async def run():
        engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'race.db'}")
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        monkeypatch.setattr(sources, "async_session", sessions)
        monkeypatch.setattr(resume_route_operations, "async_session", sessions)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with sessions() as db:
            row = Resume(title="Original", user_name="Fixture", source_mode="manual")
            db.add(row)
            await db.commit()
            identity = row.id
        node = (await sources.capture_sources([{"operation": "create_resume_section", "args": {"resume_id": identity, "section_type": "project"}}]))[0]
        ready, edited = asyncio.Event(), asyncio.Event()
        async def user_edit():
            await ready.wait()
            async with sessions() as db:
                row = await db.get(Resume, identity)
                row.summary = "Concurrent user edit"
                await db.commit()
            edited.set()
        task = asyncio.create_task(user_edit())
        async with observe_node_sources(node) as guard:
            await resume_route_operations.create_resume_section(**node["args"])
            ready.set()
            await edited.wait()
            witness = await guard.finish({"ok": True})
        await task
        assert witness["effect_state"] == "partial"
        assert not witness["source_evidence"]["verified"]
        assert not witness["proven_no_effect"]
        await engine.dispose()
    asyncio.run(run())


def test_section_review_shows_only_changed_fields_but_binds_whole_source(tmp_path, monkeypatch):
    async def run():
        engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'display.db'}")
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        monkeypatch.setattr(sources, "async_session", sessions)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with sessions() as db:
            resume = Resume(title="Original", user_name="Fixture", source_mode="manual")
            db.add(resume)
            await db.flush()
            section = ResumeSection(resume_id=resume.id, section_type="project", title="Evidence", visible=True)
            db.add(section)
            await db.commit()
        node = (await sources.capture_sources([{
            "operation": "update_resume_section", "args": {"resume_id": resume.id,
                "section_id": section.id, "update_data": {"visible": False}},
            "affected_entities": [{"kind": "resume", "id": 999, "title": "Forged target"}],
        }]))[0]
        assert node["display"]["before"] == {"visible": True}
        assert node["display"]["after"] == {"visible": False}
        assert node["affected_entities"] == [{"kind": "resume", "id": str(resume.id), "title": "Original"},
                                            {"kind": "resume_section", "id": str(section.id), "title": "Evidence"}]
        async with sessions() as db:
            row = await db.get(ResumeSection, section.id)
            row.title = "User changed an undisplayed field"
            await db.commit()
        with pytest.raises(PlanValidationError, match="changed"):
            await sources.validate_source_versions(node["source_versions"])
        await engine.dispose()
    asyncio.run(run())


def test_legacy_node_without_source_snapshot_cannot_begin_a_write(tmp_path, monkeypatch):
    async def run():
        engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'legacy-source.db'}")
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        monkeypatch.setattr(sources, "async_session", sessions)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with sessions() as db:
            resume = Resume(title="Original", user_name="Fixture", source_mode="manual")
            db.add(resume)
            await db.commit()
        node = {"operation": "update_resume_record", "args": {"resume_id": resume.id, "update_data": {"title": "Unreviewed"}}, "source_versions": {}}
        with pytest.raises(PlanValidationError, match="snapshots are missing"):
            async with observe_node_sources(node):
                pytest.fail("A source-less legacy node reached business execution")
        async with sessions() as db:
            assert (await db.get(Resume, resume.id)).title == "Original"
        await engine.dispose()
    asyncio.run(run())
