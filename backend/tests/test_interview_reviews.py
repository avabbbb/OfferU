"""真实面试复盘：整份保存、题目按顺序替换、删除连题目一起删。"""

import asyncio
from unittest.mock import patch

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.database import Base
from app.models.models import InterviewReviewQuestion
from app.services import interview_reviews as reviews


def test_review_round_trip(tmp_path):
    async def run():
        engine = create_async_engine(f"sqlite+aiosqlite:///{(tmp_path / 'r.db').as_posix()}")
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            with patch.object(reviews, "async_session", sessions):
                created = await reviews.save_interview_review(company="字节跳动", round_label="一面", questions=[{"question": "A"}])
                saved = await reviews.save_interview_review(
                    review_id=created["id"], company="字节跳动", outcome="passed",
                    questions=[{"question": "B", "reflection": "没讲取舍"}, {"question": "C"}],
                )
                assert saved["outcome"] == "passed"
                assert [q["question"] for q in saved["questions"]] == ["B", "C"]
                assert (await reviews.list_interview_reviews())["items"][0]["questions"][0]["reflection"] == "没讲取舍"
                await reviews.delete_interview_review(created["id"])
                assert (await reviews.list_interview_reviews())["items"] == []
            async with sessions() as db:
                assert (await db.execute(select(func.count()).select_from(InterviewReviewQuestion))).scalar_one() == 0
        finally:
            await engine.dispose()

    asyncio.run(run())
