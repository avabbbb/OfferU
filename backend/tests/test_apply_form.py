"""官网投递助手主线：贴官网页面 → Agent（或内置模型）对话式回复，每段可复制 → 用户追加要求再回复。"""

import asyncio
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.database import Base
from app.models.models import ApplicationRecord, Job, Profile, ProfileSection
from app.ops import OPERATIONS
from app.services import apply_form as af

# 照百度在线简历结构手写的样本，不是真实复制结果；拿到真实 Ctrl+A 文本后替换。
PAGE = (Path(__file__).parent / "fixtures" / "apply_form_baidu_synthetic.txt").read_text(encoding="utf-8")


def test_apply_form_conversation(tmp_path):
    async def run():
        engine = create_async_engine(f"sqlite+aiosqlite:///{(tmp_path / 'a.db').as_posix()}")
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            async with sessions() as db:
                profile = Profile(name="李凯风", school="华南师范大学")
                db.add(profile)
                await db.flush()
                db.add(ProfileSection(profile_id=profile.id, section_type="project", title="CLIProxyAPI", tier="verified_fact",
                                      content_json={"bullets": ["修复请求重试和流式转发问题，合入 4 个 PR"]}))
                job = Job(title="AI 产品经理", company="百度", source="manual", hash_key="baidu", raw_description="负责大模型产品")
                db.add(job)
                await db.commit()
            with ExitStack() as stack:
                stack.enter_context(patch.object(af, "async_session", sessions))
                form = await OPERATIONS["send_apply_form_message"].fn(job_id=job.id, text=PAGE + "\n官网还要个人优势，300 字")
                assert form["status"] == "waiting"

                context = await af.get_apply_form_context(form["id"])
                cli = next(fact["id"] for fact in context["facts"] if fact["label"].endswith("CLIProxyAPI"))
                assert "个人优势" in context["messages"][0]["text"]

                replied = await af.reply_apply_form(form["id"], reply="原来解析的项目职责混进了实习成果，已按项目重写。", blocks=[
                    {"title": "CLIProxyAPI · 项目职责", "text": "修复请求重试与流式转发，合入 4 个 PR。社区用户增长 200%。",
                     "sources": [cli]},
                    {"title": "个人优势", "text": "熟悉大模型应用，能把需求落到可用的产品流程。"},
                ])
                duty, strength = replied["messages"][-1]["blocks"]
                assert replied["status"] == "ready"
                assert duty["unsupported"] == ["社区用户增长 200%。"]  # 编出来的数字标「无依据」
                assert strength["unsupported"] == []  # 没数字、没引用的普通表述不打扰用户

                again = await af.send_apply_form_message(job.id, "项目职责压到 30 字", use_builtin=False)
                assert again["id"] == form["id"] and len(again["messages"]) == 3

                async def builtin(messages):
                    assert "untrusted" in messages[1]["content"]
                    return {"reply": "", "blocks": [{"title": "CLIProxyAPI · 项目职责", "text": "修复重试与流式转发，合入 4 个 PR。",
                                                     "sources": [cli]}]}
                with patch.object(af, "_builtin", builtin):
                    by_model = await af.send_apply_form_message(job.id, "再短一点")
                assert by_model["messages"][-1]["by"] == "builtin" and not by_model["messages"][-1]["blocks"][0]["unsupported"]

            async with sessions() as db:
                assert (await db.execute(ApplicationRecord.__table__.select())).first() is None
        finally:
            await engine.dispose()

    asyncio.run(run())
