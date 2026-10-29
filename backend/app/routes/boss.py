"""BOSS 直聘扫码登录：设置页按钮直接调用已有的 boss_login 操作。"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter

from app.routes.main_agent import _ui_operation_outputs, _ui_operation_projection

router = APIRouter()

_ACTIONS = {"start": "start_boss_login", "cancel": "cancel_boss_login", "logout": "logout_boss"}


@router.get("/boss-login")
async def get_boss_login_route() -> dict[str, Any]:
    return await _ui_operation_outputs("get_boss_login", {})


@router.post("/boss-login/{action}")
async def boss_login_action_route(action: Literal["start", "cancel", "logout"]) -> dict[str, Any]:
    return await _ui_operation_projection(_ACTIONS[action], {})
