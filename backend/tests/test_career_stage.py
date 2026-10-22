"""阶段与每日问题主线：开头三问 → 自述和记录不一致时让用户选 → 回答面试结果直接改投递 → 不回答就降到每周。"""

import asyncio
import uuid
from contextlib import ExitStack
from datetime import datetime, timedelta
from unittest.mock import patch

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.database import Base
from app.models.models import CalendarEvent, Job
from app.services import agent_operations, application_progress, career_stage as cs


def test_stage_main_path(tmp_path):
    async def run():
        engine = create_async_engine(f"sqlite+aiosqlite:///{(tmp_path / 's.db').as_posix()}")
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            with ExitStack() as stack:
                for module in (cs, application_progress, agent_operations):
                    stack.enter_context(patch.object(module, "async_session", sessions))
                first = await cs.get_career_next_step()
                assert first["next_step"]["key"] == "onboarding"
                assert [q["key"] for q in first["questions"]] == ["onboarding.stage", "onboarding.about", "onboarding.deadline"]
                assert (await cs.get_career_next_step_for_agent())["alternate"]["key"] != "connect-agent"

                await cs.answer_check_in("onboarding.stage", "interviewing", user_quote="在面试了")
                after = (await cs.answer_check_in("onboarding.about", text="27 届 产品 上海"))["next"]
                assert after["stage"] == "interviewing" and after["inferred_stage"] == "not_started"
                assert after["questions"][0]["key"] == "conflict:interviewing:not_started"

                async with sessions() as db:
                    job = Job(title="产品经理", company="美团", source="manual", hash_key=uuid.uuid4().hex)
                    db.add(job)
                    await db.flush()
                    db.add(CalendarEvent(title="美团一面", event_type="interview",
                                         start_time=datetime.now() - timedelta(days=1), related_job_id=job.id))
                    await db.commit()
                record = await agent_operations.create_application(job.id)
                await agent_operations.update_application_status(record["id"], "interview")
                now = await cs.get_career_next_step()
                assert now["stage"] == "interviewing" and now["self_stage"] == ""
                key = now["questions"][0]["key"]
                assert key.startswith("interview_result:")

                done = (await cs.answer_check_in(key, "rejected", user_quote="美团挂了"))["next"]
                assert done["stage"] == "applying"
                assert all(q["key"] != key for q in done["questions"])

                # Three asked-but-ignored days → weekly; nothing urgent, so no question on day 4.
                async with sessions() as db:
                    state = await db.get(cs.CareerCheckInState, 1)
                    state.ignored_days, state.last_asked_on = 3, (datetime.now() - timedelta(days=1)).date().isoformat()
                    await db.commit()
                later = await cs.get_career_next_step(datetime.now() + timedelta(days=8))
                assert later["cadence"] == "weekly"
        finally:
            await engine.dispose()

    asyncio.run(run())
