from __future__ import annotations

import json
from typing import Any, Iterable, Optional, Union

from pydantic import TypeAdapter

from app.agent.types import (
    AgentMessage,
    AssistantMessage,
    BranchSummaryMessage,
    CompactionSummaryMessage,
    CustomMessage,
    ImageContent,
    MessageContent,
    TextContent,
    ThinkingContent,
    ToolCallContent,
    ToolResultMessage,
    UserMessage,
)


COMPACTION_SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n"
COMPACTION_SUMMARY_SUFFIX = "\n</summary>"
BRANCH_SUMMARY_PREFIX = "The following is a summary of a branch that this conversation came back from:\n\n<summary>\n"
BRANCH_SUMMARY_SUFFIX = "</summary>"

_AGENT_MESSAGE_LIST_ADAPTER = TypeAdapter(list[AgentMessage])


def create_text_message(text: str, timestamp: Optional[float] = None) -> UserMessage:
    return UserMessage(content=[TextContent(text=text)], timestamp=timestamp)


def create_custom_message(
    custom_type: str,
    content: Union[str, list[MessageContent]],
    display: bool = False,
    details: Any = None,
    timestamp: Optional[float] = None,
) -> CustomMessage:
    return CustomMessage(
        custom_type=custom_type,
        content=content,
        display=display,
        details=details,
        timestamp=timestamp,
    )


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _content_to_text(content: Iterable[MessageContent]) -> str:
    parts: list[str] = []
    for block in content:
        if isinstance(block, TextContent):
            parts.append(block.text)
        elif isinstance(block, ImageContent):
            parts.append(f"[image: {block.url}]")
    return "".join(parts)


def _custom_content_to_text(content: Union[str, list[MessageContent]]) -> str:
    if isinstance(content, str):
        return content
    return _content_to_text(content)


def _assistant_to_llm(message: AssistantMessage) -> dict[str, Any]:
    text = _content_to_text(block for block in message.content if not isinstance(block, ThinkingContent))
    tool_calls = [
        {
            "id": block.id,
            "type": "function",
            "function": {"name": block.name, "arguments": _json_dumps(block.arguments)},
        }
        for block in message.content
        if isinstance(block, ToolCallContent)
    ]
    payload: dict[str, Any] = {"role": "assistant", "content": text}
    if tool_calls:
        payload["tool_calls"] = tool_calls
    return payload


def _tool_result_to_llm(message: ToolResultMessage) -> dict[str, Any]:
    text = _content_to_text(message.content)
    if message.is_error and not text.startswith("ERROR:"):
        text = f"ERROR: {text}"
    return {"role": "tool", "tool_call_id": message.tool_call_id, "content": text}


def convert_to_llm(messages: Union[list[AgentMessage], list[dict[str, Any]]]) -> list[dict[str, Any]]:
    parsed = _AGENT_MESSAGE_LIST_ADAPTER.validate_python(messages)
    llm_messages: list[dict[str, Any]] = []
    for message in parsed:
        if isinstance(message, UserMessage):
            llm_messages.append({"role": "user", "content": _content_to_text(message.content)})
        elif isinstance(message, AssistantMessage):
            llm_messages.append(_assistant_to_llm(message))
        elif isinstance(message, ToolResultMessage):
            llm_messages.append(_tool_result_to_llm(message))
        elif isinstance(message, CompactionSummaryMessage):
            llm_messages.append(
                {
                    "role": "user",
                    "content": COMPACTION_SUMMARY_PREFIX + message.summary + COMPACTION_SUMMARY_SUFFIX,
                }
            )
        elif isinstance(message, BranchSummaryMessage):
            llm_messages.append(
                {
                    "role": "user",
                    "content": BRANCH_SUMMARY_PREFIX + message.summary + BRANCH_SUMMARY_SUFFIX,
                }
            )
        elif isinstance(message, CustomMessage):
            llm_messages.append({"role": "user", "content": _custom_content_to_text(message.content)})
    return llm_messages


def estimate_tokens(messages: Union[list[AgentMessage], list[dict[str, Any]]]) -> int:
    serialized = _json_dumps(convert_to_llm(messages))
    return max(1, len(serialized) // 4)
