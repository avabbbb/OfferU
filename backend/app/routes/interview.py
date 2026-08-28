# =============================================
# Interview 路由 — 面经 & 题库管理 API (PRD §8.5)
# =============================================
# GET  /api/interview/questions       查询题库（按公司/岗位）
# POST /api/interview/collect         提交面经原文（手动粘贴 P0）
# POST /api/interview/extract         LLM 提炼面经中的问题
# POST /api/interview/generate-answer 根据 Profile 生成回答思路
# =============================================

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select, and_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.models.models import (
    InterviewExperience,
    InterviewQuestion,
    Profile,
    ProfileSection,
)
from app.agents.interview_prep import extract_questions, generate_answer_hint

router = APIRouter()
_logger = logging.getLogger(__name__)


# ---------- Pydantic schemas ----------

class CollectBody(BaseModel):
    company: str = Field(..., min_length=1, max_length=300)
    role: str = Field(..., min_length=1, max_length=300)
    raw_text: str = Field(..., min_length=10)
    source_url: Optional[str] = None
    source_platform: str = "manual"
    job_id: Optional[int] = None


class ExtractBody(BaseModel):
    experience_id: int


class GenerateAnswerBody(BaseModel):
    question_id: int


async def _execute_operation(name: str, args: dict[str, Any]) -> Any:
    from app.ops import execute_operation

    result = await execute_operation(name, args, surface="legacy_interview_api")
    if not result.get("ok"):
        message = "；".join(str(item) for item in result.get("errors") or [])
        lowered = message.lower()
        if "不存在" in message or "not found" in lowered:
            status = 404
        elif "llm" in lowered:
            status = 502
        else:
            status = 400
        raise HTTPException(status_code=status, detail=message or "操作失败")
    return result.get("outputs")


# ---------- GET /questions ----------

@router.get("/questions")
async def list_questions(
    company: Optional[str] = Query(None),
    role: Optional[str] = Query(None),
    job_id: Optional[int] = Query(None),
    category: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
):
    """按公司/岗位/类型查询题库"""
    stmt = select(InterviewQuestion)

    filters = []
    if company:
        filters.append(InterviewQuestion.experience.has(
            InterviewExperience.company.contains(company)
        ))
    if role:
        filters.append(InterviewQuestion.experience.has(
            InterviewExperience.role.contains(role)
        ))
    if job_id is not None:
        filters.append(InterviewQuestion.job_id == job_id)
    if category:
        filters.append(InterviewQuestion.category == category)

    if filters:
        stmt = stmt.where(and_(*filters))

    stmt = stmt.order_by(InterviewQuestion.frequency.desc(), InterviewQuestion.id.desc())
    result = await db.execute(stmt)
    rows = result.scalars().all()

    return [
        {
            "id": q.id,
            "experience_id": q.experience_id,
            "question_text": q.question_text,
            "round_type": q.round_type,
            "category": q.category,
            "difficulty": q.difficulty,
            "frequency": q.frequency,
            "suggested_answer": q.suggested_answer,
            "job_id": q.job_id,
            "created_at": q.created_at.isoformat() if q.created_at else None,
        }
        for q in rows
    ]


# ---------- POST /collect ----------

@router.post("/collect")
async def collect_experience(body: CollectBody):
    """提交面经原文（手动粘贴）"""
    return await _execute_operation(
        "collect_interview_experience", body.model_dump()
    )


# ---------- POST /extract ----------

@router.post("/extract")
async def extract_from_experience(body: ExtractBody):
    """LLM 提炼面经 → 结构化问题入库"""
    return await _execute_operation(
        "extract_interview_questions", body.model_dump()
    )


# ---------- POST /generate-answer ----------

@router.post("/generate-answer")
async def generate_answer(body: GenerateAnswerBody):
    """根据 Profile 为某道题生成回答思路"""
    return await _execute_operation(
        "generate_legacy_interview_answer", body.model_dump()
    )


# ---------- GET /experiences ----------

@router.get("/experiences")
async def list_experiences(
    company: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
):
    """查看已收集的面经列表"""
    stmt = select(InterviewExperience).order_by(InterviewExperience.collected_at.desc())

    if company:
        stmt = stmt.where(InterviewExperience.company.contains(company))

    result = await db.execute(stmt)
    rows = result.scalars().all()

    # 一次分组查询统计每个面经的问题数（避免 N+1，也不返回假数据）
    question_counts: dict[int, int] = {}
    if rows:
        ids = [e.id for e in rows]
        count_stmt = (
            select(InterviewQuestion.experience_id, func.count(InterviewQuestion.id))
            .where(InterviewQuestion.experience_id.in_(ids))
            .group_by(InterviewQuestion.experience_id)
        )
        question_counts = dict((await db.execute(count_stmt)).all())

    return [
        {
            "id": e.id,
            "company": e.company,
            "role": e.role,
            "source_platform": e.source_platform,
            "source_url": e.source_url,
            "collected_at": e.collected_at.isoformat() if e.collected_at else None,
            "questions_count": question_counts.get(e.id, 0),
        }
        for e in rows
    ]
