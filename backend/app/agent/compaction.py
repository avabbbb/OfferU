from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, Optional

from app.agent.messages import convert_to_llm, estimate_tokens
from app.agent.types import (
    AgentMessage,
    AssistantMessage,
    CompactionSummaryMessage,
    TextContent,
    ToolCallContent,
    ToolResultMessage,
    UserMessage,
)


SUMMARY_SECTIONS = ("Goal", "Constraints", "Progress", "Key Decisions", "Next Steps", "Critical Context")
KEPT_CONTEXT_PREVIEW_CHARS = 8000


@dataclass
class CompactionResult:
    summary: str
    first_kept_index: int
    tokens_before: int
    kept_messages: list[AgentMessage]
    details: dict[str, Any] = field(default_factory=dict)
    ok: bool = True


@dataclass
class _CompactionPlan:
    messages_to_summarize: list[AgentMessage]
    turn_prefix_messages: list[AgentMessage]
    kept_messages: list[AgentMessage]
    first_kept_index: int
    is_split_turn: bool = False


def should_compact(messages: list[AgentMessage], *, context_window: int, reserve_tokens: int) -> bool:
    return estimate_tokens(messages) > context_window - reserve_tokens


def find_cut_point(messages: list[AgentMessage], *, keep_recent_tokens: int) -> Optional[int]:
    if len(messages) < 2:
        return None

    accumulated = 0
    target_index = len(messages) - 1
    for index in range(len(messages) - 1, -1, -1):
        accumulated += estimate_tokens([messages[index]])
        target_index = index
        if accumulated >= keep_recent_tokens:
            break

    for candidate in range(target_index, 0, -1):
        if _is_legal_cut(messages, candidate):
            return candidate
    return None


def split_turn_for_compaction(
    messages: list[AgentMessage],
    cut_index: int,
) -> tuple[list[AgentMessage], list[AgentMessage]]:
    if cut_index <= 0:
        return [], list(messages)
    if cut_index >= len(messages):
        return list(messages), []

    adjusted = cut_index
    if isinstance(messages[adjusted], ToolResultMessage):
        call_index = _matching_tool_call_index(messages, adjusted)
        if call_index is not None:
            adjusted = call_index
    if isinstance(messages[adjusted], AssistantMessage):
        turn_start = _turn_start_index(messages, adjusted)
        if turn_start is not None:
            adjusted = turn_start

    return list(messages[:adjusted]), list(messages[adjusted:])


def build_compaction_prompt(
    previous_summary: Optional[str],
    messages_to_summarize: list[AgentMessage],
    kept_messages: list[AgentMessage],
) -> list[AgentMessage]:
    prompt = [
        "Create or update a structured context checkpoint summary for the conversation.",
        "",
        "Use exactly these sections:",
        "## Goal",
        "## Constraints",
        "## Progress",
        "## Key Decisions",
        "## Next Steps",
        "## Critical Context",
        "",
        "<conversation-to-summarize>",
        _serialize_messages(messages_to_summarize),
        "</conversation-to-summarize>",
        "",
        "<kept-recent-context>",
        _serialize_messages_preview(kept_messages),
        "</kept-recent-context>",
    ]
    if previous_summary:
        prompt.extend(["", "<previous-summary>", previous_summary, "</previous-summary>"])
    prompt.append("")
    prompt.append("Do not continue the conversation. Output only the structured summary.")
    return [UserMessage(content=[TextContent(text="\n".join(prompt))], timestamp=time.time())]


def build_turn_prefix_prompt(
    turn_prefix_messages: list[AgentMessage],
    kept_messages: list[AgentMessage],
) -> list[AgentMessage]:
    prompt = [
        "This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.",
        "",
        "Summarize the prefix to provide context for the retained suffix:",
        "",
        "## Original Request",
        "[What did the user ask for in this turn?]",
        "",
        "## Early Progress",
        "- [Key decisions and work done in the prefix]",
        "",
        "## Context for Suffix",
        "- [Information needed to understand the kept suffix]",
        "",
        "<turn-prefix>",
        _serialize_messages(turn_prefix_messages),
        "</turn-prefix>",
        "",
        "<kept-suffix>",
        _serialize_messages(kept_messages),
        "</kept-suffix>",
        "",
        "Be concise. Focus on what is needed to understand the kept suffix.",
    ]
    return [UserMessage(content=[TextContent(text="\n".join(prompt))], timestamp=time.time())]


async def compact_messages(
    provider: Any,
    *,
    system_prompt: str,
    previous_summary: Optional[str],
    messages: list[AgentMessage],
    keep_recent_tokens: int,
    max_tokens: int = 4096,
    cancel: Any = None,
) -> CompactionResult:
    tokens_before = estimate_tokens(messages)
    cut_index = find_cut_point(messages, keep_recent_tokens=keep_recent_tokens)
    if cut_index is None:
        return CompactionResult(
            summary="",
            first_kept_index=0,
            tokens_before=tokens_before,
            kept_messages=list(messages),
            details={"status": "failed_no_cut", "readFiles": [], "modifiedFiles": []},
            ok=False,
        )

    plan = _plan_compaction(messages, cut_index)
    prompt_messages = build_compaction_prompt(previous_summary, plan.messages_to_summarize, plan.kept_messages)
    details = {
        "status": "ok",
        "readFiles": [],
        "modifiedFiles": [],
        "messages_summarized": len(plan.messages_to_summarize),
        "messages_kept": len(plan.kept_messages),
        "is_split_turn": plan.is_split_turn,
        "turn_prefix_messages": len(plan.turn_prefix_messages),
    }

    try:
        if cancel is not None and getattr(cancel, "cancelled", False):
            raise RuntimeError("compaction cancelled")
        if plan.is_split_turn and plan.turn_prefix_messages:
            if plan.messages_to_summarize:
                history_summary = await provider.complete_text(system_prompt, prompt_messages, max_tokens=max_tokens)
                history_summary = (history_summary or "").strip()
            else:
                history_summary = "No prior history."
            if not history_summary:
                details["status"] = "failed_empty"
                details["empty_segment"] = "history"
                summary = ""
            else:
                prefix_prompt_messages = build_turn_prefix_prompt(plan.turn_prefix_messages, plan.kept_messages)
                turn_prefix_summary = await provider.complete_text(
                    system_prompt,
                    prefix_prompt_messages,
                    max_tokens=max(1, max_tokens // 2),
                )
                turn_prefix_summary = (turn_prefix_summary or "").strip()
                if not turn_prefix_summary:
                    details["status"] = "failed_empty"
                    details["empty_segment"] = "turn_prefix"
                    summary = ""
                else:
                    summary = "%s\n\n---\n\n**Turn Context (split turn):**\n\n%s" % (
                        history_summary,
                        turn_prefix_summary,
                    )
        else:
            summary = await provider.complete_text(system_prompt, prompt_messages, max_tokens=max_tokens)
            summary = (summary or "").strip()
        if not summary:
            details["status"] = details.get("status") if details.get("status", "").startswith("failed_") else "failed_empty"
    except Exception as exc:
        details["status"] = "failed_error"
        details["error"] = str(exc)
        summary = ""

    return CompactionResult(
        summary=summary,
        first_kept_index=plan.first_kept_index,
        tokens_before=tokens_before,
        kept_messages=plan.kept_messages,
        details=details,
        ok=bool(summary),
    )


def compaction_summary_message(result: CompactionResult) -> CompactionSummaryMessage:
    return CompactionSummaryMessage(summary=result.summary, tokens_before=result.tokens_before, timestamp=time.time())


def _is_legal_cut(messages: list[AgentMessage], index: int) -> bool:
    if index <= 0 or index >= len(messages):
        return False
    first_kept = messages[index]
    if isinstance(first_kept, ToolResultMessage):
        call_index = _matching_tool_call_index(messages, index)
        if call_index is None or call_index < index:
            return False
    previous = messages[index - 1]
    if isinstance(previous, AssistantMessage):
        previous_call_ids = _tool_call_ids(previous)
        if previous_call_ids:
            following_results = _leading_tool_result_ids(messages, index)
            if previous_call_ids.intersection(following_results):
                return False
    return True


def _plan_compaction(messages: list[AgentMessage], cut_index: int) -> _CompactionPlan:
    is_split_turn = False
    turn_start = None
    if cut_index > 0 and cut_index < len(messages) and not isinstance(messages[cut_index], UserMessage):
        turn_start = _turn_start_index(messages, cut_index)
        is_split_turn = turn_start is not None and turn_start < cut_index

    if is_split_turn and turn_start is not None:
        return _CompactionPlan(
            messages_to_summarize=list(messages[:turn_start]),
            turn_prefix_messages=list(messages[turn_start:cut_index]),
            kept_messages=list(messages[cut_index:]),
            first_kept_index=cut_index,
            is_split_turn=True,
        )

    return _CompactionPlan(
        messages_to_summarize=list(messages[:cut_index]),
        turn_prefix_messages=[],
        kept_messages=list(messages[cut_index:]),
        first_kept_index=cut_index,
        is_split_turn=False,
    )


def _tool_call_ids(message: AssistantMessage) -> set[str]:
    return {block.id for block in message.content if isinstance(block, ToolCallContent)}


def _leading_tool_result_ids(messages: list[AgentMessage], start: int) -> set[str]:
    ids: set[str] = set()
    for message in messages[start:]:
        if not isinstance(message, ToolResultMessage):
            break
        ids.add(message.tool_call_id)
    return ids


def _matching_tool_call_index(messages: list[AgentMessage], result_index: int) -> Optional[int]:
    result = messages[result_index]
    if not isinstance(result, ToolResultMessage):
        return None
    for index in range(result_index - 1, -1, -1):
        message = messages[index]
        if isinstance(message, AssistantMessage) and result.tool_call_id in _tool_call_ids(message):
            return index
    return None


def _turn_start_index(messages: list[AgentMessage], index: int) -> Optional[int]:
    for current in range(index, -1, -1):
        if isinstance(messages[current], UserMessage):
            return current
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


def _serialize_messages_preview(messages: list[AgentMessage]) -> str:
    text = _serialize_messages(messages)
    if len(text) <= KEPT_CONTEXT_PREVIEW_CHARS:
        return text
    return text[:KEPT_CONTEXT_PREVIEW_CHARS].rstrip() + "\n...(kept recent context truncated for compaction preview)"
