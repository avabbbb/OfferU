"""内置 Agent 的工具和提示词：工具就是 core TOOLS，执行走 tools.call（actor 默认「助手」），写入直接生效、可撤销。"""

from __future__ import annotations

import asyncio
import json
from datetime import date
from typing import Any, Optional

from app.agent.loop import LoopTool
from app.agent.types import TextContent, ToolResultMessage
from app.core import tools

ACTOR = "助手"
MAX_STEPS = 6  # 工具调用轮数上限；之后还有一轮写回复


async def execute(name: str, args: Any, *, actor: str = ACTOR) -> tuple[str, bool]:
    """返回 (JSON 文本, 是否出错)。参数不对、业务校验失败都作为错误文本还给模型，不抛出。"""
    try:
        result = await asyncio.to_thread(tools.call, name, args if isinstance(args, dict) else {}, actor=actor)
    except ValueError as exc:  # pydantic.ValidationError 也是 ValueError
        return f"ERROR: {exc}", True
    return json.dumps(result, ensure_ascii=False, default=str), False


def loop_tools(actor: str = ACTOR) -> list[LoopTool]:
    def bind(name: str):
        async def run(call_id: str, args: Any, cancel: Any = None, update: Any = None) -> ToolResultMessage:
            if cancel is not None:
                cancel.throw_if_cancelled()
            text, failed = await execute(name, args, actor=actor)
            return ToolResultMessage(tool_call_id=call_id, tool_name=name, content=[TextContent(text=text)], is_error=failed)
        return run

    return [LoopTool(name=t.name, description=t.description, parameters=t.input.model_json_schema(),
                     execute=bind(t.name), execution_mode="sequential") for t in tools.TOOLS.values()]


def system_prompt(today: Optional[date] = None) -> str:
    view = tools.overview(today=today)
    summary = {
        "stage": view["stage"],
        "next_step": view["next_step"],
        "jobs": {k: v for k, v in view["jobs"].items() if v},
        "todos": {k: len(v) for k, v in view["todos"].items() if v},
    }
    if view.get("mail"):
        summary["mail"] = view["mail"]
    return (
        f"你是 OfferU 里的求职助手。今天是 {view['today']}。\n"
        f"用户现在的情况（overview 摘要）：{json.dumps(summary, ensure_ascii=False)}\n"
        "规则：\n"
        "- 只用工具查到的记录和用户说的话，不编造经历、数字、公司、技能。\n"
        "- 对外的事（发邮件、回复 HR、提交网申）只写草稿存成 doc，不替用户发出。\n"
        "- save / delete 直接生效，用户能在「最近改动」里撤销；做完告诉用户改了什么。\n"
        f"- 最多调用 {MAX_STEPS} 轮工具，先用 overview / search / get 查清楚再写。"
    )
