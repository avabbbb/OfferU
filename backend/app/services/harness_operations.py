"""Operation-backed persistence for the local Harness conversation surface."""

from __future__ import annotations

from typing import Any

from app.services.harness_history import (
    delete_conversation,
    get_conversation,
    save_conversation_messages,
)


def save_harness_conversation(
    conversation_id: str | None = None,
    messages: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return save_conversation_messages(
        conversation_id=conversation_id,
        messages=messages or [],
    )


def delete_harness_conversation(conversation_id: str) -> dict[str, Any]:
    return {
        "ok": delete_conversation(conversation_id),
        "conversation_id": conversation_id,
    }
