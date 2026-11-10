"""邮件分类归 core：规则保底、模型融合、只回写 core（不再写旧的候选进展）。"""

import asyncio
import json

from app.core import mail, store, tools


def _classify(**kwargs):
    return asyncio.run(mail.classify(**kwargs))


def test_rules_match_stage_and_term():
    assert mail.rule_stage("面试邀请：请于周三参加一面")[0] == "interview_1"
    assert mail.rule_stage("恭喜，正式录用")[0] == "offer"
    assert mail.rule_stage("很遗憾地通知您未通过")[0] == "rejected"
    assert mail.rule_stage("随便聊聊") == ("unknown", "")


def test_llm_company_and_title_feed_apply(tmp_path, monkeypatch):
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    from app.agents import llm

    async def fake(messages, **kwargs):
        return json.dumps({"stage": "interview_1", "company": "美团", "job_title": "后端",
                           "confidence": 0.9, "interview_time": "2099-01-02T10:00:00",
                           "location": "", "evidence_span": "一面"}, ensure_ascii=False)

    monkeypatch.setattr(llm, "chat_completion", fake)
    job = tools.save("job", {"company": "美团", "title": "后端"}, actor="你")["record"]
    out = _classify(subject="一面通知", body="请参加一面", sender="hr@meituan.com")
    assert out["stage"] == "interview_1" and out["company"] == "美团" and out["at"]
    written = mail.apply({"mail_id": "m-1", "stage": out["stage"], "company": out["company"],
                          "title": out["title"], "at": out["at"]})
    assert written["job_id"] == job["id"]
    assert store.get("job", job["id"])["status"] == "interview"


def test_llm_cannot_override_rule_below_confidence(tmp_path, monkeypatch):
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    from app.agents import llm

    async def low(messages, **kwargs):
        return json.dumps({"stage": "offer", "confidence": 0.4, "evidence_span": "笔试"})

    monkeypatch.setattr(llm, "chat_completion", low)
    out = _classify(subject="笔试通知", body="请参加在线笔试", sender="hr@x.com")
    assert out["stage"] == "written_test" and out["llm_used"] is True


def test_llm_failure_falls_back_to_rules(tmp_path, monkeypatch):
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    from app.agents import llm

    async def broken(messages, **kwargs):
        raise RuntimeError("gateway down")

    monkeypatch.setattr(llm, "chat_completion", broken)
    out = _classify(subject="感谢投递", body="简历已收到", sender="hr@x.com")
    assert out["stage"] == "applied" and out["llm_used"] is False


def test_email_sync_no_longer_writes_legacy_candidates():
    from app.services import email_sync

    assert not hasattr(email_sync, "ingest_application_signal")
