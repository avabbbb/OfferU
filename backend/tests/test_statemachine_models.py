"""状态机模型测试：用真实函数穷举「状态 × 事件」，对照 docs/design/statecharts.md 和 .agents/skills/statemachine-<名字>/SKILL.md。

known(...) 是 xfail(strict=True) 的已知问题，reason 写问题编号和现象；修好后会 XPASS 变红，提醒去掉标记。
"""

import asyncio
import itertools
import json
from contextlib import suppress
from datetime import date

import pytest

from app.core import consent, mail, store, tailor, tools

USER = tools.USER_ACTOR
AGENT = "Agent"
STATUSES = list(tools.JOB_STATUS)
MAIL_FROZEN = {"offer", "rejected", "closed"}
AT = "2026-11-01T10:00:00"


def known(issue: str) -> pytest.MarkDecorator:
    """已知问题：现在必然失败；修好后 XPASS 让这条测试变红。"""
    return pytest.mark.xfail(strict=True, raises=AssertionError, reason=issue)


@pytest.fixture(autouse=True)
def _one_page(monkeypatch):
    """量页数要开 Chromium；这里固定一页。"""
    monkeypatch.setattr(tailor, "measure", lambda body, doc: 1.0)


# ---------- job pipeline：job.status ----------

def _job(status: str, actor: str = USER) -> dict:
    job = tools.save("job", {"company": "公司", "title": "岗位"}, actor=actor)["record"]
    if status != "saved":
        tools.save("job", {"status": status}, job["id"], actor=actor)
    return store.get("job", job["id"])


def _mail(stage: str, mail_id: str, company: str = "公司") -> dict:
    return mail.apply({"mail_id": mail_id, "stage": stage, "company": company, "title": "岗位", "at": AT})


def _mail_model(current: str, new: str) -> str:
    """邮件这条路的规格：offer / rejected / closed 冻结；rejected 随时可进；其余只按 ORDER 前进。"""
    if current in MAIL_FROZEN:
        return current
    if new == "rejected":
        return "rejected"
    return new if mail.ORDER.index(new) > mail.ORDER.index(current) else current


@pytest.mark.parametrize("current,stage", list(itertools.product(STATUSES, mail.STAGE)))
def test_mail_moves_job_forward_only(current, stage):
    job = _job(current)
    out = _mail(stage, f"m-{current}-{stage}")
    assert out["job_id"] == job["id"]
    assert store.get("job", job["id"])["status"] == _mail_model(current, mail.STAGE[stage][0])


@pytest.mark.parametrize("current,new", list(itertools.product(STATUSES, STATUSES)))
def test_user_save_reaches_any_status(current, new):
    job = _job(current)
    tools.save("job", {"status": new}, job["id"], actor=USER)
    assert store.get("job", job["id"])["status"] == new


def test_mail_id_applies_once_even_after_undo():
    job = _job("saved")
    first = _mail("interview_1", "m-1")
    assert store.get("job", job["id"])["status"] == "interview"
    for change in reversed(first["changes"]):
        tools.undo(change, actor=USER)
    assert store.get("job", job["id"])["status"] == "saved"
    assert _mail("interview_1", "m-1")["skipped"] is True
    assert store.get("job", job["id"])["status"] == "saved"


def test_applied_at_set_when_status_moves_to_applied():
    job = _job("saved")
    tools.save("job", {"status": "applied"}, job["id"], actor=USER)
    assert store.get("job", job["id"])["applied_at"] == date.today().isoformat()


@pytest.mark.parametrize("via", ["user", "mail"])
def test_applied_at_set_when_created_applied(via):
    if via == "user":
        job_id = tools.save("job", {"company": "公司", "title": "岗位", "status": "applied"}, actor=USER)["record"]["id"]
    else:
        job_id = _mail("applied", "m-new", company="新公司")["job_id"]
    assert store.get("job", job_id).get("applied_at")


def test_agent_cannot_move_job_backward():
    job = _job("offer")
    with suppress(ValueError):
        tools.save("job", {"status": "saved"}, job["id"], actor=AGENT)
    assert store.get("job", job["id"])["status"] == "offer"


# ---------- change log：live -> undone ----------

def test_undo_each_change_once_in_any_kind():
    created = tools.save("job", {"company": "公司", "title": "岗位"}, actor=USER)
    job_id, made = created["record"]["id"], created["change_id"]
    edited = tools.save("job", {"notes": "Agent 补的"}, job_id, actor=AGENT)["change_id"]
    deleted = tools.delete("job", job_id, actor=USER)["change_id"]
    for change in (deleted, edited, made):
        tools.undo(change, actor=USER)
        with pytest.raises(ValueError, match="已经撤销过了"):
            tools.undo(change, actor=USER)
    assert store.get("job", job_id) is None
    undone = {row["id"]: row["undone_at"] for row in store.changes()}
    assert all(undone[c] for c in (deleted, edited, made))
    with pytest.raises(ValueError, match="不存在"):
        tools.undo(10_000, actor=USER)


def test_same_actor_edits_merge_other_actor_splits():
    job = _job("saved")
    first = tools.save("job", {"notes": "一"}, job["id"], actor=USER)["change_id"]
    second = tools.save("job", {"notes": "二"}, job["id"], actor=USER)["change_id"]
    third = tools.save("job", {"notes": "三"}, job["id"], actor=AGENT)["change_id"]
    assert first == second != third


def test_undo_keeps_later_edits():
    job = _job("saved")
    mine = tools.save("job", {"notes": "用户写的"}, job["id"], actor=USER)["change_id"]
    tools.save("job", {"notes": "Agent 改的"}, job["id"], actor=AGENT)
    with suppress(ValueError):
        tools.undo(mine, actor=USER)
    assert store.get("job", job["id"]).get("notes") == "Agent 改的"


def test_undo_create_keeps_record_updated_later():
    created = tools.save("job", {"company": "公司", "title": "岗位"}, actor=USER)
    job_id = created["record"]["id"]
    tools.save("job", {"notes": "Agent 补的"}, job_id, actor=AGENT)
    with suppress(ValueError):
        tools.undo(created["change_id"], actor=USER)
    assert store.get("job", job_id) is not None


# ---------- tailor run：idle / running，doc.pending_asks ----------

OLD = "# 张三\n138 · a@b.com\n\n## 教育经历\n### 某大学 | 计算机 | 2022.09 – 2026.06\n"
NEW = "# 张三\n138 · a@b.com\n\n## 实习经历\n### 字节 | 后端 | 2025.06 – 2025.09\n- 负责接口开发\n"
ASK = {"old": "- 负责接口开发", "why": "只有动作，没有结果", "question": "接口开发带来了什么结果？"}
BUSY = {"type": "error", "message": "这份简历正在改写，等它写完或取消"}


def _tailor_setup() -> tuple[int, int]:
    tools.save("profile", {"name": "张三", "school": "某大学"}, actor=USER)
    job = tools.save("job", {"company": "美团", "title": "后端", "jd": "负责 Go 后端开发"}, actor=USER)["record"]
    doc = tools.save("doc", {"kind": "resume", "title": "主简历", "body": OLD}, actor=USER)["record"]
    return doc["id"], job["id"]


def _draft(text: str = NEW, delay: float = 0.0):
    async def stream(messages):
        await asyncio.sleep(delay)
        yield text
    return stream


def _review(asks: list | None = None):
    async def complete(messages):
        return json.dumps({"edits": [], "asks": asks or []}, ensure_ascii=False)
    return complete


def _events(doc_id, job_id, stream=None, complete=None, deadline=5.0, review_only=False) -> list[dict]:
    async def go():
        return [event async for event in tailor.run(doc_id, job_id, stream=stream or _draft(), complete=complete or _review(),
                                                    deadline=deadline, review_only=review_only)]
    return asyncio.run(go())


def test_tailor_running_guard_and_release():
    doc_id, job_id = _tailor_setup()
    tailor._running.add(doc_id)
    try:
        assert _events(doc_id, job_id) == [BUSY]
    finally:
        tailor._running.discard(doc_id)
    # idle -> running -> idle：超时、成功都要释放
    timeout = _events(doc_id, job_id, stream=_draft(delay=1.0), deadline=0.1)
    assert timeout[-1]["type"] == "error" and doc_id not in tailor._running
    done = _events(doc_id, job_id)
    assert done[-1]["type"] == "done" and doc_id not in tailor._running


def test_tailor_full_run_persists_pending_asks():
    doc_id, job_id = _tailor_setup()
    done = _events(doc_id, job_id, complete=_review([ASK]))[-1]
    assert done["type"] == "done" and done["asks"] == [ASK]
    assert store.get("doc", done["doc_id"])["pending_asks"] == [ASK]


def test_review_only_does_not_write_pending_asks():
    doc_id, job_id = _tailor_setup()
    tailored = _events(doc_id, job_id)[-1].get("doc_id")
    rerun = _events(doc_id, job_id, complete=_review([ASK]), review_only=True)[-1]
    if rerun.get("type") != "done" or rerun.get("doc_id") != tailored:
        pytest.fail(f"只审稿没跑通：{rerun}")
    assert not store.get("doc", tailored).get("pending_asks")


# ---------- pick_asks：性质穷举 ----------

CANDIDATES = ["甲", "乙", "甲乙", "丙", "丁", "戊"]


@pytest.mark.parametrize("body", ["甲乙丙丁戊", "甲 甲 乙", "丙丁戊乙", ""])
def test_pick_asks_invariants(body):
    for size in range(5):
        for combo in itertools.product(CANDIDATES, repeat=size):
            asks = [{"old": old, "why": "w", "question": "q"} for old in combo]
            olds = [ask["old"] for ask in tailor.pick_asks(asks, body)]
            expected: list[str] = []
            for old in combo:
                if old not in expected and body.count(old) == 1:
                    expected.append(old)
            assert olds == expected[: tailor.MAX_ASKS]
            tools.check_asks([{"old": old, "why": "w", "question": "q"} for old in olds])


# ---------- 本轮修正：event.done / applied_at / 邮件改期 / consent 损坏 ----------

def test_event_done_must_be_bool():
    with pytest.raises(ValueError, match="event.done"):
        tools.save("event", {"kind": "interview", "title": "面试", "at": AT, "done": "false"}, actor=USER)


def test_resave_applied_keeps_applied_at():
    job = _job("applied")
    tools.save("job", {"applied_at": "2026-01-02"}, job["id"], actor=USER)
    tools.save("job", {"status": "applied"}, job["id"], actor=USER)
    assert store.get("job", job["id"])["applied_at"] == "2026-01-02"


def _interview(mail_id: str, at: str) -> dict:
    return mail.apply({"mail_id": mail_id, "stage": "interview_1", "company": "公司", "title": "岗位", "at": at})


def test_mail_reschedule_moves_upcoming_event():
    job = _job("saved")
    _interview("m-r1", "2099-01-01T10:00:00")
    _interview("m-r2", "2099-01-02T15:00:00")
    events = store.all_of("event", job_id=job["id"])
    assert len(events) == 1
    assert events[0]["at"] == mail._local("2099-01-02T15:00:00")


def test_mail_past_round_still_creates_new_event():
    job = _job("saved")
    _interview("m-p1", "2020-01-01T10:00:00")
    _interview("m-p2", "2020-01-08T10:00:00")
    assert len(store.all_of("event", job_id=job["id"])) == 2


def test_corrupt_consent_file_means_not_agreed():
    consent._path().write_text("{坏了", encoding="utf-8")
    with pytest.raises(ValueError, match="登录态采集还没开启"):
        consent.require()
