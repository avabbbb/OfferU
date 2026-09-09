from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from temp_paths import offeru_temp_directory

from app.services.harness_history import (  # noqa: E402
    delete_conversation,
    get_conversation,
    list_conversations,
    save_conversation_messages,
)


def test_history_creates_lists_and_loads_conversation() -> None:
    with offeru_temp_directory("harness-agent-history-") as tmp:
        path = pathlib.Path(tmp) / "history.json"
        saved = save_conversation_messages(
            conversation_id=None,
            messages=[
                {"role": "user", "content": "我是应届生，帮我做校招规划"},
                {"role": "assistant", "content": "先确认档案完整度。"},
            ],
            path=path,
        )

        assert saved["id"]
        assert saved["title"] == "我是应届生，帮我做校招规划"
        assert len(saved["messages"]) == 2

        conversations = list_conversations(path=path)
        assert len(conversations) == 1
        assert conversations[0]["id"] == saved["id"]
        assert conversations[0]["message_count"] == 2

        loaded = get_conversation(saved["id"], path=path)
        assert loaded is not None
        assert loaded["messages"][0]["role"] == "user"


def test_history_updates_existing_conversation_without_duplicates() -> None:
    with offeru_temp_directory("harness-agent-history-") as tmp:
        path = pathlib.Path(tmp) / "history.json"
        saved = save_conversation_messages(
            conversation_id=None,
            messages=[{"role": "user", "content": "第一轮"}],
            path=path,
        )
        updated = save_conversation_messages(
            conversation_id=saved["id"],
            messages=[
                {"role": "user", "content": "第一轮"},
                {"role": "assistant", "content": "收到"},
                {"role": "user", "content": "第二轮"},
            ],
            path=path,
        )

        assert updated["id"] == saved["id"]
        assert updated["title"] == "第一轮"
        assert len(updated["messages"]) == 3
        assert len(list_conversations(path=path)) == 1


def test_history_deletes_conversation() -> None:
    with offeru_temp_directory("harness-agent-history-") as tmp:
        path = pathlib.Path(tmp) / "history.json"
        saved = save_conversation_messages(
            conversation_id=None,
            messages=[{"role": "user", "content": "要删除的对话"}],
            path=path,
        )

        assert delete_conversation(saved["id"], path=path) is True
        assert get_conversation(saved["id"], path=path) is None
        assert list_conversations(path=path) == []


if __name__ == "__main__":
    test_history_creates_lists_and_loads_conversation()
    test_history_updates_existing_conversation_without_duplicates()
    test_history_deletes_conversation()
    print("harness agent history contract tests passed")
