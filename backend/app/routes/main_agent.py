from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from app.ops import list_operations
from app.services.harness_history import (
    get_conversation,
    list_conversations,
)
from app.services.harness_memory import (
    export_agent_memory_markdown,
    load_agent_memory,
)
from app.services.agent_skill_registry import registry_snapshot
from app.services.agent_runtime import (
    canonical_agent_run_event,
    get_agent_run_provider,
)

router = APIRouter()
runtime_router = APIRouter()
_background_runtime_tasks: set[asyncio.Task[Any]] = set()


class AgentMemoryImportRequest(BaseModel):
    content: dict[str, Any] | str


class AgentContextRequest(BaseModel):
    scope: str = "default"
    route: str = ""
    title: str = ""
    entity_type: str = ""
    entity_id: str = ""
    selection: dict[str, Any] = Field(default_factory=dict)
    filters: dict[str, Any] = Field(default_factory=dict)
    context: dict[str, Any] = Field(default_factory=dict)
    updated_by: str = "ui"


class PiAgentRunRequest(BaseModel):
    message: str = Field(min_length=1, max_length=20_000)
    skill_id: str = Field(min_length=1, max_length=120)
    conversation_id: str | None = None
    task_id: str | None = None
    run_id: str | None = Field(
        default=None,
        pattern=r"^run_[a-f0-9]{16,32}$",
    )
    runtime_provider: str = Field(
        default="pi",
        min_length=1,
        max_length=40,
        pattern=r"^[a-z0-9][a-z0-9_-]*$",
    )


class PiAgentConfirmationRequest(BaseModel):
    action_id: str = Field(min_length=1, max_length=200)


class HostedSessionActionRequest(BaseModel):
    confirmed: bool


class AutomationEventRequest(BaseModel):
    event_type: str = Field(min_length=1, max_length=80)
    source: str = Field(default="ui", min_length=1, max_length=80)
    target_type: str = ""
    target_id: str = ""
    payload: dict[str, Any] = Field(default_factory=dict)
    dedupe_key: str = ""


class AutomationInboxActionRequest(BaseModel):
    action: str = Field(pattern="^(resolve|dismiss|reopen)$")


class CareerTaskStartRequest(BaseModel):
    task_type: str = Field(min_length=1, max_length=100)
    source: str = Field(default="ui", min_length=1, max_length=80)
    target_type: str = ""
    target_id: str = ""
    runtime_provider: str = "replay"
    input: dict[str, Any] = Field(default_factory=dict)
    output_contract: dict[str, Any] = Field(default_factory=dict)
    run_id: str = ""
    idempotency_key: str = ""
    max_attempts: int = Field(default=3, ge=1, le=10)


async def _ui_operation_outputs(
    operation: str,
    args: dict[str, Any],
) -> dict[str, Any]:
    from app.ops import execute_operation

    result = await execute_operation(
        operation,
        args,
        surface="hosted_session_ui",
    )
    if not result.get("ok"):
        detail = "；".join(str(item) for item in result.get("errors") or [])
        raise HTTPException(status_code=400, detail=detail or "Operation failed")
    outputs = result.get("outputs")
    if not isinstance(outputs, dict):
        raise HTTPException(status_code=502, detail="Operation returned invalid outputs")
    return outputs


async def _ui_operation_projection(
    operation: str,
    args: dict[str, Any],
) -> dict[str, Any]:
    """Use the same proposal boundary for UI-triggered runtime mutations."""
    from app.services.operation_projection import execute_or_propose_operation

    result = await execute_or_propose_operation(
        operation,
        args,
        surface="agent_runtime_ui",
    )
    if not result.get("ok"):
        detail = "；".join(str(item) for item in result.get("errors") or [])
        raise HTTPException(status_code=400, detail=detail or "Operation failed")
    outputs = result.get("outputs")
    if not isinstance(outputs, dict):
        raise HTTPException(status_code=502, detail="Operation returned invalid outputs")
    return outputs


def _main_agent_provider(provider_id: str = "pi"):
    """Resolve the provider at the anti-corruption boundary only."""

    try:
        return get_agent_run_provider(provider_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


async def _provider_for_run(run_id: str):
    from app.services.agent_run_state import load_agent_run

    run = await load_agent_run(run_id)
    provider_id = "pi"
    if run is not None:
        runtime = run.get("llm_runtime") if isinstance(run.get("llm_runtime"), dict) else {}
        provider_id = str(runtime.get("provider_id") or "pi")
    return _main_agent_provider(provider_id)


@router.get("/skills")
async def skills() -> dict[str, Any]:
    return registry_snapshot(list_operations())


@runtime_router.get("/runs")
async def agent_runs(
    conversation_id: str | None = None,
    task_id: str | None = None,
    limit: int = 20,
) -> dict[str, Any]:
    from app.services.agent_run_state import list_agent_runs

    return {
        "runs": await list_agent_runs(
            conversation_id=conversation_id,
            task_id=task_id,
            limit=limit,
        )
    }


@runtime_router.get("/runs/{run_id}")
async def agent_run_detail(run_id: str) -> dict[str, Any]:
    from app.services.agent_run_state import load_agent_run

    run = await load_agent_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Agent Run not found")
    return {"run": run}


@runtime_router.get("/runs/{run_id}/events")
async def agent_run_events(
    run_id: str,
    after_sequence: int = 0,
    limit: int = 200,
) -> dict[str, Any]:
    from app.services.agent_run_state import (
        list_agent_run_events,
        load_agent_run,
    )

    if await load_agent_run(run_id) is None:
        raise HTTPException(status_code=404, detail="Agent Run not found")
    events = await list_agent_run_events(
        run_id,
        after_sequence=after_sequence,
        limit=limit,
    )
    return {
        "run_id": run_id,
        "events": [canonical_agent_run_event(event) for event in events],
        "last_sequence": events[-1]["sequence"] if events else after_sequence,
    }


def _runtime_response_from_run(run: dict[str, Any]) -> dict[str, Any]:
    from app.services.agent_run_state import pending_actions_for_run
    from app.services.agent_skill_registry import resolve_skill

    final_result = (
        run.get("final_result")
        if isinstance(run.get("final_result"), dict)
        else {}
    )
    skill = resolve_skill(str(run.get("skill_id") or ""))
    active_skill = (
        final_result.get("active_skill")
        if isinstance(final_result.get("active_skill"), dict)
        else (
            skill.summary()
            if skill is not None
            else {
                **(
                    run.get("skill_snapshot")
                    if isinstance(run.get("skill_snapshot"), dict)
                    else {}
                ),
                "group": "system",
                "status": "unavailable",
                "featured": False,
                "order": 9999,
                "missing_capabilities": [],
            }
        )
    )
    status = str(run.get("status") or "")
    failure_reason = str(run.get("failure_reason") or "").strip()
    conversation_id = str(run.get("conversation_id") or "")
    conversation = get_conversation(conversation_id) if conversation_id else None
    response = {
        "ok": status not in {
            "failed",
            "cancelled",
            "interrupted",
            "needs_reconciliation",
        },
        "run": run,
        "assistant_message": str(final_result.get("assistant_message") or ""),
        "pending_actions": pending_actions_for_run(run),
        "active_skill": active_skill,
        "guardian": (
            final_result.get("guardian")
            if isinstance(final_result.get("guardian"), dict)
            else {}
        ),
        "conversation_id": conversation_id,
        "conversation_title": str((conversation or {}).get("title") or ""),
    }
    if failure_reason:
        response["errors"] = [failure_reason]
    return response


def _runtime_turn_is_finished(run: dict[str, Any]) -> bool:
    status = str(run.get("status") or "")
    if status not in {
        "completed",
        "failed",
        "cancelled",
        "waiting_confirmation",
        "interrupted",
        "needs_reconciliation",
    }:
        return False
    final_result = (
        run.get("final_result")
        if isinstance(run.get("final_result"), dict)
        else {}
    )
    runtime = (
        run.get("llm_runtime")
        if isinstance(run.get("llm_runtime"), dict)
        else {}
    )
    if runtime.get("stream_protocol") == "cursor_v1":
        return final_result.get("turn_finished") is True
    return True


@runtime_router.get("/runtime/runs/{run_id}/events/stream")
async def follow_runtime_run_events(
    run_id: str,
    after_sequence: int = 0,
):
    """Replay missed durable events, then follow the same Run until its turn ends."""
    from app.services.agent_run_state import (
        list_agent_run_events,
        load_agent_run,
    )

    if await load_agent_run(run_id) is None:
        raise HTTPException(status_code=404, detail="Agent Run not found")

    async def events():
        cursor = max(0, int(after_sequence or 0))
        while True:
            batch = await list_agent_run_events(
                run_id,
                after_sequence=cursor,
                limit=500,
            )
            for event in batch:
                cursor = int(event["sequence"])
                canonical = canonical_agent_run_event(event)
                yield {
                    "id": str(cursor),
                    "event": str(canonical.get("type") or "reasoning.status"),
                    "data": json.dumps({**canonical, "durable": True}, ensure_ascii=False),
                }

            run = await load_agent_run(run_id)
            if run is None:
                yield {
                    "event": "error",
                    "data": json.dumps(
                        {"error": "Agent Run disappeared"},
                        ensure_ascii=False,
                    ),
                }
                return
            if (
                _runtime_turn_is_finished(run)
                and cursor >= int(run.get("event_sequence") or 0)
            ):
                yield {
                    "event": "message",
                    "data": json.dumps(
                        {"response": _runtime_response_from_run(run)},
                        ensure_ascii=False,
                    ),
                }
                return
            await asyncio.sleep(0.25)

    return EventSourceResponse(events())


@runtime_router.get("/runtime")
async def runtime_status() -> dict[str, Any]:
    """Probe the configured Main Agent provider without leaking its implementation."""

    provider = _main_agent_provider("pi")
    return await provider.status()


@runtime_router.get("/runtime/providers/health")
async def agent_provider_health() -> dict[str, Any]:
    return await _ui_operation_outputs("list_agent_provider_health", {})


@runtime_router.get("/runtime/career-tasks")
async def career_tasks(
    status: str | None = None,
    task_type: str | None = None,
    target_type: str | None = None,
    target_id: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    return await _ui_operation_outputs(
        "list_career_tasks",
        {
            "status": status,
            "task_type": task_type,
            "target_type": target_type,
            "target_id": target_id,
            "limit": limit,
        },
    )


@runtime_router.post("/runtime/career-tasks")
async def start_career_task(body: CareerTaskStartRequest) -> dict[str, Any]:
    return await _ui_operation_projection(
        "start_career_task",
        body.model_dump(),
    )


@runtime_router.get("/runtime/career-tasks/{task_id}")
async def career_task(task_id: str) -> dict[str, Any]:
    return await _ui_operation_outputs("get_career_task", {"task_id": task_id})


@runtime_router.get("/runtime/career-tasks/{task_id}/events")
async def career_task_events(task_id: str, after: int = 0, limit: int = 100) -> dict[str, Any]:
    return await _ui_operation_outputs(
        "list_career_task_events",
        {"task_id": task_id, "after": after, "limit": limit},
    )


@runtime_router.get("/runtime/career-tasks/{task_id}/result")
async def career_task_result(task_id: str) -> dict[str, Any]:
    return await _ui_operation_outputs("get_career_task_result", {"task_id": task_id})


@runtime_router.post("/runtime/career-tasks/{task_id}/cancel")
async def cancel_career_task(task_id: str) -> dict[str, Any]:
    return await _ui_operation_projection("cancel_career_task", {"task_id": task_id})


@runtime_router.post("/runtime/career-tasks/{task_id}/retry")
async def retry_career_task(task_id: str) -> dict[str, Any]:
    return await _ui_operation_projection("retry_career_task", {"task_id": task_id})


@runtime_router.post("/runtime/career-tasks/{task_id}/resume")
async def resume_career_task(task_id: str) -> dict[str, Any]:
    return await _ui_operation_projection("resume_career_task", {"task_id": task_id})


@runtime_router.get("/runtime/plugins")
async def capability_plugins() -> dict[str, Any]:
    return await _ui_operation_outputs("list_capability_plugins", {})


@runtime_router.get("/runtime/plugins/capabilities")
async def plugin_capabilities() -> dict[str, Any]:
    return await _ui_operation_outputs("list_plugin_capabilities", {})


@runtime_router.post("/runtime/plugins/{plugin}/install")
async def install_plugin(plugin: str) -> dict[str, Any]:
    return await _ui_operation_projection("install_capability_plugin", {"plugin": plugin})


@runtime_router.delete("/runtime/plugins/{plugin}")
async def uninstall_plugin(plugin: str) -> dict[str, Any]:
    return await _ui_operation_projection("uninstall_capability_plugin", {"plugin": plugin})


@runtime_router.get("/runtime/automation/events")
async def automation_events(
    event_type: str | None = None,
    status: str | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    return await _ui_operation_outputs(
        "list_automation_events",
        {"event_type": event_type, "status": status, "limit": limit},
    )


@runtime_router.get("/runtime/automation/inbox")
async def automation_inbox(
    status: str = "pending",
    category: str | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    return await _ui_operation_outputs(
        "list_automation_inbox",
        {"status": status, "category": category, "limit": limit},
    )


@runtime_router.get("/runtime/automation/rules")
async def automation_rules(enabled: bool | None = None) -> dict[str, Any]:
    return await _ui_operation_outputs(
        "list_automation_rules",
        {"enabled": enabled},
    )


@runtime_router.post("/runtime/automation/events")
async def record_automation_event(body: AutomationEventRequest) -> dict[str, Any]:
    return await _ui_operation_projection(
        "record_automation_event",
        body.model_dump(),
    )


@runtime_router.post("/runtime/automation/inbox/{item_id}")
async def resolve_automation_inbox_item(
    item_id: str,
    body: AutomationInboxActionRequest,
) -> dict[str, Any]:
    return await _ui_operation_projection(
        "resolve_automation_inbox_item",
        {"item_id": item_id, "action": body.action},
    )


@runtime_router.post("/runtime/runs")
async def start_runtime_run(body: PiAgentRunRequest) -> dict[str, Any]:
    """Start one task-bound Agent Run through the configured provider seam."""

    try:
        if body.run_id:
            from app.services.agent_run_state import load_agent_run

            existing = await load_agent_run(body.run_id)
            if existing is not None:
                return _runtime_response_from_run(existing)
        previous = (
            get_conversation(body.conversation_id)
            if body.conversation_id
            else None
        )
        previous_messages = list((previous or {}).get("messages") or [])
        conversation = await _ui_operation_outputs(
            "save_harness_conversation",
            {
                "conversation_id": body.conversation_id,
                "messages": [
                    *previous_messages,
                    {"role": "user", "content": body.message},
                ],
            },
        )
        provider = _main_agent_provider(body.runtime_provider)
        result = await provider.start_run(
            message=body.message,
            skill_id=body.skill_id,
            conversation_id=conversation["id"],
            task_id=str(body.task_id or ""),
            context_messages=previous_messages,
            requested_run_id=str(body.run_id or ""),
        )
        assistant_message = str(result.get("assistant_message") or "").strip()
        if assistant_message:
            conversation = await _ui_operation_outputs(
                "save_harness_conversation",
                {
                    "conversation_id": conversation["id"],
                    "messages": [
                        *conversation["messages"],
                        {"role": "assistant", "content": assistant_message},
                    ],
                },
            )
        result["conversation_id"] = conversation["id"]
        result["conversation_title"] = conversation["title"]
        return result
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@runtime_router.post("/runtime/runs/stream")
async def stream_runtime_run(body: PiAgentRunRequest):
    """Stream stable OfferU Agent Run events from the selected provider."""
    from app.services.agent_run_state import load_agent_run

    if body.run_id and await load_agent_run(body.run_id) is not None:
        return await follow_runtime_run_events(body.run_id)

    previous = (
        get_conversation(body.conversation_id)
        if body.conversation_id
        else None
    )
    previous_messages = list((previous or {}).get("messages") or [])
    conversation = await _ui_operation_outputs(
        "save_harness_conversation",
        {
            "conversation_id": body.conversation_id,
            "messages": [
                *previous_messages,
                {"role": "user", "content": body.message},
            ],
        },
    )
    provider = _main_agent_provider(body.runtime_provider)

    async def events():
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=1000)

        async def listener(event: dict[str, Any]) -> None:
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                # The persisted Run event log remains authoritative. A detached
                # or very slow UI must not block the Agent execution loop.
                pass

        async def run_and_record() -> dict[str, Any]:
            result = await provider.start_run(
                message=body.message,
                skill_id=body.skill_id,
                conversation_id=conversation["id"],
                task_id=str(body.task_id or ""),
                context_messages=previous_messages,
                requested_run_id=str(body.run_id or ""),
                stream_listener=listener,
            )
            assistant_message = str(result.get("assistant_message") or "").strip()
            completed_conversation = conversation
            if assistant_message:
                completed_conversation = await _ui_operation_outputs(
                    "save_harness_conversation",
                    {
                        "conversation_id": conversation["id"],
                        "messages": [
                            *conversation["messages"],
                            {"role": "assistant", "content": assistant_message},
                        ],
                    },
                )
            result["conversation_id"] = completed_conversation["id"]
            result["conversation_title"] = completed_conversation["title"]
            return result

        task = asyncio.create_task(
            run_and_record(),
            name=f"offeru-pi-stream-{conversation['id']}",
        )
        _background_runtime_tasks.add(task)
        task.add_done_callback(_background_runtime_tasks.discard)
        try:
            while not task.done() or not queue.empty():
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=0.25)
                except asyncio.TimeoutError:
                    continue
                canonical = canonical_agent_run_event(event)
                yield {
                    **(
                        {"id": str(canonical["sequence"])}
                        if canonical.get("sequence") is not None
                        else {}
                    ),
                    "event": str(canonical.get("type") or "reasoning.status"),
                    "data": json.dumps(canonical, ensure_ascii=False),
                }
            result = await task
            yield {
                "event": "message",
                "data": json.dumps({"response": result}, ensure_ascii=False),
            }
        except Exception as exc:
            yield {
                "event": "error",
                "data": json.dumps({"error": str(exc)[:1000]}, ensure_ascii=False),
            }

    return EventSourceResponse(events())


@runtime_router.post("/runtime/runs/{run_id}/confirm")
async def confirm_runtime_action(
    run_id: str,
    body: PiAgentConfirmationRequest,
) -> dict[str, Any]:
    """Confirm one persisted action through the selected Agent provider."""

    provider = await _provider_for_run(run_id)
    return await provider.confirm_run(run_id, action_id=body.action_id)


@runtime_router.post("/runtime/runs/{run_id}/resume")
async def resume_runtime_run(run_id: str) -> dict[str, Any]:
    """Explicitly restore the persisted Agent Session for an interrupted Run."""

    try:
        provider = await _provider_for_run(run_id)
        result = await provider.resume_run(run_id)
        conversation_id = str(result.get("run", {}).get("conversation_id") or "")
        conversation = get_conversation(conversation_id) if conversation_id else None
        assistant_message = str(result.get("assistant_message") or "").strip()
        if conversation is not None and assistant_message:
            conversation = await _ui_operation_outputs(
                "save_harness_conversation",
                {
                    "conversation_id": conversation_id,
                    "messages": [
                        *(conversation.get("messages") or []),
                        {"role": "assistant", "content": assistant_message},
                    ],
                },
            )
            result["conversation_id"] = conversation["id"]
            result["conversation_title"] = conversation["title"]
        return result
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@runtime_router.post("/runtime/runs/{run_id}/abort")
async def abort_runtime_run(run_id: str) -> dict[str, Any]:
    try:
        provider = await _provider_for_run(run_id)
        return await provider.abort_run(run_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@runtime_router.get("/runtime/hosted-sessions")
async def hosted_executor_sessions(
    task_type: str | None = None,
    task_id: str | None = None,
    limit: int = 20,
) -> dict[str, Any]:
    return await _ui_operation_outputs(
        "list_hosted_executor_sessions",
        {
            "task_type": task_type,
            "task_id": task_id,
            "limit": max(1, min(int(limit), 100)),
        },
    )


@runtime_router.get("/runtime/hosted-sessions/{session_id}")
async def hosted_executor_session(session_id: str) -> dict[str, Any]:
    session = await _ui_operation_outputs(
        "get_hosted_executor_session",
        {"session_id": session_id},
    )
    if session.get("error"):
        raise HTTPException(status_code=404, detail=str(session["error"]))
    return session


async def _hosted_job_research_action(
    session_id: str,
    operation: str,
    body: HostedSessionActionRequest,
) -> dict[str, Any]:
    if not body.confirmed:
        raise HTTPException(status_code=400, detail="User confirmation is required")
    session = await hosted_executor_session(session_id)
    if session.get("task_type") != "job_research":
        raise HTTPException(
            status_code=409,
            detail="This hosted task type has no UI action contract",
        )
    return await _ui_operation_outputs(
        operation,
        {"run_id": str(session.get("task_id") or "")},
    )


@runtime_router.post("/runtime/hosted-sessions/{session_id}/cancel")
async def cancel_hosted_executor_session_from_ui(
    session_id: str,
    body: HostedSessionActionRequest,
) -> dict[str, Any]:
    return await _hosted_job_research_action(
        session_id,
        "cancel_job_research",
        body,
    )


@runtime_router.post("/runtime/hosted-sessions/{session_id}/resume")
async def resume_hosted_executor_session_from_ui(
    session_id: str,
    body: HostedSessionActionRequest,
) -> dict[str, Any]:
    return await _hosted_job_research_action(
        session_id,
        "resume_job_research",
        body,
    )


@router.get("/context")
async def get_agent_context(scope: str = "default") -> dict[str, Any]:
    from app.ops import execute_operation
    return await execute_operation("get_current_view", {"scope": scope}, surface="ui")


@router.put("/context")
async def set_agent_context(body: AgentContextRequest) -> dict[str, Any]:
    from app.ops import execute_operation
    return await execute_operation("set_current_view", body.model_dump(), surface="ui")


@router.delete("/context")
async def clear_agent_context(scope: str = "default") -> dict[str, Any]:
    from app.ops import execute_operation
    return await execute_operation("clear_current_view", {"scope": scope}, surface="ui")


@router.get("/conversations")
async def conversations() -> dict[str, Any]:
    return {"conversations": list_conversations()}


@router.get("/conversations/{conversation_id}")
async def conversation_detail(conversation_id: str) -> dict[str, Any]:
    conversation = get_conversation(conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conversation


@router.delete("/conversations/{conversation_id}")
async def remove_conversation(conversation_id: str) -> dict[str, Any]:
    return await _ui_operation_outputs(
        "delete_harness_conversation",
        {"conversation_id": conversation_id},
    )


@router.post("/conversations/{conversation_id}/distill")
async def distill_conversation_memory(conversation_id: str) -> dict[str, Any]:
    return await _ui_operation_outputs(
        "distill_harness_conversation",
        {"conversation_id": conversation_id},
    )


@router.post("/memory/promote")
async def promote_memory() -> dict[str, Any]:
    """把 harness 会话记忆快照送入职业记忆管线（提案进收件箱，需人工确认）。"""
    return await _ui_operation_outputs("promote_harness_memory", {})


@router.get("/memory/search")
async def memory_search(query: str, limit: int = 8) -> dict[str, Any]:
    """语义检索长时记忆（已确认档案事实 + 相关历史观察）。"""
    from app.services.memory_distiller import search_memory

    try:
        return await search_memory(query=query, limit=limit)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/memory/export")
async def export_memory(format: str = "json") -> dict[str, Any]:
    memory = load_agent_memory()
    if format.lower() in {"md", "markdown"}:
        return {"format": "markdown", "content": export_agent_memory_markdown(memory), "memory": memory}
    return {"format": "json", "content": memory, "memory": memory}


@router.get("/data/export")
async def export_user_data() -> dict[str, Any]:
    """Downloadable local core career state through the Operation Registry."""
    return await _ui_operation_outputs("export_user_data", {})


@router.post("/memory/import")
async def import_memory(body: AgentMemoryImportRequest) -> dict[str, Any]:
    return await _ui_operation_outputs(
        "import_harness_memory",
        {"content": body.content},
    )
