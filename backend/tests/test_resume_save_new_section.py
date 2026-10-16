"""Saving the whole resume from the paper canvas."""

import asyncio
from unittest.mock import patch

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.database import Base
from app.services import resume_route_operations as routes


def test_saving_the_whole_resume_keeps_a_newly_added_section(tmp_path):
    """画布上加的新模块随整份简历一起保存，不能因为 section_type 后赋值而撞 NOT NULL。"""
    async def run():
        engine = create_async_engine(f"sqlite+aiosqlite:///{(tmp_path / 'r.db').as_posix()}")
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            with patch.object(routes, "async_session", sessions):
                created = await routes.create_resume_record(title="校招版")
                await routes.update_resume_record(created["id"], {"sections": [
                    {"section_type": "campusExperiences", "title": "校园经历", "sort_order": 3,
                     "visible": True, "content_json": [{"title": "学生会", "bullets": ["组织迎新"]}]},
                ]})
            async with sessions() as db:
                from app.models.models import ResumeSection
                rows = (await db.execute(select(ResumeSection))).scalars().all()
            assert [(row.section_type, row.title, row.sort_order) for row in rows] == [("campusExperiences", "校园经历", 3)]
            assert rows[0].content_json[0]["bullets"] == ["组织迎新"]
        finally:
            await engine.dispose()

    asyncio.run(run())
