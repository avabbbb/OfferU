"""记忆要记来源和是否经用户确认：Agent 推断的不进定制简历，只有用户能确认。Route: fast-path。"""

import pytest

from app.core import agent, resume_split, store, tailor
from app.core.tools import USER_ACTOR, call


@pytest.fixture(autouse=True)
def _data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))


def _new(actor, extra=None):
    data = {"kind": "experience", "title": "测试经历"}
    data.update(extra or {})
    return call("save", {"type": "memory", "data": data}, actor=actor)["record"]


def test_user_actor_is_the_ui_default():
    assert USER_ACTOR == "你"


def test_user_created_memory_is_user_and_confirmed():
    record = _new(USER_ACTOR)
    assert record["source"] == "user" and record["confirmed"] is True


def test_agent_created_memory_is_agent_and_unconfirmed():
    record = _new(agent.ACTOR)
    assert record["source"] == "agent" and record["confirmed"] is False


def test_agent_cannot_self_confirm_or_claim_user_source():
    with pytest.raises(ValueError, match="确认"):
        _new(agent.ACTOR, {"confirmed": True})
    record = _new(agent.ACTOR)
    with pytest.raises(ValueError, match="确认"):
        call("save", {"type": "memory", "id": record["id"], "data": {"confirmed": True}}, actor="agent")
    with pytest.raises(ValueError, match="source"):
        call("save", {"type": "memory", "id": record["id"], "data": {"source": "user"}}, actor=agent.ACTOR)


def test_user_confirms_agent_memory_and_can_undo():
    record = _new(agent.ACTOR)
    out = call("save", {"type": "memory", "id": record["id"], "data": {"confirmed": True}}, actor=USER_ACTOR)
    assert out["record"]["confirmed"] is True and out["record"]["source"] == "agent"
    call("undo", {"change_id": out["change_id"]}, actor=USER_ACTOR)
    assert store.get("memory", record["id"])["confirmed"] is False


def test_legacy_memory_without_confirmed_feeds_tailoring():
    store.save("memory", {"kind": "experience", "title": "旧经历老数据"}, id_=None, actor=USER_ACTOR, summary="legacy")
    assert "旧经历老数据" in tailor._facts()


def test_unconfirmed_memory_is_kept_out_of_tailoring():
    _new(agent.ACTOR, {"title": "评估自评分 5.8 到 6.4"})
    _new(USER_ACTOR, {"title": "用户亲口的经历"})
    facts = tailor._facts()
    assert "评估自评分" not in facts and "用户亲口的经历" in facts


@pytest.mark.parametrize("actor", [USER_ACTOR, agent.ACTOR])
def test_split_resume_memories_are_resume_and_confirmed(monkeypatch, actor):
    monkeypatch.setattr(resume_split, "available", lambda: True)

    async def fake_extract(text):
        return [{"kind": "experience", "title": "腾讯 | 产品实习生"}]

    monkeypatch.setattr(resume_split, "extract", fake_extract)
    out = call("split_resume", {"text": "腾讯 产品实习生"}, actor=actor)
    record = store.get("memory", out["items"][0]["id"])
    assert record["source"] == "resume" and record["confirmed"] is True
    assert "腾讯 | 产品实习生" in tailor._facts()
