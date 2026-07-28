from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from app.services.harness_agent import run_harness_agent_turn
from app.services.harness_history import (
    delete_conversation,
    get_conversation,
    list_conversations,
    save_conversation_messages,
)
from app.services.harness_memory import (
    export_agent_memory_markdown,
    import_agent_memory_payload,
    load_agent_memory,
    save_agent_memory,
)
from app.services.agent_skill_registry import catalog

router = APIRouter()


class HarnessAgentMessage(BaseModel):
    role: str
    content: str


class HarnessAgentChatRequest(BaseModel):
    messages: list[HarnessAgentMessage] = Field(default_factory=list)
    confirmed_action_ids: list[str] = Field(default_factory=list)
    memory: dict[str, Any] | None = None
    conversation_id: str | None = None
    skill_id: str | None = None


class HarnessAgentMemoryImportRequest(BaseModel):
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


@router.post("/chat")
async def chat(body: HarnessAgentChatRequest) -> dict[str, Any]:
    return await _run_chat(body)


@router.post("/chat/stream")
async def chat_stream(body: HarnessAgentChatRequest):
    async def events():
        yield {"event": "thinking", "data": json.dumps({"status": "routing_skill"}, ensure_ascii=False)}
        try:
            response = await _run_chat(body)
            active = response.get("active_skill") or {}
            yield {"event": "skill_selected", "data": json.dumps(active, ensure_ascii=False)}
            yield {"event": "message", "data": json.dumps({"response": response}, ensure_ascii=False)}
        except Exception as exc:
            yield {"event": "error", "data": json.dumps({"error": str(exc)}, ensure_ascii=False)}

    return EventSourceResponse(events())


async def _run_chat(body: HarnessAgentChatRequest) -> dict[str, Any]:
    initial = save_conversation_messages(
        conversation_id=body.conversation_id,
        messages=[message.model_dump() for message in body.messages],
    )
    response = await run_harness_agent_turn(
        messages=[message.model_dump() for message in body.messages],
        confirmed_action_ids=body.confirmed_action_ids,
        memory=body.memory,
        conversation_id=initial["id"],
        skill_id=body.skill_id,
    )
    next_messages = [message.model_dump() for message in body.messages]
    assistant_text = str(response.get("assistant_message") or "").strip()
    if assistant_text:
        next_messages.append({"role": "assistant", "content": assistant_text})
    conversation = save_conversation_messages(
        conversation_id=initial["id"],
        messages=next_messages,
    )
    response["conversation_id"] = conversation["id"]
    response["conversation_title"] = conversation["title"]
    return response


@router.get("/skills")
async def skills() -> dict[str, Any]:
    return {"skills": catalog()}


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
    return {"ok": delete_conversation(conversation_id)}


@router.post("/conversations/{conversation_id}/distill")
async def distill_conversation_memory(conversation_id: str) -> dict[str, Any]:
    """会话结束钩子：把对话中的用户要点提炼进记忆收件箱（HITL，不直接写 Profile）。"""
    conversation = get_conversation(conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    user_lines = [
        str(item.get("content") or "").strip()
        for item in conversation.get("messages", [])
        if isinstance(item, dict) and item.get("role") == "user"
    ]
    text = "\n".join(line for line in user_lines if line)
    if not text:
        return {"recorded": False, "reason": "conversation has no user messages"}
    from app.services.memory_distiller import distill_conversation

    return await distill_conversation(
        conversation_text=text,
        session_key=conversation_id,
        metadata={"turns": len(user_lines)},
    )


@router.post("/memory/promote")
async def promote_memory() -> dict[str, Any]:
    """把 harness 会话记忆快照送入职业记忆管线（提案进收件箱，需人工确认）。"""
    from app.services.memory_distiller import promote_session_memory

    return await promote_session_memory()


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


@router.post("/memory/import")
async def import_memory(body: HarnessAgentMemoryImportRequest) -> dict[str, Any]:
    memory = import_agent_memory_payload(body.content)
    saved = save_agent_memory(memory)
    return {"ok": True, "memory": saved}
