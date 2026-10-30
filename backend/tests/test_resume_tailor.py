"""按岗位改简历：流式、只有成功才写库（一条 Agent 改动）；超时、取消、空输出、格式不对、缺 JD、并发都不动简历。"""

import asyncio

from app.core import store, tailor
from app.core.tools import save

FENCE = chr(96) * 3

OLD = "# 张三\n138 · a@b.com\n\n## 教育经历\n### 某大学 | 计算机 | 2022.09 – 2026.06\n"
NEW = "# 张三\n138 · a@b.com\n\n## 实习经历\n### 字节 | 后端 | 2025.06 – 2025.09\n- 接口 QPS 提升 30%\n"


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


def _run(doc_id, job_id, stream, deadline=5.0):
    async def go():
        return [event async for event in tailor.run(doc_id, job_id, stream=stream, deadline=deadline)]
    return asyncio.run(go())


def test_tailor_saves_one_agent_change(tmp_path, monkeypatch):
    doc_id, job_id = _setup(tmp_path, monkeypatch)
    events = _run(doc_id, job_id, _chunks(FENCE + "markdown\n", NEW[:20], NEW[20:], FENCE))
    assert [e["type"] for e in events] == ["start", "delta", "delta", "delta", "delta", "done"]
    doc = store.get("doc", doc_id)
    assert doc["body"] == NEW and doc["job_id"] == job_id
    assert store.changes(1)[0]["actor"] == "Agent"


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
    assert store.get("doc", doc_id)["body"] == OLD


def test_tailor_needs_jd(tmp_path, monkeypatch):
    doc_id, job_id = _setup(tmp_path, monkeypatch, jd="")
    assert _run(doc_id, job_id, _chunks(NEW)) == [{"type": "error", "message": "「美团 · 后端」还没有 JD，先在岗位页贴上"}]
    assert _run(doc_id, None, _chunks(NEW))[0]["message"] == "先给这份简历选一个岗位"


def test_tailor_one_run_per_resume_and_cancel(tmp_path, monkeypatch):
    doc_id, job_id = _setup(tmp_path, monkeypatch)

    async def go():
        first = tailor.run(doc_id, job_id, stream=_chunks(NEW, delay=0.2), deadline=5.0)
        assert (await anext(first))["type"] == "start"
        busy = [e async for e in tailor.run(doc_id, job_id, stream=_chunks(NEW))]
        await first.aclose()  # 前端断开连接 = 取消
        after = [e async for e in tailor.run(doc_id, job_id, stream=_chunks(NEW))]
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
