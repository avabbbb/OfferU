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


def test_weak_spots_only_keep_known_refs_once(tmp_path):
    """只收写了「卡在哪」的题；模型乱给的 ref 和重复归类都丢掉，题多的考察点排前面；结果保存，复盘改了标成可重新归类。"""

    async def run():
        engine = create_async_engine(f"sqlite+aiosqlite:///{(tmp_path / 'w.db').as_posix()}")
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            with patch.object(reviews, "async_session", sessions):
                a = await reviews.save_interview_review(company="字节", questions=[{"question": "Redis 过期通知", "reflection": "没讲兜底"}, {"question": "自我介绍"}])
                b = await reviews.save_interview_review(company="美团", questions=[{"question": "RDB 和 AOF", "reflection": "重写说错"}, {"question": "项目难点", "reflection": "太散"}])
                reply = (
                    '{"topics": [{"title": "项目表达", "advice": "先讲数字", "refs": ["%(b)s:1", "%(a)s:1"]},'
                    ' {"title": "Redis", "advice": "讲清边界", "refs": ["%(a)s:0", "%(b)s:0", "%(b)s:1", "99:0"]}]}'
                ) % {"a": a["id"], "b": b["id"]}

                async def fake_chat(**kwargs):
                    assert "自我介绍" not in kwargs["messages"][1]["content"]
                    return reply

                with patch("app.agents.llm.chat_completion", fake_chat):
                    topics = (await reviews.group_interview_weak_spots())["topics"]
                assert (await reviews.get_interview_weak_spots())["stale"] is False
                await reviews.save_interview_review(review_id=b["id"], company="美团", questions=[{"question": "RDB 和 AOF", "reflection": "重写和混合持久化都没讲"}])
                again = await reviews.get_interview_weak_spots()
                assert again["stale"] is True and again["topics"] == topics
            assert [(t["title"], t["refs"]) for t in topics] == [
                ("Redis", [f"{a['id']}:0", f"{b['id']}:0"]),
                ("项目表达", [f"{b['id']}:1"]),
            ]
        finally:
            await engine.dispose()

    asyncio.run(run())
