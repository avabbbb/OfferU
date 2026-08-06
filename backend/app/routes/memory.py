from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.ops import execute_operation

router = APIRouter()


class CreateMemoryProposalRequest(BaseModel):
    observation_id: int = Field(gt=0)
    target_tier: str = Field(
        pattern="^(verified_fact|preference|career_hypothesis)$",
    )
    section_type: str = Field(min_length=1, max_length=80)
    title: str = Field(min_length=1, max_length=220)
    after: dict[str, Any] = Field(min_length=1)
    reason: str = Field(min_length=1, max_length=4000)
    before: dict[str, Any] | None = None
    impact: list[str] | None = None
    supersedes_proposal_id: int | None = Field(default=None, gt=0)


class ReviewMemoryProposalRequest(BaseModel):
    action: str = Field(pattern="^(accept|reject|defer|revoke)$")
    note: str = Field(default="", max_length=2000)


async def _execute(name: str, args: dict[str, Any]) -> dict[str, Any]:
    result = await execute_operation(name, args, surface="memory_api")
    if not result.get("ok"):
        detail = "；".join(str(item) for item in result.get("errors") or [])
        raise HTTPException(status_code=400, detail=detail or "Operation failed")
    outputs = result.get("outputs")
    if not isinstance(outputs, dict):
        raise HTTPException(status_code=502, detail="Operation returned invalid outputs")
    return outputs


@router.get("/inbox")
async def memory_inbox(status: str = "pending", limit: int = 100) -> dict[str, Any]:
    """记忆收件箱：待审核的职业模型变更提案（含取代链字段）。"""
    return await _execute("list_memory_inbox", {"status": status, "limit": limit})


@router.get("/ledger")
async def career_ledger(status: str = "all", limit: int = 100) -> dict[str, Any]:
    """职业模型变更账本：按条目列出变化前后、来源、理由、影响与取代链。"""
    return await _execute("list_career_ledger", {"status": status, "limit": limit})


@router.get("/career-model")
async def career_model() -> dict[str, Any]:
    """当前职业模型：由仍有效的条目派生，含失效条目审计列表。"""
    return await _execute("derive_career_model", {})


@router.post("/proposals")
async def create_proposal(body: CreateMemoryProposalRequest) -> dict[str, Any]:
    """从一条有效学习观察生成收件箱提案；不会直接改写 Profile。"""
    return await _execute("create_memory_proposal", body.model_dump(exclude_none=True))


@router.post("/proposals/{proposal_id}/review")
async def review_proposal(
    proposal_id: int,
    body: ReviewMemoryProposalRequest,
) -> dict[str, Any]:
    """使用者审核提案：accept/reject/defer/revoke；接受才按分层事实门写入 Profile。"""
    return await _execute(
        "review_memory_proposal",
        {"proposal_id": proposal_id, **body.model_dump(exclude_none=True)},
    )
