from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, Optional

from pydantic import TypeAdapter

from app.agent.messages import convert_to_llm, estimate_tokens
from app.agent.types import (
    AgentMessage,
    BranchSummaryMessage,
    CompactionSummaryMessage,
    TextContent,
    ToolResultMessage,
    UserMessage,
)


_AGENT_MESSAGE_ADAPTER = TypeAdapter(AgentMessage)


@dataclass
class BranchSummaryResult:
    summary: str
    common_ancestor_id: Optional[str]
    from_messages: list[AgentMessage]
    to_messages: list[AgentMessage]
    details: dict[str, Any] = field(default_factory=dict)
    ok: bool = True


def find_common_ancestor(path_a: list[Any], path_b: list[Any]) -> Optional[str]:
    ids_a = [_entry_id(entry) for entry in path_a]
    ids_b = [_entry_id(entry) for entry in path_b]
    seen = set(ids_a)
    for entry_id in reversed(ids_b):
        if entry_id in seen:
            return entry_id
    return None


def collect_branch_messages(
    path: list[Any],
    *,
    since_entry_id: Optional[str],
    token_budget: int,
) -> list[AgentMessage]:
    selected: list[AgentMessage] = []
    total_tokens = 0
    for entry in reversed(path):
        entry_id = _entry_id(entry)
        if since_entry_id is not None and entry_id == since_entry_id:
            break
        message = _message_from_entry(entry)
        if message is None or isinstance(message, ToolResultMessage):
            continue
        tokens = estimate_tokens([message])
        if token_budget > 0 and total_tokens + tokens > token_budget and selected:
            break
        selected.append(message)
        total_tokens += tokens
    selected.reverse()
    return selected


def build_branch_summary_prompt(
    from_messages: list[AgentMessage],
    to_messages: list[AgentMessage],
) -> list[AgentMessage]:
    prompt = [
        "The user is leaving one conversation branch and moving to another.",
        "Summarize the branch being left so another LLM can understand facts that may affect the current branch.",
        "",
        "Extract the user goal, completed work, key decisions, and facts that may matter after navigation.",
        "",
        "<leaving-branch>",
        _serialize_messages(from_messages),
        "</leaving-branch>",
        "",
        "<destination-branch-context>",
        _serialize_messages(to_messages),
        "</destination-branch-context>",
        "",
        "Output a concise structured branch summary. Do not continue the conversation.",
    ]
    return [UserMessage(content=[TextContent(text="\n".join(prompt))], timestamp=time.time())]


async def summarize_branch(
    provider: Any,
    *,
    system_prompt: str,
    from_path: list[Any],
    to_path: list[Any],
    token_budget: int,
    max_tokens: int = 2048,
    cancel: Any = None,
) -> BranchSummaryResult:
    common_ancestor_id = find_common_ancestor(from_path, to_path)
    from_messages = collect_branch_messages(from_path, since_entry_id=common_ancestor_id, token_budget=token_budget)
    to_messages = collect_branch_messages(to_path, since_entry_id=common_ancestor_id, token_budget=token_budget)
    prompt_messages = build_branch_summary_prompt(from_messages, to_messages)
    details = {"status": "ok", "readFiles": [], "modifiedFiles": []}

    try:
        if cancel is not None and getattr(cancel, "cancelled", False):
            raise RuntimeError("branch summarization cancelled")
        summary = await provider.complete_text(system_prompt, prompt_messages, max_tokens=max_tokens)
        summary = (summary or "").strip()
        if not summary:
            details["status"] = "failed_empty"
            summary = ""
    except Exception as exc:
        details["status"] = "failed_error"
        details["error"] = str(exc)
        summary = ""

    return BranchSummaryResult(
        summary=summary,
        common_ancestor_id=common_ancestor_id,
        from_messages=from_messages,
        to_messages=to_messages,
        details=details,
        ok=bool(summary),
    )


def branch_summary_message(result: BranchSummaryResult, from_id: str) -> BranchSummaryMessage:
    return BranchSummaryMessage(summary=result.summary, from_id=from_id, timestamp=time.time())


def _entry_id(entry: Any) -> str:
    if isinstance(entry, str):
        return entry
    if isinstance(entry, dict):
        return str(entry.get("entry_id") or entry.get("id") or "")
    return str(getattr(entry, "entry_id", getattr(entry, "id", "")))


def _entry_type(entry: Any) -> str:
    if isinstance(entry, dict):
        return str(entry.get("entry_type") or entry.get("type") or "")
    return str(getattr(entry, "entry_type", getattr(entry, "type", "")))


def _entry_payload(entry: Any) -> dict[str, Any]:
    if isinstance(entry, dict):
        payload = entry.get("payload")
        if payload is not None:
            return dict(payload)
        if "message" in entry:
            message = entry["message"]
            return message.model_dump(mode="json") if hasattr(message, "model_dump") else dict(message)
        return {}
    payload = getattr(entry, "payload", None)
    if payload is not None:
        return dict(payload)
    message = getattr(entry, "message", None)
    if message is not None:
        return message.model_dump(mode="json") if hasattr(message, "model_dump") else dict(message)
    return {}


def _message_from_entry(entry: Any) -> Optional[AgentMessage]:
    entry_type = _entry_type(entry)
    payload = _entry_payload(entry)
    if entry_type == "message" and payload:
        return _AGENT_MESSAGE_ADAPTER.validate_python(payload)
    if entry_type == "compaction":
        return CompactionSummaryMessage(
            summary=str(payload.get("summary") or ""),
            tokens_before=int(payload.get("tokens_before") or payload.get("tokensBefore") or 0),
        )
    if entry_type == "branch_summary":
        return BranchSummaryMessage(
            summary=str(payload.get("summary") or ""),
            from_id=str(payload.get("from_id") or payload.get("fromId") or ""),
        )
    if payload.get("role"):
        return _AGENT_MESSAGE_ADAPTER.validate_python(payload)
    return None


def _serialize_messages(messages: list[AgentMessage]) -> str:
    if not messages:
        return "(none)"
    lines: list[str] = []
    for item in convert_to_llm(messages):
        role = item.get("role", "unknown")
        payload = {key: value for key, value in item.items() if key != "role"}
        lines.append("[%s] %s" % (role, json.dumps(payload, ensure_ascii=False, separators=(",", ":"))))
    return "\n".join(lines)

