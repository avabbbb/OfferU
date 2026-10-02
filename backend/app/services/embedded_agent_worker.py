"""Run the migrated Python Agent kernel; all business tools call the Registry host."""
from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from typing import Any, Callable

from pydantic import TypeAdapter

from app.agent.compaction import compact_messages, should_compact
from app.agent.hooks import AFTER_TOOL_CALL, BEFORE_TOOL_CALL, SAVE_POINT, HookRegistry
from app.agent.loop import AgentContext, AgentLoopConfig, LoopTool, run_agent_loop
from app.agent.messages import convert_to_llm, create_text_message
from app.agent.proposal_hook import ProposalHook
from app.agent.provider import LlmStreamProvider
from app.agent.types import AgentMessage, AssistantMessage, CancelToken, CompactionSummaryMessage, TextContent, ToolResultMessage
from app.services.agent_files import atomic_write_bytes
from app.services.security_redaction import redact_secret_value, safe_error_message

PROTOCOL_VERSION = "offeru.python-agent.v1"
SESSION_VERSION = 1
_MESSAGES = TypeAdapter(list[AgentMessage])


class EmbeddedAgentWorkerError(RuntimeError):
    pass


class EmbeddedAgentWorker:
    """One active session; credentials and Career Truth never enter session files."""

    def __init__(self, *, provider_factory: Callable[[], Any] = LlmStreamProvider) -> None:
        self._provider_factory = provider_factory
        self.active_run_id: str | None = None
        self._messages: list[AgentMessage] = []
        self._system_prompt = ""
        self._operations: list[dict[str, Any]] = []
        self._operation_runner: Any = None
        self._event_listener: Any = None
        self._session_path: Path | None = None
        self._cancel = CancelToken()
        self._steering: list[AgentMessage] = []
        self._follow_up: list[AgentMessage] = []
        self._task: asyncio.Task[Any] | None = None
        self._provider: Any = None
        self._hooks = HookRegistry()
        self._proposal_hook: ProposalHook | None = None
        self._start_lock = asyncio.Lock()
        self._prompt_lock = asyncio.Lock()

    async def probe(self) -> dict[str, Any]:
        return {"available": True, "kernel": "python", "protocol_version": PROTOCOL_VERSION,
                "version": "luyishui-offeru-3a446ff", "session_scope": "one_session_per_agent_run",
                "features": {"persistent_sessions": True, "compaction": True, "steer": True,
                             "follow_up": True, "registry_tools_only": True}}

    async def _emit(self, event: str, payload: dict[str, Any]) -> None:
        if self._event_listener:
            await self._event_listener({"event": event, "run_id": self.active_run_id, "payload": payload})

    def _save(self) -> None:
        if self._session_path is None:
            raise EmbeddedAgentWorkerError("Session path unavailable")
        payload = redact_secret_value({
            "protocol_version": PROTOCOL_VERSION, "version": SESSION_VERSION,
            "run_id": self.active_run_id, "messages": [item.model_dump(mode="json") for item in self._messages],
        })
        # The generic secret filter also matches telemetry names such as
        # input_tokens. Restore only these typed integer counters, never strings.
        for original, safe in zip(self._messages, payload["messages"]):
            if isinstance(original, AssistantMessage) and original.usage is not None:
                safe["usage"] = original.usage.model_dump(mode="json")
            if isinstance(original, CompactionSummaryMessage):
                safe["tokens_before"] = original.tokens_before
        atomic_write_bytes(self._session_path, json.dumps(payload, ensure_ascii=False).encode("utf-8"))

    async def start_run(self, *, run_id: str, system_prompt: str, provider: dict[str, Any],
                        allowed_operations: list[dict[str, Any]], operation_runner: Any,
                        event_listener: Any = None, session_directory: str = "", session_file: str = "") -> dict[str, Any]:
        del provider  # Model credentials/configuration stay in the canonical LLM layer.
        async with self._start_lock:
            if self.active_run_id:
                raise EmbeddedAgentWorkerError(f"An Agent Run is already active: {self.active_run_id}")
            if not re.fullmatch(r"run_[a-f0-9]{16,32}", run_id):
                raise EmbeddedAgentWorkerError("Invalid Agent Run ID")
            directory = Path(session_directory).resolve()
            path = Path(session_file).resolve() if session_file else directory / f"{run_id}.json"
            if not session_directory or path.parent != directory or path.name != f"{run_id}.json":
                raise EmbeddedAgentWorkerError("Session must stay within its runtime directory")
            messages: list[AgentMessage] = []
            if session_file:
                payload = json.loads(path.read_text(encoding="utf-8"))
                if (payload.get("protocol_version") != PROTOCOL_VERSION or payload.get("run_id") != run_id
                        or payload.get("version") != SESSION_VERSION):
                    raise EmbeddedAgentWorkerError("Session version/identity mismatch; refusing replay")
                messages = _MESSAGES.validate_python(payload["messages"])
                if messages and isinstance(messages[-1], AssistantMessage) and any(
                    block.type == "toolCall" for block in messages[-1].content
                ):
                    raise EmbeddedAgentWorkerError("Interrupted tool batch needs reconciliation")
            elif path.exists():
                raise EmbeddedAgentWorkerError("Session already exists; use explicit resume")
            self._provider = self._provider_factory()
            self.active_run_id = run_id
            self._session_path = path
            self._messages = messages
            self._system_prompt = system_prompt
            self._operations = allowed_operations
            self._operation_runner = operation_runner
            self._event_listener = event_listener
            self._cancel = CancelToken()
            self._steering = []
            self._follow_up = []
            self._hooks = HookRegistry()
            self._proposal_hook = ProposalHook()
            self._hooks.on(BEFORE_TOOL_CALL, self._proposal_hook.before_tool_call)
            self._hooks.on(AFTER_TOOL_CALL, self._proposal_hook.after_tool_call)
            self._hooks.on(SAVE_POINT, self._save_turn)
            self._save()
            await self._emit("run.started", {"session_id": run_id, "kernel": "python"})
            return {"session_id": run_id, "session_file": str(path), "sdk_version": "luyishui-3a446ff",
                    "active_tools": [item["name"] for item in allowed_operations]}

    async def _save_turn(self, payload: dict[str, Any]) -> None:
        self._messages = list(payload["context"].messages)
        self._save()

    def _check_run(self, run_id: str) -> None:
        if self.active_run_id != run_id:
            raise EmbeddedAgentWorkerError("Run is not active in the embedded Agent")

    def _drain(self, queue: list[AgentMessage]) -> list[AgentMessage]:
        result = list(queue)
        queue.clear()
        return result

    async def _execute(self, name: str, call_id: str, args: dict[str, Any], cancel: Any, on_update: Any) -> ToolResultMessage:
        del on_update
        cancel.throw_if_cancelled()
        result = await self._operation_runner(name, args)
        outputs = result.get("outputs") if isinstance(result.get("outputs"), dict) else {}
        proposal = outputs.get("proposal")
        details = dict(result)
        if isinstance(proposal, dict):
            details.update(status="proposal_required", proposal={**proposal,
                "proposal_id": proposal.get("action_id"), "tool_name": name, "locked_payload": args})
        return ToolResultMessage(tool_call_id=call_id, tool_name=name,
            content=[TextContent(text=json.dumps(result, ensure_ascii=False, default=str))],
            details=details, is_error=not result.get("ok", False))

    async def _on_loop_event(self, event: dict[str, Any]) -> None:
        kind = event["type"]
        if kind == "message_update":
            delta = event.get("delta") or {}
            if delta.get("text"):
                await self._emit("message.delta", {"delta": delta["text"]})
        elif kind.startswith("tool_execution_"):
            mapped = {"tool_execution_start": "tool.started", "tool_execution_update": "tool.progress",
                      "tool_execution_end": "tool.completed"}[kind]
            result = event.get("result")
            description = next((item.get("description", "") for item in self._operations
                                if item["name"] == event.get("tool_name")), "")
            await self._emit(mapped, {"tool_call_id": event.get("tool_call_id"),
                "operation": event.get("tool_name"), "args": event.get("args"),
                "description": description,
                "result": result.model_dump(mode="json") if hasattr(result, "model_dump") else result,
                "is_error": bool(event.get("is_error"))})
        elif kind in {"agent_start", "agent_end", "turn_start", "turn_end"}:
            await self._emit(f"kernel.{kind}", {})

    async def _compact(self, context: AgentContext, instructions: str = "") -> AgentContext:
        await self._emit("kernel.compaction_start", {})
        prompt = self._system_prompt
        if instructions.strip():
            prompt += "\nUser context compaction instructions:\n" + instructions.strip()
        result = await compact_messages(self._provider, system_prompt=prompt,
            previous_summary=None, messages=context.messages, keep_recent_tokens=12000, cancel=self._cancel)
        if not result.ok:
            raise EmbeddedAgentWorkerError("Context compaction failed; session preserved")
        context.messages = [CompactionSummaryMessage(summary=result.summary, tokens_before=result.tokens_before), *result.kept_messages]
        self._messages = list(context.messages)
        self._save()
        await self._emit("kernel.compaction_end", {"tokens_before": result.tokens_before})
        return context

    async def _prepare_next_turn(self, payload: dict[str, Any]) -> dict[str, Any]:
        context = payload["context"]
        if should_compact(context.messages, context_window=64000, reserve_tokens=8000):
            context = await self._compact(context)
        return {"context": context}

    async def prompt(self, *, run_id: str, message: str, timeout: float = 180) -> dict[str, Any]:
        self._check_run(run_id)
        if self._prompt_lock.locked():
            raise EmbeddedAgentWorkerError("A model turn is already running")
        async with self._prompt_lock:
            self._messages.append(create_text_message(message))
            self._save()
            tools = [LoopTool(name=item["name"], description=item.get("description", ""),
                parameters=item.get("input_schema") or {"type": "object", "properties": {}},
                execute=lambda call_id, args, cancel, update, name=item["name"]: self._execute(name, call_id, args, cancel, update),
                execution_mode="sequential") for item in self._operations]
            context = AgentContext(system_prompt=self._system_prompt, messages=list(self._messages), tools=tools)
            config = AgentLoopConfig(stream_fn=self._provider.stream, convert_to_llm=convert_to_llm,
                tools=tools, hooks=self._hooks, cancel=self._cancel,
                get_steering_messages=lambda: self._drain(self._steering),
                get_follow_up_messages=lambda: self._drain(self._follow_up),
                prepare_next_turn=self._prepare_next_turn)
            self._task = asyncio.create_task(run_agent_loop(context, config, self._on_loop_event))
            try:
                result = await asyncio.wait_for(self._task, timeout=timeout)
                if result.stop_reason in {"error", "hard_loop_limit", "aborted"}:
                    errors = [m.error_message for m in result.messages if isinstance(m, AssistantMessage) and m.error_message]
                    raise EmbeddedAgentWorkerError(safe_error_message(errors[-1] if errors else result.stop_reason))
                assistant = next((m for m in reversed(result.messages) if isinstance(m, AssistantMessage)), None)
                text = "".join(block.text for block in assistant.content if isinstance(block, TextContent)) if assistant else ""
                return {"assistant_message": text, "stop_reason": result.stop_reason}
            finally:
                self._task = None

    async def steer_run(self, run_id: str, message: str) -> dict[str, Any]:
        self._check_run(run_id)
        if not message.strip():
            raise EmbeddedAgentWorkerError("Steering message must not be empty")
        self._steering.append(create_text_message(message))
        return {"run_id": run_id, "disposition": "queued"}

    async def follow_up_run(self, run_id: str, message: str) -> dict[str, Any]:
        self._check_run(run_id)
        if not message.strip():
            raise EmbeddedAgentWorkerError("Follow-up message must not be empty")
        self._follow_up.append(create_text_message(message))
        return {"run_id": run_id, "disposition": "queued"}

    async def compact_run(self, run_id: str, instructions: str = "") -> dict[str, Any]:
        self._check_run(run_id)
        if self._prompt_lock.locked():
            raise EmbeddedAgentWorkerError("Cannot compact an active model turn")
        await self._compact(AgentContext(system_prompt=self._system_prompt, messages=list(self._messages)), instructions)
        return {"run_id": run_id, "compacted": True}

    async def abort_run(self, run_id: str) -> dict[str, Any]:
        self._check_run(run_id)
        self._cancel.cancel()
        task = self._task
        if task is not None and task is not asyncio.current_task():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await self._emit("run.aborted", {})
        return {"run_id": run_id, "cancelled": True}

    async def dispose_run(self, run_id: str) -> None:
        self._check_run(run_id)
        if self._task:
            await self.abort_run(run_id)
        close = getattr(self._provider, "close", None)
        if close:
            await close()
        await self._emit("run.disposed", {})
        self.active_run_id = None
        self._provider = None

    async def forget_run_after_fresh_reset(self, run_id: str) -> None:
        """Dispose a reset-approved Run and erase its volatile career context."""
        async with self._start_lock:
            if self.active_run_id != run_id:
                return
            await self.dispose_run(run_id)
            self._messages.clear()
            self._system_prompt = ""
            self._operations.clear()
            self._operation_runner = None
            self._event_listener = None
            self._session_path = None
            self._steering.clear()
            self._follow_up.clear()
            self._task = None
            self._proposal_hook = None
            self._hooks = HookRegistry()
            self._cancel = CancelToken()

    async def close(self) -> None:
        if self.active_run_id:
            await self.dispose_run(self.active_run_id)


_worker = EmbeddedAgentWorker()


def get_embedded_agent_worker() -> EmbeddedAgentWorker:
    return _worker


async def close_embedded_agent_worker() -> None:
    await _worker.close()
