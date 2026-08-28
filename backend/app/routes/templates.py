# =============================================
# 简历模板管理 API
# =============================================
# 模板市场：浏览、预览、应用内置和自定义模板
# =============================================

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel, Field
from typing import Optional

from app.database import get_db
from app.models.models import ResumeTemplate, Resume

router = APIRouter()


async def _execute_operation(name: str, args: dict[str, Any]) -> Any:
    from app.ops import execute_operation

    result = await execute_operation(name, args, surface="templates_api")
    if not result.get("ok"):
        message = "；".join(str(item) for item in result.get("errors") or [])
        lowered = message.lower()
        if "不存在" in message or "not found" in lowered:
            status = 404
        elif "不能" in message or "forbidden" in lowered:
            status = 403
        else:
            status = 400
        raise HTTPException(status_code=status, detail=message or "操作失败")
    return result.get("outputs")


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
):
    """
    创建自定义模板
    ────────────────────────────────────────────
    用户可以创建自己的简历模板，定义 CSS 变量和 HTML 布局。
    """
    return await _execute_operation("create_resume_template", body.model_dump())


@router.put("/{template_id}")
async def update_template(
    template_id: int,
    body: TemplateUpdate,
):
    """
    更新模板
    ────────────────────────────────────────────
    只能更新非内置模板。
    """
    return await _execute_operation(
        "update_resume_template",
        {"template_id": template_id, **body.model_dump(exclude_unset=True)},
    )


@router.delete("/{template_id}")
async def delete_template(
    template_id: int,
):
    """
    删除模板
    ────────────────────────────────────────────
    只能删除非内置模板。
    """
    return await _execute_operation("delete_resume_template", {"template_id": template_id})


@router.post("/{template_id}/apply/{resume_id}")
async def apply_template(
    template_id: int,
    resume_id: int,
):
    """
    将模板应用到简历
    ────────────────────────────────────────────
    更新简历的 template_id，前端会根据模板的 CSS 变量重新渲染。
    """
    return await _execute_operation(
        "apply_resume_template",
        {"template_id": template_id, "resume_id": resume_id},
    )


@router.post("/{template_id}/duplicate")
async def duplicate_template(
    template_id: int,
    new_name: str,
):
    """
    复制模板
    ────────────────────────────────────────────
    用户可以复制内置模板并修改为自己的版本。
    """
    return await _execute_operation(
        "duplicate_resume_template",
        {"template_id": template_id, "new_name": new_name},
    )
