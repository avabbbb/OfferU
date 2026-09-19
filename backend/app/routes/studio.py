# backend/app/routes/studio.py
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import Any, List, Optional
from pydantic import BaseModel
from jinja2 import Template
import json

from ..database import get_db
from ..models.html_resume import HtmlResumeTemplate, HtmlResume
from ..models.models import Profile
from ..agents.llm import chat_completion

router = APIRouter(prefix="/api/studio", tags=["studio"])

class TemplateListResponse(BaseModel):
    id: int
    name: str
    display_name: str
    category: str
    preview_image: str
    # 模板真正消费的设计令牌。各模板的 html_template 引用范围不同
    # （例如只有 modern-minimal 使用 fontFamily），前端据此判断哪些
    # 设计控件对当前模板有效，避免出现改了没反应的控件。
    design_tokens: dict[str, Any] = {}

class GenerateHtmlResumeRequest(BaseModel):
    profile_id: int
    template_id: int
    design_overrides: Optional[dict] = {}
    job_ids: Optional[List[int]] = []

@router.get("/templates", response_model=List[TemplateListResponse])
async def list_templates(db: AsyncSession = Depends(get_db)):
    """获取所有模板"""
    result = await db.execute(select(HtmlResumeTemplate))
    templates = result.scalars().all()
    return templates

@router.post("/generate")
async def generate_html_resume(
    req: GenerateHtmlResumeRequest,
):
    """AI 生成 HTML 简历（SSE 流式）"""
    from app.ops import execute_operation

    result = await execute_operation(
        "generate_html_resume",
        req.model_dump(),
        surface="studio_api",
    )
    if not result.get("ok"):
        message = "；".join(str(item) for item in result.get("errors") or [])
        status = 404 if "not found" in message.lower() or "不存在" in message else 400
        raise HTTPException(status_code=status, detail=message or "操作失败")
    return result.get("outputs")

@router.get("/resumes/{resume_id}/preview")
async def preview_html_resume(resume_id: int, db: AsyncSession = Depends(get_db)):
    """预览 HTML 简历"""
    resume = await db.get(HtmlResume, resume_id)
    if not resume:
        raise HTTPException(status_code=404, detail="Resume not found")

    # Generated/imported resume HTML is untrusted content rendered on the
    # backend API origin.  Serve it under a restrictive CSP ``sandbox``
    # directive so a hostile document cannot execute script, submit forms,
    # navigate, or claim same-origin authority against the OfferU API.  This is
    # defence-in-depth alongside the sandboxed <iframe> in the Studio UI.
    headers = {
        # Empty ``sandbox`` = apply every restriction: no scripts, no forms,
        # no popups, no top-navigation, no same-origin, no plugins/downloads.
        # Resumes are static HTML+CSS; they need none of those capabilities.
        "Content-Security-Policy": (
            "sandbox; "
            "default-src 'none'; "
            "img-src data: https:; "
            "font-src data: https:; "
            "style-src 'unsafe-inline' https:; "
            "media-src 'none'; "
            "connect-src 'none'; "
            "frame-ancestors 'self'"
        ),
        "X-Content-Type-Options": "nosniff",
    }
    return StreamingResponse(
        iter([resume.html_content]),
        media_type="text/html",
        headers=headers,
    )
