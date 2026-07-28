from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.services.agent_files import atomic_write_json

HISTORY_DIR = Path(__file__).resolve().parents[2] / "data"
HISTORY_PATH = HISTORY_DIR / "harness_agent_conversations.json"
MAX_TITLE_LENGTH = 32
MAX_MESSAGES_PER_CONVERSATION = 120


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _empty_store() -> dict[str, Any]:
    return {"schema_version": "offeru.harness_conversations.v1", "conversations": []}


def _clean_message(message: Any) -> dict[str, str] | None:
    if not isinstance(message, dict):
        return None
    role = str(message.get("role") or "").strip()
    content = str(message.get("content") or "").strip()
    if role not in {"user", "assistant"} or not content:
        return None
    return {"role": role, "content": content[:8000]}


def _clean_messages(messages: list[dict[str, str]] | Any) -> list[dict[str, str]]:
    if not isinstance(messages, list):
        return []
    cleaned = [_clean_message(message) for message in messages]
    return [message for message in cleaned if message is not None][-MAX_MESSAGES_PER_CONVERSATION:]


def _title_from_messages(messages: list[dict[str, str]]) -> str:
    for message in messages:
        if message.get("role") == "user":
            title = re.sub(r"\s+", " ", str(message.get("content") or "")).strip()
            return title[:MAX_TITLE_LENGTH] or "新对话"
    return "新对话"


def _load_store(path: Path | None = None) -> dict[str, Any]:
    target = path or HISTORY_PATH
    if not target.exists():
        return _empty_store()
    try:
        payload = json.loads(target.read_text(encoding="utf-8"))
    except Exception:
        return _empty_store()
    if not isinstance(payload, dict) or not isinstance(payload.get("conversations"), list):
        return _empty_store()
    payload["schema_version"] = "offeru.harness_conversations.v1"
    return payload


def _save_store(store: dict[str, Any], path: Path | None = None) -> None:
    target = path or HISTORY_PATH
    atomic_write_json(target, store)


def list_conversations(path: Path | None = None) -> list[dict[str, Any]]:
    store = _load_store(path)
    result: list[dict[str, Any]] = []
    for item in store.get("conversations") or []:
        if not isinstance(item, dict):
            continue
        messages = _clean_messages(item.get("messages") or [])
        result.append(
            {
                "id": str(item.get("id") or ""),
                "title": str(item.get("title") or "新对话"),
                "created_at": str(item.get("created_at") or ""),
                "updated_at": str(item.get("updated_at") or ""),
                "message_count": len(messages),
                "last_message": messages[-1]["content"][:120] if messages else "",
            }
        )
    result = [item for item in result if item["id"]]
    result.sort(key=lambda item: item.get("updated_at") or "", reverse=True)
    return result


def get_conversation(conversation_id: str, path: Path | None = None) -> dict[str, Any] | None:
    store = _load_store(path)
    for item in store.get("conversations") or []:
        if isinstance(item, dict) and str(item.get("id")) == str(conversation_id):
            return {
                "id": str(item.get("id") or ""),
                "title": str(item.get("title") or "新对话"),
                "created_at": str(item.get("created_at") or ""),
                "updated_at": str(item.get("updated_at") or ""),
                "messages": _clean_messages(item.get("messages") or []),
            }
    return None


def save_conversation_messages(
    *,
    conversation_id: str | None,
    messages: list[dict[str, str]],
    path: Path | None = None,
) -> dict[str, Any]:
    clean_messages = _clean_messages(messages)
    now = _now_iso()
    store = _load_store(path)
    conversations = [item for item in store.get("conversations") or [] if isinstance(item, dict)]
    existing = next((item for item in conversations if str(item.get("id")) == str(conversation_id)), None)

    if existing is None:
        existing = {
            "id": conversation_id or f"conv_{uuid.uuid4().hex[:12]}",
            "title": _title_from_messages(clean_messages),
            "created_at": now,
            "updated_at": now,
            "messages": clean_messages,
        }
        conversations.append(existing)
    else:
        existing["title"] = str(existing.get("title") or _title_from_messages(clean_messages))
        existing["updated_at"] = now
        existing["messages"] = clean_messages

    existing["message_count"] = len(clean_messages)
    store["conversations"] = conversations
    _save_store(store, path)
    return {
        "id": str(existing.get("id") or ""),
        "title": str(existing.get("title") or "新对话"),
        "created_at": str(existing.get("created_at") or now),
        "updated_at": str(existing.get("updated_at") or now),
        "messages": clean_messages,
        "message_count": len(clean_messages),
    }


def delete_conversation(conversation_id: str, path: Path | None = None) -> bool:
    store = _load_store(path)
    conversations = [item for item in store.get("conversations") or [] if isinstance(item, dict)]
    next_conversations = [item for item in conversations if str(item.get("id")) != str(conversation_id)]
    if len(next_conversations) == len(conversations):
        return False
    store["conversations"] = next_conversations
    _save_store(store, path)
    return True
