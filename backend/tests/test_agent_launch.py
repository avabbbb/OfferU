import pytest

from app.services import agent_launch as a

CID = "0123456789abcdef0123456789abcdef"


def test_prompt_is_shell_safe_and_carries_challenge():
    prompt = a.build_init_prompt("codex", CID)
    assert CID in prompt and "provider_id=codex" in prompt
    assert not set(prompt) & a._UNSAFE_PROMPT_CHARS


def test_rejects_malformed_challenge():
    with pytest.raises(ValueError):
        a.build_init_prompt("codex", "x" * 32)


def test_unverified_provider_has_no_launch():
    assert not a.supports_launch("gemini")
    with pytest.raises(ValueError):
        a.build_agent_argv("gemini", "gemini", "hi")


def test_windows_cmd_shim_opens_in_new_console(tmp_path):
    argv = a.build_agent_argv("opencode", "C:/bin/opencode.cmd", "hi")
    assert argv == ["C:/bin/opencode.cmd", "--prompt", "hi"]
    command, options = a.build_terminal_launch(argv, tmp_path, platform="win32")
    assert command == ["cmd.exe", "/d", "/s", "/k", *argv]
    assert options["creationflags"]


def test_no_terminal_returns_copyable_command(tmp_path):
    def never(*_args, **_kwargs):
        pytest.fail("must not spawn without a terminal")

    out = a.launch("codex", "/usr/bin/codex", "hi", tmp_path, platform="linux", which=lambda _: None, spawn=never)
    assert out == {"launched": False, "command": "/usr/bin/codex hi", "error": out["error"]}
    assert out["error"]


def test_launch_spawns_terminal_once(tmp_path):
    calls = []
    out = a.launch(
        "claude", "/usr/bin/claude", "hi", tmp_path / "sessions", platform="linux",
        which=lambda _: "/usr/bin/x-terminal-emulator", spawn=lambda cmd, **kw: calls.append((cmd, kw)),
    )
    assert out["launched"] is True
    assert calls == [(["/usr/bin/x-terminal-emulator", "-e", "/usr/bin/claude", "hi"], calls[0][1])]
    assert (tmp_path / "sessions").is_dir()


def test_spawn_failure_is_reported_not_raised(tmp_path):
    def boom(*_args, **_kwargs):
        raise OSError("no console")

    out = a.launch("pi", "/usr/bin/pi", "hi", tmp_path, platform="linux", which=lambda _: "/t", spawn=boom)
    assert out["launched"] is False and "no console" in out["error"]
