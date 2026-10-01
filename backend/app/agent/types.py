from __future__ import annotations

import asyncio
from typing import Any, Callable, Literal, Optional, Union

from pydantic import BaseModel, Field
from typing_extensions import Annotated


class Usage(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    estimated: bool = False


class TextContent(BaseModel):
    type: Literal["text"] = "text"
    text: str


class ThinkingContent(BaseModel):
    type: Literal["thinking"] = "thinking"
    thinking: str


class ImageContent(BaseModel):
    type: Literal["image"] = "image"
    url: str
    mime_type: Optional[str] = None


class ToolCallContent(BaseModel):
    type: Literal["toolCall"] = "toolCall"
    id: str
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)


MessageContent = Annotated[
    Union[TextContent, ThinkingContent, ImageContent, ToolCallContent],
    Field(discriminator="type"),
]


class UserMessage(BaseModel):
    role: Literal["user"] = "user"
    content: list[MessageContent]
    timestamp: Optional[float] = None


class AssistantMessage(BaseModel):
    role: Literal["assistant"] = "assistant"
    content: list[MessageContent] = Field(default_factory=list)
    stop_reason: Optional[str] = None
    usage: Optional[Usage] = None
    model: str = ""
    provider: str = ""
    error_message: Optional[str] = None
    timestamp: Optional[float] = None


class ToolResultMessage(BaseModel):
    role: Literal["toolResult"] = "toolResult"
    tool_call_id: str
    tool_name: str
    content: list[MessageContent] = Field(default_factory=list)
    details: Any = None
    is_error: bool = False
    timestamp: Optional[float] = None


class CompactionSummaryMessage(BaseModel):
    role: Literal["compactionSummary"] = "compactionSummary"
    summary: str
    tokens_before: int = 0
    timestamp: Optional[float] = None


class BranchSummaryMessage(BaseModel):
    role: Literal["branchSummary"] = "branchSummary"
    summary: str
    from_id: str
    timestamp: Optional[float] = None


class CustomMessage(BaseModel):
    role: Literal["custom"] = "custom"
    custom_type: str
    content: Union[str, list[MessageContent]]
    display: bool = False
    details: Any = None
    timestamp: Optional[float] = None


AgentMessage = Annotated[
    Union[
        UserMessage,
        AssistantMessage,
        ToolResultMessage,
        CompactionSummaryMessage,
        BranchSummaryMessage,
        CustomMessage,
    ],
    Field(discriminator="role"),
]


class StreamEvent(BaseModel):
    type: str
    message: Optional[AssistantMessage] = None
    delta: dict[str, Any] = Field(default_factory=dict)


class AgentTool(BaseModel):
    name: str
    description: str = ""
    parameters: dict[str, Any] = Field(default_factory=dict)


class CancelToken:
    def __init__(self) -> None:
        self._event = asyncio.Event()

    def cancel(self) -> None:
        self._event.set()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def throw_if_cancelled(self) -> None:
        if self.cancelled:
            raise asyncio.CancelledError()


StreamFn = Callable[..., Any]
"""流式 LLM 调用的统一契约（对齐 PI 的 StreamFn 语义）。

实现必须满足：
- 永不 raise：任何失败编码为事件流内的 ``error`` 事件 + ``stop_reason="error"``
  的 AssistantMessage（含 ``error_message``）；协作式取消以 ``stop_reason="aborted"`` 收尾。
- 事件序：``start`` 恰好一次（永远是第一个事件），任意个
  ``text_delta``/``thinking_delta``/``tool_call_delta``，最后恰好一个终结事件
  （``done`` 或 ``error``），终结事件的 ``message`` 为完整最终消息。
"""
