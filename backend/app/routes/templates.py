# =============================================
# 简历模板管理 API
# =============================================
# 模板市场：浏览、预览、应用内置和自定义模板
# =============================================

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel, Field
from typing import Optional

from app.database import get_db
from app.models.models import ResumeTemplate, Resume

router = APIRouter()


# =============================================
# Pydantic 模型
# =============================================

class TemplateCreate(BaseModel):
    """创建模板的请求体"""
    name: str
    thumbnail_url: str = ""
    css_variables: dict = Field(default_factory=dict)
    html_layout: str = ""
    is_builtin: bool = False


class TemplateUpdate(BaseModel):
    """更新模板的请求体"""
    name: Optional[str] = None
    thumbnail_url: Optional[str] = None
    css_variables: Optional[dict] = None
    html_layout: Optional[str] = None


# =============================================
# API 端点
# =============================================

@router.get("/")
async def list_templates(
    include_custom: bool = True,
    db: AsyncSession = Depends(get_db)
):
    """
    获取所有模板列表
    ────────────────────────────────────────────
    返回内置模板和用户自定义模板。
    """
    query = select(ResumeTemplate)
    if not include_custom:
        query = query.where(ResumeTemplate.is_builtin == True)
    
    result = await db.execute(query.order_by(ResumeTemplate.is_builtin.desc(), ResumeTemplate.created_at.desc()))
    templates = result.scalars().all()

    return [
        {
            "id": t.id,
            "name": t.name,
            "thumbnail_url": t.thumbnail_url,
            "css_variables": t.css_variables,
            "is_builtin": t.is_builtin,
            "created_at": t.created_at.isoformat(),
        }
        for t in templates
    ]


@router.get("/{template_id}")
async def get_template(
    template_id: int,
    db: AsyncSession = Depends(get_db)
):
    """
    获取模板详情（包含完整 HTML 布局）
    """
    result = await db.execute(
        select(ResumeTemplate).where(ResumeTemplate.id == template_id)
    )
    template = result.scalar_one_or_none()
    if not template:
        raise HTTPException(status_code=404, detail="模板不存在")

    return {
        "id": template.id,
        "name": template.name,
        "thumbnail_url": template.thumbnail_url,
        "css_variables": template.css_variables,
        "html_layout": template.html_layout,
        "is_builtin": template.is_builtin,
        "created_at": template.created_at.isoformat(),
    }


@router.post("/")
async def create_template(
    body: TemplateCreate,
    db: AsyncSession = Depends(get_db)
):
    """
    创建自定义模板
    ────────────────────────────────────────────
    用户可以创建自己的简历模板，定义 CSS 变量和 HTML 布局。
    """
    template = ResumeTemplate(
        name=body.name,
        thumbnail_url=body.thumbnail_url,
        css_variables=body.css_variables,
        html_layout=body.html_layout,
        is_builtin=body.is_builtin,
    )
    db.add(template)
    await db.commit()
    await db.refresh(template)

    return {
        "id": template.id,
        "name": template.name,
        "thumbnail_url": template.thumbnail_url,
        "css_variables": template.css_variables,
        "is_builtin": template.is_builtin,
        "created_at": template.created_at.isoformat(),
    }


@router.put("/{template_id}")
async def update_template(
    template_id: int,
    body: TemplateUpdate,
    db: AsyncSession = Depends(get_db)
):
    """
    更新模板
    ────────────────────────────────────────────
    只能更新非内置模板。
    """
    result = await db.execute(
        select(ResumeTemplate).where(ResumeTemplate.id == template_id)
    )
    template = result.scalar_one_or_none()
    if not template:
        raise HTTPException(status_code=404, detail="模板不存在")

    if template.is_builtin:
        raise HTTPException(status_code=403, detail="不能修改内置模板")

    if body.name is not None:
        template.name = body.name
    if body.thumbnail_url is not None:
        template.thumbnail_url = body.thumbnail_url
    if body.css_variables is not None:
        template.css_variables = body.css_variables
    if body.html_layout is not None:
        template.html_layout = body.html_layout

    await db.commit()
    await db.refresh(template)

    return {
        "id": template.id,
        "name": template.name,
        "thumbnail_url": template.thumbnail_url,
        "css_variables": template.css_variables,
        "is_builtin": template.is_builtin,
        "created_at": template.created_at.isoformat(),
    }


@router.delete("/{template_id}")
async def delete_template(
    template_id: int,
    db: AsyncSession = Depends(get_db)
):
    """
    删除模板
    ────────────────────────────────────────────
    只能删除非内置模板。
    """
    result = await db.execute(
        select(ResumeTemplate).where(ResumeTemplate.id == template_id)
    )
    template = result.scalar_one_or_none()
    if not template:
        raise HTTPException(status_code=404, detail="模板不存在")

    if template.is_builtin:
        raise HTTPException(status_code=403, detail="不能删除内置模板")

    await db.delete(template)
    await db.commit()

    return {"success": True, "message": "模板已删除"}


@router.post("/{template_id}/apply/{resume_id}")
async def apply_template(
    template_id: int,
    resume_id: int,
    db: AsyncSession = Depends(get_db)
):
    """
    将模板应用到简历
    ────────────────────────────────────────────
    更新简历的 template_id，前端会根据模板的 CSS 变量重新渲染。
    """
    # 检查模板是否存在
    template_result = await db.execute(
        select(ResumeTemplate).where(ResumeTemplate.id == template_id)
    )
    template = template_result.scalar_one_or_none()
    if not template:
        raise HTTPException(status_code=404, detail="模板不存在")

    # 检查简历是否存在
    resume_result = await db.execute(
        select(Resume).where(Resume.id == resume_id)
    )
    resume = resume_result.scalar_one_or_none()
    if not resume:
        raise HTTPException(status_code=404, detail="简历不存在")

    # 应用模板
    resume.template_id = template_id
    # 清空用户的样式覆盖，使用模板默认样式
    resume.style_config = {}

    await db.commit()

    return {
        "success": True,
        "message": f"已将模板 '{template.name}' 应用到简历",
        "template_id": template_id,
    }


@router.post("/{template_id}/duplicate")
async def duplicate_template(
    template_id: int,
    new_name: str,
    db: AsyncSession = Depends(get_db)
):
    """
    复制模板
    ────────────────────────────────────────────
    用户可以复制内置模板并修改为自己的版本。
    """
    result = await db.execute(
        select(ResumeTemplate).where(ResumeTemplate.id == template_id)
    )
    template = result.scalar_one_or_none()
    if not template:
        raise HTTPException(status_code=404, detail="模板不存在")

    # 创建副本
    new_template = ResumeTemplate(
        name=new_name,
        thumbnail_url=template.thumbnail_url,
        css_variables=template.css_variables.copy(),
        html_layout=template.html_layout,
        is_builtin=False,  # 复制的模板始终是自定义模板
    )
    db.add(new_template)
    await db.commit()
    await db.refresh(new_template)

    return {
        "id": new_template.id,
        "name": new_template.name,
        "thumbnail_url": new_template.thumbnail_url,
        "css_variables": new_template.css_variables,
        "is_builtin": new_template.is_builtin,
        "created_at": new_template.created_at.isoformat(),
    }
