from __future__ import annotations

from pathlib import Path

import pytest

from app.services import agent_board


@pytest.fixture()
def board_home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    monkeypatch.setattr(agent_board, "runtime_data_dir", lambda: tmp_path / "data")
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

    ids = [row["id"] for row in agent_board.list_board()["agents"]]
    assert "codex" in ids and ids[-1] == "workbuddy"


def test_edit_hide_and_remove(board_home):
    agent_board.add_custom_agent(_workbuddy(board_home))
    assert agent_board.update_custom_agent("workbuddy", {"display_name": "WorkBuddy CLI"})["display_name"] == "WorkBuddy CLI"
    assert agent_board.set_hidden("codex", True)["hidden"] is True
    assert agent_board.list_board()["summary"]["connected"] == 0
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


def test_connected_needs_a_conversation_readback(board_home):
    agent_board.add_custom_agent(_workbuddy(board_home))
    row = agent_board.connect_agent("workbuddy")
    assert row["skill_status"] == "INSTALLED"
    assert row["connected"] is False
    assert agent_board.list_board()["summary"]["connected"] == 0

    agent_board.record_connection("workbuddy", challenge_id="a" * 32, session_hint="  OFFERU \n main  ")
    row = agent_board.check_agent("workbuddy")
    assert row["connected"] is True
    assert row["connection"]["session_hint"] == "OFFERU main"
    assert agent_board.list_board()["summary"]["connected"] == 1

    assert agent_board.connect_agent("workbuddy", "repair")["connected"] is False
