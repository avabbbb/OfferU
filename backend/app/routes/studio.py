# backend/app/routes/studio.py
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import List, Optional
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
    db: AsyncSession = Depends(get_db)
):
    """AI 生成 HTML 简历（SSE 流式）"""
    # 1. 获取 Profile
    profile = await db.get(Profile, req.profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    # 2. 获取模板
    template = await db.get(HtmlResumeTemplate, req.template_id)
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")

    # 3. 提取 Profile 数据
    #    Profile.sections / target_roles 是 ORM relationship（对象列表），不是 JSON 字符串。
    #    需从 relationship 对象提取字段，从 base_info_json 取地点/摘要等。
    base_info = profile.base_info_json if isinstance(profile.base_info_json, dict) else {}
    profile_data = {
        "name": profile.name,
        "email": profile.email,
        "phone": profile.phone,
        "location": base_info.get("current_city", ""),
        "summary": base_info.get("personal_summary") or base_info.get("summary") or profile.headline or "",
        "sections": [
            {
                "section_type": s.section_type,
                "title": s.title,
                "content_json": s.content_json if isinstance(s.content_json, dict) else {},
                "sort_order": s.sort_order,
            }
            for s in profile.sections
        ],
        "target_roles": [r.role_name for r in profile.target_roles],
    }

    # 4. 渲染模板
    jinja_template = Template(template.html_template)
    html_content = jinja_template.render(
        profile=profile_data,
        design_tokens={**template.design_tokens, **req.design_overrides}
    )

    # 5. 保存到数据库
    html_resume = HtmlResume(
        profile_id=req.profile_id,
        template_id=req.template_id,
        title=f"{profile.name} - {template.display_name}",
        html_content=html_content,
        design_overrides=req.design_overrides,
        job_ids=req.job_ids
    )
    db.add(html_resume)
    await db.commit()
    await db.refresh(html_resume)

    return {"id": html_resume.id, "html": html_content}

@router.get("/resumes/{resume_id}/preview")
async def preview_html_resume(resume_id: int, db: AsyncSession = Depends(get_db)):
    """预览 HTML 简历"""
    resume = await db.get(HtmlResume, resume_id)
    if not resume:
        raise HTTPException(status_code=404, detail="Resume not found")

    return StreamingResponse(
        iter([resume.html_content]),
        media_type="text/html"
    )
