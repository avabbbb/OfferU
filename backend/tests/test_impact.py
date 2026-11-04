"""追问成果：用户回答 → 记忆草稿。一次模型调用；原话里没有的数字、弄丢或叠用的约数词、拔高的程度词只标出来提醒，不作废；只出草稿不写库。"""

import asyncio
import json

import pytest

from app.core import impact, store, tailor
from app.core.tools import save

JOB = "百度 · AI产品营销经理"
TODAY = "2026-11-04"
FANS = {"old": "- 负责公众号运营", "question": "你接手前后，粉丝大概变了多少？", "answer": "大概从2000涨到8000吧"}
PROMO = {"old": "- 负责活动策划", "question": "有没有被推广到别的组？", "answer": "没有数据，但后来被推广到别的组了"}
PRAISE = {"old": "- 负责数据周报", "question": "有没有被表扬、拿奖？", "answer": "被部门表扬过"}


def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    record = save("memory", {"kind": "experience", "title": "某公司 · 运营实习", "body": "- 负责公众号运营"}, actor="你")
    return record["record"]["id"]


def _model(reply):
    """模型替身：固定返回 reply，收到的 messages 记在 .calls。"""
    calls = []

    async def complete(messages):
        calls.append(messages)
        return reply if isinstance(reply, str) else json.dumps(reply, ensure_ascii=False)

    complete.calls = calls
    return complete


def _capture(answers, complete):
    return asyncio.run(impact.capture(answers, JOB, complete=complete, today=TODAY))


def test_capture_drafts_with_quote_and_date(tmp_path, monkeypatch):
    memory_id = _setup(tmp_path, monkeypatch)
    before = len(store.changes(100))
    model = _model({"drafts": [
        {"index": 0, "memory_id": memory_id, "add": "运营期间粉丝约从 2,000 增至 8000"},
        {"index": 1, "memory_id": None, "title": "活动策划", "add": "活动方案被推广到其他小组复用"},
    ]})
    out = _capture([FANS, PROMO, {**PRAISE, "answer": "  "}], model)

    assert len(model.calls) == 1
    prompt = model.calls[0][-1]["content"]
    assert JOB in prompt and f"#{memory_id} 某公司 · 运营实习" in prompt and FANS["answer"] in prompt
    assert "负责数据周报" not in prompt  # 空回答就是「先不答」，不送去整理
    fans, promo = out["drafts"]
    assert fans["memory_id"] == memory_id and fans["title"] == "某公司 · 运营实习"
    assert fans["data"] == {"body": "- 负责公众号运营\n- 运营期间粉丝约从 2,000 增至 8000",
                            "quote": FANS["answer"], "said_at": TODAY}
    assert fans["answers"][0]["index"] == 0 and fans["answers"][0]["old"] == FANS["old"]
    assert fans["answers"][0]["flags"] == [] and promo["answers"][0]["flags"] == []
    assert promo["memory_id"] is None
    assert promo["data"] == {"kind": "note", "title": "活动策划", "body": "- 活动方案被推广到其他小组复用",
                             "quote": PROMO["answer"], "said_at": TODAY}
    assert out["dropped"] == []
    assert len(store.changes(100)) == before  # 只出草稿，不写库


def test_capture_flags_instead_of_dropping(tmp_path, monkeypatch):
    memory_id = _setup(tmp_path, monkeypatch)
    out = _capture([FANS, PROMO, PRAISE], _model({"drafts": [
        {"index": 0, "memory_id": memory_id, "add": "粉丝从 2000 增至 8000"},
        {"index": 1, "memory_id": None, "add": "方案推广到 3 个小组，效率提升 30%"},
        {"index": "2", "memory_id": 999, "add": "- 获部门表扬"},
        {"index": 7, "add": "越界的序号不要"},
    ]}))

    assert out["dropped"] == []  # 有问题也留着，交给用户确认
    flagged = {a["index"]: a["flags"] for d in out["drafts"] for a in d["answers"]}
    assert flagged == {0: ["原话是「大概」，草稿没带约数词"], 1: ["原话里没有这个数字：3、30"], 2: []}
    praise = out["drafts"][-1]  # 对不上的 memory_id 当新建
    assert praise["memory_id"] is None
    assert praise["data"] == {"kind": "note", "title": "负责数据周报", "body": "- 获部门表扬",
                              "quote": PRAISE["answer"], "said_at": TODAY}


def test_flags_chinese_numbers_stacked_hedges_and_intensity():
    said = "大概让处理时间缩短了三成左右，没有精确统计"
    assert impact.flags("处理时间缩短约三成", said) == []
    assert impact.flags("处理时间缩短约三成左右", said) == ["约数词叠用了：约、左右"]
    assert impact.flags("处理时间缩短约五成", said) == ["原话里没有这个数字：五成"]
    assert impact.flags("找资料效率明显提升", "同事反馈说找资料快多了") == ["原话没有这个程度：明显"]
    assert impact.flags("效率明显提升", "效率明显提高了") == []  # 原话自己说了「明显」
    assert impact.flags("提升约两倍", "差不多快了两倍") == []
    assert impact.flags("覆盖约百分之三十的同事", "大约百分之二十的人在用") == ["原话里没有这个数字：百分之三十"]


def test_capture_merges_answers_for_one_memory(tmp_path, monkeypatch):
    memory_id = _setup(tmp_path, monkeypatch)
    out = _capture([FANS, PRAISE], _model({"drafts": [
        {"index": 0, "memory_id": memory_id, "add": "粉丝约从 2000 增至 8000"},
        {"index": 1, "memory_id": str(memory_id), "add": "周报获部门表扬"},
    ]}))

    [draft] = out["drafts"]
    assert draft["data"]["body"] == "- 负责公众号运营\n- 粉丝约从 2000 增至 8000\n- 周报获部门表扬"
    assert draft["data"]["quote"] == FANS["answer"] + "；" + PRAISE["answer"]
    assert [a["index"] for a in draft["answers"]] == [0, 1]


def test_capture_same_quote_saved_once(tmp_path, monkeypatch):
    """同一句话答了两个问题（真模型走查里出过），档案里的原话只记一次。"""
    memory_id = _setup(tmp_path, monkeypatch)
    out = _capture([FANS, {**PRAISE, "answer": FANS["answer"]}], _model({"drafts": [
        {"index": 0, "memory_id": memory_id, "add": "粉丝约从 2000 增至 8000"},
        {"index": 1, "memory_id": memory_id, "add": "粉丝约从 2000 增至 8000"},
    ]}))
    [draft] = out["drafts"]
    assert draft["data"]["quote"] == FANS["answer"]


def test_capture_needs_answers_and_json(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)

    async def never(messages):
        raise AssertionError("没有回答就不该调模型")

    with pytest.raises(ValueError, match="没有要整理的回答"):
        _capture([{**FANS, "answer": ""}], never)
    with pytest.raises(ValueError, match="没返回可用的草稿"):
        _capture([FANS], _model("好的，我整理一下"))
    out = _capture([FANS, PRAISE], _model({"drafts": [{"index": 0, "memory_id": None, "add": "粉丝约从 2000 增至 8000"}]}))
    assert [(d["index"], d["why"]) for d in out["dropped"]] == [(1, "模型没整理这条回答")]


def test_impact_route_then_facts_cite_quote(tmp_path, monkeypatch):
    """HTTP 路由：按岗位名整理；草稿存进档案后，改写的事实来源带上原话和日期；said_at 格式不对拒绝。"""
    memory_id = _setup(tmp_path, monkeypatch)
    job = save("job", {"company": "百度", "title": "AI产品营销经理", "jd": "负责 AI 产品营销"}, actor="你")["record"]
    model = _model({"drafts": [{"index": 0, "memory_id": memory_id, "add": "粉丝约从 2000 增至 8000"}]})
    monkeypatch.setattr(impact, "_default_complete", lambda: model)

    from fastapi.testclient import TestClient

    from app.main import app

    # 不进 lifespan：这条路由用不到它，而和别的测试一起跑时 lifespan 关闭会卡在 aiosqlite 线程上。
    client = TestClient(app, base_url="http" + "://127.0.0.1:8766")
    res = client.post("/api/resume/impact", json={"answers": [FANS], "job_id": job["id"]})
    assert res.status_code == 200, res.text
    out = res.json()
    assert JOB in model.calls[0][-1]["content"]
    [draft] = out["drafts"]
    save("memory", draft["data"], draft["memory_id"], actor="你")
    facts = tailor._facts()
    assert "粉丝约从 2000 增至 8000" in facts
    assert f"（用户 {draft['data']['said_at']} 亲口说：{FANS['answer']}）" in facts
    with pytest.raises(ValueError, match="said_at"):
        save("memory", {"title": "x", "said_at": "昨天"}, actor="你")
