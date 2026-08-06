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
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, and_
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
async def collect_experience(body: CollectBody, db: AsyncSession = Depends(get_db)):
    """提交面经原文（手动粘贴）"""
    exp = InterviewExperience(
        company=body.company.strip(),
        role=body.role.strip(),
        raw_text=body.raw_text,
        source_url=body.source_url,
        source_platform=body.source_platform,
        job_id=body.job_id,
    )
    db.add(exp)
    await db.commit()
    await db.refresh(exp)

    _logger.info("Collected experience #%d: %s / %s", exp.id, exp.company, exp.role)

    return {
        "id": exp.id,
        "company": exp.company,
        "role": exp.role,
        "source_platform": exp.source_platform,
        "collected_at": exp.collected_at.isoformat() if exp.collected_at else None,
    }


# ---------- POST /extract ----------

@router.post("/extract")
async def extract_from_experience(body: ExtractBody, db: AsyncSession = Depends(get_db)):
    """LLM 提炼面经 → 结构化问题入库"""
    exp = await db.get(InterviewExperience, body.experience_id)
    if not exp:
        raise HTTPException(404, "面经记录不存在")

    result = await extract_questions(
        company=exp.company,
        role=exp.role,
        raw_text=exp.raw_text,
    )

    if not result:
        raise HTTPException(502, "LLM 提炼失败，请稍后重试")

    questions_added = []
    for q in result.get("questions", []):
        iq = InterviewQuestion(
            experience_id=exp.id,
            question_text=q.get("question_text", ""),
            round_type=q.get("round_type", "department"),
            category=q.get("category", "behavioral"),
            difficulty=q.get("difficulty", 3),
            job_id=exp.job_id,
        )
        db.add(iq)
        questions_added.append(iq)

    # 更新面经的 rounds 信息
    if result.get("rounds"):
        import json
        exp.interview_rounds = json.dumps(result["rounds"], ensure_ascii=False)

    await db.commit()

    # refresh to get IDs
    for iq in questions_added:
        await db.refresh(iq)

    _logger.info("Extracted %d questions from experience #%d", len(questions_added), exp.id)

    return {
        "experience_id": exp.id,
        "rounds": result.get("rounds", []),
        "questions_count": len(questions_added),
        "questions": [
            {
                "id": iq.id,
                "question_text": iq.question_text,
                "round_type": iq.round_type,
                "category": iq.category,
                "difficulty": iq.difficulty,
            }
            for iq in questions_added
        ],
    }


# ---------- POST /generate-answer ----------

@router.post("/generate-answer")
async def generate_answer(body: GenerateAnswerBody, db: AsyncSession = Depends(get_db)):
    """根据 Profile 为某道题生成回答思路"""
    iq = await db.get(InterviewQuestion, body.question_id)
    if not iq:
        raise HTTPException(404, "题目不存在")

    # 获取用户 Profile bullets
    profile = (await db.execute(select(Profile).limit(1))).scalar_one_or_none()
    if not profile:
        raise HTTPException(404, "请先创建个人档案")

    sections = (await db.execute(
        select(ProfileSection)
        .where(ProfileSection.profile_id == profile.id)
        .where(ProfileSection.status == "active")
    )).scalars().all()

    # 从 content_json 提取文本（PRD §8.4: 优先 bullet → description → title）
    bullet_lines = []
    for s in sections:
        cj = s.content_json or {}
        text = cj.get("bullet") or cj.get("description") or s.title or ""
        if isinstance(text, str):
            text = text.strip()
        if text:
            bullet_lines.append(f"- [{s.section_type}] {text}")

    bullets = "\n".join(bullet_lines)

    if not bullets:
        raise HTTPException(400, "Profile 内容为空，请先填写个人经历")

    answer = await generate_answer_hint(
        question=iq.question_text,
        category=iq.category,
        difficulty=iq.difficulty,
        profile_bullets=bullets,
    )

    if not answer:
        raise HTTPException(502, "LLM 生成失败，请稍后重试")

    # 保存到数据库
    iq.suggested_answer = answer
    await db.commit()

    return {
        "question_id": iq.id,
        "question_text": iq.question_text,
        "suggested_answer": answer,
    }


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

    return [
        {
            "id": e.id,
            "company": e.company,
            "role": e.role,
            "source_platform": e.source_platform,
            "source_url": e.source_url,
            "collected_at": e.collected_at.isoformat() if e.collected_at else None,
            "questions_count": 0,  # lazy — avoid N+1
        }
        for e in rows
    ]
