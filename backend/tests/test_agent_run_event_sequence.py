"""同一 Agent Run 的事件序号在并发追加时必须唯一且连续。

回归场景：运行中取消时，abort 路由、host 事件转发和 worker dispose 会同时为同一 Run
追加事件。旧实现读行后在内存加一，两个会话拿到同一 sequence，
触发 UNIQUE(run_id, sequence) 的 IntegrityError。
"""

import asyncio
from unittest.mock import patch

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.database import Base
from app.services import agent_run_state as state

RUN_ID = "run_aaaaaaaaaaaaaaaa"
MISSING_RUN_ID = "run_bbbbbbbbbbbbbbbb"
CONCURRENT_APPENDS = 20


def _engine(tmp_path):
    return create_async_engine(
        f"sqlite+aiosqlite:///{(tmp_path / 'seq.db').as_posix()}",
        connect_args={"timeout": 30},
    )


def test_concurrent_appends_get_unique_contiguous_sequences(tmp_path):
    async def scenario():
        engine = _engine(tmp_path)
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            with patch.object(state, "async_session", sessions):
                await state.create_agent_run(
                    conversation_id="conv_seq",
                    goal="并发追加事件",
                    mode="general",
                    actions=[],
                    run_id=RUN_ID,
                )
                tasks = [
                    asyncio.create_task(
                        state.append_agent_run_event(
                            RUN_ID, event_type="test.event", payload={"i": i}
                        )
                    )
                    for i in range(CONCURRENT_APPENDS)
                ]
                await asyncio.wait(tasks)
                appended = [task.result() for task in tasks]
                async with sessions() as db:
                    sequences = sorted(
                        (
                            await db.execute(
                                select(state.AgentRunEvent.sequence).where(
                                    state.AgentRunEvent.run_id == RUN_ID
                                )
                            )
                        ).scalars()
                    )
                    counter = (
                        await db.execute(
                            select(state.AgentRunRecord.event_sequence).where(
                                state.AgentRunRecord.run_id == RUN_ID
                            )
                        )
                    ).scalar_one()
        finally:
            await engine.dispose()

        # run.started 占 1 号，其后每条并发事件各占一号，无重复、无空洞。
        total = CONCURRENT_APPENDS + 1
        assert sequences == list(range(1, total + 1))
        assert counter == total
        assert sorted(event["sequence"] for event in appended) == list(range(2, total + 1))

    asyncio.run(scenario())


def test_append_to_missing_run_raises(tmp_path):
    async def scenario():
        engine = _engine(tmp_path)
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            with patch.object(state, "async_session", sessions):
                with pytest.raises(ValueError, match="does not exist"):
                    await state.append_agent_run_event(
                        MISSING_RUN_ID, event_type="test.event"
                    )
        finally:
            await engine.dispose()

    asyncio.run(scenario())
