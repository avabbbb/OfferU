"""做梦（reconcile）：离线核对记忆，只出待核对的建议，不写库。Route: fast-path。"""

from datetime import date

import pytest

from app.core import agent, reconcile, store
from app.core.tools import TOOLS, USER_ACTOR, call

TODAY = date(2026, 11, 9)


@pytest.fixture(autouse=True)
def _data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))


def _mem(actor=USER_ACTOR, **data):
    return call("save", {"type": "memory", "data": {"kind": "experience", **data}}, actor=actor)["record"]


def _snapshot():
    return store.changes(200), store.all_of("memory"), store.all_of("doc"), store.all_of("profile")


def _scan():
    before = _snapshot()
    found = reconcile.scan(today=TODAY)
    assert _snapshot() == before
    return found


def _of(found, kind):
    return [f for f in found if f["kind"] == kind]


def test_number_conflict_between_memories_patches_the_agent_one_only_when_user_applies():
    mine = _mem(title="腾讯 | 产品实习生", body="小程序服务了 7000+ 用户")
    guess = _mem(agent.ACTOR, title="腾讯 产品实习", body="小程序累计 6000+ 用户")
    [hit] = _of(_scan(), "conflict")
    assert hit["memory_ids"] == sorted([mine["id"], guess["id"]])
    assert {e["source"] for e in hit["evidence"]} == {f"memory#{mine['id']}", f"memory#{guess['id']}"}
    assert hit["suggestion"]
    assert hit["proposed"] == {"type": "memory", "id": guess["id"], "data": {"body": "小程序累计 7000+ 用户"}}

    out = call("save", hit["proposed"], actor=USER_ACTOR)
    assert store.changes(1)[0]["actor"] == USER_ACTOR
    assert not _of(_scan(), "conflict")
    call("undo", {"change_id": out["change_id"]}, actor=USER_ACTOR)
    assert store.get("memory", guess["id"])["body"] == "小程序累计 6000+ 用户"


def test_memory_body_conflicts_with_its_own_quote():
    memory = _mem(agent.ACTOR, title="增长项目", body="日活 3 万", quote="日活 5 万", said_at="2026-11-01")
    [hit] = _of(_scan(), "conflict")
    assert hit["memory_ids"] == [memory["id"]]
    assert {e.get("field") for e in hit["evidence"]} == {"body", "quote"}
    assert hit["proposed"]["data"] == {"body": "日活 5 万"}


def test_memory_conflicts_with_master_resume():
    _mem(title="腾讯 | 产品实习生", body="小程序服务了 7000+ 用户")
    call("save", {"type": "doc", "data": {"kind": "resume", "title": "主简历", "body":
         "# 张三\n\n## 实习\n\n### 腾讯 | 产品实习生 | 2024.06 - 2024.09\n- 小程序服务了 8000+ 用户"}}, actor=USER_ACTOR)
    hits = _of(_scan(), "conflict")
    assert any(e["source"].startswith("doc#") for h in hits for e in h["evidence"])


def test_same_title_with_different_dates_is_a_conflict():
    a = _mem(title="字节跳动 | 后端实习", start="2024-06", end="2024-09")
    b = _mem(title="字节跳动|后端实习", start="2024-07", end="2024-09")
    hits = [h for h in _of(_scan(), "conflict") if h["memory_ids"] == sorted([a["id"], b["id"]])]
    assert hits and "2024-06" in " ".join(e["text"] for e in hits[0]["evidence"])


def test_education_end_year_conflicts_with_profile():
    call("save", {"type": "profile", "data": {"school": "复旦大学", "grad_year": "2026"}}, actor=USER_ACTOR)
    _mem(kind="education", title="复旦大学 | 计算机", end="2027-06")
    assert any(e["source"] == "profile" for h in _of(_scan(), "conflict") for e in h["evidence"])


def test_status_drift_done_vs_planned():
    done = _mem(kind="award", title="数学建模国赛", body="已入选国赛决赛")
    plan = _mem(agent.ACTOR, kind="award", title="数学建模国赛 备赛", body="计划参加国赛决赛")
    [hit] = _of(_scan(), "status_drift")
    assert hit["memory_ids"] == sorted([done["id"], plan["id"]]) and hit["proposed"] is None
    assert "入选" in hit["suggestion"] and "计划" in hit["suggestion"]


def test_duplicate_by_title_and_by_body():
    a = _mem(kind="skill", title="Python")
    b = _mem(kind="skill", title="python ")
    c = _mem(kind="project", title="校园二手平台", body="用 FastAPI 和 React 做了校园二手交易平台，上线三个月")
    d = _mem(kind="project", title="二手交易小程序", body="用 FastAPI 和 React 做了校园二手交易平台，上线三个月。")
    pairs = {tuple(f["memory_ids"]) for f in _of(_scan(), "duplicate")}
    assert pairs == {(a["id"], b["id"]), (c["id"], d["id"])}


def test_stale_gap_only_after_n_days():
    old = _mem(title="增长实习", body="负责拉新，成果待补", said_at="2026-01-01")
    _mem(title="数据实习", body="具体数字记不清", said_at="2026-11-08")
    [hit] = _of(_scan(), "stale_gap")
    assert hit["memory_ids"] == [old["id"]] and "待补" in hit["evidence"][0]["text"]


def test_reconcile_tool_is_registered_and_read_only_for_any_actor():
    assert "reconcile_memory" in TOOLS
    _mem(title="旧实习", body="成果待补", said_at="2020-01-01")
    before = _snapshot()
    out = call("reconcile_memory", {}, actor=agent.ACTOR)
    assert _snapshot() == before and _of(out["items"], "stale_gap")
