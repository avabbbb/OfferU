"""New resumes open on the paper canvas; existing and derived ones keep their look."""

import asyncio
from contextlib import AsyncExitStack
from unittest.mock import patch

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.database import Base
from app.models.models import Resume
from app.services import resume_route_operations as routes
from app.services.resume_builder import NEW_RESUME_DEFAULT_TEMPLATE, with_new_resume_template


def test_helper_only_fills_a_missing_template_on_brand_new_resumes():
    assert NEW_RESUME_DEFAULT_TEMPLATE == "paper"
    assert with_new_resume_template({}, derived_from_existing=False) == {"template": "paper"}
    assert with_new_resume_template(None, derived_from_existing=False) == {"template": "paper"}
    # An explicit choice always wins, in either legacy key.
    assert with_new_resume_template({"template": "reference"}, derived_from_existing=False)["template"] == "reference"
    assert "template" not in with_new_resume_template({"templateType": "modern"}, derived_from_existing=False)
    # Derived from an existing resume: keep exactly what the source rendered as.
    assert with_new_resume_template({"bodySize": "10.5"}, derived_from_existing=True) == {"bodySize": "10.5"}
    original = {"bodySize": "10"}
    with_new_resume_template(original, derived_from_existing=False)
    assert original == {"bodySize": "10"}


def test_create_resume_record_defaults_new_resumes_to_paper_and_leaves_existing_rows(tmp_path):
    async def run():
        engine = create_async_engine(f"sqlite+aiosqlite:///{(tmp_path / 'r.db').as_posix()}")
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            async with sessions() as db:
                legacy = Resume(user_name="老用户", title="旧简历", style_config={})
                db.add(legacy)
                await db.commit()
                legacy_id = legacy.id
            async with AsyncExitStack() as stack:
                stack.enter_context(patch.object(routes, "async_session", sessions))
                blank = await routes.create_resume_record(user_name="新用户", title="新简历")
                chosen = await routes.create_resume_record(title="指定模板", style_config={"template": "modern"})
                copied = await routes.create_resume_record(title="副本", style_config={"bodySize": "10"},
                                                           source_resume_id=legacy_id)
            async with sessions() as db:
                rows = {row.title: row.style_config for row in (await db.execute(select(Resume))).scalars()}
            assert rows["新简历"]["template"] == "paper"
            assert rows["指定模板"]["template"] == "modern"
            assert "template" not in rows["副本"]
            assert rows["旧简历"] == {}
            assert blank and chosen and copied
        finally:
            await engine.dispose()

    asyncio.run(run())
