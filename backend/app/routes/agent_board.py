"""HTTP face of the Agent board. The `offeru agent` CLI calls the same service functions."""

from __future__ import annotations

import asyncio
from typing import Any, Callable

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services import agent_board

router = APIRouter()


class CustomAgentRequest(BaseModel):
    id: str = Field(default="", max_length=40)
    display_name: str = Field(default="", max_length=60)
    executable: str = Field(default="", max_length=80)
    skill_root: str = Field(default="", max_length=500)
    memory_file: str = Field(default="", max_length=500)


class ConnectRequest(BaseModel):
    action: str = Field(default="install", pattern="^(install|update|repair)$")


class HiddenRequest(BaseModel):
    hidden: bool


async def _call(function: Callable[..., dict[str, Any]], *args: Any) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(function, *args)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("")
async def list_agents() -> dict[str, Any]:
    return await _call(agent_board.list_board)


@router.post("")
async def add_agent(body: CustomAgentRequest) -> dict[str, Any]:
    return await _call(agent_board.add_custom_agent, body.model_dump())


@router.patch("/{agent_id}")
async def edit_agent(agent_id: str, body: CustomAgentRequest) -> dict[str, Any]:
    return await _call(agent_board.update_custom_agent, agent_id, body.model_dump(exclude_unset=True, exclude={"id"}))


@router.delete("/{agent_id}")
async def remove_agent(agent_id: str) -> dict[str, Any]:
    return await _call(agent_board.remove_custom_agent, agent_id)


@router.post("/{agent_id}/hidden")
async def hide_agent(agent_id: str, body: HiddenRequest) -> dict[str, Any]:
    return await _call(agent_board.set_hidden, agent_id, body.hidden)


@router.post("/{agent_id}/connect")
async def connect_agent(agent_id: str, body: ConnectRequest) -> dict[str, Any]:
    return await _call(agent_board.connect_agent, agent_id, body.action)


@router.post("/{agent_id}/check")
async def check_agent(agent_id: str) -> dict[str, Any]:
    return await _call(agent_board.check_agent, agent_id)


@router.post("/{agent_id}/memory-export")
async def export_agent_memory(agent_id: str) -> dict[str, Any]:
    return await _call(agent_board.export_memory_for_agent, agent_id)
