"""评估流的事件顺序和落库：start → job_start / job … → done。"""

import asyncio

from app.core import job_eval, store, tools
from app.core.tools import USER_ACTOR


def test_evaluate_stream_order_and_persist(tmp_path, monkeypatch):
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(job_eval, "available", lambda: True)

    async def fake(text, job):
        return {"score": 70, "reasons": ["a", "b", "c"], "greeting": "", "markdown": "# 结论\nx"}

    monkeypatch.setattr(job_eval, "evaluate", fake)

    async def collect():
        return [e async for e in tools.evaluate_stream(ids=None, actor=USER_ACTOR)]

    first = tools.save("job", {"company": "甲", "title": "后端", "jd": "Go"}, actor=USER_ACTOR)["record"]
    second = tools.save("job", {"company": "乙", "title": "算法", "jd": "推荐"}, actor=USER_ACTOR)["record"]
    events = asyncio.run(collect())

    assert events[0] == {"type": "start", "total": 2}
    assert [e["type"] for e in events[1:-1]] == ["job_start", "job", "job_start", "job"]
    done = events[-1]
    assert done["type"] == "done" and done["count"] == 2 and len(done["change_ids"]) == 4
    assert store.get("job", first["id"])["score"] == 70
    assert store.get("job", second["id"])["score"] == 70
    again = asyncio.run(collect())
    assert again == [{"type": "done", "count": 0, "change_ids": [], "items": [], "failed": [], "remaining": 0}]


def test_evaluate_tool_is_chunked(tmp_path, monkeypatch):
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(job_eval, "available", lambda: True)

    async def fake(text, job):
        return {"score": 60, "reasons": ["a", "b", "c"], "greeting": "", "markdown": "# 结论\nx"}

    monkeypatch.setattr(job_eval, "evaluate", fake)
    for index in range(3):
        tools.save("job", {"company": f"公司{index}", "title": "后端", "jd": "Go"}, actor=USER_ACTOR)
    first = tools.evaluate_jobs(limit=1, actor=USER_ACTOR)
    assert first["count"] == 1 and first["remaining"] == 2
    second = tools.evaluate_jobs(limit=1, actor=USER_ACTOR)
    assert second["count"] == 1 and second["remaining"] == 1
    third = tools.evaluate_jobs(limit=1, actor=USER_ACTOR)
    assert third["count"] == 1 and third["remaining"] == 0
    assert tools.evaluate_jobs(limit=1, actor=USER_ACTOR)["count"] == 0
