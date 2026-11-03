"""主线：Agent（MCP）和工作台（HTTP）用同一套工具写同一份数据，写了直接生效、能撤销，今天页给出下一步。"""

import asyncio
import json
from datetime import date

from app.core.tools import call, overview


def test_core_main_path(tmp_path, monkeypatch):
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    agent = "codex"
    assert overview(today=date(2026, 10, 20))["next_step"]["title"] == "先建档案"
    call("save", {"type": "profile", "data": {"name": "张三"}}, actor="你")
    assert overview(today=date(2026, 10, 20))["next_step"]["title"] == "写一份简历"
    call("save", {"type": "doc", "data": {"kind": "resume", "title": "主简历", "body": "# 张三"}}, actor="你")
    assert overview(today=date(2026, 10, 20))["next_step"]["title"] == "存几个想投的岗位"

    job = call("save", {"type": "job", "data": {"company": "百度", "title": "AI 产品经理"}}, actor=agent)["record"]
    assert job["status"] == "saved"
    assert overview(today=date(2026, 10, 20))["next_step"]["title"] == "投递「百度 · AI 产品经理」"

    call("save", {"type": "event", "data": {"title": "百度笔试", "kind": "test", "at": "2026-10-21T19:00", "job_id": job["id"]}}, actor=agent)
    view = overview(today=date(2026, 10, 20))
    assert view["next_step"]["title"] == "准备「百度笔试」" and view["todos"]["week"][0]["job_label"] == "百度 · AI 产品经理"

    applied = call("save", {"type": "job", "id": job["id"], "data": {"status": "applied"}}, actor="你")
    assert applied["record"]["applied_at"] and overview()["stage"] == "applying"
    call("undo", {"change_id": applied["change_id"]}, actor="你")
    assert call("get", {"type": "job", "id": job["id"]}, actor="你")["record"]["status"] == "saved"

    gone = call("delete", {"type": "job", "id": job["id"]}, actor=agent)
    call("undo", {"change_id": gone["change_id"]}, actor="你")
    assert call("get", {"type": "job", "id": job["id"]}, actor="你")["events"][0]["title"] == "百度笔试"

    call("save", {"type": "memory", "data": {"kind": "experience", "title": "学生会外联部长", "body": "拉到 3 家企业赞助"}}, actor=agent)
    assert call("search", {"query": "赞助"}, actor=agent)["items"][0]["label"] == "学生会外联部长"
    assert {c["actor"] for c in call("changes", {}, actor="你")["items"]} == {"codex", "你"}


def test_mcp_and_http_share_tools(tmp_path, monkeypatch):
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    from fastapi.testclient import TestClient

    from app.main import app
    from app.mcp_server import mcp

    names = [t.name for t in asyncio.run(mcp.list_tools())]
    assert names[0] == "overview" and len(names) <= 19
    asyncio.run(mcp.call_tool("save", {"type": "job", "data": {"company": "米哈游"}}))
    with TestClient(app, base_url="http://127.0.0.1:8766") as client:
        listed = client.post("/api/tools/list", json={"type": "job"}).json()
        assert listed["items"][0]["company"] == "米哈游"
        bad = client.post("/api/tools/save", json={"type": "job", "data": {"status": "maybe"}})
        assert bad.status_code == 400 and "status" in json.dumps(bad.json(), ensure_ascii=False)


def test_resume_import_edit_export(tmp_path, monkeypatch):
    """导入旧简历 → 档案 → Markdown 简历（连续编辑只算一条改动）→ 编辑器和 PDF 用同一份模板样式。"""
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    import docx
    import fitz
    from fastapi.testclient import TestClient

    from app.main import app

    old = docx.Document()
    old.add_paragraph("李四 复旦大学 计算机 2025 届")
    old.add_paragraph("字节跳动 后端实习：接口延迟从 120ms 降到 40ms")
    old.save(tmp_path / "old.docx")
    with TestClient(app, base_url="http://127.0.0.1:8766") as client:
        name = client.post("/api/files", files={"file": ("我的简历.docx", (tmp_path / "old.docx").read_bytes())}).json()["name"]
        text = client.post("/api/tools/read_file", json={"path": name}).json()["text"]
        assert "120ms" in text

        body = "# 李四\n138 0000 0000 · li@example.com\n\n## 实习经历\n### 字节跳动 | 后端开发实习生 | 2024.06 – 2024.09\n- 接口延迟从 120ms 降到 40ms\n"
        doc = client.post("/api/tools/save", json={"type": "doc", "data": {"kind": "resume", "title": "主简历", "body": "# 李四", "template": "compact"}}).json()["record"]
        first = client.post("/api/tools/save", json={"type": "doc", "id": doc["id"], "data": {"body": "# 李四\n"}}).json()["change_id"]
        second = client.post("/api/tools/save", json={"type": "doc", "id": doc["id"], "data": {"body": body}}).json()["change_id"]
        assert first == second
        assert client.post("/api/tools/save", json={"type": "doc", "id": doc["id"], "data": {"template": "fancy"}}).status_code == 400

        assert "--body-size: 9.2pt" in client.get("/api/resume/templates/compact.css").text
        pdf = client.get(f"/api/resume/{doc['id']}/pdf").content
        assert "接口延迟从 120ms 降到 40ms" in fitz.open(stream=pdf, filetype="pdf")[0].get_text()
        path = client.post("/api/tools/export_resume_pdf", json={"id": doc["id"]}).json()["path"]
        assert path.endswith("主简历.pdf")

        client.post("/api/tools/undo", json={"change_id": second})
        record = client.post("/api/tools/get", json={"type": "doc", "id": doc["id"]}).json()["record"]
        assert record["body"] == "# 李四\n" and record["resume"]["basics"]["name"] == "李四" and record["resume"]["sections"] == []


def test_mail_writes_core_and_respects_undo(tmp_path, monkeypatch):
    """邮件识别结果直接写岗位和事项（actor=邮箱），状态只前进，同一封信只处理一次，撤销后不会被下次同步写回来。"""
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    from app.core import mail
    from app.core.tools import TOOLS

    assert "email_sync" in TOOLS
    first = mail.apply({"mail_id": "m1", "stage": "applied", "company": "腾讯", "title": "后端开发", "subject": "投递成功"})
    job_id = first["job_id"]
    assert call("get", {"type": "job", "id": job_id}, actor="你")["record"]["status"] == "applied"
    assert call("changes", {}, actor="你")["items"][0]["actor"] == "邮箱"

    test_mail = {"mail_id": "m2", "stage": "written_test", "company": "腾讯", "title": "后端开发", "at": "2026-11-05T19:00"}
    written = mail.apply(test_mail)
    assert written["job_id"] == job_id and len(written["changes"]) == 2
    record = call("get", {"type": "job", "id": job_id}, actor="你")
    assert record["record"]["status"] == "test" and record["events"][0]["at"] == "2026-11-05T19:00"
    assert mail.apply(test_mail)["skipped"]
    assert mail.apply({"mail_id": "m3", "stage": "applied", "company": "腾讯", "title": "后端开发"})["skipped"]
    assert overview()["mail"]["today_changes"] == 3

    for change_id in reversed(written["changes"]):
        call("undo", {"change_id": change_id}, actor="你")
    assert mail.apply(test_mail)["skipped"]
    record = call("get", {"type": "job", "id": job_id}, actor="你")
    assert record["record"]["status"] == "applied" and record["events"] == []


def test_agent_uses_core_tools(tmp_path, monkeypatch):
    """内置 Agent 的工具就是 core TOOLS，写入记在「助手」名下，校验失败作为错误文本返回。"""
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    from app.core import agent, tools

    assert [t.name for t in agent.loop_tools()] == list(tools.TOOLS)
    text, failed = asyncio.run(agent.execute("save", {"type": "job", "data": {"company": "美团"}}))
    assert not failed and json.loads(text)["record"]["company"] == "美团"
    assert call("changes", {}, actor="你")["items"][0]["actor"] == "助手"
    text, failed = asyncio.run(agent.execute("save", {"type": "job", "data": {"status": "maybe"}}))
    assert failed and text.startswith("ERROR")
    assert "overview" in agent.system_prompt()


def test_review_lives_in_core(tmp_path, monkeypatch):
    """复盘就是 doc kind=review，题目在 doc.questions；标拒就是存 job.status；旧表迁移只迁一次，删了也不会被重新迁回来。"""
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    import pytest

    from app.services import interview_reviews as reviews

    async def no_legacy() -> int:
        return 0

    monkeypatch.setattr(reviews, "migrate_legacy_reviews", no_legacy)
    job = call("save", {"type": "job", "data": {"company": "字节跳动", "title": "后端开发"}}, actor="你")["record"]
    saved = asyncio.run(reviews.save_interview_review(
        job_id=job["id"], company="字节跳动", round_label="一面", interviewed_on="2026-11-01",
        questions=[{"question": "讲讲 Redis 持久化", "reflection": "AOF 重写没讲清"}]))
    doc = call("get", {"type": "doc", "id": saved["id"]}, actor="你")["record"]
    assert doc["kind"] == "review" and doc["questions"][0]["answer"] == "" and saved["interviewed_on"] == "2026-11-01"
    assert asyncio.run(reviews.list_interview_reviews())["items"][0]["id"] == saved["id"]
    assert asyncio.run(reviews._stuck_questions())[0]["ref"] == f"{saved['id']}:0"

    asyncio.run(reviews.mark_application_rejected_from_review(saved["id"]))
    assert call("get", {"type": "job", "id": job["id"]}, actor="你")["record"]["status"] == "rejected"
    with pytest.raises(ValueError):
        call("save", {"type": "doc", "data": {"kind": "review", "questions": [{"score": "1"}]}}, actor="你")

    legacy = [{"kind": "review", "title": "美团 二面", "legacy_review_id": 7, "company": "美团", "job_id": None, "questions": []}]
    assert reviews._import_legacy(legacy) == 1 and reviews._import_legacy(legacy) == 0
    migrated = next(d for d in reviews._review_docs() if d.get("legacy_review_id") == 7)
    assert call("changes", {}, actor="你")["items"][0]["actor"] == "迁移"
    call("delete", {"type": "doc", "id": migrated["id"]}, actor="你")
    assert reviews._import_legacy(legacy) == 0


def test_tailor_resume_tool(tmp_path, monkeypatch):
    """tailor_resume 同步返回：成功写一条改动（记在调用方名下）、能撤销；失败是中文 ValueError，简历不动。"""
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    import pytest

    from app.core import tailor

    new = "# 张三\n138 · a@b.com\n\n## 实习经历\n### 字节 | 后端 | 2025.06 – 2025.09\n- 接口 QPS 提升 30%\n"

    async def stream(messages):
        yield new

    monkeypatch.setattr(tailor, "_default_stream", lambda: stream)
    job = call("save", {"type": "job", "data": {"company": "美团", "title": "后端", "jd": "负责 Go 后端开发"}}, actor="你")["record"]
    bare = call("save", {"type": "job", "data": {"company": "京东"}}, actor="你")["record"]
    doc = call("save", {"type": "doc", "data": {"kind": "resume", "title": "主简历", "body": "# 张三\n"}}, actor="你")["record"]

    with pytest.raises(ValueError, match="JD"):
        call("tailor_resume", {"id": doc["id"], "job_id": bare["id"]}, actor="助手")
    result = call("tailor_resume", {"id": doc["id"], "job_id": job["id"]}, actor="助手")
    assert result["doc_id"] == doc["id"] and "接口 QPS 提升 30%" in result["body"]
    assert call("changes", {}, actor="你")["items"][0]["actor"] == "助手"
    call("undo", {"change_id": result["change_id"]}, actor="你")
    assert "接口 QPS" not in call("get", {"type": "doc", "id": doc["id"]}, actor="你")["record"]["body"]


def test_add_job_from_text_or_link(tmp_path, monkeypatch):
    """贴 JD：模型拆出公司 / 岗位 / 截止，岗位和截止事项各一条改动；链接抓不到正文就报错、不存空壳；没配模型时第一行当岗位名。"""
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    import pytest

    from app.core import job_intake, tools

    async def extract(text):
        assert "Go" in text
        return {"company": "美团", "title": "后端开发实习生", "city": "北京", "deadline": "2026-11-20", "jd": "负责 Go 后端开发"}

    monkeypatch.setattr(job_intake, "available", lambda: True)
    monkeypatch.setattr(job_intake, "extract", extract)
    out = call("add_job", {"text": "美团 后端开发实习生\n负责 Go 后端开发\n11 月 20 日截止"}, actor="你")
    job = out["record"]
    assert (job["company"], job["title"], job["jd"]) == ("美团", "后端开发实习生", "负责 Go 后端开发")
    assert len(out["change_ids"]) == 2
    events = call("get", {"type": "job", "id": job["id"]}, actor="你")["events"]
    assert events[0]["kind"] == "deadline" and events[0]["at"] == "2026-11-20"

    monkeypatch.setattr(tools, "fetch_page", lambda url, **_: {"url": url, "title": "腾讯招聘", "text": "加载中", "truncated": False})
    with pytest.raises(ValueError, match="插件"):
        call("add_job", {"text": "https://join.qq.com/post.html?pid=1"}, actor="你")

    monkeypatch.setattr(job_intake, "available", lambda: False)
    bare = call("add_job", {"text": "京东 算法工程师\n负责推荐"}, actor="你")["record"]
    assert bare["title"] == "京东 算法工程师" and "负责推荐" in bare["jd"]
    assert len(call("list", {"type": "job"}, actor="你")["items"]) == 2


def test_rank_jobs(tmp_path, monkeypatch):
    """批量评估：只评没打分的岗位，分数和理由存在 job 上、按分排序，每个岗位一条改动可撤销。"""
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    from app.core import job_rank

    assert job_rank.normalize({"items": [{"id": 1, "score": 120, "reasons": ["x"]}, {"id": 9, "score": 5}]}, {1}) == {1: {"score": 100, "reasons": ["x"]}}
    a = call("save", {"type": "job", "data": {"company": "美团", "title": "后端实习", "jd": "Go"}}, actor="你")["record"]
    b = call("save", {"type": "job", "data": {"company": "京东", "title": "算法实习", "jd": "推荐"}}, actor="你")["record"]
    call("save", {"type": "memory", "data": {"kind": "preference", "title": "想去北京"}}, actor="你")

    async def evaluate(text, jobs):
        assert "想去北京" in text and sorted(j["id"] for j in jobs) == sorted([a["id"], b["id"]])
        return {a["id"]: {"score": 62, "reasons": ["Go 对口", "缺实习", "在北京"]},
                b["id"]: {"score": 85, "reasons": ["有推荐经历", "无明显差距", "在北京"]}}

    monkeypatch.setattr(job_rank, "available", lambda: True)
    monkeypatch.setattr(job_rank, "evaluate", evaluate)
    out = call("rank_jobs", {}, actor="助手")
    assert [i["id"] for i in out["items"]] == [b["id"], a["id"]] and len(out["change_ids"]) == 2
    assert call("get", {"type": "job", "id": a["id"]}, actor="你")["record"]["reasons"][0] == "Go 对口"
    assert call("rank_jobs", {}, actor="助手")["count"] == 0
    call("undo", {"change_id": out["change_ids"][0]}, actor="你")
    assert call("get", {"type": "job", "id": a["id"]}, actor="你")["record"].get("score") is None


def test_new_record_never_reuses_undone_id(tmp_path, monkeypatch):
    """撤销新建以后再建记录，id 不复用（岗位 20 被旧表单只填公司重新占用的问题）。"""
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    first = call("save", {"type": "job", "data": {"company": "字节跳动", "title": "产品实习生"}}, actor="插件")
    call("undo", {"change_id": first["change_id"]}, actor="你")
    second = call("save", {"type": "job", "data": {"company": "字节跳动"}}, actor="你")["record"]
    assert second["id"] > first["record"]["id"]


def test_apply_answer(tmp_path, monkeypatch):
    """官网网申问答：引用 JD 和定制简历，同一岗位的问答追加到同一份 apply_chat，每次一条改动可撤销。"""
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    from app.core import job_rank, tools

    seen: dict = {}

    async def fake(context, question, history):
        seen["context"], seen["history"] = context, history
        return "我在实习里做过需求分析。"

    monkeypatch.setattr(job_rank, "available", lambda: True)
    monkeypatch.setattr(tools, "_apply_reply", fake)
    job = call("save", {"type": "job", "data": {"company": "字节跳动", "title": "产品实习生", "jd": "负责 AI 产品需求分析"}}, actor="你")["record"]
    call("save", {"type": "doc", "data": {"kind": "note", "job_id": job["id"], "title": "定制版", "body": "无关笔记"}}, actor="你")
    first = call("apply_answer", {"job_id": job["id"], "question": "为什么想加入？"}, actor="你")
    assert "负责 AI 产品需求分析" in seen["context"] and first["answer"]
    second = call("apply_answer", {"job_id": job["id"], "question": "最有成就感的项目？"}, actor="你")
    assert second["doc_id"] == first["doc_id"] and "为什么想加入" in seen["history"]
    call("undo", {"change_id": second["change_id"]}, actor="你")
    body = call("get", {"type": "doc", "id": first["doc_id"]}, actor="你")["record"]["body"]
    assert "为什么想加入" in body and "最有成就感" not in body
