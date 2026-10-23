"""主线：Agent（MCP）和工作台（HTTP）用同一套工具写同一份数据，写了直接生效、能撤销，今天页给出下一步。"""

import asyncio
import json
from datetime import date

from app.core.tools import call, overview


def test_core_main_path(tmp_path, monkeypatch):
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    agent = "codex"
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
    assert names[0] == "overview" and len(names) <= 15
    asyncio.run(mcp.call_tool("save", {"type": "job", "data": {"company": "米哈游"}}))
    with TestClient(app, base_url="http://127.0.0.1:8766") as client:
        listed = client.post("/api/tools/list", json={"type": "job"}).json()
        assert listed["items"][0]["company"] == "米哈游"
        bad = client.post("/api/tools/save", json={"type": "job", "data": {"status": "maybe"}})
        assert bad.status_code == 400 and "status" in json.dumps(bad.json(), ensure_ascii=False)
