"""事件生命周期：岗位进终态后不再催它的事项；撤回同意会清掉登录态目录。"""

from datetime import date

import pytest

from app.core import consent, store, tools

USER = tools.USER_ACTOR


def _job_with_event(status: str = "applied") -> tuple[int, int]:
    job = tools.save("job", {"company": "公司", "title": "岗位", "status": status}, actor=USER)["record"]
    event = tools.save("event", {"kind": "interview", "title": "面试", "at": "2020-01-01T10:00",
                                 "job_id": job["id"]}, actor=USER)["record"]
    return job["id"], event["id"]


def _titles(view: dict) -> set[str]:
    return {e["title"] for bucket in view["todos"].values() for e in bucket}


def test_terminal_job_events_leave_todo_list():
    job_id, _ = _job_with_event()
    assert "面试" in _titles(tools.overview(today=date(2026, 11, 10)))
    tools.save("job", {"status": "rejected"}, job_id, actor=USER)
    assert "面试" not in _titles(tools.overview(today=date(2026, 11, 10)))


def test_offer_keeps_events():
    job_id, _ = _job_with_event("interview")
    tools.save("job", {"status": "offer"}, job_id, actor=USER)
    assert "面试" in _titles(tools.overview(today=date(2026, 11, 10)))


def test_terminal_save_reports_open_events():
    job_id, _ = _job_with_event()
    out = tools.save("job", {"status": "closed"}, job_id, actor=USER)
    assert out["open_events"] == 1
    summary = store.changes(1)[0]["summary"]
    assert "还有 1 件未完成事项" in summary


def test_revoke_consent_clears_browser_profile(tmp_path, monkeypatch):
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    profile = tmp_path / "chrome-profile"
    (profile / "Default").mkdir(parents=True)
    (profile / "Default" / "Cookies").write_bytes(b"x")
    consent.agree(consent.VERSION)
    consent.revoke()
    assert not profile.exists()
    with pytest.raises(ValueError, match="登录态采集还没开启"):
        consent.require()
