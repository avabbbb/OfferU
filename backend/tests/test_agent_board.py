from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.services import agent_board, coding_agent_runtime


@pytest.fixture()
def board_home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    monkeypatch.setattr(agent_board, "runtime_data_dir", lambda: tmp_path / "data")
    monkeypatch.setattr(agent_board, "_process_tokens", lambda: frozenset())
    monkeypatch.setattr(agent_board, "_last_plain_call", {})
    return home


def _workbuddy(home: Path) -> dict:
    return {"id": "workbuddy", "display_name": "WorkBuddy", "executable": "workbuddy", "skill_root": str(home / ".workbuddy" / "skills")}


def test_custom_agent_connects_and_tracks_memory(board_home):
    added = agent_board.add_custom_agent(_workbuddy(board_home))
    assert added["custom"] is True
    assert added["skill_status"] == "NOT_INSTALLED"
    assert added["memory_status"] == "none"

    connected = agent_board.connect_agent("workbuddy")
    assert connected["skill_status"] == "INSTALLED"
    assert (board_home / ".workbuddy" / "skills" / "offeru" / "SKILL.md").is_file()

    exported = agent_board.export_memory_for_agent("workbuddy")
    assert exported["content"].startswith("# OfferU Agent Memory")
    assert agent_board.check_agent("workbuddy")["memory_status"] == "exported"
    assert agent_board.mark_memory_imported("workbuddy", "~/.workbuddy/MEMORY.md")["memory_status"] == "imported"

    board = agent_board.list_board()
    ids = [row["id"] for row in board["agents"]]
    assert "codex" in ids and ids[-1] == "workbuddy"
    assert board["live_window_seconds"] == agent_board.LIVE_WINDOW_SECONDS


def test_edit_hide_and_remove(board_home):
    agent_board.add_custom_agent(_workbuddy(board_home))
    assert agent_board.update_custom_agent("workbuddy", {"display_name": "WorkBuddy CLI"})["display_name"] == "WorkBuddy CLI"
    assert agent_board.set_hidden("codex", True)["hidden"] is True
    assert agent_board.remove_custom_agent("workbuddy") == {"removed": "workbuddy"}
    with pytest.raises(ValueError):
        agent_board.remove_custom_agent("codex")


@pytest.mark.parametrize(
    "change",
    [
        {"id": "codex"},
        {"id": "Bad Id"},
        {"executable": "C:/tools/workbuddy.exe --flag"},
        {"skill_root": "relative/skills"},
    ],
)
def test_rejects_unsafe_or_duplicate_entries(board_home, change):
    with pytest.raises(ValueError):
        agent_board.add_custom_agent({**_workbuddy(board_home), **change})


def test_rejects_skill_root_outside_home(board_home, tmp_path):
    with pytest.raises(ValueError):
        agent_board.add_custom_agent({**_workbuddy(board_home), "skill_root": str(tmp_path / "elsewhere")})


def test_unknown_agent_is_a_clear_error(board_home):
    with pytest.raises(ValueError, match="offeru agent list"):
        agent_board.connect_agent("nobody")


def test_connected_means_running_and_recently_called(board_home, monkeypatch):
    agent_board.add_custom_agent(_workbuddy(board_home))
    agent_board.connect_agent("workbuddy")
    agent_board.record_call("workbuddy", session_hint="  OFFERU \n main  ")
    row = agent_board.check_agent("workbuddy")
    assert row["skill_status"] == "INSTALLED"
    assert row["running"] is False and row["connected"] is False
    assert row["last_call"]["session_hint"] == "OFFERU main"

    monkeypatch.setattr(agent_board, "_process_tokens", lambda: frozenset({"node", "workbuddy"}))
    row = next(item for item in agent_board.list_board()["agents"] if item["id"] == "workbuddy")
    assert row["running"] is True and row["connected"] is True

    data = agent_board._load()
    stale = datetime.now(timezone.utc) - timedelta(seconds=agent_board.LIVE_WINDOW_SECONDS + 60)
    data["calls"]["workbuddy"]["at"] = stale.isoformat(timespec="seconds")
    agent_board._save(data)
    row = agent_board.check_agent("workbuddy")
    assert row["running"] is True and row["connected"] is False


@pytest.mark.parametrize(
    ("client", "expected"),
    [
        ("oh-my-pi", "omp"),
        ("codex-mcp-client", "codex"),
        ("claude-code/2.0", "claude"),
        ("gemini-cli-mcp-client", "gemini"),
        ("some-editor", ""),
    ],
)
def test_record_client_call_maps_client_names(board_home, client, expected):
    assert agent_board.record_client_call(client) == expected
    calls = agent_board._load()["calls"]
    if expected:
        assert calls[expected]["client"] == client
    else:
        assert calls == {}


def test_launch_opens_a_terminal_with_the_resolved_command(board_home, monkeypatch):
    opened: list[str] = []
    monkeypatch.setattr(agent_board, "_open_terminal", opened.append)
    monkeypatch.setattr(coding_agent_runtime, "_resolve_executable", lambda name: "/opt/bin/" + name)
    assert agent_board.launch_agent("codex") == {"launched": True, "executable": "/opt/bin/codex"}
    assert opened == ["/opt/bin/codex"]


def test_launch_without_an_installed_command_is_a_clear_error(board_home, monkeypatch):
    agent_board.add_custom_agent(_workbuddy(board_home))
    monkeypatch.setattr(agent_board.shutil, "which", lambda name: None)
    monkeypatch.setattr(agent_board, "_open_terminal", lambda executable: pytest.fail("must not open a terminal"))
    with pytest.raises(ValueError, match="启动命令名"):
        agent_board.launch_agent("workbuddy")


def test_board_over_http_lists_and_launches(board_home, tmp_path, monkeypatch):
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    from fastapi.testclient import TestClient

    from app.main import app
    from app.services import ui_approval_capability

    monkeypatch.setattr(ui_approval_capability, "_APPROVAL_TOKEN", "board-test-token")
    monkeypatch.setattr(coding_agent_runtime, "_resolve_executable", lambda name: "/opt/bin/" + name)
    opened: list[str] = []
    monkeypatch.setattr(agent_board, "_open_terminal", opened.append)
    with TestClient(app, base_url="http://127.0.0.1:8766") as client:
        listed = client.get("/api/agent-board").json()
        assert listed["live_window_seconds"] == agent_board.LIVE_WINDOW_SECONDS and "summary" not in listed
        assert all("running" in row and "last_call" in row for row in listed["agents"])
        assert client.post("/api/agent-board/codex/launch").status_code == 422
        assert client.post("/api/agent-board/codex/launch", headers={"Authorization": "Bearer wrong"}).status_code == 403
        assert opened == []
        launched = client.post("/api/agent-board/codex/launch", headers={"Authorization": "Bearer board-test-token"})
        assert launched.status_code == 200
        assert launched.json() == {"launched": True, "executable": "/opt/bin/codex"}
    assert opened == ["/opt/bin/codex"]
