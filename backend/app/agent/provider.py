from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import AsyncIterator, Iterable
from typing import Any, Callable, Optional, Union

from openai import BadRequestError

from app.agent.messages import convert_to_llm, estimate_tokens
from app.agent.types import (
    AgentMessage,
    AgentTool,
    AssistantMessage,
    CancelToken,
    StreamEvent,
    TextContent,
    ThinkingContent,
    ToolCallContent,
    Usage,
)
from app.agents.llm import _get_client, resolve_llm_client_config, resolve_model_for_tier as configured_model_for_tier
from app.config import get_settings

_logger = logging.getLogger(__name__)

_SECRET_PATTERN = re.compile(r"(sk-[A-Za-z0-9_\-]{8,}|Bearer\s+\S+|api[_-]?key[=:]\s*\S+)", re.IGNORECASE)


def sanitize_error_message(message: str, limit: int = 500) -> str:
    from app.services.security_redaction import redact_sensitive_text
    cleaned = redact_sensitive_text(_SECRET_PATTERN.sub("[REDACTED]", str(message or "")), max_length=limit)
    return cleaned[:limit]


def resolve_model_for_tier(default_model: str, tier: str, tier_model_map: Optional[dict[str, str]]) -> str:
    if tier_model_map:
        return tier_model_map.get(tier, default_model)
    return default_model


def _object_to_plain(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {key: _object_to_plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_object_to_plain(item) for item in value]
    if hasattr(value, "model_dump"):
        return _object_to_plain(value.model_dump())
    if hasattr(value, "__dict__"):
        return {
            key: _object_to_plain(item)
            for key, item in vars(value).items()
            if not key.startswith("_")
        }
    return value


def _first_choice(chunk: dict[str, Any]) -> dict[str, Any]:
    choices = chunk.get("choices") or []
    if not choices:
        return {}
    return choices[0] or {}


def _parse_arguments(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if raw in (None, ""):
        return {}
    if not isinstance(raw, str):
        return {"value": raw}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {"_raw": raw}
    if isinstance(parsed, dict):
        return parsed
    return {"value": parsed}


def _tool_call_slot(tool_calls: list[dict[str, Any]], tool_delta: dict[str, Any]) -> int:
    """Resolve which accumulator slot a streamed tool_call delta belongs to.

    Providers without an ``index`` field either emit complete calls (each with
    its own ``id``) or fragment continuations (no ``id``): a new id opens a new
    slot, a known id resumes its slot, and an id-less fragment always extends
    the most recent slot.
    """
    index = tool_delta.get("index")
    if index is not None:
        index = int(index)
        while len(tool_calls) <= index:
            tool_calls.append({"id": "", "name": "", "arguments": ""})
        return index
    delta_id = str(tool_delta.get("id") or "")
    if delta_id:
        for position, call in enumerate(tool_calls):
            if call["id"] == delta_id:
                return position
        tool_calls.append({"id": "", "name": "", "arguments": ""})
        return len(tool_calls) - 1
    if not tool_calls:
        tool_calls.append({"id": "", "name": "", "arguments": ""})
    return len(tool_calls) - 1


def _usage_from_chunk(chunk: dict[str, Any], output_text: str) -> Usage:
    raw_usage = chunk.get("usage") or {}
    input_tokens = int(raw_usage.get("prompt_tokens") or raw_usage.get("input_tokens") or 0)
    output_tokens = int(raw_usage.get("completion_tokens") or raw_usage.get("output_tokens") or 0)
    if raw_usage:
        return Usage(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=int(raw_usage.get("total_tokens") or (input_tokens + output_tokens)),
            estimated=False,
        )
    estimated_output = max(1, len(output_text) // 4) if output_text else 0
    return Usage(
        input_tokens=0,
        output_tokens=estimated_output,
        total_tokens=estimated_output,
        estimated=True,
    )


def _make_partial_message(
    provider: str,
    model: str,
    text: str,
    thinking: str,
    tool_calls: list[dict[str, Any]],
    stop_reason: Optional[str] = None,
    usage: Optional[Usage] = None,
    error_message: Optional[str] = None,
    include_incomplete: bool = True,
) -> AssistantMessage:
    content = []
    if thinking:
        content.append(ThinkingContent(thinking=thinking))
    if text:
        content.append(TextContent(text=text))
    for call in tool_calls:
        # Empty-name slots come from index-bearing deltas that never carried a
        # function.name (e.g. swe-2). They are raw stream progress, so delta
        # messages keep them; terminal messages must not surface them as
        # executable ToolCallContent ("Tool not found" phantom calls).
        if not include_incomplete and not (call.get("name") or "").strip():
            continue
        content.append(
            ToolCallContent(
                id=call.get("id") or f"call_{len(content) + 1}",
                name=call.get("name") or "",
                arguments=_parse_arguments(call.get("arguments")),
            )
        )
    return AssistantMessage(
        content=content,
        stop_reason=stop_reason,
        usage=usage,
        model=model,
        provider=provider,
        error_message=error_message,
    )


class LlmStreamProvider:
    def __init__(self, client_factory: Callable[[], tuple[Any, str]] = _get_client) -> None:
        self._client_factory = client_factory
        self._client_cache: dict[tuple[int, str, str], tuple[Any, str]] = {}

    def _client_for_settings(self, settings: Any) -> tuple[Any, str]:
        provider = str(getattr(settings, "llm_provider", "") or "")
        model = str(getattr(settings, "llm_model", "") or "")
        key = (id(settings), provider, model)
        if key not in self._client_cache:
            self._client_cache[key] = self._client_factory()
        return self._client_cache[key]

    async def close(self) -> None:
        for client, _ in self._client_cache.values():
            if client is not None and hasattr(client, "close"):
                await client.close()
        self._client_cache.clear()

    async def stream(
        self,
        system_prompt: str,
        messages: list[AgentMessage],
        tools: Union[list[AgentTool], list[dict[str, Any]]],
        tier: str = "standard",
        cancel: Optional[CancelToken] = None,
    ) -> AsyncIterator[StreamEvent]:
        provider = "unknown"
        model = ""
        emitted = False
        try:
            settings = get_settings()
            resolved = resolve_llm_client_config(settings)
            provider = resolved["provider"]
            client, default_model = self._client_for_settings(settings)
            model = configured_model_for_tier(tier, settings)
            llm_messages = convert_to_llm(messages)
            if system_prompt:
                llm_messages = [{"role": "system", "content": system_prompt}] + llm_messages
            from app.agents.desensitize import desensitize, restore
            encoded, pii = desensitize(json.dumps(llm_messages, ensure_ascii=False))
            llm_messages = json.loads(encoded)
            if resolved.get("api_format") == "anthropic":
                stream = self._anthropic_chunks(client, model, llm_messages, [self._tool_to_openai(tool) for tool in tools])
                async for event in self.stream_chunks(stream, provider=provider, model=model, cancel=cancel):
                    emitted = True
                    yield self._restore_event(event, pii, restore)
                return
            kwargs = {
                "model": model,
                "messages": llm_messages,
                "tools": [self._tool_to_openai(tool) for tool in tools] if tools else None,
                "stream": True,
                "stream_options": {"include_usage": True},
            }
            kwargs = {key: value for key, value in kwargs.items() if value is not None}
            try:
                stream = await client.chat.completions.create(**kwargs)
            except (TypeError, BadRequestError):
                # SDK 客户端拒参（TypeError）或服务端 400（部分 OpenAI 兼容网关不支持
                # stream_options），去掉该参数重试一次；若仍失败则走统一错误收尾。
                kwargs.pop("stream_options", None)
                stream = await client.chat.completions.create(**kwargs)

            async for event in self.stream_chunks(stream, provider=provider, model=model, cancel=cancel):
                emitted = True
                yield self._restore_event(event, pii, restore)
        except Exception as exc:
            message = sanitize_error_message(str(exc))
            _logger.warning("LLM stream failed: %s", message)
            final = AssistantMessage(
                content=[],
                stop_reason="error",
                model=model,
                provider=provider,
                error_message=message,
                usage=Usage(estimated=True),
            )
            if not emitted:
                yield StreamEvent(type="start", message=_make_partial_message(provider, model, "", "", []))
            yield StreamEvent(type="error", message=final, delta={"error": message})

    async def stream_chunks(
        self,
        chunks: Union[Iterable[Any], AsyncIterator[Any]],
        provider: str,
        model: str,
        cancel: Optional[CancelToken] = None,
    ) -> AsyncIterator[StreamEvent]:
        text_parts: list[str] = []
        thinking_parts: list[str] = []
        tool_calls: list[dict[str, Any]] = []
        last_chunk: dict[str, Any] = {}
        usage_chunk: dict[str, Any] = {}
        finish_reason = "stop"
        started = False
        aborted = False
        error_message: Optional[str] = None

        chunk_iterator = _ensure_async(chunks)
        try:
            async for raw_chunk in chunk_iterator:
                if cancel and cancel.cancelled:
                    aborted = True
                    break
                chunk = _object_to_plain(raw_chunk) or {}
                last_chunk = chunk
                if chunk.get("usage"):
                    usage_chunk = chunk
                choice = _first_choice(chunk)
                delta = choice.get("delta") or {}
                finish_reason = choice.get("finish_reason") or finish_reason

                if not started:
                    started = True
                    yield StreamEvent(type="start", message=_make_partial_message(provider, model, "", "", []))

                thinking_delta = delta.get("reasoning_content") or delta.get("reasoning") or ""
                if thinking_delta:
                    thinking_parts.append(str(thinking_delta))
                    yield StreamEvent(
                        type="thinking_delta",
                        message=_make_partial_message(provider, model, "".join(text_parts), "".join(thinking_parts), tool_calls),
                        delta={"thinking": str(thinking_delta)},
                    )

                text_delta = delta.get("content") or ""
                if text_delta:
                    text_parts.append(str(text_delta))
                    yield StreamEvent(
                        type="text_delta",
                        message=_make_partial_message(provider, model, "".join(text_parts), "".join(thinking_parts), tool_calls),
                        delta={"text": str(text_delta)},
                    )

                for tool_delta in delta.get("tool_calls") or []:
                    index = _tool_call_slot(tool_calls, tool_delta)
                    current = tool_calls[index]
                    if tool_delta.get("id"):
                        current["id"] = tool_delta["id"]
                    function_delta = tool_delta.get("function") or {}
                    name_delta = function_delta.get("name") or ""
                    # 名称一般整段到达；部分 provider 会在每个分片重复完整名称，
                    # 与已累积值相同的名称分片直接忽略，避免拼成 "lookuplookup"。
                    if name_delta and name_delta != current["name"]:
                        current["name"] += name_delta
                    if function_delta.get("arguments"):
                        current["arguments"] += function_delta["arguments"]
                    yield StreamEvent(
                        type="tool_call_delta",
                        message=_make_partial_message(provider, model, "".join(text_parts), "".join(thinking_parts), tool_calls),
                        delta={"tool_call": dict(current)},
                    )
        except Exception as exc:
            error_message = sanitize_error_message(str(exc))
            _logger.warning("LLM stream interrupted: %s", error_message)
        finally:
            await _close_quietly(chunks)

        if not started:
            yield StreamEvent(type="start", message=_make_partial_message(provider, model, "", "", []))
        output_text = "".join(text_parts)
        usage = _usage_from_chunk(usage_chunk or last_chunk, output_text)
        if error_message is not None:
            stop_reason = "error"
        elif aborted:
            stop_reason = "aborted"
        else:
            stop_reason = finish_reason
        final = _make_partial_message(
            provider,
            model,
            output_text,
            "".join(thinking_parts),
            tool_calls,
            stop_reason=stop_reason,
            usage=usage,
            error_message=error_message,
            include_incomplete=False,
        )
        if error_message is not None:
            yield StreamEvent(type="error", message=final, delta={"error": error_message})
        else:
            yield StreamEvent(type="done", message=final)

    async def complete_text(
        self,
        system_prompt: str,
        messages: list[AgentMessage],
        tier: str = "standard",
        max_tokens: int = 2048,
    ) -> str:
        settings = get_settings()
        client, default_model = self._client_for_settings(settings)
        model = configured_model_for_tier(tier, settings)
        llm_messages = convert_to_llm(messages)
        if system_prompt:
            llm_messages = [{"role": "system", "content": system_prompt}] + llm_messages
        from app.agents.desensitize import desensitize, restore
        encoded, pii = desensitize(json.dumps(llm_messages, ensure_ascii=False))
        llm_messages = json.loads(encoded)
        if resolve_llm_client_config(settings).get("api_format") == "anthropic":
            response = await asyncio.wait_for(client.messages.create(model=model, max_tokens=max_tokens,
                system=llm_messages[0]["content"] if system_prompt else "",
                messages=llm_messages[1:] if system_prompt else llm_messages), timeout=settings.llm_timeout)
            text = "".join(block.text for block in response.content if block.type == "text")
        else:
            response = await asyncio.wait_for(client.chat.completions.create(model=model, messages=llm_messages,
                max_tokens=max_tokens), timeout=settings.llm_timeout)
            text = response.choices[0].message.content or ""
        return restore(text, pii)

    @staticmethod
    def _restore_event(event: StreamEvent, mapping: dict[str, str], restore: Any) -> StreamEvent:
        # Restore complete messages/arguments locally; stream deltas stay masked so
        # fragmented placeholders cannot corrupt the protocol or expose PII remotely.
        if event.message is not None:
            event.message = AssistantMessage.model_validate_json(restore(event.message.model_dump_json(), mapping))
        return event

    async def _anthropic_chunks(self, client: Any, model: str, messages: list[dict[str, Any]], tool_specs: list[dict[str, Any]]) -> AsyncIterator[dict[str, Any]]:
        native: list[dict[str, Any]] = []
        system = ""
        for message in messages:
            role = message["role"]
            if role == "system":
                system = message["content"]
                continue
            if role == "tool":
                blocks = [{"type": "tool_result", "tool_use_id": message["tool_call_id"], "content": message["content"]}]
                role = "user"
            else:
                blocks = [{"type": "text", "text": message["content"]}] if message.get("content") else []
                for call in message.get("tool_calls") or []:
                    blocks.append({"type": "tool_use", "id": call["id"], "name": call["function"]["name"],
                                   "input": json.loads(call["function"]["arguments"])})
            if not blocks:
                continue
            if native and native[-1]["role"] == role:
                native[-1]["content"].extend(blocks)
            else:
                native.append({"role": role, "content": blocks})
        tools = [{"name": tool["function"]["name"], "description": tool["function"]["description"],
                  "input_schema": tool["function"]["parameters"]} for tool in tool_specs]
        kwargs = {"model": model, "max_tokens": 8192, "system": system, "messages": native, "stream": True}
        if tools:
            kwargs["tools"] = tools
        stream = await client.messages.create(**kwargs)
        try:
            async for raw in stream:
                event = _object_to_plain(raw)
                kind = event.get("type")
                delta: dict[str, Any] = {}
                if kind == "content_block_start" and event["content_block"]["type"] == "tool_use":
                    block = event["content_block"]
                    delta = {"tool_calls": [{"index": event["index"], "id": block["id"], "function": {"name": block["name"]}}]}
                elif kind == "content_block_delta":
                    part = event["delta"]
                    if part["type"] == "text_delta":
                        delta = {"content": part["text"]}
                    elif part["type"] == "thinking_delta":
                        delta = {"reasoning_content": part["thinking"]}
                    elif part["type"] == "input_json_delta":
                        delta = {"tool_calls": [{"index": event["index"], "function": {"arguments": part["partial_json"]}}]}
                elif kind == "message_delta":
                    reason = event.get("delta", {}).get("stop_reason")
                    yield {"choices": [{"delta": {}, "finish_reason": {
                        "end_turn": "stop", "tool_use": "tool_calls", "max_tokens": "length",
                    }.get(reason, reason)}]}
                    continue
                elif kind == "error":
                    raise RuntimeError(sanitize_error_message(str(event.get("error", {}).get("message", "Anthropic stream failed"))))
                yield {"choices": [{"delta": delta}]}
        finally:
            await stream.close()

    @staticmethod
    def _tool_to_openai(tool: Union[AgentTool, dict[str, Any]]) -> dict[str, Any]:
        if isinstance(tool, AgentTool):
            name = tool.name
            description = tool.description
            parameters = tool.parameters
        else:
            name = str(tool.get("name") or "")
            description = str(tool.get("description") or "")
            parameters = tool.get("parameters") or {}
        return {
            "type": "function",
            "function": {"name": name, "description": description, "parameters": parameters},
        }


class ScriptedStreamProvider(LlmStreamProvider):
    def __init__(self, script: list[dict[str, Any]], provider: str = "scripted", model: str = "scripted-model") -> None:
        super().__init__(client_factory=lambda: (None, model))
        self._script = list(script)
        self._provider = provider
        self._model = model

    async def stream(
        self,
        system_prompt: str,
        messages: list[AgentMessage],
        tools: Union[list[AgentTool], list[dict[str, Any]]],
        tier: str = "standard",
        cancel: Optional[CancelToken] = None,
    ) -> AsyncIterator[StreamEvent]:
        text = ""
        thinking = ""
        tool_calls: list[dict[str, Any]] = []
        yield StreamEvent(type="start", message=_make_partial_message(self._provider, self._model, text, thinking, []))
        for item in self._script:
            if cancel and cancel.cancelled:
                final = _make_partial_message(
                    self._provider,
                    self._model,
                    text,
                    thinking,
                    tool_calls,
                    stop_reason="aborted",
                    usage=Usage(estimated=True),
                    include_incomplete=False,
                )
                yield StreamEvent(type="done", message=final)
                return
            item_type = item.get("type")
            if item_type == "text":
                delta = str(item.get("text") or "")
                text += delta
                yield StreamEvent(
                    type="text_delta",
                    message=_make_partial_message(self._provider, self._model, text, thinking, tool_calls),
                    delta={"text": delta},
                )
            elif item_type == "thinking":
                delta = str(item.get("thinking") or item.get("text") or "")
                thinking += delta
                yield StreamEvent(
                    type="thinking_delta",
                    message=_make_partial_message(self._provider, self._model, text, thinking, tool_calls),
                    delta={"thinking": delta},
                )
            elif item_type in {"tool_call", "toolCall"}:
                tool_calls.append(
                    {
                        "id": item.get("id") or f"call_{len(tool_calls) + 1}",
                        "name": item.get("name") or "",
                        "arguments": json.dumps(item.get("arguments") or {}, ensure_ascii=False),
                    }
                )
                yield StreamEvent(
                    type="tool_call_delta",
                    message=_make_partial_message(self._provider, self._model, text, thinking, tool_calls),
                    delta={"tool_call": dict(tool_calls[-1])},
                )
        stop_reason = "tool_calls" if tool_calls else "stop"
        usage = Usage(
            input_tokens=estimate_tokens(messages) if messages else 0,
            output_tokens=max(1, len(text) // 4) if text else 0,
            estimated=True,
        )
        usage.total_tokens = usage.input_tokens + usage.output_tokens
        yield StreamEvent(
            type="done",
            message=_make_partial_message(
                self._provider,
                self._model,
                text,
                thinking,
                tool_calls,
                stop_reason=stop_reason,
                usage=usage,
                include_incomplete=False,
            ),
        )


async def _ensure_async(chunks: Union[Iterable[Any], AsyncIterator[Any]]) -> AsyncIterator[Any]:
    if hasattr(chunks, "__aiter__"):
        async for chunk in chunks:  # type: ignore[union-attr]
            yield chunk
        return
    for chunk in chunks:  # type: ignore[union-attr]
        yield chunk


async def _close_quietly(chunks: Any) -> None:
    close = getattr(chunks, "aclose", None) or getattr(chunks, "close", None)
    if close is None:
        return
    try:
        result = close()
        if asyncio.iscoroutine(result):
            await result
    except Exception:  # pragma: no cover - best-effort资源释放
        _logger.debug("closing LLM stream failed")


async def collect_stream(events: AsyncIterator[StreamEvent]) -> AssistantMessage:
    final: Optional[AssistantMessage] = None
    async for event in events:
        if event.message is not None:
            final = event.message
    if final is None:
        return AssistantMessage(stop_reason="error", error_message="stream produced no message")
    return final
