"""按岗位改简历：起草（流式）→ 独立审稿 → 按 old 精确修订，最多两轮，只在最后写一次库（一条 Agent 改动）；
超时、取消、空输出、格式不对、缺 JD、并发都不动简历。"""

import asyncio
import json

import pytest

from app.core import store, tailor
from app.core.tools import save
from app.core.resume_model import from_markdown, to_markdown

FENCE = chr(96) * 3

OLD = "# 张三\n138 · a@b.com\n\n## 教育经历\n### 某大学 | 计算机 | 2022.09 – 2026.06\n"
NEW = "# 张三\n138 · a@b.com\n\n## 实习经历\n### 字节 | 后端 | 2025.06 – 2025.09\n- 接口 QPS 提升 30%\n"


@pytest.fixture(autouse=True)
def _no_browser(monkeypatch):
    """量页数要开 Chromium；单测里固定成一页。"""
    monkeypatch.setattr(tailor, "measure", lambda body, doc: 1.0)


def _setup(tmp_path, monkeypatch, jd="负责 Go 后端开发"):
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    save("profile", {"name": "张三", "school": "某大学"}, actor="你")
    save("memory", {"kind": "experience", "title": "字节后端实习", "body": "接口 QPS 提升 30%"}, actor="你")
    job = save("job", {"company": "美团", "title": "后端", "jd": jd}, actor="你")["record"]
    doc = save("doc", {"kind": "resume", "title": "主简历", "body": OLD}, actor="你")["record"]
    return doc["id"], job["id"]


def _chunks(*parts, delay=0.0):
    async def stream(messages):
        prompt = messages[-1]["content"]
        assert "美团" in prompt and "接口 QPS 提升 30%" in prompt and "某大学 | 计算机" in prompt
        for part in parts:
            await asyncio.sleep(delay)
            yield part
    return stream


def _review(*replies):
    """审稿替身：按轮次依次返回 replies，用完就返回没有修改。收到的 messages 记在 .calls。"""
    calls = []

    async def complete(messages):
        calls.append(messages)
        return replies[len(calls) - 1] if len(calls) <= len(replies) else '{"edits": []}'

    complete.calls = calls
    return complete


def _run(doc_id, job_id, stream, deadline=5.0, complete=None):
    async def go():
        return [event async for event in tailor.run(doc_id, job_id, stream=stream, complete=complete or _review(),
                                                    deadline=deadline)]
    return asyncio.run(go())


def test_tailor_main_resume_gets_job_copy(tmp_path, monkeypatch):
    doc_id, job_id = _setup(tmp_path, monkeypatch)
    events = _run(doc_id, job_id, _chunks(FENCE + "markdown\n", NEW[:20], NEW[20:], FENCE))
    assert [e["type"] for e in events] == ["start", "delta", "delta", "delta", "delta", "review", "done"]
    main = store.get("doc", doc_id)
    assert main["body"] == to_markdown(from_markdown(OLD)) and not main.get("job_id")  # 主简历不动
    copy = store.get("doc", events[-1]["doc_id"])
    assert copy["id"] != doc_id and copy["kind"] == "resume" and copy["job_id"] == job_id
    assert copy["body"] == to_markdown(from_markdown(NEW)) and copy["title"] == "主简历 · 美团 · 后端"
    assert copy["resume"]["sections"][0]["type"] == "internship" and events[-1]["resume"] == copy["resume"]
    assert store.changes(1)[0]["actor"] == "Agent"
    again = _run(doc_id, job_id, _chunks(NEW))  # 同一岗位再改：写回那份定制简历，不再新建
    assert again[-1]["doc_id"] == copy["id"] and store.get("doc", doc_id)["body"] == main["body"]

    async def plain(messages):
        yield NEW

    in_place = _run(copy["id"], None, plain)  # 岗位简历本身原地改
    assert in_place[-1]["doc_id"] == copy["id"]


def test_tailor_reads_evaluation(tmp_path, monkeypatch):
    doc_id, job_id = _setup(tmp_path, monkeypatch)
    report = ("# 结论\n可以投\n\n## 逐条匹配\n- Go 后端 → 差距\n\n## 简历怎么改\n- 字节实习放最前面\n\n"
              "## 面试准备\n- Go 调度器\n")
    save("doc", {"kind": "evaluation", "job_id": job_id, "title": "岗位评估", "body": report}, actor="你")
    seen = []

    async def stream(messages):
        seen.append(messages[-1]["content"])
        yield NEW

    assert _run(doc_id, job_id, stream)[-1]["type"] == "done"
    assert "## 岗位评估" in seen[0] and "Go 后端 → 差距" in seen[0] and "字节实习放最前面" in seen[0]
    assert "Go 调度器" not in seen[0] and "可以投" not in seen[0]
    assert tailor.evaluation_notes(999) == ""


def test_tailor_failures_leave_resume_alone(tmp_path, monkeypatch):
    doc_id, job_id = _setup(tmp_path, monkeypatch)
    cases = [
        (_chunks(NEW, delay=1.0), 0.05, "秒没写完"),
        (_chunks(), 5.0, "没有返回内容"),
        (_chunks("好的，以下是为你改好的简历"), 5.0, "不是简历格式"),
    ]
    for stream, deadline, message in cases:
        events = _run(doc_id, job_id, stream, deadline)
        assert events[-1]["type"] == "error" and message in events[-1]["message"], events
    assert store.get("doc", doc_id)["body"] == to_markdown(from_markdown(OLD))


def test_tailor_needs_jd(tmp_path, monkeypatch):
    doc_id, job_id = _setup(tmp_path, monkeypatch, jd="")
    assert _run(doc_id, job_id, _chunks(NEW)) == [{"type": "error", "message": "「美团 · 后端」还没有 JD，先在岗位页贴上"}]
    assert _run(doc_id, None, _chunks(NEW))[0]["message"] == "先给这份简历选一个岗位"


def test_tailor_one_run_per_resume_and_cancel(tmp_path, monkeypatch):
    doc_id, job_id = _setup(tmp_path, monkeypatch)

    async def go():
        first = tailor.run(doc_id, job_id, stream=_chunks(NEW, delay=0.2), complete=_review(), deadline=5.0)
        assert (await anext(first))["type"] == "start"
        busy = [e async for e in tailor.run(doc_id, job_id, stream=_chunks(NEW), complete=_review())]
        await first.aclose()  # 前端断开连接 = 取消
        after = [e async for e in tailor.run(doc_id, job_id, stream=_chunks(NEW), complete=_review())]
        return busy, after

    busy, after = asyncio.run(go())
    assert busy[-1]["type"] == "error" and "正在改写" in busy[-1]["message"]
    assert after[-1]["type"] == "done"


def test_tailor_route_streams_sse(tmp_path, monkeypatch):
    doc_id, _ = _setup(tmp_path, monkeypatch)
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app, base_url="http" + chr(58) + "//" + ".".join(["127", "0", "0", "1"]) + chr(58) + "8766") as client:
        response = client.post(f"/api/resume/{doc_id}/tailor", json={})
    assert response.status_code == 200 and response.headers["content-type"].startswith("text/event-stream")
    assert response.text.startswith("data: ") and "先给这份简历选一个岗位" in response.text


DRAFT = ("# 张三\n138 · a@b.com\n\n## 实习经历\n### 字节 | 后端 | 2025.06 – 2025.09\n"
         "- 接口 QPS 提升 50%\n- 用 Go 重写服务\n- 用 Go 重写服务\n")


def _edit(old, new, category="tone", reason=""):
    return {"old": old, "new": new, "category": category, "reason": reason}


def test_tailor_review_revises_then_saves_once(tmp_path, monkeypatch):
    jd = "岗位职责：\n负责 Go 后端开发\n任职要求：\n熟悉 Go、Redis\n福利待遇：\n五险一金"
    doc_id, job_id = _setup(tmp_path, monkeypatch, jd=jd)
    drafts = []

    async def stream(messages):
        drafts.append(messages[-1]["content"])
        yield DRAFT

    first = json.dumps({"edits": [
        _edit("接口 QPS 提升 50%", "接口 QPS 提升 30%", "grounding", "档案写的是 30%"),
        _edit("用 Go 重写服务", "x", "depth"),
        _edit("不存在的句子", "y"),
    ]}, ensure_ascii=False)
    second = "好的：" + json.dumps({"edits": [], "notes": {"关键词": "缺 Redis，档案里没有"}}, ensure_ascii=False)
    review = _review(first, second)
    events = _run(doc_id, job_id, stream, complete=review)
    done = events[-1]

    assert "五险一金" in drafts[0]  # JD 原样交给模型，噪声由模型自己忽略
    assert [e["type"] for e in events if e["type"] == "review"] == ["review", "review"]
    system, user = review.calls[0]
    assert system["role"] == "system" and "审稿人" in system["content"]
    assert "## 原简历（事实来源）" in user["content"] and "某大学 | 计算机" in user["content"]
    assert "预计 1.00 页" in user["content"] and "接口 QPS 提升 50%" in user["content"]
    assert "接口 QPS 提升 30%" in review.calls[1][1]["content"]  # 第二轮审的是修订后的稿子

    first_round, second_round = done["rounds"]
    assert [e["old"] for e in first_round["applied"]] == ["接口 QPS 提升 50%"]
    assert [e["why"] for e in first_round["skipped"]] == ["原文出现 2 次，不唯一", "原文里找不到"]
    assert second_round["applied"] == [] and "error" not in second_round
    assert done["grounding"] == [_edit("接口 QPS 提升 50%", "接口 QPS 提升 30%", "grounding", "档案写的是 30%")]
    assert done["notes"]["关键词"] == "缺 Redis，档案里没有" and done["notes"]["语气"] == "无"
    saved = store.get("doc", done["doc_id"])["body"]
    assert "30%" in saved and "50%" not in saved and done["pages"] == 1.0


def test_tailor_review_limits(tmp_path, monkeypatch):
    doc_id, job_id = _setup(tmp_path, monkeypatch)

    async def draft(messages):
        yield NEW.replace("30%", "30%（版本1）")

    # 改坏格式：整轮作废，初稿原样保存
    broken = _run(doc_id, job_id, draft, complete=_review(json.dumps({"edits": [_edit("# 张三", "张三")]})))[-1]
    assert broken["rounds"][0]["applied"] == [] and "整轮作废" in broken["rounds"][0]["skipped"][0]["why"]
    assert len(broken["rounds"]) == 1 and store.get("doc", broken["doc_id"])["body"].startswith("# 张三")

    # 审稿不是 JSON：停在这一轮并写明原因，初稿照常保存
    bad = _run(doc_id, job_id, draft, complete=_review("好的，我看过了"))[-1]
    assert bad["type"] == "done" and "JSON" in bad["rounds"][0]["error"]

    # 每轮都有修改：最多 ROUNDS 轮
    async def endless(messages):
        n = len(endless.seen) + 1
        endless.seen.append(n)
        return json.dumps({"edits": [_edit(f"版本{n}", f"版本{n + 1}")]}, ensure_ascii=False)

    endless.seen = []
    capped = _run(doc_id, job_id, draft, complete=endless)[-1]
    assert len(capped["rounds"]) == tailor.ROUNDS == len(endless.seen)
    assert f"版本{tailor.ROUNDS + 1}" in store.get("doc", capped["doc_id"])["body"]
