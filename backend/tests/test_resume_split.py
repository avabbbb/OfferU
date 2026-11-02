"""旧简历拆成 memory：只认合法 kind、空条目丢掉，每条一条改动可逐条撤销；没模型也没开回退时不动档案；发往远端前脱敏。"""

import asyncio
import json

import pytest

from app.core import resume_split
from app.core.tools import call


def test_split_resume_saves_each_item_and_undoes(tmp_path, monkeypatch):
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(resume_split, "available", lambda: True)

    async def fake_extract(text):
        assert "腾讯" in text
        raw = [
            {"kind": "experience", "title": "腾讯 · 产品实习生", "body": "- 负责 3 个需求", "start": "2025-06", "end": "2025-09"},
            {"kind": "hobby", "title": "摄影", "body": ""},
            {"kind": "project", "title": "", "body": ""},
        ]
        return [m for m in map(resume_split.normalize, raw) if m]

    monkeypatch.setattr(resume_split, "extract", fake_extract)
    out = call("split_resume", {"text": "腾讯 产品实习生 2025.06-2025.09 负责 3 个需求"}, actor="你")
    assert out["count"] == 2 and len(out["change_ids"]) == 2
    items = call("list", {"type": "memory"}, actor="你")["items"]
    assert sorted(i["kind"] for i in items) == ["experience", "note"]

    for change_id in reversed(out["change_ids"]):
        call("undo", {"change_id": change_id}, actor="你")
    assert call("list", {"type": "memory"}, actor="你")["total"] == 0


def test_split_resume_refuses_without_model(tmp_path, monkeypatch):
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(resume_split, "available", lambda: False)
    with pytest.raises(ValueError, match="没配模型"):
        call("split_resume", {"text": "腾讯 实习"}, actor="你")
    assert call("list", {"type": "memory"}, actor="你")["total"] == 0


def test_extract_desensitizes_for_remote_endpoint(monkeypatch):
    from app.agents import agent_fallback, llm

    monkeypatch.setattr(agent_fallback, "endpoint_is_local", lambda: False)
    seen = {}

    async def fake_chat(messages, **kwargs):
        seen["user"] = messages[-1]["content"]
        return json.dumps({"items": [{"kind": "experience", "title": "实习", "body": seen["user"]}]}, ensure_ascii=False)

    monkeypatch.setattr(llm, "chat_completion", fake_chat)
    items = asyncio.run(resume_split.extract("电话 13812345678，腾讯实习"))
    assert "13812345678" not in seen["user"]
    assert "13812345678" in items[0]["body"]
