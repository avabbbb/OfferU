# =============================================
# Resume 路由 — 简历管理 API（v2 重构版）
# =============================================
# 完整 CRUD + 段落管理 + 文件上传 + PDF 导出
# =============================================
# 数据模型：
#   Resume         → 简历主表（元信息 + 样式配置）
#   ResumeSection  → 段落通用块表（教育/经历/技能/项目/自定义）
#   ResumeTemplate → 模板表（CSS 变量 + HTML 布局）
# =============================================
# API 端点概览：
#   GET    /api/resume/                            获取简历列表
#   POST   /api/resume/                            创建新简历
#   GET    /api/resume/templates                   模板列表
#   GET    /api/resume/{id}                        获取完整简历（含所有段落）
#   PUT    /api/resume/{id}                        更新简历（可选 sections 全量同步）
#   DELETE /api/resume/{id}                        删除简历（级联删段落）
#   POST   /api/resume/{id}/sections               添加段落
#   PUT    /api/resume/{id}/sections/{sid}          更新段落
#   DELETE /api/resume/{id}/sections/{sid}          删除段落
#   PUT    /api/resume/{id}/sections/reorder        段落排序
#   POST   /api/resume/{id}/photo                  上传头像
#   POST   /api/resume/{id}/export/pdf             导出 PDF
#   POST   /api/resume/parse                       解析 PDF/Word 简历文件（提取文本）
# =============================================

from __future__ import annotations

import base64
import os
import time
import threading
from pathlib import Path

import re
import uuid
from io import BytesIO
from typing import Optional, Any
from urllib.parse import quote
from xml.sax.saxutils import escape as xml_escape

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
import anyio
import httpx
from pydantic import BaseModel, Field
from jinja2 import Template
from sse_starlette import EventSourceResponse, ServerSentEvent

from app.database import get_db
from app.models.models import Resume, ResumeSection, ResumeTemplate, Job, Profile
from app.services.application_workspace import auto_write_job_to_total
from app.services.security_redaction import safe_error_message

router = APIRouter()


async def _execute_operation(name: str, args: dict[str, Any]) -> Any:
    from app.ops import execute_operation

    result = await execute_operation(name, args, surface="resume_api")
    if not result.get("ok"):
        message = "；".join(str(item) for item in result.get("errors") or [])
        lowered = message.lower()
        if "not found" in lowered or "不存在" in message or "未找到" in message:
            status = 404
        elif "密码" in message or "需要密码" in message:
            status = 401
        elif "过期" in message or "禁用" in message:
            status = 403
        else:
            status = 400
        raise HTTPException(status_code=status, detail=message or "操作失败")
    return result.get("outputs")

FRONTEND_BASE_URL = os.getenv("FRONTEND_BASE_URL", "http://127.0.0.1:7410").rstrip("/")
_EXPORT_IMAGE_CACHE_TTL_SECONDS = 120
_EXPORT_IMAGE_CACHE_MAX_ENTRIES = 8
_export_image_cache: dict[tuple[int, str, str], tuple[float, bytes]] = {}
_export_image_cache_lock = threading.Lock()


# =============================================
# Pydantic 请求/响应模型
# =============================================
# 严格定义 API 的输入输出结构，
# 前端按此契约传参，后端做类型校验。
# =============================================


class ResumeCreate(BaseModel):
    """创建简历的请求体"""
    user_name: str = ""
    title: str = "未命名简历"
    summary: str = ""
    contact_json: dict = Field(default_factory=dict)
    template_id: Optional[int] = None
    style_config: dict = Field(default_factory=dict)
    language: str = "zh"
    source_mode: str = "manual"
    source_job_ids: list[int] = Field(default_factory=list)
    source_profile_snapshot: dict = Field(default_factory=dict)
    source_resume_id: Optional[int] = None
    target_job_id: Optional[int] = None
    application_id: Optional[int] = None


class ResumeSectionInput(BaseModel):
    """PUT /api/resume/{id} 体内 sections 数组的单元素。"""
    id: Optional[int] = None
    section_type: str
    sort_order: int = 0
    title: str = ""
    visible: bool = True
    content_json: list = Field(default_factory=list)
    source_section_ids: Optional[list[int]] = None


class ResumeUpdate(BaseModel):
    """更新简历的请求体（所有字段可选）。

    传 sections 时走「按 id diff」同步：有 id 且匹配 → 更新；无 id → 新建；
    请求中缺失的旧 section → 删除。一次 PUT 完成全量段落同步，免去多端点往返。
    """
    user_name: Optional[str] = None
    title: Optional[str] = None
    summary: Optional[str] = None
    contact_json: Optional[dict] = None
    template_id: Optional[int] = None
    style_config: Optional[dict] = None
    is_primary: Optional[bool] = None
    language: Optional[str] = None
    source_mode: Optional[str] = None
    source_job_ids: Optional[list[int]] = None
    source_profile_snapshot: Optional[dict] = None
    source_resume_id: Optional[int] = None
    target_job_id: Optional[int] = None
    application_id: Optional[int] = None
    sections: Optional[list[ResumeSectionInput]] = None


class SectionCreate(BaseModel):
    """创建段落的请求体"""
    section_type: str  # education / workExperiences / internshipExperiences / projects / skills / certificates / awards / personalExperiences
    title: str = ""
    sort_order: int = 0
    visible: bool = True
    content_json: list = Field(default_factory=list)


class SectionUpdate(BaseModel):
    """更新段落的请求体（所有字段可选）"""
    title: Optional[str] = None
    sort_order: Optional[int] = None
    visible: Optional[bool] = None
    content_json: Optional[list] = None


class ReorderItem(BaseModel):
    """排序请求中的单个条目"""
    id: int
    sort_order: int


class SectionReorder(BaseModel):
    """段落排序请求体"""
    items: list[ReorderItem]


class LogoResolveRequest(BaseModel):
    """Resolve a university logo from an online source."""
    school_name: str = Field(..., min_length=1, max_length=120)


# =============================================
# 辅助函数
# =============================================


def _serialize_resume_brief(r: Resume, source_jobs_map: dict[int, dict] | None = None) -> dict:
    """序列化简历列表项（不含段落详情）"""
    source_ids = _normalize_source_job_ids(r.source_job_ids)
    source_jobs = _source_jobs_from_map(source_ids, source_jobs_map)
    return {
        "id": r.id,
        "user_name": r.user_name,
        "title": r.title,
        "photo_url": r.photo_url,
        "template_id": r.template_id,
        "is_primary": r.is_primary,
        "language": r.language,
        "source_mode": r.source_mode,
        "source_job_ids": source_ids,
        "source_jobs": source_jobs,
        "source_profile_snapshot": r.source_profile_snapshot or {},
        "source_profile_id": r.source_profile_id,
        "source_resume_id": r.source_resume_id,
        "target_job_id": r.target_job_id,
        "application_id": r.application_id,
        "current_version_id": r.current_version_id,
        "workspace_revision": r.workspace_revision,
        "created_at": str(r.created_at),
        "updated_at": str(r.updated_at),
    }


def _serialize_section(s: ResumeSection) -> dict:
    """序列化单个段落"""
    return {
        "id": s.id,
        "resume_id": s.resume_id,
        "section_type": s.section_type,
        "sort_order": s.sort_order,
        "title": s.title,
        "visible": s.visible,
        "content_json": s.content_json,
    }


def _normalize_source_job_ids(source_job_ids: Any) -> list[int]:
    if not isinstance(source_job_ids, list):
        return []
    normalized: list[int] = []
    for item in source_job_ids:
        if isinstance(item, int) and item > 0:
            normalized.append(item)
            continue
        if isinstance(item, str) and item.isdigit():
            normalized.append(int(item))
    return normalized


def _source_jobs_from_map(source_ids: list[int], source_jobs_map: dict[int, dict] | None) -> list[dict]:
    if not source_jobs_map:
        return []
    return [source_jobs_map[job_id] for job_id in source_ids if job_id in source_jobs_map]


async def _load_source_jobs_map(db: AsyncSession, source_job_ids: list[int]) -> dict[int, dict]:
    if not source_job_ids:
        return {}
    result = await db.execute(select(Job).where(Job.id.in_(source_job_ids)))
    jobs = result.scalars().all()
    return {
        job.id: {
            "id": job.id,
            "title": job.title,
            "company": job.company,
        }
        for job in jobs
    }


def _serialize_resume_full(r: Resume, source_jobs_map: dict[int, dict] | None = None) -> dict:
    """
    序列化完整简历（含所有段落），用于编辑器页面。
    前端根据此结构渲染左侧编辑区和右侧 A4 预览。
    """
    source_ids = _normalize_source_job_ids(r.source_job_ids)
    source_jobs = _source_jobs_from_map(source_ids, source_jobs_map)
    return {
        "id": r.id,
        "user_name": r.user_name,
        "title": r.title,
        "photo_url": r.photo_url,
        "summary": r.summary,
        "contact_json": r.contact_json,
        "template_id": r.template_id,
        "style_config": r.style_config,
        "is_primary": r.is_primary,
        "language": r.language,
        "source_mode": r.source_mode,
        "source_job_ids": source_ids,
        "source_jobs": source_jobs,
        "source_profile_snapshot": r.source_profile_snapshot or {},
        "source_profile_id": r.source_profile_id,
        "source_resume_id": r.source_resume_id,
        "target_job_id": r.target_job_id,
        "application_id": r.application_id,
        "current_version_id": r.current_version_id,
        "workspace_revision": r.workspace_revision,
        "sections": [_serialize_section(s) for s in r.sections],
        "created_at": str(r.created_at),
        "updated_at": str(r.updated_at),
    }


async def _get_resume_or_404(
    resume_id: int, db: AsyncSession, *, load_sections: bool = False
) -> Resume:
    """
    根据 ID 获取简历，不存在则抛 404。
    load_sections=True 时 eager load 段落列表，避免 N+1 查询。
    """
    stmt = select(Resume).where(Resume.id == resume_id)
    if load_sections:
        stmt = stmt.options(selectinload(Resume.sections))
    result = await db.execute(stmt)
    resume = result.scalar_one_or_none()
    if not resume:
        raise HTTPException(status_code=404, detail="Resume not found")
    return resume


# =============================================
# 简历 CRUD 端点
# =============================================


@router.get("/")
async def list_resumes(db: AsyncSession = Depends(get_db)):
    """获取所有简历（列表概览，不含段落详情）"""
    result = await db.execute(select(Resume).order_by(Resume.updated_at.desc()))
    resumes = result.scalars().all()
    source_job_ids = sorted({
        job_id
        for resume in resumes
        for job_id in _normalize_source_job_ids(resume.source_job_ids)
    })
    source_jobs_map = await _load_source_jobs_map(db, source_job_ids)
    return [_serialize_resume_brief(r, source_jobs_map) for r in resumes]


@router.post("/")
async def create_resume(data: ResumeCreate):
    """
    创建新简历
    ─────────────────────────────────────────────
    流程：
    1. 根据请求体创建 Resume 主记录
    2. 自动创建默认段落（教育、经历、技能），方便用户直接编辑
    3. 返回完整简历（含段落）
    """
    return await _execute_operation("create_resume_record", data.model_dump())


@router.get("/templates")
async def list_templates(db: AsyncSession = Depends(get_db)):
    """获取所有可用模板"""
    result = await db.execute(select(ResumeTemplate).order_by(ResumeTemplate.id))
    templates = result.scalars().all()
    return [
        {
            "id": t.id,
            "name": t.name,
            "thumbnail_url": t.thumbnail_url,
            "css_variables": t.css_variables,
            "is_builtin": t.is_builtin,
        }
        for t in templates
    ]


class ResumeWorkspaceEnsureRequest(BaseModel):
    job_id: int = Field(..., gt=0)
    proposal_id: Optional[str] = Field(default=None, min_length=1, max_length=80)
    reference_resume_id: Optional[int] = Field(default=None, gt=0)


class ResumeProposalItemReviewRequest(BaseModel):
    resume_id: int = Field(..., gt=0)
    change_id: str = Field(..., min_length=1, max_length=120)
    action: str = Field(..., pattern="^(accept|reject)$")
    edited_text: str = Field(default="", max_length=20_000)


@router.get("/workspace/{resume_id}")
async def get_resume_workspace(resume_id: int):
    return await _execute_operation("get_resume_workspace", {"resume_id": resume_id})


@router.post("/workspace/ensure")
async def ensure_resume_workspace(body: ResumeWorkspaceEnsureRequest):
    return await _execute_operation(
        "ensure_resume_workspace",
        body.model_dump(exclude_none=True),
    )


@router.post("/workspace/proposals/{proposal_id}/review-item")
async def review_resume_proposal_item(
    proposal_id: str,
    body: ResumeProposalItemReviewRequest,
):
    return await _execute_operation(
        "review_resume_proposal_item",
        {"proposal_id": proposal_id, **body.model_dump()},
    )


@router.post("/{resume_id}/apply-template/{template_id}")
async def apply_template(resume_id: int, template_id: int):
    """
    应用模板到简历 — 将模板的 css_variables 合并到简历的 style_config
    关联 template_id 到简历，并用模板的 CSS 变量覆盖当前样式
    """
    return await _execute_operation(
        "apply_resume_record_template",
        {"template_id": template_id, "resume_id": resume_id},
    )


@router.get("/{resume_id}")
async def get_resume(resume_id: int, db: AsyncSession = Depends(get_db)):
    """获取完整简历详情（含所有段落），用于编辑器页面"""
    resume = await _get_resume_or_404(resume_id, db, load_sections=True)
    source_jobs_map = await _load_source_jobs_map(db, _normalize_source_job_ids(resume.source_job_ids))
    return _serialize_resume_full(resume, source_jobs_map)


@router.put("/{resume_id}")
async def update_resume(resume_id: int, data: ResumeUpdate):
    """
    更新简历主信息（含可选段落全量同步）。
    ─────────────────────────────────────────────
    · 顶层字段：只更新非 None 字段（PATCH 语义）。
    · sections：传非 None 时按 id diff 同步：
        - 有 id 且命中已有 section → 更新字段
        - 无 id → 新建 section
        - 已有但请求中缺失 id 的 section → 删除
      一次 PUT 完成段落全量同步，Puck onPublish 用此一处即可。
    """
    return await _execute_operation(
        "update_resume_record",
        {"resume_id": resume_id, "update_data": data.model_dump(exclude_none=True)},
    )


@router.delete("/{resume_id}")
async def delete_resume(resume_id: int):
    """删除简历（ORM cascade 自动删除关联段落）"""
    return await _execute_operation("delete_resume_record", {"resume_id": resume_id})


# =============================================
# 段落 CRUD 端点
# =============================================


# 注意：静态路径段（reorder）必须注册在动态段（{section_id}）之前，
# 否则 FastAPI 按注册顺序匹配会把 "reorder" 当作 section_id 导致 422。
@router.put("/{resume_id}/sections/reorder")
async def reorder_sections(resume_id: int, data: SectionReorder):
    """
    批量更新段落排序
    ─────────────────────────────────────────────
    前端拖拽排序后，一次性提交所有段落的新 sort_order。
    """
    return await _execute_operation(
        "reorder_resume_sections",
        {"resume_id": resume_id, "items": [item.model_dump() for item in data.items]},
    )


@router.post("/{resume_id}/sections")
async def create_section(resume_id: int, data: SectionCreate):
    """向指定简历添加一个新段落"""
    return await _execute_operation(
        "create_resume_section",
        {"resume_id": resume_id, **data.model_dump()},
    )


@router.put("/{resume_id}/sections/{section_id}")
async def update_section(
    resume_id: int,
    section_id: int,
    data: SectionUpdate,
):
    """更新指定段落（只更新非 None 字段）"""
    return await _execute_operation(
        "update_resume_section",
        {
            "resume_id": resume_id,
            "section_id": section_id,
            "update_data": data.model_dump(exclude_none=True),
        },
    )


@router.delete("/{resume_id}/sections/{section_id}")
async def delete_section(resume_id: int, section_id: int):
    """删除指定段落"""
    return await _execute_operation(
        "delete_resume_section",
        {"resume_id": resume_id, "section_id": section_id},
    )


# =============================================
# 文件上传端点
# =============================================

# 头像存储目录（后端本地），生产环境可替换为云存储
BACKEND_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
)

UPLOAD_DIR = os.path.join(
    BACKEND_DIR,
    "uploads", "photos",
)

LOGO_UPLOAD_DIR = os.path.join(
    BACKEND_DIR,
    "uploads", "logos",
)


def _image_extension(content_type: str | None) -> str:
    ext_by_type = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
    }
    if content_type not in ext_by_type:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type: {content_type}",
        )
    return ext_by_type[content_type]


async def _read_upload_image(file: UploadFile, *, max_bytes: int = 5 * 1024 * 1024) -> tuple[bytes, str]:
    ext = _image_extension(file.content_type)
    contents = await file.read()
    if len(contents) > max_bytes:
        raise HTTPException(status_code=400, detail="File too large (max 5MB)")
    return contents, ext


def _commons_file_url(filename: str) -> str:
    return f"https://commons.wikimedia.org/wiki/Special:FilePath/{quote(filename)}"


async def _resolve_university_logo_url(school_name: str) -> dict[str, str]:
    name = school_name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="School name is required")

    headers = {"User-Agent": "OfferU/0.1 university-logo-resolver"}
    async with httpx.AsyncClient(timeout=15, follow_redirects=True, headers=headers) as client:
        wiki_response = await client.get(
            "https://zh.wikipedia.org/w/api.php",
            params={
                "action": "query",
                "generator": "search",
                "gsrsearch": name,
                "gsrlimit": 5,
                "prop": "pageimages|pageprops",
                "piprop": "original",
                "format": "json",
            },
        )
        wiki_response.raise_for_status()
        pages = (wiki_response.json().get("query") or {}).get("pages") or {}
        sorted_pages = sorted(pages.values(), key=lambda page: page.get("index", 999))
        for page in sorted_pages:
            title = str(page.get("title") or "")
            if "大学" not in title and "学院" not in title and name not in title:
                continue
            page_image = (page.get("pageprops") or {}).get("page_image")
            if page_image:
                return {
                    "logo_url": _commons_file_url(page_image),
                    "school_name": name,
                    "source": "zh.wikipedia.page_image",
                    "matched_title": title,
                }
            original = page.get("original") or {}
            if original.get("source"):
                return {
                    "logo_url": original["source"],
                    "school_name": name,
                    "source": "zh.wikipedia.original",
                    "matched_title": title,
                }

        wikidata_response = await client.get(
            "https://www.wikidata.org/w/api.php",
            params={
                "action": "wbsearchentities",
                "search": name,
                "language": "zh",
                "format": "json",
                "limit": 5,
            },
        )
        wikidata_response.raise_for_status()
        for item in wikidata_response.json().get("search", []):
            description = str(item.get("description") or "").lower()
            label = str(item.get("label") or "")
            if "university" not in description and "大学" not in label and "学院" not in label:
                continue
            entity_id = item.get("id")
            if not entity_id:
                continue
            entity_response = await client.get(f"https://www.wikidata.org/wiki/Special:EntityData/{entity_id}.json")
            entity_response.raise_for_status()
            entity = entity_response.json().get("entities", {}).get(entity_id, {})
            claims = entity.get("claims", {})
            for prop in ("P154", "P18"):
                for claim in claims.get(prop, []):
                    value = (((claim or {}).get("mainsnak") or {}).get("datavalue") or {}).get("value")
                    if isinstance(value, str) and value:
                        return {
                            "logo_url": _commons_file_url(value),
                            "school_name": name,
                            "source": f"wikidata.{prop}",
                            "matched_title": label,
                        }

    raise HTTPException(status_code=404, detail=f"Logo not found for school: {name}")


@router.post("/{resume_id}/photo")
async def upload_photo(
    resume_id: int,
    file: UploadFile = File(...),
):
    """
    上传简历头像
    ─────────────────────────────────────────────
    流程：
    1. 校验文件类型（仅允许 JPEG/PNG/WebP）
    2. 限制文件大小（最大 5MB）
    3. 生成唯一文件名，写入本地 uploads/photos 目录
    4. 更新 resume.photo_url 为相对路径
    5. 返回可访问的 URL
    """
    # 安全校验：只允许图片类型
    allowed_types = {"image/jpeg", "image/png", "image/webp"}
    if file.content_type not in allowed_types:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type: {file.content_type}",
        )

    # 限制文件大小（5MB）
    contents = await file.read()
    if len(contents) > 5 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File too large (max 5MB)")

    return await _execute_operation(
        "upload_resume_photo",
        {
            "resume_id": resume_id,
            "content_b64": base64.b64encode(contents).decode("ascii"),
            "content_type": file.content_type,
        },
    )


@router.post("/{resume_id}/logo")
async def upload_logo(
    resume_id: int,
    file: UploadFile = File(...),
):
    """
    Upload a university logo and store its relative URL in contact_json.schoolLogoUrl.
    """
    contents, _ = await _read_upload_image(file)
    return await _execute_operation(
        "upload_resume_logo",
        {
            "resume_id": resume_id,
            "content_b64": base64.b64encode(contents).decode("ascii"),
            "content_type": file.content_type,
        },
    )


@router.post("/{resume_id}/logo/resolve")
async def resolve_logo(
    resume_id: int,
    payload: LogoResolveRequest,
):
    """
    Resolve a university logo by school name and store it in contact_json.schoolLogoUrl.
    """
    return await _execute_operation(
        "resolve_resume_logo",
        {"resume_id": resume_id, "school_name": payload.school_name},
    )


# =============================================
# PDF 导出
# =============================================
# 流程：
#   1. 从 DB 读取简历 + 段落 + 模板
#   2. 合并模板 css_variables 与用户 style_config
#   3. 使用 Jinja2 渲染 HTML
#   4. WeasyPrint 将 HTML → PDF
#   5. StreamingResponse 返回二进制流
# =============================================

# 默认 HTML 模板：Reference 风格（照片+姓名+校徽三栏头部，黑色正文横线分区）
# 与前端 ResumeReference 模板视觉一致，用于 WeasyPrint/ReportLab fallback
DEFAULT_HTML_TEMPLATE = Template("""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
    :root {
        --primary-color: {{ primary_color }};
        --accent-color: {{ accent_color }};
        --body-size: {{ body_size }};
        --heading-size: {{ heading_size }};
        --line-height: {{ line_height }};
        --page-margin: {{ page_margin }};
        --section-gap: {{ section_gap }};
        --font-family: {{ font_family }};
    }

    @page {
        size: A4;
        margin: 0;
    }

    html, body {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        background: #ffffff;
    }

    body {
        font-family: var(--font-family);
        font-size: var(--body-size);
        line-height: var(--line-height);
        color: #000000;
        background: #ffffff;
    }

    .page {
        width: 210mm;
        min-height: 297mm;
        padding: var(--page-margin);
        box-sizing: border-box;
    }

    /* ── Header: photo + name/contact + logo ── */
    .header {
        display: flex;
        align-items: flex-start;
        min-height: 30mm;
        margin-bottom: 6mm;
    }

    .photo-slot {
        flex-shrink: 0;
        width: 23mm;
        min-height: 30mm;
        margin-right: 2mm;
    }

    .photo-slot img {
        display: block;
        width: 23mm;
        height: 30mm;
        object-fit: cover;
        object-position: center top;
    }

    .identity {
        flex: 1;
        min-width: 0;
    }

    .name {
        font-size: 20pt;
        font-weight: 800;
        letter-spacing: 0;
        line-height: 1.05;
        margin: 0 0 4mm;
        color: #000000;
    }

    .contact-lines {
        font-size: 11.5pt;
        font-weight: 400;
        line-height: 1.38;
        color: #000000;
    }

    .contact-lines p {
        margin: 0;
    }

    .logo-slot {
        flex-shrink: 0;
        margin-left: 4mm;
        max-width: 50mm;
        display: flex;
        align-items: flex-start;
        justify-content: flex-end;
        min-height: 22mm;
    }

    .logo-slot img {
        display: block;
        max-height: 18mm;
        max-width: 50mm;
        object-fit: contain;
    }

    /* ── Sections ── */
    .section {
        margin-top: 6mm;
    }

    .section-title {
        border-bottom: 1.2pt solid #000000;
        font-size: 15pt;
        font-weight: 800;
        line-height: 1.15;
        margin: 0 0 3mm;
        padding-bottom: 1mm;
        color: #000000;
    }

    .section-body {
        display: flex;
        flex-direction: column;
        gap: 2.4mm;
    }

    /* ── Entry items ── */
    .entry {
        break-inside: avoid;
    }

    .entry-row {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 4mm;
    }

    .entry-main {
        font-size: 11.5pt;
        line-height: 1.35;
        min-width: 0;
    }

    .entry-main strong {
        font-weight: 800;
    }

    .entry-date {
        font-size: 11.5pt;
        line-height: 1.35;
        text-align: right;
        white-space: nowrap;
        flex-shrink: 0;
    }

    .entry-sub {
        font-size: 11pt;
        margin-top: 1mm;
    }

    .entry-desc {
        font-size: 11pt;
        margin-top: 1mm;
    }

    .entry-desc ul {
        list-style-type: disc;
        margin: 1mm 0 0;
        padding-left: 6mm;
    }

    .entry-desc li {
        margin: 0 0 1mm;
        padding-left: 0.5mm;
    }

    .tags {
        display: flex;
        flex-wrap: wrap;
        gap: 1.5mm;
        margin-top: 1.4mm;
        font-size: 11pt;
    }

    .tags span {
        border-radius: 2px;
        padding: 0 1.5mm;
    }

    .summary-text {
        font-size: 11pt;
        margin: 0;
    }
</style>
</head>
<body>
    <div class="page">
        <div class="header">
            {% if photo_url %}
            <div class="photo-slot">
                <img src="{{ photo_url }}" />
            </div>
            {% endif %}
            <div class="identity">
                <div class="name">{{ name }}</div>
                <div class="contact-lines">
                    {% if contact_phone or contact_email %}
                    <p>
                        {% if contact_phone %}电话：{{ contact_phone }}{% endif %}
                        {% if contact_phone and contact_email %} | {% endif %}
                        {% if contact_email %}邮箱：{{ contact_email }}{% endif %}
                    </p>
                    {% endif %}
                    {% if contact_website %}
                    <p>个人网站：{{ contact_website }}</p>
                    {% endif %}
                    {% if contact_age or contact_gender or contact_native_place %}
                    <p>
                        {% if contact_age %}年龄：{{ contact_age }}{% endif %}
                        {% if contact_age and (contact_gender or contact_native_place) %} | {% endif %}
                        {% if contact_gender %}性别：{{ contact_gender }}{% endif %}
                        {% if contact_gender and contact_native_place %} | {% endif %}
                        {% if contact_native_place %}籍贯：{{ contact_native_place }}{% endif %}
                    </p>
                    {% endif %}
                    {% if contact_status %}
                    <p>当前状态：{{ contact_status }}</p>
                    {% endif %}
                </div>
            </div>
            {% if logo_url %}
            <div class="logo-slot">
                <img src="{{ logo_url }}" />
            </div>
            {% endif %}
        </div>

        {% if summary %}
        <div class="section">
            <div class="section-title">个人评价</div>
            <div class="summary-text">{{ summary }}</div>
        </div>
        {% endif %}

        {% for section in sections %}
        {% if section.visible %}
        <div class="section">
            <div class="section-title">{{ section.title }}</div>
            <div class="section-body">
                {% if section.section_type == "education" %}
                    {% for item in section.content_json %}
                    <div class="entry">
                        <div class="entry-row">
                            <div class="entry-main"><strong>{{ item.school }}{% if item.degree %} — {{ item.degree }}{% endif %}{% if item.major %}, {{ item.major }}{% endif %}</strong></div>
                            {% if item.startDate or item.endDate %}
                            <div class="entry-date">{{ item.startDate }}{% if item.endDate %} - {{ item.endDate }}{% endif %}</div>
                            {% endif %}
                        </div>
                        {% if item.gpa %}<div class="entry-sub">GPA: {{ item.gpa }}</div>{% endif %}
                        {% if item.description %}<div class="entry-desc">{{ item.description }}</div>{% endif %}
                    </div>
                    {% endfor %}

                {% elif section.section_type == "workExperiences" or section.section_type == "internshipExperiences" %}
                    {% for item in section.content_json %}
                    <div class="entry">
                        <div class="entry-row">
                            <div class="entry-main"><strong>{{ item.position }}{% if item.company %} @ {{ item.company }}{% endif %}</strong></div>
                            {% if item.startDate or item.endDate %}
                            <div class="entry-date">{{ item.startDate }}{% if item.endDate %} - {{ item.endDate }}{% endif %}</div>
                            {% endif %}
                        </div>
                        {% if item.description %}<div class="entry-desc">{{ item.description }}</div>{% endif %}
                    </div>
                    {% endfor %}

                {% elif section.section_type == "projects" %}
                    {% for item in section.content_json %}
                    <div class="entry">
                        <div class="entry-row">
                            <div class="entry-main"><strong>{{ item.name }}{% if item.role %} — {{ item.role }}{% endif %}</strong></div>
                            {% if item.startDate or item.endDate %}
                            <div class="entry-date">{{ item.startDate }}{% if item.endDate %} - {{ item.endDate }}{% endif %}</div>
                            {% endif %}
                        </div>
                        {% if item.url %}<div class="entry-sub">{{ item.url }}</div>{% endif %}
                        {% if item.description %}<div class="entry-desc">{{ item.description }}</div>{% endif %}
                    </div>
                    {% endfor %}

                {% elif section.section_type == "skills" %}
                    {% for item in section.content_json %}
                    <div class="entry">
                        {% if item.category %}
                        <div class="entry-main"><strong>{{ item.category }}</strong></div>
                        {% endif %}
                        {% if item.items %}
                        <div class="tags">
                            {% for s in item.items %}
                            <span>{{ s }}</span>
                            {% endfor %}
                        </div>
                        {% endif %}
                    </div>
                    {% endfor %}

                {% elif section.section_type == "certificates" %}
                    {% for item in section.content_json %}
                    <div class="entry">
                        <div class="entry-row">
                            <div class="entry-main"><strong>{{ item.name }}{% if item.issuer %} — {{ item.issuer }}{% endif %}</strong></div>
                            {% if item.date %}<div class="entry-date">{{ item.date }}</div>{% endif %}
                        </div>
                        {% if item.url %}<div class="entry-sub">{{ item.url }}</div>{% endif %}
                    </div>
                    {% endfor %}

                {% elif section.section_type == "awards" %}
                    {% for item in section.content_json %}
                    <div class="entry">
                        <div class="entry-row">
                            <div class="entry-main"><strong>{{ item.awardName }}{% if item.issuer %} — {{ item.issuer }}{% endif %}</strong></div>
                            {% if item.awardedAt %}<div class="entry-date">{{ item.awardedAt }}</div>{% endif %}
                        </div>
                        {% if item.description %}<div class="entry-desc">{{ item.description }}</div>{% endif %}
                    </div>
                    {% endfor %}

                {% elif section.section_type == "personalExperiences" %}
                    {% for item in section.content_json %}
                    <div class="entry">
                        {% if item.experienceTitle %}<div class="entry-main"><strong>{{ item.experienceTitle }}</strong></div>{% endif %}
                        {% if item.startDate or item.endDate %}
                        <div class="entry-sub">{{ item.startDate }}{% if item.endDate %} - {{ item.endDate }}{% endif %}</div>
                        {% endif %}
                        {% if item.description %}<div class="entry-desc">{{ item.description }}</div>{% endif %}
                    </div>
                    {% endfor %}

                {% else %}
                    {% for item in section.content_json %}
                    <div class="entry">
                        {% if item.subtitle or item.title %}<div class="entry-main"><strong>{{ item.subtitle or item.title }}</strong></div>{% endif %}
                        {% if item.description %}<div class="entry-desc">{{ item.description }}</div>{% endif %}
                    </div>
                    {% endfor %}
                {% endif %}
            </div>
        </div>
        {% endif %}
        {% endfor %}
    </div>
</body>
</html>
""")

# 默认 CSS 变量值（用户未自定义时使用）
DEFAULT_STYLE = {
    "primaryColor": "#222222",
    "accentColor": "#666666",
    "bodySize": "10pt",
    "headingSize": "12pt",
    "lineHeight": "1.5",
    "pageMargin": "2cm",
    "sectionGap": "14pt",
    "fontFamily": '"Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif',
}


def _resolve_photo_url_for_render(photo_url: str) -> str:
    """
    将 /uploads/... 相对路径转换为本地 file:// URI，方便 WeasyPrint 读取头像。
    """
    if not photo_url:
        return ""

    if photo_url.startswith("/uploads/"):
        local_path = os.path.join(BACKEND_DIR, photo_url.lstrip("/"))
        if os.path.exists(local_path):
            return Path(local_path).as_uri()

    return photo_url


def _build_contact_line(contact_json: Optional[dict]) -> str:
    c = contact_json or {}
    contact_parts = [
        c.get("phone", ""),
        c.get("email", ""),
        c.get("linkedin", ""),
        c.get("website", ""),
    ]
    return " · ".join(str(p).strip() for p in contact_parts if str(p).strip())


def _resolve_logo_url_for_render(contact_json: Optional[dict]) -> str:
    """从 contact_json 中提取校徽 URL 并转换为本地 file:// URI。"""
    c = contact_json or {}
    for key in ("schoolLogoUrl", "universityLogoUrl", "logoUrl", "school_logo_url"):
        url = c.get(key, "")
        if url:
            return _resolve_photo_url_for_render(url)
    return ""


def _serialize_export_sections(resume: Resume) -> list[dict]:
    return [
        {
            "title": s.title,
            "section_type": s.section_type,
            "visible": s.visible,
            "content_json": s.content_json or [],
        }
        for s in resume.sections
    ]


async def _resolve_export_style(resume: Resume, db: AsyncSession) -> dict:
    """
    合并样式优先级：默认 < 模板 < 用户覆盖。
    """
    style = {**DEFAULT_STYLE}

    if resume.template_id:
        tpl_result = await db.execute(
            select(ResumeTemplate).where(ResumeTemplate.id == resume.template_id)
        )
        tpl = tpl_result.scalar_one_or_none()
        if tpl and tpl.css_variables:
            style.update(tpl.css_variables)

    if resume.style_config:
        style.update(resume.style_config)

    return style


async def _render_resume_html_for_export(resume: Resume, db: AsyncSession) -> str:
    style = await _resolve_export_style(resume, db)
    c = resume.contact_json or {}

    return DEFAULT_HTML_TEMPLATE.render(
        name=resume.user_name,
        photo_url=_resolve_photo_url_for_render(resume.photo_url or ""),
        logo_url=_resolve_logo_url_for_render(resume.contact_json),
        contact_phone=c.get("phone", ""),
        contact_email=c.get("email", ""),
        contact_website=c.get("website", "") or c.get("personalWebsite", "") or c.get("homepage", "") or c.get("github", "") or c.get("linkedin", ""),
        contact_age=c.get("age", ""),
        contact_gender=c.get("gender", "") or c.get("sex", ""),
        contact_native_place=c.get("nativePlace", "") or c.get("hometown", "") or c.get("籍贯", ""),
        contact_status=c.get("status", "") or c.get("currentStatus", "") or c.get("当前状态", ""),
        summary=resume.summary or "",
        sections=_serialize_export_sections(resume),
        primary_color=style.get("primaryColor", "#222"),
        accent_color=style.get("accentColor", "#666"),
        body_size=style.get("bodySize", "10pt"),
        heading_size=style.get("headingSize", "12pt"),
        line_height=style.get("lineHeight", "1.5"),
        page_margin=style.get("pageMargin", "2cm"),
        section_gap=style.get("sectionGap", "14pt"),
        font_family=style.get("fontFamily", "sans-serif"),
    )


def _render_resume_png_from_pdf(pdf_bytes: bytes, scale: float) -> bytes:
    try:
        import pymupdf as fitz  # PyMuPDF
    except ImportError:
        raise HTTPException(status_code=500, detail="PyMuPDF not installed")

    safe_scale = _normalize_export_image_scale(scale)
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        if doc.page_count < 1:
            raise HTTPException(status_code=500, detail="Empty resume page")

        matrix = fitz.Matrix(safe_scale, safe_scale)
        pixmaps: list[Any] = [
            page.get_pixmap(matrix=matrix, alpha=False)
            for page in doc
        ]

        if len(pixmaps) == 1:
            return pixmaps[0].tobytes("png")

        max_width = max(pix.width for pix in pixmaps)
        total_height = sum(pix.height for pix in pixmaps)

        merged = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, max_width, total_height), False)
        merged.set_rect(merged.irect, (255, 255, 255))

        offset_y = 0
        for pix in pixmaps:
            offset_x = max(0, (max_width - pix.width) // 2)
            pix.set_origin(offset_x, offset_y)
            merged.copy(pix, pix.irect)
            offset_y += pix.height

        return merged.tobytes("png")
    finally:
        doc.close()


def _normalize_export_image_scale(scale: float) -> float:
    return max(1.0, min(scale, 2.2))


def _extract_pdf_fallback_lines(html_str: str) -> list[tuple[str, str]]:
    try:
        from bs4 import BeautifulSoup
    except Exception:
        text = re.sub(r"<[^>]+>", "\n", html_str or "")
        lines = [re.sub(r"\s+", " ", line).strip() for line in text.splitlines()]
        return [("body", line) for line in lines if line]

    soup = BeautifulSoup(html_str or "", "html.parser")
    for tag in soup(["style", "script", "template"]):
        tag.decompose()

    selectors = [
        ".name",
        ".contact-line",
        ".sidebar-title",
        ".skill-category",
        ".skill-tag",
        ".section-title",
        ".entry-title",
        ".entry-meta",
        ".entry-sub",
        ".entry-desc",
        "h1",
        "h2",
        "h3",
        "p",
        "li",
    ]

    lines: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()

    for element in soup.select(",".join(selectors)):
        text = re.sub(r"\s+", " ", element.get_text(" ", strip=True)).strip()
        if not text:
            continue

        classes = set(element.get("class") or [])
        if "name" in classes or element.name == "h1":
            kind = "title"
        elif classes.intersection({"sidebar-title", "section-title"}) or element.name in {"h2", "h3"}:
            kind = "heading"
        else:
            kind = "body"

        key = (kind, text)
        if key not in seen:
            lines.append(key)
            seen.add(key)

    if lines:
        return lines

    body = soup.body or soup
    text = body.get_text("\n", strip=True)
    normalized = [re.sub(r"\s+", " ", line).strip() for line in text.splitlines()]
    return [("body", line) for line in normalized if line]


def _register_reportlab_cjk_font() -> str:
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    font_name = "OfferUFallbackCJK"
    if font_name in pdfmetrics.getRegisteredFontNames():
        return font_name

    font_candidates = [
        os.environ.get("OFFERU_PDF_FONT", ""),
        r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\simsun.ttc",
        r"C:\Windows\Fonts\Deng.ttf",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
        "/System/Library/Fonts/PingFang.ttc",
        "/Library/Fonts/Arial Unicode.ttf",
    ]

    for font_path in font_candidates:
        if not font_path or not os.path.exists(font_path):
            continue
        try:
            pdfmetrics.registerFont(TTFont(font_name, font_path, subfontIndex=0))
            return font_name
        except Exception:
            continue

    return "Helvetica"


def _render_resume_pdf_with_reportlab(html_str: str) -> bytes:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer

    font_name = _register_reportlab_cjk_font()
    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        rightMargin=18 * mm,
        leftMargin=18 * mm,
        topMargin=16 * mm,
        bottomMargin=16 * mm,
        title="OfferU Resume",
    )

    base_style = {
        "fontName": font_name,
        "wordWrap": "CJK",
    }
    styles = {
        "title": ParagraphStyle(
            "OfferUTitle",
            **base_style,
            fontSize=16,
            leading=22,
            spaceAfter=8,
        ),
        "heading": ParagraphStyle(
            "OfferUHeading",
            **base_style,
            fontSize=11,
            leading=16,
            spaceBefore=8,
            spaceAfter=5,
        ),
        "body": ParagraphStyle(
            "OfferUBody",
            **base_style,
            fontSize=9.5,
            leading=14,
            spaceAfter=4,
        ),
    }

    lines = _extract_pdf_fallback_lines(html_str)
    if not lines:
        lines = [("title", "OfferU Resume"), ("body", "No resume content available.")]

    story = []
    for kind, text in lines:
        style = styles.get(kind, styles["body"])
        story.append(Paragraph(xml_escape(text), style))
        if kind in {"title", "heading"}:
            story.append(Spacer(1, 2))

    doc.build(story)
    return buffer.getvalue()


def _can_try_weasyprint() -> bool:
    if os.name != "nt":
        return True

    try:
        import ctypes.util
    except Exception:
        return True

    return bool(ctypes.util.find_library("libgobject-2.0-0"))


async def _render_resume_pdf_with_playwright(resume_id: int, resume: Resume) -> bytes:
    """
    Render the dedicated frontend print route so PDF output matches the React preview.
    Falls back to the legacy HTML renderer when Playwright or Chromium is unavailable.
    优先使用系统已安装的 Chrome/Edge 浏览器，避免需要下载 Playwright 自带的 Chromium。
    """
    try:
        from playwright.async_api import async_playwright
    except Exception as exc:
        raise RuntimeError(f"Playwright is not installed: {exc}") from exc

    # OfferU 的桌面 Web 壳使用 HashRouter；必须保留 hash，否则 Vite
    # 入口会把无 hash 的打印地址解析成 Today，Playwright 只能等到超时。
    print_url = f"{FRONTEND_BASE_URL}/#/resume/print/{resume_id}"
    async with async_playwright() as p:
        # 尝试按优先级使用系统浏览器：Chrome > Edge > Playwright Chromium
        launched = False
        browser = None
        for channel in ["chrome", "msedge", "chromium"]:
            try:
                browser = await p.chromium.launch(channel=channel)
                launched = True
                break
            except Exception:
                continue
        if not launched:
            # 最后尝试不指定 channel（使用 Playwright 自带浏览器）
            browser = await p.chromium.launch()
        try:
            page = await browser.new_page(viewport={"width": 1240, "height": 1754}, device_scale_factor=1)
            await page.goto(print_url, wait_until="networkidle", timeout=30000)
            await page.wait_for_selector(".resume-print .resume-body", timeout=15000)
            await page.emulate_media(media="print")
            await page.evaluate("document.fonts && document.fonts.ready")
            return await page.pdf(
                format="A4",
                print_background=True,
                prefer_css_page_size=True,
                margin={"top": "0", "right": "0", "bottom": "0", "left": "0"},
            )
        finally:
            await browser.close()


def _render_resume_pdf_bytes(html_str: str) -> bytes:
    weasy_error: Exception | None = None

    if not _can_try_weasyprint():
        weasy_error = RuntimeError("WeasyPrint native GTK/Pango libraries were not found")
    else:
        try:
            from weasyprint import HTML
        except Exception as exc:
            weasy_error = exc
        else:
            try:
                return HTML(string=html_str).write_pdf()
            except Exception as exc:
                weasy_error = exc

    try:
        return _render_resume_pdf_with_reportlab(html_str)
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=(
                "PDF 渲染失败。"
                f"（WeasyPrint: {safe_error_message(weasy_error or RuntimeError('unavailable'))}; "
                f"备用渲染器: {safe_error_message(exc)}）"
            ),
        )


def _build_export_image_cache_key(resume: Resume, scale: float) -> tuple[int, str, str]:
    return (resume.id, str(resume.updated_at or ""), f"{scale:.2f}")


def _get_cached_export_image(cache_key: tuple[int, str, str]) -> bytes | None:
    now = time.monotonic()
    with _export_image_cache_lock:
        cached = _export_image_cache.get(cache_key)
        if not cached:
            return None

        expires_at, png_bytes = cached
        if expires_at <= now:
            _export_image_cache.pop(cache_key, None)
            return None

        return png_bytes


def _set_cached_export_image(cache_key: tuple[int, str, str], png_bytes: bytes) -> None:
    now = time.monotonic()
    with _export_image_cache_lock:
        _export_image_cache[cache_key] = (now + _EXPORT_IMAGE_CACHE_TTL_SECONDS, png_bytes)

        expired_keys = [
            key
            for key, (expires_at, _) in _export_image_cache.items()
            if expires_at <= now
        ]
        for key in expired_keys:
            _export_image_cache.pop(key, None)

        overflow = len(_export_image_cache) - _EXPORT_IMAGE_CACHE_MAX_ENTRIES
        if overflow > 0:
            oldest_keys = sorted(_export_image_cache.items(), key=lambda item: item[1][0])[:overflow]
            for key, _ in oldest_keys:
                _export_image_cache.pop(key, None)


# GET is also exposed for the browser's native download path. POST remains
# supported for existing API callers and explicit export actions.
@router.api_route("/{resume_id}/export/pdf", methods=["GET", "POST"])
async def export_pdf(resume_id: int, db: AsyncSession = Depends(get_db)):
    """
    导出简历为 PDF
    ─────────────────────────────────────────────
    1. 读取简历 + 段落 + 模板
    2. 使用统一 HTML 渲染逻辑（与图片导出共用）
    3. WeasyPrint 转 PDF
    4. StreamingResponse 返回
    """
    resume = await _get_resume_or_404(resume_id, db, load_sections=True)
    try:
        pdf_bytes = await _render_resume_pdf_with_playwright(resume_id, resume)
    except Exception:
        html_str = await _render_resume_html_for_export(resume, db)
        pdf_bytes = await anyio.to_thread.run_sync(_render_resume_pdf_bytes, html_str)

    return StreamingResponse(
        BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="resume_{resume_id}.pdf"',
        },
    )


@router.get("/{resume_id}/export/image")
@router.post("/{resume_id}/export/image")
async def export_image(
    resume_id: int,
    db: AsyncSession = Depends(get_db),
    scale: float = 1.2,
):
    """
    导出完整简历为 PNG 图片
    ─────────────────────────────────────────────
    1. 优先使用 Playwright 渲染（与前端预览一致）
    2. Fallback: WeasyPrint/ReportLab 生成 PDF，PyMuPDF 光栅化为 PNG
    """
    resume = await _get_resume_or_404(resume_id, db, load_sections=True)
    safe_scale = _normalize_export_image_scale(scale)
    cache_key = _build_export_image_cache_key(resume, safe_scale)
    cached_png = _get_cached_export_image(cache_key)

    if cached_png is not None:
        return StreamingResponse(
            BytesIO(cached_png),
            media_type="image/png",
            headers={
                "Content-Disposition": f'inline; filename="resume_{resume_id}.png"',
                "Cache-Control": "private, max-age=120",
                "X-OfferU-Export-Cache": "hit",
            },
        )

    # 优先 Playwright，fallback 到 WeasyPrint/ReportLab
    try:
        pdf_bytes = await _render_resume_pdf_with_playwright(resume_id, resume)
    except Exception:
        html_str = await _render_resume_html_for_export(resume, db)
        pdf_bytes = await anyio.to_thread.run_sync(_render_resume_pdf_bytes, html_str)

    try:
        png_bytes = await anyio.to_thread.run_sync(_render_resume_png_from_pdf, pdf_bytes, safe_scale)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"图片渲染失败: {safe_error_message(exc)}",
        ) from exc

    _set_cached_export_image(cache_key, png_bytes)

    return StreamingResponse(
        BytesIO(png_bytes),
        media_type="image/png",
        headers={
            "Content-Disposition": f'inline; filename="resume_{resume_id}.png"',
            "Cache-Control": "private, max-age=120",
            "X-OfferU-Export-Cache": "miss",
        },
    )


# =============================================
# =============================================
# AI 简历优化 — 多 LLM Provider 架构
# =============================================
# 端点：POST /api/resume/{id}/ai/optimize
#       POST /api/resume/ai/optimize-text
#
# 工作流：
#   1. 前端传入 JD（手动粘贴 或 job_id 从 DB 读取）
#   2. 后端读取简历数据 + JD
#   3. 调用 resume_optimizer agent（通过 llm.py 抽象层）
#   4. 返回关键词匹配 + 逐条优化建议
#   5. 前端 Diff 式逐条展示，用户 Accept / Reject
# =============================================


class AiOptimizeRequest(BaseModel):
    """AI 优化请求体 — 基于已有简历"""
    jd_text: Optional[str] = None
    job_id: Optional[int] = None


class AiOptimizeTextRequest(BaseModel):
    """AI 优化请求体 — 粘贴纯文本（无需预先创建简历）"""
    resume_text: str
    jd_text: str


@router.post("/{resume_id}/ai/optimize")
async def ai_optimize_resume(
    resume_id: int,
    data: AiOptimizeRequest,
    db: AsyncSession = Depends(get_db),
):
    """
    AI 优化简历 — 对标 JD 生成优化建议
    ─────────────────────────────────────────────
    支持两种 JD 来源：
      1. jd_text: 用户手动粘贴的 JD 文本
      2. job_id: 从 jobs 表读取 raw_description
    至少提供其中一种，否则返回 400。

    响应：
      {
        "keyword_match": { "matched": [...], "missing": [...], "score": 75 },
        "suggestions": [
          { "type": "...", "original": "...", "suggested": "...", "reason": "..." }
        ],
        "summary": "整体分析"
      }
    """
    from app.agents.resume_optimizer import optimize_resume_with_context

    # ── 1. 获取简历数据 ──
    resume = await _get_resume_or_404(resume_id, db, load_sections=True)

    # ── 2. 获取 JD 文本 ──
    jd_text = ""
    if data.jd_text:
        jd_text = data.jd_text.strip()
    elif data.job_id:
        result = await db.execute(select(Job).where(Job.id == data.job_id))
        job = result.scalar_one_or_none()
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        jd_text = job.raw_description or ""

    if not jd_text:
        raise HTTPException(
            status_code=400,
            detail="请提供 JD 文本（jd_text）或选择岗位（job_id）",
        )

    # ── 3. 调用 AI Agent ──
    resume_data = _serialize_resume_full(resume)
    try:
        ai_result = await optimize_resume_with_context(resume_data, jd_text)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=safe_error_message(e))

    if not ai_result:
        raise HTTPException(
            status_code=500,
            detail="AI 优化失败，请检查 LLM API Key 配置",
        )

    return ai_result


@router.post("/ai/optimize-text")
async def ai_optimize_text(data: AiOptimizeTextRequest):
    """
    粘贴文本快速优化 — 无需预先创建简历
    ─────────────────────────────────────────────
    前端「粘贴 JD」入口直接调用此端点，
    用户粘贴简历文本 + JD 文本，立即获取分析结果。
    """
    from app.agents.resume_optimizer import optimize_resume

    if not data.resume_text.strip() or not data.jd_text.strip():
        raise HTTPException(status_code=400, detail="简历和 JD 文本不能为空")

    try:
        ai_result = await optimize_resume(data.resume_text.strip(), data.jd_text.strip())
    except ValueError as e:
        raise HTTPException(status_code=400, detail=safe_error_message(e))

    if not ai_result:
        raise HTTPException(
            status_code=500,
            detail="AI 优化失败，请检查 LLM API Key 配置",
        )

    return ai_result


# =============================================
# AI Skill Pipeline — 模块化分步分析
# =============================================
# 新一代分析端点，使用 Skill Pipeline 架构：
#   Skill 1: JD 解析 → Skill 2: 匹配分析
# 相比旧的单次 optimize，更精准、更可控
# =============================================


class SkillAnalyzeRequest(BaseModel):
    """Skill Pipeline 分析请求体"""
    jd_text: Optional[str] = None
    job_id: Optional[int] = None


@router.post("/{resume_id}/ai/analyze")
async def ai_analyze_resume(
    resume_id: int,
    data: SkillAnalyzeRequest,
    db: AsyncSession = Depends(get_db),
):
    """
    AI 深度分析 — Skill Pipeline 模块化架构
    ─────────────────────────────────────────────
    执行 JD 解析 + 简历匹配 分步分析:
      1. Skill 1 (JD Analyzer): 提取岗位要求结构化信息
      2. Skill 2 (Resume Matcher): ATS 评分 + 逐段匹配 + 风险检测

    响应:
      {
        "jd_analysis": { job_title, required_skills, is_campus, ... },
        "match_analysis": { ats_score, matched_skills, missing_skills, section_scores, risk_items, ... }
      }
    """
    from app.agents.skills import SkillPipeline

    # ── 1. 获取简历数据 ──
    resume = await _get_resume_or_404(resume_id, db, load_sections=True)

    # ── 2. 获取 JD 文本 ──
    jd_text = ""
    if data.jd_text:
        jd_text = data.jd_text.strip()
    elif data.job_id:
        result = await db.execute(select(Job).where(Job.id == data.job_id))
        job = result.scalar_one_or_none()
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        jd_text = job.raw_description or ""

    if not jd_text:
        raise HTTPException(
            status_code=400,
            detail="请提供 JD 文本（jd_text）或选择岗位（job_id）",
        )

    # ── 3. 构建简历文本 ──
    resume_data = _serialize_resume_full(resume)
    resume_text = _flatten_resume_to_text(resume_data)

    # ── 4. 执行 Skill Pipeline ──
    pipeline = SkillPipeline()
    try:
        result = await pipeline.run(
            resume_text=resume_text,
            resume_data=resume_data,
            jd_text=jd_text,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=safe_error_message(e))

    # 检查是否有致命错误
    for key, val in result.items():
        if isinstance(val, dict) and "error" in val:
            if val["error"] == "LLM 调用失败":
                raise HTTPException(
                    status_code=500,
                    detail="AI 分析失败，请检查 LLM API Key 配置",
                )

    return result


@router.post("/ai/analyze-text")
async def ai_analyze_text(data: AiOptimizeTextRequest):
    """
    粘贴文本快速分析 — 无需预先创建简历
    ─────────────────────────────────────────────
    与 /ai/optimize-text 类似，但使用 Skill Pipeline 架构
    返回更精细的分步分析结果。
    """
    from app.agents.skills import SkillPipeline

    if not data.resume_text.strip() or not data.jd_text.strip():
        raise HTTPException(status_code=400, detail="简历和 JD 文本不能为空")

    pipeline = SkillPipeline()
    try:
        result = await pipeline.run(
            resume_text=data.resume_text.strip(),
            resume_data=None,
            jd_text=data.jd_text.strip(),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=safe_error_message(e))

    return result


def _flatten_resume_to_text(resume_data: dict) -> str:
    """将结构化简历 JSON 展平为可读纯文本（供 LLM 输入）"""
    parts = []
    if resume_data.get("user_name"):
        parts.append(f"姓名: {resume_data['user_name']}")
    if resume_data.get("summary"):
        parts.append(f"个人简介: {resume_data['summary']}")

    for section in resume_data.get("sections", []):
        title = section.get("title", section.get("section_type", ""))
        parts.append(f"\n## {title}")
        for item in section.get("content_json", []):
            if isinstance(item, dict):
                label = item.get("title", item.get("company", item.get("school", "")))
                if label:
                    parts.append(f"### {label}")
                desc = item.get("description", "")
                if desc:
                    parts.append(desc)
                items = item.get("items", [])
                if items:
                    parts.append(", ".join(items) if isinstance(items, list) else str(items))
            elif isinstance(item, str):
                parts.append(item)

    return "\n".join(parts)


@router.post("/{resume_id}/ai/apply")
async def ai_apply_suggestion(
    resume_id: int,
    suggestion: dict,
):
    """
    应用单条 AI 优化建议
    ─────────────────────────────────────────────
    前端用户点击 Accept 后，将具体建议发回后端执行。
    支持的建议类型：
      - bullet_rewrite: 更新经历/项目描述
      - keyword_add: 更新技能列表
      - section_reorder: 更新段落排序
    """
    return await _execute_operation(
        "apply_resume_suggestion",
        {"resume_id": resume_id, "suggestion": suggestion},
    )


@router.post("/{resume_id}/ai/apply-batch")
async def ai_apply_batch(
    resume_id: int,
    payload: dict,
):
    """
    批量应用 Skill Pipeline 的已采纳建议
    ─────────────────────────────────────────────
    前端 HITL: 用户逐条审核 → 点击「一键应用」→ 发送已采纳列表

    payload:
      {
        "suggestions": [
          { "type": "rewrite"/"inject", "section_title": "...", "original": "...", "suggested": "..." }
        ],
        "reorder": { "suggested_order": ["段落1", "段落2", ...] }  // 可选
      }
    """
    return await _execute_operation(
        "apply_resume_suggestions_batch",
        {"resume_id": resume_id, "payload": payload},
    )


# =============================================
# 批量 AI 简历定制 — 核心差异化功能
# =============================================
# 用户选择一份基础简历 + 多个目标岗位 →
# 系统为每个岗位克隆一份简历副本 →
# SkillPipeline 逐份分析 + 自动应用优化建议 →
# 返回所有生成结果（ATS 评分、新简历 ID）
# =============================================


class BatchOptimizeRequest(BaseModel):
    """批量 AI 简历定制请求体"""
    job_ids: list[int] = Field(..., min_length=1, max_length=20)
    auto_apply: bool = False  # 默认仅生成可审阅建议；用户必须明确开启自动写入


@router.post("/{resume_id}/ai/batch-optimize")
async def ai_batch_optimize(
    resume_id: int,
    data: BatchOptimizeRequest,
    request: Request,
):
    """
    批量 AI 简历定制 — SSE 流式版本
    ─────────────────────────────────────────────
        返回 text/event-stream，逐个岗位实时推送进度。
        兼容断连检测和心跳，提升长连接稳定性。
    """
    import json as _json
    result = await _execute_operation(
        "batch_optimize_resume_records",
        {"resume_id": resume_id, "job_ids": data.job_ids, "auto_apply": data.auto_apply},
    )
    entries = list((result or {}).get("results") or [])

    async def _stream():
        event_id = 1
        yield ServerSentEvent(
            data=_json.dumps({"total": len(entries)}, ensure_ascii=False),
            event="started",
            id=str(event_id),
        )
        for entry in entries:
            if await request.is_disconnected():
                break
            event_id += 1
            yield ServerSentEvent(
                data=_json.dumps(entry, ensure_ascii=False),
                event="error" if entry.get("status") == "failed" else "progress",
                id=str(event_id),
            )
        event_id += 1
        yield ServerSentEvent(
            data=_json.dumps(result or {}, ensure_ascii=False),
            event="done",
            id=str(event_id),
        )

    return EventSourceResponse(
        _stream(),
        ping=15,
        send_timeout=60,
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # nginx 不缓冲
        },
    )


# =============================================
# 简历文件解析 — PDF / Word 上传提取文本
# =============================================

ALLOWED_EXTENSIONS = {".pdf", ".docx"}
MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB


@router.post("/parse")
async def parse_resume_upload(file: UploadFile = File(...)):
    """
    上传 PDF 或 Word 简历文件，提取纯文本
    ─────────────────────────────────────────────
    支持 .pdf 和 .docx 格式。
    解析后返回文本内容，可直接用于 AI 分析或导入编辑器。
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="缺少文件名")

    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的文件格式 {ext}，仅支持 .pdf 和 .docx",
        )

    file_bytes = await file.read()
    if len(file_bytes) > MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail="文件大小不能超过 10MB")

    from app.services.resume_parser import parse_resume_document

    parsed_document = await parse_resume_document(file.filename, file_bytes)
    if parsed_document is None:
        raise HTTPException(status_code=500, detail="文件解析失败")
    if not parsed_document.text.strip():
        ocr_unavailable = any(
            "ocr_unavailable" in str(warning)
            for warning in parsed_document.warnings
        )
        detail = (
            "这是扫描版 PDF，但本机 OCR 不可用；请安装 Tesseract（中文 chi_sim + 英文 eng）后重试"
            if ocr_unavailable
            else "未能从文件中提取文本"
        )
        raise HTTPException(status_code=400, detail=detail)

    return {
        "filename": file.filename,
        "text": parsed_document.text,
        "length": len(parsed_document.text),
        "parse_diagnostics": parsed_document.public_dict(),
    }


# =============================================
# 简历版本管理 API
# =============================================

from app.models.models import ResumeVersion


class VersionCreate(BaseModel):
    """创建版本快照的请求体"""
    change_summary: str = ""
    created_by: str = "user"


@router.post("/{resume_id}/versions")
async def create_resume_version(
    resume_id: int,
    body: VersionCreate,
):
    """
    手动创建简历版本快照
    ────────────────────────────────────────────
    用于用户主动保存版本，或在生成新简历前自动调用。
    会保存完整的 Resume + ResumeSection 数据快照。
    """
    return await _execute_operation(
        "create_resume_version_record",
        {"resume_id": resume_id, **body.model_dump()},
    )


@router.get("/{resume_id}/versions")
async def list_resume_versions(
    resume_id: int,
    db: AsyncSession = Depends(get_db)
):
    """
    获取简历的所有版本列表
    ────────────────────────────────────────────
    返回版本号、创建时间、变更摘要等元信息，不包含完整快照内容。
    """
    result = await db.execute(
        select(ResumeVersion)
        .where(ResumeVersion.resume_id == resume_id)
        .order_by(ResumeVersion.version_number.desc())
    )
    versions = result.scalars().all()

    return [
        {
            "id": v.id,
            "resume_id": v.resume_id,
            "version_number": v.version_number,
            "change_summary": v.change_summary,
            "created_by": v.created_by,
            "created_at": v.created_at.isoformat(),
        }
        for v in versions
    ]


@router.get("/{resume_id}/versions/{version_id}")
async def get_resume_version(
    resume_id: int,
    version_id: int,
    db: AsyncSession = Depends(get_db)
):
    """
    获取指定版本的完整快照内容
    ────────────────────────────────────────────
    用于前端预览历史版本或回滚。
    """
    result = await db.execute(
        select(ResumeVersion)
        .where(ResumeVersion.resume_id == resume_id, ResumeVersion.id == version_id)
    )
    version = result.scalar_one_or_none()
    if not version:
        raise HTTPException(status_code=404, detail="版本不存在")

    return {
        "id": version.id,
        "resume_id": version.resume_id,
        "version_number": version.version_number,
        "change_summary": version.change_summary,
        "created_by": version.created_by,
        "created_at": version.created_at.isoformat(),
        "content_snapshot": version.content_snapshot,
    }


@router.post("/{resume_id}/versions/{version_id}/restore")
async def restore_resume_version(
    resume_id: int,
    version_id: int,
):
    """
    回滚到指定版本
    ────────────────────────────────────────────
    1. 创建当前状态的版本快照（防止误操作）
    2. 将目标版本的快照恢复到当前简历
    3. 删除旧的 sections，插入快照中的 sections
    """
    return await _execute_operation(
        "restore_resume_version_record",
        {"resume_id": resume_id, "version_id": version_id},
    )


# =============================================
# 简历分享 API
# =============================================

from app.models.models import ResumeShare
import secrets


class ShareCreate(BaseModel):
    """创建分享链接的请求体"""
    password: Optional[str] = None  # 可选密码保护
    expires_days: Optional[int] = None  # 过期天数，None 表示永久


@router.post("/{resume_id}/share")
async def create_resume_share(
    resume_id: int,
    body: ShareCreate,
):
    """
    创建简历分享链接
    ────────────────────────────────────────────
    生成随机 token，可选密码保护和过期时间。
    """
    return await _execute_operation(
        "create_resume_share_record",
        {"resume_id": resume_id, **body.model_dump()},
    )


@router.get("/{resume_id}/shares")
async def list_resume_shares(
    resume_id: int,
    db: AsyncSession = Depends(get_db)
):
    """
    获取简历的所有分享链接
    ────────────────────────────────────────────
    返回分享链接列表，包含访问统计。
    """
    result = await db.execute(
        select(ResumeShare)
        .where(ResumeShare.resume_id == resume_id)
        .order_by(ResumeShare.created_at.desc())
    )
    shares = result.scalars().all()

    return [
        {
            "id": s.id,
            "resume_id": s.resume_id,
            "share_token": s.share_token,
            "share_url": f"{FRONTEND_BASE_URL}/share/{s.share_token}",
            "has_password": bool(s.password_hash),
            "expires_at": s.expires_at.isoformat() if s.expires_at else None,
            "is_active": s.is_active,
            "view_count": s.view_count,
            "last_viewed_at": s.last_viewed_at.isoformat() if s.last_viewed_at else None,
            "created_at": s.created_at.isoformat(),
        }
        for s in shares
    ]


@router.delete("/shares/{share_id}")
async def delete_resume_share(
    share_id: int,
):
    """
    删除分享链接
    """
    return await _execute_operation(
        "delete_resume_share_record",
        {"share_id": share_id},
    )


@router.patch("/shares/{share_id}/toggle")
async def toggle_resume_share(
    share_id: int,
):
    """
    启用/禁用分享链接
    """
    return await _execute_operation(
        "toggle_resume_share_record",
        {"share_id": share_id},
    )


class ShareAccessRequest(BaseModel):
    """访问分享链接的请求体"""
    password: Optional[str] = None


@router.post("/share/{share_token}/access")
async def access_resume_share(
    share_token: str,
    body: ShareAccessRequest,
):
    """
    访问分享链接（公开端点）
    ────────────────────────────────────────────
    1. 验证 token 是否存在且有效
    2. 验证密码（如果设置了）
    3. 检查是否过期
    4. 更新访问统计
    5. 返回完整简历数据
    """
    return await _execute_operation(
        "access_resume_share_record",
        {"share_token": share_token, **body.model_dump()},
    )


# =============================================
# Endpoint: POST /api/resume/{resume_id}/ai/generate-draft
# One-click AI resume draft generator (SSE stream)
# ---------------------------------------------
# Input: { jd_text: str }
# Flow:  read default Profile + ProfileSections as background, call LLM(json_mode)
# SSE:
#   event: progress  data: {stage, message}
#   event: result    data: {summary, sections:[...]}
#   event: error     data: {message}
#   event: done      data: {}
# No DB write - user previews in Drawer and applies via existing PUT
# =============================================

ALLOWED_DRAFT_SECTION_TYPES = (
    "workExperiences",
    "internshipExperiences",
    "projects",
    "education",
    "skills",
    "certificates",
    "awards",
    "personalExperiences",
)


class AiGenerateDraftRequest(BaseModel):
    jd_text: str = Field(..., min_length=10)


def _profile_background_text(profile: Profile, sections) -> str:
    parts: list[str] = []
    parts.append(f"姓名: {profile.name or '未填'}")
    parts.append(f"headline: {profile.headline or '未填'}")
    parts.append(f"专业: {profile.major or '未填'}")
    parts.append(f"学历: {profile.degree or '未填'}")
    parts.append(f"学校: {profile.school or '未填'}")
    parts.append(f"GPA: {profile.gpa or '未填'}")
    parts.append(f"email: {profile.email or '未填'}")
    parts.append(f"phone: {profile.phone or '未填'}")
    parts.append(f"wechat: {profile.wechat or '未填'}")
    parts.append(f"exit_story: {profile.exit_story or '未填'}")
    parts.append(f"cross_cutting_advantage: {profile.cross_cutting_advantage or '未填'}")
    parts.append("")
    parts.append("=== Profile Sections ===")
    for s in sections:
        try:
            cj = s.content_json if isinstance(s.content_json, (list, dict)) else []
        except Exception:
            cj = []
        import json as _json
        parts.append(f"\n[类型={s.section_type} | sort_order={s.sort_order}] title={s.title or ''}")
        parts.append("content_json=" + _json.dumps(cj, ensure_ascii=False))
    return "\n".join(parts)


DRAFT_SYSTEM_PROMPT = """You are a senior career consultant and fact-grounded resume designer. Based on the user profile background and the target JD, generate a high-quality resume draft.

## Output
Return strict JSON only (no surrounding prose), with this shape:
{
  "summary": "3-5 sentences aligned with JD keywords and supported by profile facts",
  "sections": [
    {
      "section_type": "workExperiences|internshipExperiences|projects|education|skills|certificates|awards|personalExperiences",
      "title": "the Chinese title of this section, e.g. gong zuo jing li / ji neng / xiang mu jing li",
      "sort_order": int,
      "content_json": [ ... items matching the section_type schema ... ]
    }
  ]
}

## section_type -> content_json schemas (strict):
- workExperiences / internshipExperiences: list of {company, position, location, startDate, endDate, description}
- projects: list of {name, role, url, startDate, endDate, description}
- education: list of {school, degree, major, startDate, endDate, gpa, description}
- skills: list of {category, items: [string, ...]}
- certificates: list of {name, scoreOrLevel, issuer, date, url, description}
- awards: list of {awardName, issuer, awardedAt, description}
- personalExperiences: list of {experienceTitle, startDate, endDate, description}

## Rules
1. Preserve facts. Never invent employers, skills, dates, metrics, scope, outcomes, credentials, or responsibilities. Use a metric only when it already appears in the profile
2. Order sections by JD priority via sort_order (0, 1, 2 ...). Sections most relevant to JD come first
3. Only generate sections that have real background support from the profile. Do not fabricate section types absent from the profile
4. The JD controls emphasis and ordering, never candidate facts. Unsupported JD requirements remain gaps and must not be added as candidate skills
5. Output only sections supported by actual profile evidence; do not force work experience or any minimum section set
6. Description language: Chinese if JD is Chinese, English if JD is English
7. Dates use YYYY-MM or YYYY.MM format
8. sort_order must be consecutive non-negative integers starting from 0
"""


def _sse_event(event: str, payload: dict) -> str:
    body = json.dumps(payload, ensure_ascii=False)
    return f"event: {event}\ndata: {body}\n\n"


@router.post("/{resume_id}/ai/generate-draft")
async def ai_generate_draft(
    resume_id: int,
    data: AiGenerateDraftRequest,
    db: AsyncSession = Depends(get_db),
):
    from app.agents.llm import chat_completion, extract_json
    from app.models.models import ProfileSection

    jd_text = data.jd_text.strip()
    if not jd_text:
        raise HTTPException(status_code=400, detail="JD 文本不能为空")

    async def _stream():
        yield _sse_event("progress", {"stage": "load_profile", "message": "Loading profile..."})
        try:
            result = await db.execute(
                select(Profile).order_by(Profile.is_default.desc(), Profile.updated_at.desc())
            )
            profile = result.scalars().first()
            if not profile:
                yield _sse_event("error", {"message": "未找到个人档案，请先在 Profile 页面建档"})
                yield _sse_event("done", {})
                return
            sec_result = await db.execute(
                select(ProfileSection)
                .where(ProfileSection.profile_id == profile.id)
                .where(ProfileSection.status == "active")
                .order_by(ProfileSection.sort_order.asc())
            )
            profile_sections = list(sec_result.scalars().all())
        except Exception as e:
            yield _sse_event(
                "error",
                {"message": f"读取档案失败: {safe_error_message(e)}"},
            )
            yield _sse_event("done", {})
            return

        yield _sse_event("progress", {"stage": "build_prompt", "message": f"Loaded {len(profile_sections)} profile sections, building prompt..."})

        background = _profile_background_text(profile, profile_sections)
        user_prompt = f"【Applicant Background】\n{background}\n\n===== Target JD =====\n{jd_text}\n\nGenerate a resume draft tightly aligned with this JD. Follow the JSON schema exactly."

        messages = [
            {"role": "system", "content": DRAFT_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ]

        yield _sse_event("progress", {"stage": "llm_call", "message": "Calling LLM (10-30s)..."})

        try:
            raw = await chat_completion(
                messages=messages,
                temperature=0.4,
                json_mode=True,
                max_tokens=8192,
                tier="standard",
            )
        except Exception as e:
            yield _sse_event(
                "error",
                {"message": f"LLM 调用异常: {safe_error_message(e)}"},
            )
            yield _sse_event("done", {})
            return

        if not raw:
            yield _sse_event("error", {"message": "LLM 未返回内容，请检查 API Key 配置或网络"})
            yield _sse_event("done", {})
            return

        yield _sse_event("progress", {"stage": "parse", "message": "Parsing LLM output..."})

        parsed = extract_json(raw)
        if not parsed or not isinstance(parsed, dict):
            yield _sse_event("error", {"message": "LLM 输出不是合法 JSON，无法解析"})
            yield _sse_event("done", {})
            return

        summary = str(parsed.get("summary", "") or "")
        raw_sections = parsed.get("sections")
        if not isinstance(raw_sections, list) or not raw_sections:
            yield _sse_event("error", {"message": "LLM 未返回 sections 数组或数组为空"})
            yield _sse_event("done", {})
            return

        sections_out: list[dict] = []
        for idx, sec in enumerate(raw_sections):
            if not isinstance(sec, dict):
                continue
            sec_type = str(sec.get("section_type", "") or "")
            if sec_type not in ALLOWED_DRAFT_SECTION_TYPES:
                continue
            title = str(sec.get("title", "") or "")
            content_json = sec.get("content_json")
            if not isinstance(content_json, list):
                content_json = []
            sections_out.append({
                "id": 0,
                "section_type": sec_type,
                "title": title,
                "sort_order": int(sec.get("sort_order", idx) or idx),
                "visible": True,
                "content_json": content_json,
            })

        if not sections_out:
            yield _sse_event("error", {"message": "生成结果中没有合法的 section，请重试或更换 JD 内容"})
            yield _sse_event("done", {})
            return

        from app.services.resume_fact_gates import validate_generated_content
        fact_gates = validate_generated_content(background, {"summary": summary, "sections": sections_out})
        if fact_gates["status"] == "blocked":
            yield _sse_event("error", {
                "message": "事实校验未通过，草稿包含档案中不存在的量化信息",
                "fact_gates": fact_gates,
            })
            yield _sse_event("done", {})
            return

        try:
            saved_draft = await _execute_operation(
                "save_resume_draft_record",
                {
                    "resume_id": resume_id,
                    "profile_id": profile.id,
                    "jd_text": jd_text,
                    "summary": summary,
                    "sections": sections_out,
                    "fact_gates": fact_gates,
                },
            )
        except Exception as e:
            yield _sse_event(
                "error",
                {
                    "message": (
                        "草稿持久化失败，未返回未落盘结果: "
                        f"{safe_error_message(e)}"
                    )
                },
            )
            yield _sse_event("done", {})
            return

        yield _sse_event("result", {
            "draft_id": saved_draft["id"],
            "draft_status": saved_draft["status"],
            "summary": summary,
            "sections": sections_out,
            "fact_gates": fact_gates,
        })
        yield _sse_event("done", {})

    return StreamingResponse(_stream(), media_type="text/event-stream")
