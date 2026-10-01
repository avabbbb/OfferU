from __future__ import annotations

import asyncio
import inspect
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Literal, Optional

from app.agent.hooks import (
    AFTER_TOOL_CALL,
    BEFORE_AGENT_START,
    BEFORE_TOOL_CALL,
    CONTEXT,
    SAVE_POINT,
    SETTLED,
    TURN_END,
    HookRegistry,
)
from app.agent.messages import create_custom_message
from app.agent.types import (
    AgentMessage,
    AgentTool,
    AssistantMessage,
    CancelToken,
    MessageContent,
    StreamEvent,
    TextContent,
    ToolCallContent,
    ToolResultMessage,
)


@dataclass
class AgentContext:
    system_prompt: str
    messages: list[AgentMessage]
    tools: list[Any] = field(default_factory=list)


@dataclass
class ToolExecutionResult:
    message: ToolResultMessage
    terminate: bool = False


@dataclass
class AgentLoopResult:
    messages: list[AgentMessage]
    stop_reason: str = "stop"


@dataclass
class LoopTool:
    name: str
    execute: Callable[..., Any]
    description: str = ""
    parameters: dict[str, Any] = field(default_factory=dict)
    prepare_arguments: Optional[Callable[[Any], Any]] = None
    execution_mode: Optional[Literal["parallel", "sequential"]] = None
    expose_to_provider: bool = True


@dataclass
class AgentLoopConfig:
    stream_fn: Callable[..., Any]
    convert_to_llm: Callable[..., Any]
    tools: list[Any] = field(default_factory=list)
    hooks: Optional[HookRegistry] = None
    tool_execution: Literal["parallel", "sequential"] = "sequential"
    soft_loop_limit: int = 10
    hard_loop_limit: int = 15
    get_steering_messages: Optional[Callable[[], Any]] = None
    get_follow_up_messages: Optional[Callable[[], Any]] = None
    prepare_next_turn: Optional[Callable[[dict[str, Any]], Any]] = None
    should_stop_after_turn: Optional[Callable[[dict[str, Any]], Any]] = None
    cancel: Optional[CancelToken] = None


@dataclass
class _PreparedToolCall:
    index: int
    tool_call: ToolCallContent
    tool: LoopTool
    args: Any


@dataclass
class _FinalizedToolCall:
    index: int
    tool_call: ToolCallContent
    message: ToolResultMessage
    terminate: bool = False


async def run_agent_loop(
    context: AgentContext,
    config: AgentLoopConfig,
    emit: Callable[[dict[str, Any]], Any],
) -> AgentLoopResult:
    current = AgentContext(
        system_prompt=context.system_prompt,
        messages=list(context.messages),
        tools=list(context.tools or config.tools),
    )
    new_messages: list[AgentMessage] = []
    pending_messages: list[AgentMessage] = await _call_message_queue(config.get_steering_messages)
    first_turn = True
    soft_limit_injected = False
    assistant_turns = 0

    if config.hooks:
        before_result = await config.hooks.emit(
            BEFORE_AGENT_START,
            {
                "context": current,
                "system_prompt": current.system_prompt,
                "messages": list(current.messages),
                "tools": list(current.tools),
            },
            cancel=config.cancel,
        )
        if isinstance(before_result, dict):
            if before_result.get("system_prompt") is not None:
                current.system_prompt = str(before_result["system_prompt"])
            for message in before_result.get("messages") or []:
                current.messages.append(message)
                new_messages.append(message)

    await _emit(emit, {"type": "agent_start"})

    while True:
        has_more_tool_calls = True

        while has_more_tool_calls or pending_messages:
            if assistant_turns >= config.hard_loop_limit:
                await _emit_agent_end(config, emit, new_messages)
                return AgentLoopResult(messages=new_messages, stop_reason="hard_loop_limit")

            if first_turn:
                first_turn = False
            await _emit(emit, {"type": "turn_start"})

            if assistant_turns >= config.soft_loop_limit and not soft_limit_injected:
                reminder = create_custom_message(
                    "loop_limit_reminder",
                    "Soft loop limit reached. Please finish the current task or reduce tool usage.",
                    display=False,
                )
                pending_messages = [reminder] + pending_messages
                soft_limit_injected = True

            if pending_messages:
                for message in pending_messages:
                    await _emit_message(emit, message)
                    current.messages.append(message)
                    new_messages.append(message)
                pending_messages = []

            message = await _stream_assistant_response(current, config, emit)
            assistant_turns += 1
            new_messages.append(message)

            if message.stop_reason in ("error", "aborted"):
                await _emit_turn_end(config, emit, message, [], current, new_messages)
                await _emit_agent_end(config, emit, new_messages)
                return AgentLoopResult(messages=new_messages, stop_reason=message.stop_reason or "error")

            tool_calls = _tool_calls_from_message(message)
            tool_results: list[ToolResultMessage] = []
            has_more_tool_calls = False
            if tool_calls:
                batch = await _execute_tool_calls(current, message, tool_calls, config, emit)
                finalized = batch["finalized"]
                tool_results = [entry.message for entry in finalized]
                has_more_tool_calls = not batch["terminate"]
                for result in tool_results:
                    current.messages.append(result)
                    new_messages.append(result)

            turn_payload = {
                "message": message,
                "tool_results": tool_results,
                "context": current,
                "new_messages": new_messages,
            }
            await _emit_turn_end(config, emit, message, tool_results, current, new_messages)
            next_turn = await _maybe_call(config.prepare_next_turn, turn_payload)
            if isinstance(next_turn, dict) and next_turn.get("context") is not None:
                current = next_turn["context"]

            if await _truthy_call(config.should_stop_after_turn, turn_payload):
                await _emit_agent_end(config, emit, new_messages)
                return AgentLoopResult(messages=new_messages, stop_reason=getattr(message, "stop_reason", None) or "stop")

            pending_messages = await _call_message_queue(config.get_steering_messages)

        follow_up_messages = await _call_message_queue(config.get_follow_up_messages)
        if follow_up_messages:
            pending_messages = follow_up_messages
            continue
        break

    await _emit_agent_end(config, emit, new_messages)
    stop_reason = "stop"
    for message in reversed(new_messages):
        if isinstance(message, AssistantMessage):
            stop_reason = message.stop_reason or "stop"
            break
    return AgentLoopResult(messages=new_messages, stop_reason=stop_reason)


async def _emit_turn_end(
    config: AgentLoopConfig,
    emit: Callable[[dict[str, Any]], Any],
    message: AssistantMessage,
    tool_results: list[ToolResultMessage],
    context: AgentContext,
    new_messages: list[AgentMessage],
) -> None:
    payload = {
        "type": "turn_end",
        "message": message,
        "tool_results": tool_results,
        "context": context,
        "new_messages": new_messages,
    }
    await _emit(emit, payload)
    if config.hooks:
        await config.hooks.emit(TURN_END, payload, cancel=config.cancel)
        await config.hooks.emit(
            SAVE_POINT,
            {
                "type": "save_point",
                "message": message,
                "tool_results": tool_results,
                "context": context,
                "new_messages": new_messages,
                "had_pending_mutations": False,
            },
            cancel=config.cancel,
        )


async def _emit_agent_end(
    config: AgentLoopConfig,
    emit: Callable[[dict[str, Any]], Any],
    new_messages: list[AgentMessage],
) -> None:
    payload = {"type": "agent_end", "messages": new_messages}
    await _emit(emit, payload)
    if config.hooks:
        await config.hooks.emit(
            SETTLED,
            {"type": "settled", "messages": new_messages, "next_turn_count": 0},
            cancel=config.cancel,
        )


async def _stream_assistant_response(
    context: AgentContext,
    config: AgentLoopConfig,
    emit: Callable[[dict[str, Any]], Any],
) -> AssistantMessage:
    cancel = config.cancel
    if cancel and cancel.cancelled:
        message = AssistantMessage(stop_reason="aborted")
        context.messages.append(message)
        await _emit_message(emit, message)
        return message

    messages_for_provider = context.messages
    if config.hooks:
        hook_result = await config.hooks.emit(CONTEXT, {"context": context, "messages": context.messages}, cancel=cancel)
        if isinstance(hook_result, list):
            messages_for_provider = hook_result

    final_message: Optional[AssistantMessage] = None
    started = False
    try:
        stream = config.stream_fn(
            context.system_prompt,
            messages_for_provider,
            _tools_for_provider(context.tools),
            cancel=cancel,
        )
        async for event in stream:
            if cancel and cancel.cancelled and event.type not in ("done", "error"):
                continue
            if event.type == "start":
                started = True
                partial = event.message or AssistantMessage()
                context.messages.append(partial)
                await _emit(emit, {"type": "message_start", "message": partial})
            elif event.type in ("text_delta", "thinking_delta", "tool_call_delta"):
                if event.message is not None and context.messages:
                    context.messages[-1] = event.message
                await _emit(emit, {"type": "message_update", "message": event.message, "delta": event.delta, "stream_event": event.type})
            elif event.type in ("done", "error"):
                final_message = event.message or AssistantMessage(stop_reason="error", error_message="stream ended without message")
                if context.messages and started:
                    context.messages[-1] = final_message
                else:
                    context.messages.append(final_message)
                    await _emit(emit, {"type": "message_start", "message": final_message})
                await _emit(emit, {"type": "message_end", "message": final_message})
                return final_message
    except Exception as exc:
        final_message = AssistantMessage(stop_reason="error", error_message=str(exc))

    if final_message is None:
        final_message = AssistantMessage(stop_reason="error", error_message="stream produced no final message")
    if context.messages and started:
        context.messages[-1] = final_message
    else:
        context.messages.append(final_message)
        await _emit(emit, {"type": "message_start", "message": final_message})
    await _emit(emit, {"type": "message_end", "message": final_message})
    return final_message


async def _execute_tool_calls(
    context: AgentContext,
    assistant_message: AssistantMessage,
    tool_calls: list[ToolCallContent],
    config: AgentLoopConfig,
    emit: Callable[[dict[str, Any]], Any],
) -> dict[str, Any]:
    if config.tool_execution == "sequential" or any(_tool_execution_mode(context.tools, call) == "sequential" for call in tool_calls):
        finalized = await _execute_tool_calls_sequential(context, assistant_message, tool_calls, config, emit)
    else:
        finalized = await _execute_tool_calls_parallel(context, assistant_message, tool_calls, config, emit)
    finalized.sort(key=lambda entry: entry.index)
    return {
        "finalized": finalized,
        "terminate": bool(finalized) and all(entry.terminate for entry in finalized),
    }


async def _execute_tool_calls_sequential(
    context: AgentContext,
    assistant_message: AssistantMessage,
    tool_calls: list[ToolCallContent],
    config: AgentLoopConfig,
    emit: Callable[[dict[str, Any]], Any],
) -> list[_FinalizedToolCall]:
    finalized: list[_FinalizedToolCall] = []
    for index, tool_call in enumerate(tool_calls):
        await _emit_tool_start(emit, tool_call)
        prepared_or_final = await _prepare_tool_call(index, context, assistant_message, tool_call, config)
        if isinstance(prepared_or_final, _FinalizedToolCall):
            entry = prepared_or_final
        else:
            entry = await _execute_prepared_tool_call(context, assistant_message, prepared_or_final, config, emit)
        await _emit_tool_end_and_message(emit, entry)
        finalized.append(entry)
        if config.cancel and config.cancel.cancelled:
            break
    return finalized


async def _execute_tool_calls_parallel(
    context: AgentContext,
    assistant_message: AssistantMessage,
    tool_calls: list[ToolCallContent],
    config: AgentLoopConfig,
    emit: Callable[[dict[str, Any]], Any],
) -> list[_FinalizedToolCall]:
    finalized_by_index: dict[int, _FinalizedToolCall] = {}
    tasks = []
    for index, tool_call in enumerate(tool_calls):
        await _emit_tool_start(emit, tool_call)
        prepared_or_final = await _prepare_tool_call(index, context, assistant_message, tool_call, config)
        if isinstance(prepared_or_final, _FinalizedToolCall):
            await _emit_tool_end(emit, prepared_or_final)
            finalized_by_index[index] = prepared_or_final
        else:
            tasks.append(
                asyncio.create_task(
                    _execute_prepared_tool_call(context, assistant_message, prepared_or_final, config, emit)
                )
            )
        if config.cancel and config.cancel.cancelled:
            break

    for task in asyncio.as_completed(tasks):
        entry = await task
        await _emit_tool_end(emit, entry)
        finalized_by_index[entry.index] = entry

    finalized = [finalized_by_index[index] for index in sorted(finalized_by_index)]
    for entry in finalized:
        await _emit_message(emit, entry.message)
    return finalized


async def _prepare_tool_call(
    index: int,
    context: AgentContext,
    assistant_message: AssistantMessage,
    tool_call: ToolCallContent,
    config: AgentLoopConfig,
) -> Any:
    tool = _find_tool(context.tools or config.tools, tool_call.name)
    if tool is None:
        return _finalized_error(index, tool_call, "Tool %s not found" % tool_call.name)
    try:
        args = dict(tool_call.arguments or {})
        if tool.prepare_arguments:
            args = await _maybe_await(tool.prepare_arguments(args))
        if config.hooks:
            before_result = await config.hooks.emit(
                BEFORE_TOOL_CALL,
                {
                    "assistant_message": assistant_message,
                    "tool_call": tool_call,
                    "args": args,
                    "context": context,
                },
                cancel=config.cancel,
            )
            if before_result and before_result.get("block"):
                return _finalized_error(index, tool_call, str(before_result.get("reason") or "Tool execution was blocked"))
        if config.cancel and config.cancel.cancelled:
            return _finalized_error(index, tool_call, "Operation aborted")
        return _PreparedToolCall(index=index, tool_call=tool_call, tool=tool, args=args)
    except Exception as exc:
        return _finalized_error(index, tool_call, str(exc))


async def _execute_prepared_tool_call(
    context: AgentContext,
    assistant_message: AssistantMessage,
    prepared: _PreparedToolCall,
    config: AgentLoopConfig,
    emit: Callable[[dict[str, Any]], Any],
) -> _FinalizedToolCall:
    updates: list[Any] = []

    def on_update(partial_result: Any) -> None:
        updates.append(partial_result)

    try:
        result = await _maybe_await(prepared.tool.execute(prepared.tool_call.id, prepared.args, config.cancel, on_update))
        if isinstance(result, ToolExecutionResult):
            message = result.message
            terminate = result.terminate
        elif isinstance(result, ToolResultMessage):
            message = result
            terminate = False
        else:
            message = ToolResultMessage(
                tool_call_id=prepared.tool_call.id,
                tool_name=prepared.tool_call.name,
                content=[TextContent(text=str(result))],
            )
            terminate = False
        is_error = message.is_error
    except Exception as exc:
        message = _error_tool_result(prepared.tool_call, str(exc))
        terminate = False
        is_error = True

    for update in updates:
        await _emit(
            emit,
            {
                "type": "tool_execution_update",
                "tool_call_id": prepared.tool_call.id,
                "tool_name": prepared.tool_call.name,
                "args": prepared.tool_call.arguments,
                "partial_result": update,
            },
        )

    if config.hooks:
        try:
            after_result = await config.hooks.emit(
                AFTER_TOOL_CALL,
                {
                    "assistant_message": assistant_message,
                    "tool_call": prepared.tool_call,
                    "args": prepared.args,
                    "result": message,
                    "is_error": is_error,
                    "context": context,
                },
                cancel=config.cancel,
            )
        except Exception as exc:
            after_result = None
            message = _error_tool_result(prepared.tool_call, str(exc))
            terminate = False
        if after_result:
            if "content" in after_result:
                message.content = after_result["content"]
            if "details" in after_result:
                message.details = after_result["details"]
            if "is_error" in after_result:
                message.is_error = bool(after_result["is_error"])
            if "terminate" in after_result:
                terminate = bool(after_result["terminate"])

    return _FinalizedToolCall(index=prepared.index, tool_call=prepared.tool_call, message=message, terminate=terminate)


async def _emit_tool_start(emit: Callable[[dict[str, Any]], Any], tool_call: ToolCallContent) -> None:
    await _emit(
        emit,
        {
            "type": "tool_execution_start",
            "tool_call_id": tool_call.id,
            "tool_name": tool_call.name,
            "args": tool_call.arguments,
        },
    )


async def _emit_tool_end_and_message(emit: Callable[[dict[str, Any]], Any], entry: _FinalizedToolCall) -> None:
    await _emit_tool_end(emit, entry)
    await _emit_message(emit, entry.message)


async def _emit_tool_end(emit: Callable[[dict[str, Any]], Any], entry: _FinalizedToolCall) -> None:
    await _emit(
        emit,
        {
            "type": "tool_execution_end",
            "tool_call_id": entry.tool_call.id,
            "tool_name": entry.tool_call.name,
            "result": entry.message,
            "is_error": entry.message.is_error,
        },
    )


async def _emit_message(emit: Callable[[dict[str, Any]], Any], message: AgentMessage) -> None:
    await _emit(emit, {"type": "message_start", "message": message})
    await _emit(emit, {"type": "message_end", "message": message})


async def _emit(emit: Callable[[dict[str, Any]], Any], event: dict[str, Any]) -> None:
    value = emit(_event_with_aliases(event))
    if inspect.isawaitable(value):
        await value


def _event_with_aliases(event: dict[str, Any]) -> dict[str, Any]:
    if "tool_call_id" in event:
        event.setdefault("toolCallId", event["tool_call_id"])
    if "tool_name" in event:
        event.setdefault("toolName", event["tool_name"])
    if "tool_results" in event:
        event.setdefault("toolResults", event["tool_results"])
    return event


def _tool_calls_from_message(message: AssistantMessage) -> list[ToolCallContent]:
    return [block for block in message.content if isinstance(block, ToolCallContent)]


def _find_tool(tools: list[Any], name: str) -> Optional[LoopTool]:
    for tool in tools:
        if getattr(tool, "name", None) == name and hasattr(tool, "execute"):
            if isinstance(tool, LoopTool):
                return tool
            return LoopTool(
                name=tool.name,
                execute=tool.execute,
                description=getattr(tool, "description", ""),
                parameters=getattr(tool, "parameters", {}) or {},
                prepare_arguments=getattr(tool, "prepare_arguments", None),
                execution_mode=getattr(tool, "execution_mode", None),
                expose_to_provider=bool(getattr(tool, "expose_to_provider", True)),
            )
    return None


def _tool_execution_mode(tools: list[Any], tool_call: ToolCallContent) -> Optional[str]:
    tool = _find_tool(tools, tool_call.name)
    return tool.execution_mode if tool else None


def _tools_for_provider(tools: list[Any]) -> list[Any]:
    provider_tools: list[Any] = []
    for tool in tools:
        if getattr(tool, "expose_to_provider", True) is False:
            continue
        if isinstance(tool, AgentTool):
            provider_tools.append(tool)
        else:
            provider_tools.append(
                AgentTool(
                    name=str(getattr(tool, "name", "")),
                    description=str(getattr(tool, "description", "")),
                    parameters=getattr(tool, "parameters", {}) or {},
                )
            )
    return provider_tools


def _finalized_error(index: int, tool_call: ToolCallContent, message: str) -> _FinalizedToolCall:
    return _FinalizedToolCall(index=index, tool_call=tool_call, message=_error_tool_result(tool_call, message))


def _error_tool_result(tool_call: ToolCallContent, message: str) -> ToolResultMessage:
    text = message if message.startswith("ERROR:") else "ERROR: " + message
    return ToolResultMessage(
        tool_call_id=tool_call.id,
        tool_name=tool_call.name,
        content=[TextContent(text=text)],
        is_error=True,
        timestamp=time.time(),
    )


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


async def _maybe_call(callback: Optional[Callable[..., Any]], payload: Any) -> Any:
    if callback is None:
        return None
    return await _maybe_await(callback(payload))


async def _truthy_call(callback: Optional[Callable[..., Any]], payload: Any) -> bool:
    if callback is None:
        return False
    return bool(await _maybe_call(callback, payload))


async def _call_message_queue(callback: Optional[Callable[[], Any]]) -> list[AgentMessage]:
    if callback is None:
        return []
    messages = await _maybe_await(callback())
    return list(messages or [])
