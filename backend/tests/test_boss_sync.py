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
    with pytest.raises(ValueError, match="boss login"):
        asyncio.run(boss_sync._run_boss(("applied",)))


def test_next_run_is_tomorrow_daytime():
    from datetime import datetime

    now = datetime(2026, 10, 20, 23, 0)
    nxt = boss_sync._next_run(now)
    assert nxt.date().day == 21 and 10 <= nxt.hour <= 21
