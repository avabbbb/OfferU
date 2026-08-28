"""Operation-backed persistence for the local Harness conversation surface."""

from __future__ import annotations

from typing import Any

from app.services.harness_history import (
    delete_conversation,
    get_conversation,
    save_conversation_messages,
)
from app.services.harness_memory import import_agent_memory_payload, save_agent_memory


def save_harness_conversation(
    conversation_id: str | None,
    messages: list[dict[str, str]],
) -> dict[str, Any]:
    return save_conversation_messages(
        conversation_id=conversation_id,
        messages=messages,
    )


def delete_harness_conversation(conversation_id: str) -> dict[str, Any]:
    return {
        "ok": delete_conversation(conversation_id),
        "conversation_id": conversation_id,
    }


async def distill_harness_conversation(conversation_id: str) -> dict[str, Any]:
    """Distill user excerpts into the existing observation pipeline."""
    conversation = get_conversation(conversation_id)
    if conversation is None:
        raise ValueError("Conversation not found")
    user_lines = [
        str(item.get("content") or "").strip()
        for item in conversation.get("messages", [])
        if isinstance(item, dict) and item.get("role") == "user"
    ]
    text = "\n".join(line for line in user_lines if line)
    if not text:
        return {"recorded": False, "reason": "conversation has no user messages"}

    from app.services.memory_distiller import distill_conversation

    return await distill_conversation(
        conversation_text=text,
        session_key=conversation_id,
        metadata={"turns": len(user_lines)},
    )


async def promote_harness_memory() -> dict[str, Any]:
    from app.services.memory_distiller import promote_session_memory

    return await promote_session_memory()


def import_harness_memory(content: dict[str, Any] | str) -> dict[str, Any]:
    memory = import_agent_memory_payload(content)
    return {"ok": True, "memory": save_agent_memory(memory)}

