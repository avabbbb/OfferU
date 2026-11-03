import pytest

from app.core import chrome_cdp


def test_build_args_local_only(tmp_path):
    args = chrome_cdp.build_args("chrome.exe", tmp_path, 9333, "")
    assert "--remote-debugging-address=127.0.0.1" in args
    assert "--remote-debugging-port=9333" in args
    assert f"--user-data-dir={tmp_path}" in args
    assert args[-1] == ""


def test_find_chrome_env(tmp_path, monkeypatch):
    exe = tmp_path / "chrome.exe"
    exe.write_text("x")
    monkeypatch.setenv("OFFERU_CHROME", str(exe))
    assert chrome_cdp.find_chrome() == str(exe)
    monkeypatch.setenv("OFFERU_CHROME", str(tmp_path / "missing.exe"))
    with pytest.raises(ValueError):
        chrome_cdp.find_chrome()


def test_free_port_is_local():
    port = chrome_cdp.free_port()
    assert 0 < port < 65536
