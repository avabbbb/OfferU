"""官网投递助手主线：粘贴整页 → Agent（或内置模型）按字段写草稿 → OfferU 核对 → 逐条复制。"""

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


def test_apply_form_main_path(tmp_path):
    async def run():
        engine = create_async_engine(f"sqlite+aiosqlite:///{(tmp_path / 'a.db').as_posix()}")
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            async with sessions() as db:
                profile = Profile(name="李凯风", school="华南师范大学", major="软件工程", degree="本科")
                db.add(profile)
                await db.flush()
                db.add_all([
                    ProfileSection(profile_id=profile.id, section_type="project", title="CLIProxyAPI", tier="verified_fact",
                                   content_json={"bullets": ["为开源代理修复请求重试和流式转发问题，合入 4 个 PR"]}),
                    ProfileSection(profile_id=profile.id, section_type="work", title="某科技 AIGC 产品实习", tier="verified_fact",
                                   content_json={"bullets": ["改造 AIGC 生图流程，出图成功率提升 35%"]}),
                ])
                job = Job(title="AI 产品经理", company="百度", source="manual", hash_key="baidu", raw_description="负责大模型产品")
                db.add(job)
                await db.commit()
            with ExitStack() as stack:
                stack.enter_context(patch.object(af, "async_session", sessions))
                form = await OPERATIONS["create_apply_form"].fn(job_id=job.id, page_text=PAGE)
                assert form["status"] == "waiting"

                context = await af.get_apply_form_context(form["id"])
                ids = {fact["label"].split("｜")[-1]: fact["id"] for fact in context["facts"]}
                assert context["page"]["untrusted"] and "basic.school" in ids.values()

                saved = await af.save_apply_form_fields(form["id"], site="百度招聘 · 在线简历", fields=[
                    {"section": "基础信息", "label": "姓名", "kind": "fact", "value": "李凯风", "sources": ["basic.name"]},
                    {"section": "基础信息", "label": "当前年薪（万元）", "kind": "fact", "value": "30"},
                    {"section": "教育经历", "label": "在校时间", "kind": "fact", "value": "2021-09 至 2025-06", "sources": ["basic.school"]},
                    {"section": "教育经历", "label": "学校名称", "kind": "fact", "value": "华南师范大学", "sources": ["basic.school"]},
                    {"section": "项目经验", "group": "项目经验 1：CLIProxyAPI", "label": "项目职责", "kind": "write",
                     "value": "修复开源代理的请求重试与流式转发，合入 4 个 PR。推动社区用户增长 200%。",
                     "existing": "负责开源代理的请求转发与重试；主导企业 AIGC 生图流程改造，出图成功率提升 35%。",
                     "sources": [ids["CLIProxyAPI"]], "max_chars": 500},
                    {"section": "推荐", "label": "推荐好友", "kind": "write", "value": "x"},
                    {"section": "项目经验", "group": "项目经验 2：OfferU", "label": "项目职责", "kind": "write", "value": "x", "sources": []},
                    {"section": "作品集", "label": "上传作品附件", "kind": "manual", "value": "需要的话上传作品 PDF"},
                ])
                fields = {field["label"]: field for field in saved["fields"]}
                assert saved["status"] == "ready" and saved["drafter"] == "agent"
                assert "推荐好友" not in fields and saved["problems"]  # 页面上没有的字段被丢弃
                assert fields["姓名"]["value"] == "李凯风" and fields["学校名称"]["kind"] == "fact"
                assert fields["当前年薪（万元）"]["kind"] == "confirm" and fields["当前年薪（万元）"]["value"] == ""  # 案例 C
                assert fields["在校时间"]["kind"] == "confirm"  # 时间不在引用的事实里
                duty = [f for f in saved["fields"] if f["label"] == "项目职责"][0]
                assert duty["unsupported"] == ["推动社区用户增长 200%。"]  # 编出来的数字被标红
                assert duty["existing_flags"] and "35%" in duty["existing_flags"][0]  # 案例 B：原内容混入别的经历
                assert duty["max_chars"] == 500 and duty["existing_state"] == "filled"
                second_duty = [f for f in saved["fields"] if f["label"] == "项目职责"][1]
                assert second_duty["existing_state"] == "empty"  # 第二个「项目职责」对应页面上第二处，显示「请输入」
                assert fields["在校时间"]["existing_state"] == "unknown"  # 复制的文本里看不出原值，不当成空

                copied = await af.update_apply_form_field(form["id"], duty["id"], copied=True)  # 案例 D
                assert next(f for f in copied["fields"] if f["id"] == duty["id"])["copied"]
                edited = await af.update_apply_form_field(form["id"], duty["id"], value="我自己改的")
                changed = next(f for f in edited["fields"] if f["id"] == duty["id"])
                assert changed["edited"] and not changed["copied"]

                async def builtin(_messages):
                    return {"site": "百度招聘", "fields": [{"label": "学校名称", "kind": "fact", "value": "华南师范大学",
                                                          "sources": ["basic.school"]}]}
                with patch.object(af, "_builtin", builtin):
                    by_model = await af.create_apply_form(job.id, PAGE)
                assert by_model["drafter"] == "builtin" and by_model["fields"][0]["value"] == "华南师范大学"

            async with sessions() as db:
                assert (await db.get(ProfileSection, 1)).content_json["bullets"][0].startswith("为开源代理")
                assert (await db.execute(ApplicationRecord.__table__.select())).first() is None
        finally:
            await engine.dispose()

    asyncio.run(run())
