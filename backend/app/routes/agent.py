# =============================================
# OfferU Agent Chat — LLM + MCP Tool 调用编排
# =============================================
# POST /api/agent/chat  (SSE)
# 用户消息 → LLM 判断需要哪些 Tools → 调用 → 组装结果 → 回复
# =============================================

from __future__ import annotations

import json
import time
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from app.agents.llm import chat_completion, extract_json
from app.ops import OPERATIONS, build_tools_description, execute_operation
from app.services.security_redaction import safe_error_message

router = APIRouter()
PROPOSAL_TTL_SECONDS = 15 * 60
_PROPOSALS: dict[str, dict] = {}

# ---- MCP Tool Registry (name → callable + schema) ----

TOOL_REGISTRY: dict[str, dict] = {
    name: {
        "fn": operation.fn,
        "description": operation.description,
        "parameters": operation.parameters,
        "side_effects": operation.side_effects,
    }
    for name, operation in OPERATIONS.items()
}

# ---- Build Tool descriptions for LLM system prompt ----

def _build_tools_description() -> str:
    return build_tools_description()


SYSTEM_PROMPT = f"""你是 OfferU 内置求职操作 Agent，目标是像高级专家用户一样通过原子工具控制 OfferU。

可用原子工具：
{_build_tools_description()}

操作原则：
1. 先判断用户目标属于读取、批量筛选、定制简历、投递待办、上下文接管还是普通问答。
2. 复杂目标优先调用 agent_playbook 或 workflow_plan 获取操作契约和命令/步骤计划，不要凭空猜流程。
3. 单次工具调用只做一个原子操作；多步任务使用 multi_tool 编排多个原子工具。
4. 读操作可以直接执行；带 write、llm、external 副作用的工具会被系统强制 dry-run，并返回 proposal_id 等待用户确认。
5. 不自动提交站外申请，不自动发送邮件或站外消息，只生成草稿、建议、待办和可确认预案。
6. 批量工作流必须先读取 Profile、岗位列表或当前上下文，再基于返回结果选择具体 job_ids、job_id、resume_id。
7. 如果缺少真实 ID，不要编造；先调用读取工具获取候选项，或回复用户需要选择哪一项。

推荐工作流：
- 今日概览：job_stats → list_pools → list_jobs
- 批量筛选：get_profile → list_jobs → batch_update_jobs(dry-run)
- 定制简历：get_profile → get_job → start_job_research(dry-run+确认) → get_job_research → prepare_resume_optimization(dry-run+确认) → get_resume_optimization → review_resume_optimization(dry-run+确认)
- 投递待办：get_job → list_resume_optimizations → get_resume_optimization → review_resume_optimization(dry-run+确认) → generate_cover_letter(dry-run) → create_application(dry-run)
- 当前页面接管：get_current_view → 根据 selection/filters 继续操作

返回格式只能是合法 JSON：
- 单工具：{{"action": "tool_call", "tool": "工具名", "args": {{参数字典}}}}
- 多工具：{{"action": "multi_tool", "calls": [{{"tool": "工具名1", "args": {{...}}}}, {{"tool": "工具名2", "args": {{...}}}}]}}
- 直接回答：{{"action": "reply", "message": "中文回答"}}

参数必须匹配 schema。回复必须使用中文，清楚说明已执行的读取结果、需要用户确认的预案、以及下一步可选动作。"""


class ChatMessage(BaseModel):
    role: str  # user / assistant / system
    content: str


class AgentChatRequest(BaseModel):
    messages: list[ChatMessage]


class AgentConfirmRequest(BaseModel):
    proposal_id: str


class AgentContextRequest(BaseModel):
    scope: str = "default"
    route: str = ""
    title: str = ""
    entity_type: str = ""
    entity_id: str = ""
    selection: dict = Field(default_factory=dict)
    filters: dict = Field(default_factory=dict)
    context: dict = Field(default_factory=dict)
    updated_by: str = "ui"


@router.post("/chat")
async def agent_chat(body: AgentChatRequest):
    """Agent chat endpoint — SSE stream"""

    async def event_generator():
        messages = [{"role": "system", "content": SYSTEM_PROMPT}]
        for m in body.messages:
            messages.append({"role": m.role, "content": m.content})

        max_rounds = 5  # 防止无限循环
        for round_idx in range(max_rounds):
            # 调用 LLM 获取决策
            yield {"event": "thinking", "data": json.dumps(
                {"round": round_idx + 1, "status": "thinking"},
                ensure_ascii=False
            )}

            llm_response = await chat_completion(
                messages=messages,
                temperature=0.3,
                json_mode=True,
                max_tokens=2048,
                tier="standard",
            )

            if not llm_response:
                yield {"event": "message", "data": json.dumps(
                    {"content": "抱歉，AI 暂时无法响应，请稍后重试。"},
                    ensure_ascii=False
                )}
                return

            # 解析 LLM 输出
            parsed = extract_json(llm_response)
            if not parsed:
                # LLM 直接返回文本
                yield {"event": "message", "data": json.dumps(
                    {"content": llm_response},
                    ensure_ascii=False
                )}
                return

            action = parsed.get("action", "reply")

            if action == "reply":
                yield {"event": "message", "data": json.dumps(
                    {"content": parsed.get("message", llm_response)},
                    ensure_ascii=False
                )}
                return

            elif action == "tool_call":
                tool_name = parsed.get("tool", "")
                tool_args = parsed.get("args", {})
                result = await _execute_tool(tool_name, tool_args)

                yield {"event": "tool_call", "data": json.dumps(
                    {"tool": tool_name, "args": tool_args, "result": result},
                    ensure_ascii=False
                )}

                # 把工具结果追加到消息历史，让 LLM 基于结果回复
                messages.append({"role": "assistant", "content": llm_response})
                messages.append({"role": "user", "content": f"工具 {tool_name} 返回结果：\n{json.dumps(result, ensure_ascii=False)[:3000]}\n\n请根据工具结果回复用户。"})

            elif action == "multi_tool":
                calls = parsed.get("calls", [])
                all_results = []
                for call in calls:
                    tn = call.get("tool", "")
                    ta = call.get("args", {})
                    r = await _execute_tool(tn, ta)
                    all_results.append({"tool": tn, "result": r})

                    yield {"event": "tool_call", "data": json.dumps(
                        {"tool": tn, "args": ta, "result": r},
                        ensure_ascii=False
                    )}

                messages.append({"role": "assistant", "content": llm_response})
                summary = json.dumps(all_results, ensure_ascii=False)[:4000]
                messages.append({"role": "user", "content": f"工具调用结果：\n{summary}\n\n请根据结果综合回复用户。"})

            else:
                yield {"event": "message", "data": json.dumps(
                    {"content": parsed.get("message", llm_response)},
                    ensure_ascii=False
                )}
                return

        # max_rounds reached
        yield {"event": "message", "data": json.dumps(
            {"content": "操作完成。如需进一步帮助请继续提问。"},
            ensure_ascii=False
        )}

    return EventSourceResponse(event_generator())


@router.post("/confirm")
async def confirm_agent_operation(body: AgentConfirmRequest) -> dict:
    """执行 Web Agent 生成的副作用操作预案。"""
    _prune_expired_proposals()
    proposal = _PROPOSALS.pop(body.proposal_id, None)
    if not proposal:
        raise HTTPException(status_code=404, detail="proposal not found or expired")

    result = await execute_operation(
        proposal["tool"],
        proposal["args"],
        dry_run=False,
        surface="web_agent_confirm",
    )
    result["proposal_id"] = body.proposal_id
    result["confirmed"] = True

    return result


@router.get("/context")
async def get_agent_context(scope: str = "default") -> dict:
    """读取 UI 与 Agent 共享的当前工作区上下文。"""
    return await execute_operation(
        "get_current_view",
        {"scope": scope},
        surface="ui",
    )


@router.put("/context")
async def set_agent_context(body: AgentContextRequest) -> dict:
    """写入 UI 与 Agent 共享的当前工作区上下文。"""
    return await execute_operation(
        "set_current_view",
        body.model_dump(),
        surface="ui",
    )


@router.delete("/context")
async def clear_agent_context(scope: str = "default") -> dict:
    """清空 UI 与 Agent 共享的当前工作区上下文。"""
    return await execute_operation(
        "clear_current_view",
        {"scope": scope},
        surface="ui",
    )


async def _execute_tool(tool_name: str, args: dict) -> dict:
    """执行 MCP Tool"""
    if tool_name not in TOOL_REGISTRY:
        return {"error": f"未知工具: {tool_name}"}

    try:
        # 过滤掉 None 值参数
        clean_args = {k: v for k, v in args.items() if v is not None}
        side_effects = set(TOOL_REGISTRY[tool_name].get("side_effects", ()))
        dry_run = bool(side_effects.intersection({"write", "llm", "external"}))
        result = await execute_operation(tool_name, clean_args, dry_run=dry_run, surface="web_agent")
        if dry_run:
            proposal_id = _store_proposal(tool_name, clean_args, tuple(side_effects))
            result["proposal_id"] = proposal_id
            result["requires_confirmation"] = True
            result["confirmation_hint"] = "该操作包含副作用，Web Agent 已强制 dry-run；确认后调用 POST /api/agent/confirm 执行。"
        return result
    except Exception as e:
        return {"error": safe_error_message(e)}


def _store_proposal(tool_name: str, args: dict, side_effects: tuple[str, ...]) -> str:
    _prune_expired_proposals()
    proposal_id = uuid4().hex
    _PROPOSALS[proposal_id] = {
        "tool": tool_name,
        "args": args,
        "side_effects": list(side_effects),
        "created_at": time.time(),
    }
    return proposal_id


def _prune_expired_proposals() -> None:
    now = time.time()
    expired = [
        proposal_id
        for proposal_id, proposal in _PROPOSALS.items()
        if now - float(proposal.get("created_at", 0)) > PROPOSAL_TTL_SECONDS
    ]
    for proposal_id in expired:
        _PROPOSALS.pop(proposal_id, None)
