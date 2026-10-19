"""boss-cli 子进程：把 boss 的错误码翻成能照做的提示；只跑只读命令。"""

import asyncio
import sys

import pytest

from app.services import boss_sync


def _fake_boss(tmp_path, monkeypatch, envelope):
    script = tmp_path / "boss"
    script.write_text(f"#!{sys.executable}\nimport sys, json\nprint(json.dumps({envelope!r}))\nopen({str(tmp_path / 'args')!r}, 'a').write(' '.join(sys.argv[1:]) + '\\n')\n")
    script.chmod(0o755)
    monkeypatch.setenv("OFFERU_BOSS_BIN", str(script))


def test_run_boss_ok_and_args(tmp_path, monkeypatch):
    _fake_boss(tmp_path, monkeypatch, {"ok": True, "data": {"interviewList": []}})
    assert asyncio.run(boss_sync._run_boss(("interviews",)))["ok"] is True
    assert (tmp_path / "args").read_text().strip() == "interviews --json"
    assert boss_sync.COMMANDS == (("applied",), ("interviews",), ("chat",))


def test_run_boss_expired_login(tmp_path, monkeypatch):
    _fake_boss(tmp_path, monkeypatch, {"ok": False, "error": {"code": "not_authenticated", "message": "x"}})
    with pytest.raises(ValueError, match="重新扫码登录"):
        asyncio.run(boss_sync._run_boss(("applied",)))


def test_run_boss_explains_missing_web_login(tmp_path, monkeypatch):
    _fake_boss(tmp_path, monkeypatch, {"ok": False, "error": {"code": "not_authenticated", "message": "环境异常 (__zp_stoken__ 已过期)"}})
    with pytest.raises(ValueError, match="网页登录"):
        asyncio.run(boss_sync._run_boss(("search", "后端")))


def test_boss_login_shows_qr_then_ok(tmp_path, monkeypatch):
    from app.services import boss_login

    script = tmp_path / "boss"
    script.write_text(
        f"#!{sys.executable}\nimport sys, json, time\n"
        "if sys.argv[1] == 'status':\n    print(json.dumps({'credential_present': True})); sys.exit()\n"
        "open(sys.argv[2], 'wb').write(b'\\x89PNG')\n"
        "print(json.dumps({'event': 'qr'}), flush=True); time.sleep(0.5)\n"
        "print(json.dumps({'event': 'ok'}), flush=True)\n"
    )
    script.chmod(0o755)
    monkeypatch.setenv("OFFERU_BOSS_BIN", str(script))
    monkeypatch.setattr(boss_login, "QR_PNG", tmp_path / "qr.img")

    async def flow():
        await boss_login.start_boss_login()
        await asyncio.sleep(0.3)
        waiting = await boss_login.get_boss_login()
        await asyncio.sleep(0.8)
        return waiting, await boss_login.get_boss_login()

    waiting, done = asyncio.run(flow())
    assert waiting["status"] == "waiting" and waiting["qr"].startswith("data:image/png;base64,")
    assert done["status"] == "ok" and done["logged_in"] is True and done["qr"] is None
    assert done["capabilities"] == {"sync": True, "search": False}


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        ({"credential_present": True, "search_authenticated": False, "cookies": ["wt2", "zp_at"]}, {"sync": True, "search": False}),
        ({"credential_present": True, "search_authenticated": True, "cookies": ["__zp_stoken__", "wt2"]}, {"sync": True, "search": True}),
        ({"authenticated": False, "credential_present": False}, {"sync": False, "search": False}),
    ],
)
def test_boss_login_capabilities_follow_status(tmp_path, monkeypatch, status, expected):
    from app.services import boss_login

    _fake_boss(tmp_path, monkeypatch, status)
    view = asyncio.run(boss_login.get_boss_login())
    assert view["capabilities"] == expected
    assert view["logged_in"] is status["credential_present"]


def test_next_run_is_tomorrow_daytime():
    from datetime import datetime

    now = datetime(2026, 10, 20, 23, 0)
    nxt = boss_sync._next_run(now)
    assert nxt.date().day == 21 and 10 <= nxt.hour <= 21
