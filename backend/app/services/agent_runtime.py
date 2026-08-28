"""Provider-neutral Agent Runtime seam.

The runtime owns turns and executor lifecycle only.  It does not own Job,
Profile, Resume, Application or Memory truth.  Business changes must still be
requested through an OfferU Operation.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any, Awaitable, Callable, Protocol


AgentOperationCallback = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]


AgentRunStreamListener = Callable[[dict[str, Any]], Awaitable[None]]


CANONICAL_AGENT_RUN_EVENT_TYPES = {
    "run.started",
    "assistant.delta",
    "assistant.message",
    "reasoning.status",
    "tool.started",
    "tool.progress",
    "tool.completed",
    "tool.failed",
    "approval.requested",
    "approval.resolved",
    "task.progress",
    "run.completed",
    "run.failed",
    "run.cancelled",
    "run.blocked",
}


_RUN_EVENT_MAP = {
    "run.created": "run.started",
    "run.started": "run.started",
    "runtime.session_started": "reasoning.status",
    "runtime.session_restarted": "reasoning.status",
    "runtime.session_stopped": "reasoning.status",
    "runtime.agent_started": "reasoning.status",
    "runtime.agent_settled": "reasoning.status",
    "runtime.turn_started": "reasoning.status",
    "runtime.turn_completed": "reasoning.status",
    "runtime.retry_started": "reasoning.status",
    "runtime.retry_completed": "reasoning.status",
    "runtime.compaction_started": "reasoning.status",
    "runtime.compaction_completed": "reasoning.status",
    "pi.agent_start": "reasoning.status",
    "pi.agent_settled": "reasoning.status",
    "pi.turn_start": "reasoning.status",
    "pi.turn_end": "reasoning.status",
    "message.delta": "assistant.delta",
    "assistant.delta": "assistant.delta",
    "message.completed": "assistant.message",
    "assistant.message": "assistant.message",
    "runtime.agent_completed": "assistant.message",
    "pi.agent_end": "assistant.message",
    "runtime.tool_started": "tool.started",
    "pi.tool_execution_start": "tool.started",
    "runtime.tool_progress": "tool.progress",
    "tool.progress": "tool.progress",
    "runtime.tool_completed": "tool.completed",
    "pi.tool_execution_end": "tool.completed",
    "runtime.tool_failed": "tool.failed",
    "operation.started": "tool.started",
    "operation.completed": "tool.completed",
    "operation.failed": "tool.failed",
    "operation.proposed": "approval.requested",
    "approval.requested": "approval.requested",
    "approval.resolved": "approval.resolved",
    "task.progress": "task.progress",
    "run.completed": "run.completed",
    "run.failed": "run.failed",
    "runtime.failed": "run.failed",
    "runtime.fatal": "run.failed",
    "run.cancelled": "run.cancelled",
    "run.aborted": "run.cancelled",
}


def canonical_agent_run_event(event: dict[str, Any]) -> dict[str, Any]:
    """Map provider/legacy event names to the stable OfferU UI protocol."""

    raw_type = str(event.get("type") or "runtime.event")
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    mapped = _RUN_EVENT_MAP.get(raw_type)
    if raw_type == "run.turn_finished":
        status = str(payload.get("status") or "").casefold()
        mapped = {
            "completed": "run.completed",
            "failed": "run.failed",
            "cancelled": "run.cancelled",
            "blocked": "run.blocked",
        }.get(status, "reasoning.status")
    if raw_type == "runtime.blocked":
        mapped = "run.blocked"
    if mapped not in CANONICAL_AGENT_RUN_EVENT_TYPES:
        mapped = "reasoning.status"
    result = dict(event)
    result["type"] = mapped
    result["provider_event"] = raw_type
    result["payload"] = {**payload, "provider_event": raw_type}
    return result


class AgentRuntimeProvider(Protocol):
    provider_id: str

    async def start(self) -> dict[str, Any]: ...

    async def shutdown(self) -> dict[str, Any]: ...

    async def restart(self) -> dict[str, Any]: ...

    async def status(self) -> dict[str, Any]: ...

    async def events(self, *, after: int = 0) -> dict[str, Any]: ...

    async def cancel(self) -> dict[str, Any]: ...

    async def result(self) -> dict[str, Any]: ...

    async def create_thread(
        self,
        *,
        cwd: str,
        tool_descriptions: list[str] | None = None,
    ) -> dict[str, Any]: ...

    async def start_turn(self, *, prompt: str, cwd: str) -> dict[str, Any]: ...

    async def resume_turn(self, *, prompt: str, cwd: str) -> dict[str, Any]: ...

    async def approve(self, **kwargs: Any) -> dict[str, Any]: ...

    async def reject(self, **kwargs: Any) -> dict[str, Any]: ...

    async def list_skills(self) -> dict[str, Any]: ...

    async def list_plugins(self) -> dict[str, Any]: ...


class AgentRunProvider(Protocol):
    """Provider seam for the OfferU Main Agent Run API.

    The low-level runtime protocol above models thread/turn execution.  Main
    Agent providers additionally adapt OfferU's durable run lifecycle without
    moving any Career Truth into the harness implementation.
    """

    provider_id: str

    async def status(self) -> dict[str, Any]: ...

    async def start_run(
        self,
        *,
        message: str,
        skill_id: str,
        conversation_id: str,
        task_id: str,
        context_messages: list[dict[str, str]],
        requested_run_id: str,
        stream_listener: AgentRunStreamListener | None = None,
    ) -> dict[str, Any]: ...

    async def resume_run(self, run_id: str) -> dict[str, Any]: ...

    async def confirm_run(self, run_id: str, *, action_id: str) -> dict[str, Any]: ...

    async def abort_run(self, run_id: str) -> dict[str, Any]: ...


class PiAgentRuntimeProvider:
    """Anti-corruption adapter around the existing Pi host implementation.

    Pi remains a replaceable executor.  The adapter is the only place that
    knows the legacy host function names; API routes and the React client do
    not import or branch on Pi internals.
    """

    provider_id = "pi"
    version = "pi-sdk-worker"
    protocol_version = "offeru.agent-runtime.v1"

    async def status(self) -> dict[str, Any]:
        from app.services.pi_agent_worker import get_pi_agent_worker

        try:
            probe = await get_pi_agent_worker().probe()
        except Exception as exc:
            return {
                "provider_id": self.provider_id,
                "runtime": "pi_sdk_worker",
                "status": "unavailable",
                "available": False,
                "authenticated": None,
                "blocked": False,
                "version": self.version,
                "protocol_version": self.protocol_version,
                "last_error": str(exc)[:500],
            }
        return {
            "provider_id": self.provider_id,
            "runtime": "pi_sdk_worker",
            "status": "ready" if probe.get("available", True) else "unavailable",
            "available": bool(probe.get("available", True)),
            "authenticated": None,
            "blocked": False,
            "version": self.version,
            "protocol_version": self.protocol_version,
            **probe,
        }

    async def start_run(
        self,
        *,
        message: str,
        skill_id: str,
        conversation_id: str,
        task_id: str,
        context_messages: list[dict[str, str]],
        requested_run_id: str,
        stream_listener: AgentRunStreamListener | None = None,
    ) -> dict[str, Any]:
        from app.services.pi_agent_host import start_pi_agent_run

        return await start_pi_agent_run(
            message=message,
            skill_id=skill_id,
            conversation_id=conversation_id,
            task_id=task_id,
            context_messages=context_messages,
            requested_run_id=requested_run_id,
            stream_listener=stream_listener,
        )

    async def resume_run(self, run_id: str) -> dict[str, Any]:
        from app.services.pi_agent_host import resume_pi_agent_run

        return await resume_pi_agent_run(run_id)

    async def confirm_run(self, run_id: str, *, action_id: str) -> dict[str, Any]:
        from app.services.pi_agent_host import confirm_pi_agent_action

        return await confirm_pi_agent_action(run_id, action_id=action_id)

    async def abort_run(self, run_id: str) -> dict[str, Any]:
        from app.services.pi_agent_host import abort_pi_agent_run

        return await abort_pi_agent_run(run_id)


class ReplayAgentRunProvider:
    """Durable, deterministic Main Agent provider for local acceptance paths."""

    provider_id = "replay"
    version = "offeru-main-agent-replay.v1"
    protocol_version = "offeru.agent-runtime.v1"

    async def status(self) -> dict[str, Any]:
        return {
            "provider_id": self.provider_id,
            "runtime": "offeru_replay",
            "status": "ready",
            "available": True,
            "authenticated": True,
            "blocked": False,
            "version": self.version,
            "protocol_version": self.protocol_version,
        }

    async def start_run(
        self,
        *,
        message: str,
        skill_id: str,
        conversation_id: str,
        task_id: str,
        context_messages: list[dict[str, str]],
        requested_run_id: str,
        stream_listener: AgentRunStreamListener | None = None,
    ) -> dict[str, Any]:
        del context_messages
        from app.services.agent_run_state import (
            append_agent_run_event,
            create_agent_run,
            list_agent_run_events,
            pending_actions_for_run,
            save_agent_run,
        )
        from app.services.agent_skill_registry import resolve_run_skill

        goal = str(message or "").strip()
        skill = resolve_run_skill(goal, skill_id)
        run = await create_agent_run(
            conversation_id=conversation_id,
            task_id=task_id,
            goal=goal,
            mode=skill.mode,
            skill_id=skill.id,
            skill_version=skill.version,
            skill_snapshot=skill.summary(),
            actions=[],
            exit_criteria=["the replay response is persisted"],
            llm_runtime={
                "runtime": "offeru_replay",
                "provider_id": self.provider_id,
                "protocol_version": self.protocol_version,
                "stream_protocol": "cursor_v1",
                "status": "running",
            },
            run_id=requested_run_id,
        )
        run_id = run["id"]
        cursor = 0

        async def publish(event: dict[str, Any]) -> None:
            nonlocal cursor
            cursor = max(cursor, int(event.get("sequence") or 0))
            if stream_listener is not None:
                await stream_listener(
                    {
                        "run_id": run_id,
                        "type": str(event.get("type") or "reasoning.status"),
                        "payload": event.get("payload") if isinstance(event.get("payload"), dict) else {},
                        "sequence": event.get("sequence"),
                        "event_id": event.get("event_id"),
                        "timestamp": event.get("timestamp"),
                        "durable": True,
                    }
                )

        for event in await list_agent_run_events(run_id):
            await publish(event)
        await publish(
            await append_agent_run_event(
                run_id,
                event_type="executor.started",
                payload={"provider": self.provider_id, "version": self.version},
            )
        )
        response_text = f"Replay Agent 已接收任务：{goal}"
        await publish(
            await append_agent_run_event(
                run_id,
                event_type="assistant.delta",
                payload={"delta": response_text, "delta_index": 0},
            )
        )
        run["status"] = "completed"
        run["llm_runtime"] = {
            **run.get("llm_runtime", {}),
            "status": "completed",
        }
        run["final_result"] = {
            "assistant_message": response_text,
            "turn_finished": True,
            "requires_confirmation": False,
            "active_skill": skill.summary(),
        }
        saved = await save_agent_run(run)
        for event in await list_agent_run_events(run_id, after_sequence=cursor):
            await publish(event)
        return {
            "ok": True,
            "run": saved,
            "assistant_message": response_text,
            "pending_actions": pending_actions_for_run(saved),
            "active_skill": skill.summary(),
            "conversation_id": conversation_id,
        }

    async def resume_run(self, run_id: str) -> dict[str, Any]:
        from app.services.agent_run_state import (
            append_agent_run_event,
            load_agent_run,
            pending_actions_for_run,
            save_agent_run,
        )
        from app.services.agent_skill_registry import resolve_skill

        run = await load_agent_run(run_id)
        if run is None:
            raise ValueError(f"Agent Run {run_id} 不存在。")
        if run.get("status") != "interrupted":
            raise ValueError(f"Agent Run {run_id} 不能恢复（status={run.get('status')}）。")
        skill = resolve_skill(str(run.get("skill_id") or ""))
        response_text = f"Replay Agent 已从持久化 Run 恢复任务：{str(run.get('goal') or '').strip()}"
        await append_agent_run_event(
            run_id,
            event_type="executor.resumed",
            payload={"provider": self.provider_id, "version": self.version},
        )
        await append_agent_run_event(
            run_id,
            event_type="assistant.delta",
            payload={"delta": response_text, "delta_index": 0},
        )
        run["status"] = "completed"
        run["recovery_cursor"] = {
            **(
                run.get("recovery_cursor")
                if isinstance(run.get("recovery_cursor"), dict)
                else {}
            ),
            "resumed_by": self.provider_id,
        }
        run["llm_runtime"] = {
            **(run.get("llm_runtime") if isinstance(run.get("llm_runtime"), dict) else {}),
            "runtime": "offeru_replay",
            "provider_id": self.provider_id,
            "protocol_version": self.protocol_version,
            "stream_protocol": "cursor_v1",
            "status": "completed",
        }
        run["final_result"] = {
            "assistant_message": response_text,
            "turn_finished": True,
            "requires_confirmation": False,
            "active_skill": skill.summary() if skill is not None else {},
        }
        saved = await save_agent_run(run)
        return {
            "ok": True,
            "run": saved,
            "assistant_message": response_text,
            "pending_actions": pending_actions_for_run(saved),
            "active_skill": saved["final_result"].get("active_skill", {}),
            "conversation_id": saved.get("conversation_id", ""),
            "tool_calls": [],
        }

    async def confirm_run(self, run_id: str, *, action_id: str) -> dict[str, Any]:
        from app.services.agent_run_state import load_agent_run, pending_actions_for_run

        run = await load_agent_run(run_id)
        if run is None:
            raise ValueError(f"Agent Run {run_id} 不存在。")
        return {
            "ok": False,
            "run": run,
            "tool_calls": [],
            "errors": [f"Replay provider 没有可确认的动作: {action_id}"],
            "pending_actions": pending_actions_for_run(run),
        }

    async def abort_run(self, run_id: str) -> dict[str, Any]:
        from app.services.agent_run_state import load_agent_run, save_agent_run

        run = await load_agent_run(run_id)
        if run is None:
            raise ValueError(f"Agent Run {run_id} 不存在。")
        if run.get("status") in {"completed", "failed", "cancelled", "needs_reconciliation"}:
            return {"ok": True, "run": run, "warnings": ["Run 已经结束。"]}
        run["status"] = "cancelled"
        run["failure_reason"] = "cancelled_by_user"
        return {"ok": True, "run": await save_agent_run(run)}


def _event(event_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "id": f"agent_evt_{uuid.uuid4().hex}",
        "type": event_type,
        "payload": payload or {},
    }


class ReplayAgentRuntimeProvider:
    """Deterministic provider used for fixture/replay business proofs."""

    provider_id = "replay"
    version = "offeru-replay.v1"
    protocol_version = "offeru-agent-runtime.v1"

    def __init__(self, *, output: dict[str, Any] | None = None) -> None:
        self.output = output or {}
        self._state = "created"
        self._thread_id = ""
        self._turn_id = ""
        self._events: list[dict[str, Any]] = []
        self._result: dict[str, Any] = {}

    def _append(self, event_type: str, payload: dict[str, Any] | None = None) -> None:
        self._events.append(_event(event_type, payload))

    async def start(self) -> dict[str, Any]:
        self._state = "ready"
        self._append("runtime.started", {"provider": self.provider_id})
        return await self.status()

    async def status(self) -> dict[str, Any]:
        return {
            "provider_id": self.provider_id,
            "status": self._state,
            "available": True,
            "authenticated": True,
            "blocked": False,
            "version": self.version,
            "protocol_version": self.protocol_version,
            "thread_id": self._thread_id,
            "turn_id": self._turn_id,
        }

    async def shutdown(self) -> dict[str, Any]:
        self._state = "stopped"
        self._append("runtime.stopped", {"provider": self.provider_id})
        return await self.status()

    async def restart(self) -> dict[str, Any]:
        await self.shutdown()
        return await self.start()

    async def events(self, *, after: int = 0) -> dict[str, Any]:
        return {"events": self._events[max(0, int(after)):], "next": len(self._events)}

    async def cancel(self) -> dict[str, Any]:
        self._state = "cancelled"
        self._append("runtime.cancelled")
        return {"cancelled": True, "provider_id": self.provider_id}

    async def result(self) -> dict[str, Any]:
        return dict(self._result)

    async def create_thread(
        self,
        *,
        cwd: str,
        tool_descriptions: list[str] | None = None,
    ) -> dict[str, Any]:
        del cwd
        if not self._thread_id:
            self._thread_id = f"replay_thread_{uuid.uuid4().hex[:16]}"
            self._append(
                "thread.created",
                {"thread_id": self._thread_id, "tool_count": len(tool_descriptions or [])},
            )
        return {"thread_id": self._thread_id, "reused": False}

    async def start_turn(self, *, prompt: str, cwd: str) -> dict[str, Any]:
        del cwd
        if not self._thread_id:
            await self.create_thread(cwd="", tool_descriptions=[])
        self._turn_id = f"replay_turn_{uuid.uuid4().hex[:16]}"
        self._state = "running"
        self._append("turn.started", {"turn_id": self._turn_id})
        if self.output:
            value = self.output
        elif prompt.strip():
            value = {"response": prompt.strip()}
        else:
            value = {"response": ""}
        self._result = {
            "thread_id": self._thread_id,
            "turn_id": self._turn_id,
            "structured": value,
            "final_message": str(value.get("response") or "") if isinstance(value, dict) else "",
        }
        self._state = "completed"
        self._append("turn.completed", {"turn_id": self._turn_id})
        return dict(self._result)

    async def resume_turn(self, *, prompt: str, cwd: str) -> dict[str, Any]:
        return await self.start_turn(prompt=prompt, cwd=cwd)

    async def approve(self, **_: Any) -> dict[str, Any]:
        return {"approved": False, "reason": "replay provider has no external approval"}

    async def reject(self, **_: Any) -> dict[str, Any]:
        return {"rejected": True}

    async def list_skills(self) -> dict[str, Any]:
        from app.services.agent_skill_registry import registry_snapshot

        return {
            "provider_id": self.provider_id,
            "skills": registry_snapshot().get("skills", []),
            "source": "offeru_registry",
        }

    async def list_plugins(self) -> dict[str, Any]:
        from app.services.capability_plugins import discover_plugins

        return {
            "provider_id": self.provider_id,
            **discover_plugins(),
            "source": "offeru_registry",
        }


class CodexAgentRuntimeProvider:
    """OfferU adapter for one Codex app-server stdio process."""

    provider_id = "codex"

    def __init__(
        self,
        *,
        run_id: str = "",
        executable: str | None = None,
        thread_params: dict[str, Any] | None = None,
        on_operation: AgentOperationCallback | None = None,
    ) -> None:
        from app.services.agent_bridge.codex_adapter import CodexMainLoopAdapter

        self.run_id = str(run_id or "")
        self.adapter = CodexMainLoopAdapter(
            executable=executable,
            thread_params=thread_params,
        )
        if on_operation is not None:
            self.adapter.on_operation = on_operation
        self._state = "created"
        self._result: dict[str, Any] = {}
        self._last_error = ""

    @staticmethod
    async def _record_health(**kwargs: Any) -> None:
        try:
            from app.services.agent_provider_health import record_provider_health

            await record_provider_health("codex", **kwargs)
        except Exception:
            # Health persistence must not hide the provider's primary result.
            pass

    @staticmethod
    def _is_auth_error(error: Any) -> bool:
        text = str(error or "").casefold()
        return any(
            marker in text
            for marker in ("401", "invalid_api_key", "authentication", "unauthorized")
        )

    async def start(self) -> dict[str, Any]:
        try:
            await self.adapter.start()
        except Exception as exc:
            self._state = "blocked" if self._is_auth_error(exc) else "failed"
            self._last_error = str(exc)[:1000]
            await self._record_health(
                available=False,
                authenticated=False if self._is_auth_error(exc) else None,
                blocked=self._is_auth_error(exc),
                auth_mode="unknown",
                protocol_version=self.adapter.protocol_version,
                error=exc,
            )
            raise
        self._state = "ready"
        info = self.adapter.server_info
        version = str(info.get("userAgent") or info.get("version") or "")[:160]
        await self._record_health(
            available=True,
            authenticated=None,
            blocked=False,
            version=version,
            auth_mode="provider-managed",
            protocol_version=self.adapter.protocol_version,
            capabilities={"thread": True, "turn": True, "approval": False},
        )
        return await self.status()

    async def status(self) -> dict[str, Any]:
        process = self.adapter.process
        return {
            "provider_id": self.provider_id,
            "status": self._state,
            "available": process is not None and process.returncode is None,
            "authenticated": None if self._state == "ready" else False if self._state == "blocked" else None,
            "blocked": self._state == "blocked",
            "version": str(self.adapter.server_info.get("userAgent") or ""),
            "protocol_version": self.adapter.protocol_version,
            "thread_id": self.adapter.thread_id,
            "turn_id": self.adapter.turn_id,
            "last_error": "provider authentication failed" if self._is_auth_error(self._last_error) else self._last_error,
        }

    async def shutdown(self) -> dict[str, Any]:
        await self.adapter.close()
        self._state = "stopped"
        return await self.status()

    async def restart(self) -> dict[str, Any]:
        await self.shutdown()
        return await self.start()

    async def events(self, *, after: int = 0) -> dict[str, Any]:
        return {"events": self.adapter.events(after=after), "next": len(self.adapter.events())}

    async def cancel(self) -> dict[str, Any]:
        result = await self.adapter.cancel()
        self._state = "cancelled" if result.get("cancelled") else self._state
        return result

    async def result(self) -> dict[str, Any]:
        return dict(self._result)

    async def create_thread(
        self,
        *,
        cwd: str,
        tool_descriptions: list[str] | None = None,
    ) -> dict[str, Any]:
        return await self.adapter.create_thread(
            cwd=cwd,
            tool_descriptions=tool_descriptions or [],
        )

    async def start_turn(self, *, prompt: str, cwd: str) -> dict[str, Any]:
        self._state = "running"
        try:
            self._result = await self.adapter.start_turn(prompt=prompt, cwd=cwd)
        except Exception as exc:
            self._state = "blocked" if self._is_auth_error(exc) else "failed"
            self._last_error = str(exc)[:1000]
            if self._is_auth_error(exc):
                await self._record_health(
                    available=False,
                    authenticated=False,
                    blocked=True,
                    protocol_version=self.adapter.protocol_version,
                    error=exc,
                )
            raise
        self._state = "completed"
        return dict(self._result)

    async def resume_turn(self, *, prompt: str, cwd: str) -> dict[str, Any]:
        self._state = "running"
        self._result = await self.adapter.resume_turn(prompt=prompt, cwd=cwd)
        self._state = "completed"
        return dict(self._result)

    async def approve(self, **kwargs: Any) -> dict[str, Any]:
        return await self.adapter.approve(**kwargs)

    async def reject(self, **kwargs: Any) -> dict[str, Any]:
        return await self.adapter.reject(**kwargs)

    async def list_skills(self) -> dict[str, Any]:
        from app.services.agent_skill_registry import registry_snapshot

        return {
            "provider_id": self.provider_id,
            "skills": registry_snapshot().get("skills", []),
            "source": "offeru_registry",
        }

    async def list_plugins(self) -> dict[str, Any]:
        from app.services.capability_plugins import discover_plugins

        return {
            "provider_id": self.provider_id,
            **discover_plugins(),
            "source": "offeru_registry",
        }


def get_agent_runtime_provider(
    provider_id: str,
    *,
    run_id: str = "",
    executable: str | None = None,
    thread_params: dict[str, Any] | None = None,
    on_operation: AgentOperationCallback | None = None,
) -> AgentRuntimeProvider:
    clean = str(provider_id or "replay").strip().casefold()
    if clean in {"fixture", "replay", "mock"}:
        return ReplayAgentRuntimeProvider()
    if clean in {"codex", "codex-app-server"}:
        return CodexAgentRuntimeProvider(
            run_id=run_id,
            executable=executable,
            thread_params=thread_params,
            on_operation=on_operation,
        )
    raise ValueError(f"未知 Agent Runtime provider: {provider_id}")


def get_agent_run_provider(provider_id: str = "pi") -> AgentRunProvider:
    """Resolve the Main Agent provider without leaking provider details upward."""

    clean = str(provider_id or "pi").strip().casefold()
    if clean in {"pi", "pi-sdk", "pi-sdk-worker"}:
        return PiAgentRuntimeProvider()
    if clean in {"replay", "fixture", "mock"}:
        return ReplayAgentRunProvider()
    raise ValueError(f"未知 Main Agent provider: {provider_id}")


__all__ = [
    "AgentRunProvider",
    "AgentRunStreamListener",
    "AgentRuntimeProvider",
    "CANONICAL_AGENT_RUN_EVENT_TYPES",
    "CodexAgentRuntimeProvider",
    "PiAgentRuntimeProvider",
    "ReplayAgentRunProvider",
    "ReplayAgentRuntimeProvider",
    "canonical_agent_run_event",
    "get_agent_run_provider",
    "get_agent_runtime_provider",
]
