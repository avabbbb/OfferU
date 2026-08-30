"""Operation implementations for the legacy resume HTTP surface.

The resume editor predates the provider-neutral Operation Registry.  These
functions keep its response semantics while making the Registry the only
business mutation gateway used by the route, CLI and agent surfaces.
"""

from __future__ import annotations

import base64
import binascii
import copy
import os
import re
import secrets
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx
from sqlalchemy import desc, func, select
from sqlalchemy.orm import selectinload

from app.database import async_session
from app.models.models import (
    Job,
    Profile,
    ProfileSection,
    Resume,
    ResumeOptimizationProposal,
    ResumeSection,
    ResumeShare,
    ResumeTemplate,
    ResumeVersion,
)
from app.services.application_workspace import auto_write_job_to_total
from app.services.resume_drafts import save_resume_draft
from app.services.resume_fact_gates import validate_generated_content
from app.services.resume_versions import create_version_snapshot, snapshot_resume


BACKEND_DIR = Path(__file__).resolve().parents[2]
PHOTO_DIR = BACKEND_DIR / "uploads" / "photos"
LOGO_DIR = BACKEND_DIR / "uploads" / "logos"
FRONTEND_BASE_URL = os.getenv("FRONTEND_BASE_URL", "http://127.0.0.1:7410").rstrip("/")


def _source_job_ids(value: Any) -> list[int]:
    if not isinstance(value, list):
        return []
    result: list[int] = []
    for item in value:
        if isinstance(item, int) and item > 0:
            result.append(item)
        elif isinstance(item, str) and item.isdigit() and int(item) > 0:
            result.append(int(item))
    return result


async def _source_jobs(db, source_ids: list[int]) -> dict[int, dict[str, Any]]:
    if not source_ids:
        return {}
    rows = (await db.execute(select(Job).where(Job.id.in_(source_ids)))).scalars().all()
    return {row.id: {"id": row.id, "title": row.title, "company": row.company} for row in rows}


def _section_dict(section: ResumeSection) -> dict[str, Any]:
    return {
        "id": section.id,
        "resume_id": section.resume_id,
        "section_type": section.section_type,
        "sort_order": section.sort_order,
        "title": section.title,
        "visible": section.visible,
        "content_json": section.content_json,
        "source_section_ids": section.source_section_ids or [],
    }


def _resume_dict(resume: Resume, source_jobs: dict[int, dict[str, Any]] | None = None) -> dict[str, Any]:
    ids = _source_job_ids(resume.source_job_ids)
    source_map = source_jobs or {}
    return {
        "id": resume.id,
        "user_name": resume.user_name,
        "title": resume.title,
        "photo_url": resume.photo_url,
        "summary": resume.summary,
        "contact_json": resume.contact_json,
        "template_id": resume.template_id,
        "style_config": resume.style_config,
        "is_primary": resume.is_primary,
        "language": resume.language,
        "source_mode": resume.source_mode,
        "source_job_ids": ids,
        "source_jobs": [source_map[item] for item in ids if item in source_map],
        "source_profile_snapshot": resume.source_profile_snapshot or {},
        "source_profile_id": resume.source_profile_id,
        "source_resume_id": resume.source_resume_id,
        "target_job_id": resume.target_job_id,
        "application_id": resume.application_id,
        "current_version_id": resume.current_version_id,
        "workspace_revision": resume.workspace_revision,
        "sections": [_section_dict(section) for section in resume.sections],
        "created_at": str(resume.created_at),
        "updated_at": str(resume.updated_at),
    }


async def _get_resume(db, resume_id: int, *, load_sections: bool = False) -> Resume:
    stmt = select(Resume).where(Resume.id == resume_id)
    if load_sections:
        stmt = stmt.options(selectinload(Resume.sections))
    resume = (await db.execute(stmt)).scalar_one_or_none()
    if resume is None:
        raise ValueError("Resume not found")
    return resume


async def create_resume_record(
    user_name: str = "",
    title: str = "未命名简历",
    summary: str = "",
    contact_json: dict[str, Any] | None = None,
    template_id: int | None = None,
    style_config: dict[str, Any] | None = None,
    language: str = "zh",
    source_mode: str = "manual",
    source_job_ids: list[int] | None = None,
    source_profile_snapshot: dict[str, Any] | None = None,
    source_resume_id: int | None = None,
    target_job_id: int | None = None,
    application_id: int | None = None,
) -> dict[str, Any]:
    clean_name = (user_name or "").strip()
    contact = {
        str(key): value
        for key, value in dict(contact_json or {}).items()
        if isinstance(value, str) and value.strip()
    }
    async with async_session() as db:
        if not clean_name or not contact:
            profile = (
                await db.execute(
                    select(Profile).order_by(Profile.is_default.desc(), Profile.updated_at.desc())
                )
            ).scalars().first()
            if profile:
                base = profile.base_info_json if isinstance(profile.base_info_json, dict) else {}
                if not clean_name:
                    clean_name = str(base.get("name") or profile.name or "").strip()
                for field in ("phone", "email", "linkedin", "github", "website", "wechat"):
                    value = str(base.get(field, "")).strip()
                    if value and not str(contact.get(field, "")).strip():
                        contact[field] = value
        resume = Resume(
            user_name=clean_name or "默认候选人",
            title=title,
            summary=summary,
            contact_json=contact,
            template_id=template_id,
            style_config=style_config or {},
            language=language,
            source_mode=source_mode,
            source_job_ids=source_job_ids or [],
            source_profile_snapshot=source_profile_snapshot or {},
            source_resume_id=source_resume_id,
            target_job_id=target_job_id,
            application_id=application_id,
        )
        db.add(resume)
        await db.flush()
        db.add_all(
            [
                ResumeSection(resume_id=resume.id, section_type="education", title="教育经历", sort_order=0),
                ResumeSection(resume_id=resume.id, section_type="workExperiences", title="工作经历", sort_order=1),
                ResumeSection(resume_id=resume.id, section_type="skills", title="技能", sort_order=2),
            ]
        )
        await db.commit()
        fresh = await _get_resume(db, resume.id, load_sections=True)
        return _resume_dict(fresh, await _source_jobs(db, _source_job_ids(fresh.source_job_ids)))


async def apply_resume_template_to_record(template_id: int, resume_id: int) -> dict[str, Any]:
    async with async_session() as db:
        template = await db.get(ResumeTemplate, template_id)
        if template is None:
            raise ValueError("模板不存在")
        resume = await _get_resume(db, resume_id)
        merged = {**(resume.style_config or {}), **(template.css_variables or {})}
        resume.template_id = template_id
        resume.style_config = merged
        await db.commit()
        return {"ok": True, "style_config": merged}


async def update_resume_record(resume_id: int, update_data: dict[str, Any]) -> dict[str, Any]:
    async with async_session() as db:
        resume = await _get_resume(db, resume_id, load_sections=True)
        values = dict(update_data or {})
        sections = values.pop("sections", None)
        for key, value in values.items():
            if hasattr(resume, key):
                setattr(resume, key, value)

        if values or sections is not None:
            resume.workspace_revision = int(resume.workspace_revision or 0) + 1

        if sections is not None:
            existing = {section.id: section for section in resume.sections}
            seen: set[int] = set()
            for index, raw in enumerate(sections):
                row = dict(raw)
                section_id = row.get("id")
                if section_id is not None and section_id in existing:
                    section = existing[section_id]
                    seen.add(section.id)
                else:
                    section = ResumeSection(resume_id=resume.id)
                    db.add(section)
                    await db.flush()
                    seen.add(section.id)
                    existing[section.id] = section
                section.section_type = row["section_type"]
                section.sort_order = row.get("sort_order", index)
                section.title = row.get("title", "")
                section.visible = row.get("visible", True)
                section.content_json = row.get("content_json", [])
                section.source_section_ids = row.get("source_section_ids") or section.source_section_ids
            for section_id, section in existing.items():
                if section_id not in seen:
                    await db.delete(section)
        await db.commit()
        fresh = await _get_resume(db, resume_id, load_sections=True)
        return _resume_dict(fresh, await _source_jobs(db, _source_job_ids(fresh.source_job_ids)))


async def delete_resume_record(resume_id: int) -> dict[str, Any]:
    async with async_session() as db:
        resume = await _get_resume(db, resume_id)
        await db.delete(resume)
        await db.commit()
        return {"message": "Resume deleted"}


async def reorder_resume_sections(resume_id: int, items: list[dict[str, Any]]) -> dict[str, Any]:
    async with async_session() as db:
        resume = await _get_resume(db, resume_id)
        for item in items:
            section = (
                await db.execute(
                    select(ResumeSection).where(
                        ResumeSection.id == int(item["id"]),
                        ResumeSection.resume_id == resume_id,
                    )
                )
            ).scalar_one_or_none()
            if section:
                section.sort_order = int(item["sort_order"])
        resume.workspace_revision = int(resume.workspace_revision or 0) + 1
        await db.commit()
        return {"message": "Sections reordered"}


async def create_resume_section(
    resume_id: int,
    section_type: str,
    title: str = "",
    sort_order: int = 0,
    visible: bool = True,
    content_json: list[Any] | None = None,
) -> dict[str, Any]:
    async with async_session() as db:
        resume = await _get_resume(db, resume_id)
        section = ResumeSection(
            resume_id=resume_id,
            section_type=section_type,
            title=title,
            sort_order=sort_order,
            visible=visible,
            content_json=content_json or [],
        )
        db.add(section)
        resume.workspace_revision = int(resume.workspace_revision or 0) + 1
        await db.commit()
        await db.refresh(section)
        return _section_dict(section)


async def update_resume_section(
    resume_id: int,
    section_id: int,
    update_data: dict[str, Any],
) -> dict[str, Any]:
    async with async_session() as db:
        section = (
            await db.execute(
                select(ResumeSection).where(
                    ResumeSection.id == section_id,
                    ResumeSection.resume_id == resume_id,
                )
            )
        ).scalar_one_or_none()
        if section is None:
            raise ValueError("Section not found")
        for key, value in (update_data or {}).items():
            if hasattr(section, key):
                setattr(section, key, value)
        resume = await _get_resume(db, resume_id)
        resume.workspace_revision = int(resume.workspace_revision or 0) + 1
        await db.commit()
        await db.refresh(section)
        return _section_dict(section)


async def delete_resume_section(resume_id: int, section_id: int) -> dict[str, Any]:
    async with async_session() as db:
        section = (
            await db.execute(
                select(ResumeSection).where(
                    ResumeSection.id == section_id,
                    ResumeSection.resume_id == resume_id,
                )
            )
        ).scalar_one_or_none()
        if section is None:
            raise ValueError("Section not found")
        resume = await _get_resume(db, resume_id)
        await db.delete(section)
        resume.workspace_revision = int(resume.workspace_revision or 0) + 1
        await db.commit()
        return {"message": "Section deleted"}


def _decode_upload(content_b64: str) -> bytes:
    try:
        content = base64.b64decode(content_b64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("上传内容不是合法的 base64") from exc
    if not content:
        raise ValueError("上传文件不能为空")
    if len(content) > 5 * 1024 * 1024:
        raise ValueError("File too large (max 5MB)")
    return content


async def upload_resume_photo(resume_id: int, content_b64: str, content_type: str) -> dict[str, Any]:
    ext = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}.get(content_type)
    if not ext:
        raise ValueError(f"Unsupported file type: {content_type}")
    content = _decode_upload(content_b64)
    async with async_session() as db:
        resume = await _get_resume(db, resume_id)
        PHOTO_DIR.mkdir(parents=True, exist_ok=True)
        filename = f"{uuid.uuid4().hex}.{ext}"
        (PHOTO_DIR / filename).write_bytes(content)
        photo_url = f"/uploads/photos/{filename}"
        resume.photo_url = photo_url
        await db.commit()
        return {"photo_url": photo_url}


async def upload_resume_logo(
    resume_id: int,
    content_b64: str,
    content_type: str,
) -> dict[str, Any]:
    ext = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}.get(content_type)
    if not ext:
        raise ValueError(f"Unsupported file type: {content_type}")
    content = _decode_upload(content_b64)
    async with async_session() as db:
        resume = await _get_resume(db, resume_id)
        LOGO_DIR.mkdir(parents=True, exist_ok=True)
        filename = f"{uuid.uuid4().hex}.{ext}"
        (LOGO_DIR / filename).write_bytes(content)
        logo_url = f"/uploads/logos/{filename}"
        contact = dict(resume.contact_json or {})
        contact["schoolLogoUrl"] = logo_url
        resume.contact_json = contact
        await db.commit()
        return {"logo_url": logo_url, "schoolLogoUrl": logo_url}


def _commons_file_url(filename: str) -> str:
    return f"https://commons.wikimedia.org/wiki/Special:FilePath/{quote(filename)}"


async def _resolve_university_logo(school_name: str) -> dict[str, str]:
    name = school_name.strip()
    if not name:
        raise ValueError("School name is required")
    headers = {"User-Agent": "OfferU/0.1 university-logo-resolver"}
    async with httpx.AsyncClient(timeout=15, follow_redirects=True, headers=headers) as client:
        response = await client.get(
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
        response.raise_for_status()
        pages = (response.json().get("query") or {}).get("pages") or {}
        for page in sorted(pages.values(), key=lambda value: value.get("index", 999)):
            title = str(page.get("title") or "")
            if "大学" not in title and "学院" not in title and name not in title:
                continue
            page_image = (page.get("pageprops") or {}).get("page_image")
            if page_image:
                return {"logo_url": _commons_file_url(page_image), "school_name": name, "source": "zh.wikipedia.page_image", "matched_title": title}
            original = page.get("original") or {}
            if original.get("source"):
                return {"logo_url": original["source"], "school_name": name, "source": "zh.wikipedia.original", "matched_title": title}
    raise ValueError(f"Logo not found for school: {name}")


async def resolve_resume_logo(resume_id: int, school_name: str) -> dict[str, Any]:
    resolved = await _resolve_university_logo(school_name)
    async with async_session() as db:
        resume = await _get_resume(db, resume_id)
        contact = dict(resume.contact_json or {})
        contact.update(
            {
                "schoolName": resolved["school_name"],
                "schoolLogoUrl": resolved["logo_url"],
                "schoolLogoSource": resolved["source"],
            }
        )
        resume.contact_json = contact
        await db.commit()
        return {**resolved, "schoolLogoUrl": resolved["logo_url"]}


async def apply_resume_suggestion(resume_id: int, suggestion: dict[str, Any]) -> dict[str, Any]:
    async with async_session() as db:
        resume = await _get_resume(db, resume_id, load_sections=True)
        source = _resume_dict(resume)
        fact_gates = validate_generated_content(source, suggestion)
        if fact_gates["status"] == "blocked":
            raise ValueError(f"事实校验未通过，建议未应用: {fact_gates}")
        backup = await create_version_snapshot(
            db, resume, change_summary="应用 AI 建议前的自动备份", created_by="system"
        )
        suggestion_type = suggestion.get("type")
        if suggestion_type in {"bullet_rewrite", "keyword_add"}:
            section_id = suggestion.get("section_id")
            section = next((item for item in resume.sections if item.id == section_id), None)
            if section is None:
                raise ValueError("Section not found")
            content = list(section.content_json or [])
            if suggestion_type == "bullet_rewrite":
                index = int(suggestion.get("item_index", 0))
                suggested = suggestion.get("suggested")
                if suggested is None or index >= len(content) or not isinstance(content[index], dict):
                    raise ValueError("目标条目已变化，请重新生成建议")
                original = str(suggestion.get("original") or "").strip()
                current = str(content[index].get("description") or "")
                if original and original not in current:
                    raise ValueError("建议原文已变化，拒绝覆盖较新的简历内容")
                content[index]["description"] = current.replace(original, str(suggested), 1) if original else suggested
            else:
                suggested = suggestion.get("suggested")
                if content and isinstance(suggested, list):
                    source_lower = str(source).lower()
                    unsupported = [str(skill) for skill in suggested if str(skill).lower() not in source_lower]
                    if unsupported:
                        raise ValueError(f"拒绝添加缺少简历证据的技能: {', '.join(unsupported)}")
                    content[0]["items"] = suggested
            section.content_json = content
            message = "Suggestion applied"
        elif suggestion_type == "section_reorder":
            for index, section_id in enumerate(suggestion.get("suggested_order", [])):
                section = next((item for item in resume.sections if item.id == section_id), None)
                if section:
                    section.sort_order = index
            message = "Sections reordered"
        else:
            raise ValueError(f"Unknown suggestion type: {suggestion_type}")
        await db.commit()
        return {"message": message, "backup_version_number": backup.version_number, "fact_gates": fact_gates}


async def apply_resume_suggestions_batch(resume_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    async with async_session() as db:
        resume = await _get_resume(db, resume_id, load_sections=True)
        fact_gates = validate_generated_content(_resume_dict(resume), payload.get("suggestions", []))
        if fact_gates["status"] == "blocked":
            raise ValueError(f"事实校验未通过，整批建议均未应用: {fact_gates}")
        backup = await create_version_snapshot(
            db, resume, change_summary="批量应用 AI 建议前的自动备份", created_by="system"
        )
        applied = 0
        failed = 0
        for suggestion in payload.get("suggestions", []):
            title = suggestion.get("section_title", "")
            original = suggestion.get("original", "")
            suggested = suggestion.get("suggested", "")
            if not title or not original or not suggested:
                failed += 1
                continue
            section = next((item for item in resume.sections if title.lower() in (item.title or "").lower()), None)
            if section is None:
                failed += 1
                continue
            content = list(section.content_json or [])
            matched = False
            for item in content:
                if not isinstance(item, dict):
                    continue
                description = str(item.get("description") or "")
                if original in description:
                    item["description"] = description.replace(original, suggested, 1)
                    matched = True
                    break
            if matched:
                section.content_json = content
                applied += 1
            else:
                failed += 1
        reorder = payload.get("reorder") or {}
        for index, title in enumerate(reorder.get("suggested_order", [])):
            section = next((item for item in resume.sections if str(title).lower() in (item.title or "").lower()), None)
            if section:
                section.sort_order = index
        if failed:
            await db.rollback()
            raise ValueError(f"有 {failed} 条建议无法匹配，整批建议均未应用，请重新分析")
        await db.commit()
        return {
            "message": f"已应用 {applied} 条建议",
            "applied": applied,
            "failed": failed,
            "backup_version_number": backup.version_number,
            "fact_gates": fact_gates,
        }


async def batch_optimize_resume_records(
    resume_id: int,
    job_ids: list[int],
    auto_apply: bool = False,
) -> dict[str, Any]:
    """Create one tailored resume candidate per job behind the Registry."""

    from app.agents.skills import SkillPipeline

    async with async_session() as db:
        source = await _get_resume(db, resume_id, load_sections=True)
        source_data = _resume_dict(source)
        jobs = (
            await db.execute(select(Job).where(Job.id.in_(job_ids)))
        ).scalars().all()
        jobs_map = {job.id: job for job in jobs}
        missing = sorted(set(job_ids) - set(jobs_map))
        if missing:
            raise ValueError(f"以下岗位不存在: {missing}")

        pipeline = SkillPipeline()
        results: list[dict[str, Any]] = []
        for index, job_id in enumerate(job_ids):
            job = jobs_map[job_id]
            entry: dict[str, Any] = {
                "job_id": job_id,
                "job_title": job.title,
                "company": job.company,
                "new_resume_id": None,
                "ats_score": None,
                "suggestions_applied": 0,
                "status": "pending",
                "error": None,
                "index": index,
                "total": len(job_ids),
            }
            jd_text = (job.raw_description or "").strip()
            if not jd_text:
                entry.update(status="skipped", error="岗位无 JD 文本")
                results.append(entry)
                continue

            try:
                new_resume = Resume(
                    user_name=source_data.get("user_name") or "",
                    title=f"{source_data.get('title') or '简历'} - {job.company} {job.title}",
                    photo_url=source_data.get("photo_url") or "",
                    summary=source_data.get("summary") or "",
                    contact_json=copy.deepcopy(source_data.get("contact_json") or {}),
                    template_id=source_data.get("template_id"),
                    style_config=copy.deepcopy(source_data.get("style_config") or {}),
                    is_primary=False,
                    language=source_data.get("language") or "zh",
                    source_mode="batch_optimize",
                    source_job_ids=[job_id],
                )
                db.add(new_resume)
                await db.flush()
                for section in source.sections:
                    db.add(
                        ResumeSection(
                            resume_id=new_resume.id,
                            section_type=section.section_type,
                            sort_order=section.sort_order,
                            title=section.title,
                            visible=section.visible,
                            content_json=copy.deepcopy(section.content_json or []),
                        )
                    )
                await db.flush()
                entry["new_resume_id"] = new_resume.id

                cloned = await _get_resume(db, new_resume.id, load_sections=True)
                cloned_data = _resume_dict(cloned)
                pipeline_result = await pipeline.run(
                    resume_text=_flatten_resume_data(cloned_data),
                    resume_data=cloned_data,
                    jd_text=jd_text,
                )
                match_analysis = pipeline_result.get("match_analysis") or {}
                entry["ats_score"] = match_analysis.get("ats_score")
                entry["fact_gates"] = pipeline_result.get("fact_gates") or {}

                if auto_apply and entry["fact_gates"].get("status") != "blocked":
                    applied = 0
                    for suggestion in ((pipeline_result.get("content_rewrite") or {}).get("suggestions") or []):
                        section_title = str(suggestion.get("section_title") or "")
                        original = str(suggestion.get("original") or "")
                        suggested = str(suggestion.get("suggested") or "")
                        if not section_title or not suggested:
                            continue
                        section = next(
                            (item for item in cloned.sections if section_title.lower() in (item.title or "").lower()),
                            None,
                        )
                        if section is None:
                            continue
                        content = list(section.content_json or [])
                        for item in content:
                            if not isinstance(item, dict):
                                continue
                            description = str(item.get("description") or "")
                            plain_description = re.sub(r"<[^>]+>", "", description).strip()
                            plain_original = re.sub(r"<[^>]+>", "", original).strip()
                            if plain_original and plain_original in plain_description:
                                item["description"] = description.replace(original, suggested, 1) if original in description else suggested
                                applied += 1
                                break
                        section.content_json = content

                    for sort_index, section_title in enumerate(
                        ((pipeline_result.get("section_reorder") or {}).get("suggested_order") or [])
                    ):
                        section = next(
                            (item for item in cloned.sections if section_title.lower() in (item.title or "").lower()),
                            None,
                        )
                        if section:
                            section.sort_order = sort_index
                    entry["suggestions_applied"] = applied
                elif auto_apply:
                    entry.update(status="review_required", error="事实校验未通过，未自动应用建议")

                if entry["status"] == "pending":
                    entry["status"] = "success"
                await db.commit()
                try:
                    await auto_write_job_to_total(db, job_id=job_id)
                except Exception as exc:
                    entry["error"] = f"自动写入投递总表失败: {exc}"
            except Exception as exc:
                await db.rollback()
                entry.update(status="failed", error=str(exc))
            results.append(entry)
        return {
            "total": len(job_ids),
            "success": sum(1 for item in results if item.get("status") == "success"),
            "results": results,
        }


def _flatten_resume_data(resume_data: dict[str, Any]) -> str:
    parts: list[str] = []
    if resume_data.get("user_name"):
        parts.append(f"姓名: {resume_data['user_name']}")
    if resume_data.get("summary"):
        parts.append(f"个人简介: {resume_data['summary']}")
    for section in resume_data.get("sections") or []:
        parts.append(f"\n## {section.get('title') or section.get('section_type') or ''}")
        for item in section.get("content_json") or []:
            if isinstance(item, dict):
                label = item.get("title") or item.get("company") or item.get("school") or ""
                if label:
                    parts.append(f"### {label}")
                if item.get("description"):
                    parts.append(str(item["description"]))
                if item.get("items"):
                    parts.append(", ".join(item["items"]) if isinstance(item["items"], list) else str(item["items"]))
            elif isinstance(item, str):
                parts.append(item)
    return "\n".join(parts)


async def create_resume_version_record(
    resume_id: int,
    change_summary: str = "",
    created_by: str = "user",
) -> dict[str, Any]:
    async with async_session() as db:
        resume = await _get_resume(db, resume_id, load_sections=True)
        version = await create_version_snapshot(
            db,
            resume,
            change_summary=change_summary or "手动保存版本",
            created_by=created_by,
        )
        resume.current_version_id = version.id
        pending_proposals = list(
            (
                await db.execute(
                    select(ResumeOptimizationProposal).where(
                        ResumeOptimizationProposal.workspace_resume_id == resume.id,
                        ResumeOptimizationProposal.status.in_(("ready", "in_review")),
                    )
                )
            ).scalars().all()
        )
        for proposal in pending_proposals:
            change_ids = {
                item.get("change_id")
                for item in (proposal.diff_json or [])
                if isinstance(item, dict) and item.get("change_id")
            }
            reviewed_ids = set((proposal.item_reviews_json or {}).keys())
            if change_ids.issubset(reviewed_ids):
                proposal.status = "accepted"
                proposal.accepted_resume_id = resume.id
                proposal.accepted_resume_version_id = version.id
                proposal.reviewed_at = datetime.utcnow()
        await db.commit()
        await db.refresh(version)
        return {
            "id": version.id,
            "resume_id": version.resume_id,
            "version_number": version.version_number,
            "change_summary": version.change_summary,
            "created_by": version.created_by,
            "created_at": version.created_at.isoformat(),
            "is_current": True,
        }


async def restore_resume_version_record(resume_id: int, version_id: int) -> dict[str, Any]:
    async with async_session() as db:
        version = (
            await db.execute(
                select(ResumeVersion).where(
                    ResumeVersion.resume_id == resume_id,
                    ResumeVersion.id == version_id,
                )
            )
        ).scalar_one_or_none()
        if version is None:
            raise ValueError("版本不存在")
        resume = await _get_resume(db, resume_id, load_sections=True)
        backup = await create_version_snapshot(
            db, resume, change_summary="回滚前的备份", created_by="system"
        )
        data = version.content_snapshot or {}
        resume_data = data.get("resume") or {}
        for key in ("user_name", "title", "photo_url", "summary", "contact_json", "template_id", "style_config", "is_primary", "language", "source_mode", "source_job_ids", "source_profile_snapshot", "source_profile_id", "source_resume_id", "target_job_id", "application_id"):
            if key in resume_data:
                setattr(resume, key, resume_data[key])
        for section in list(resume.sections):
            await db.delete(section)
        for row in data.get("sections", []):
            db.add(
                ResumeSection(
                    resume_id=resume_id,
                    section_type=row["section_type"],
                    sort_order=row["sort_order"],
                    title=row["title"],
                    visible=row["visible"],
                    content_json=row["content_json"],
                    source_section_ids=row.get("source_section_ids"),
                )
            )
        resume.current_version_id = version.id
        resume.workspace_revision = int(resume.workspace_revision or 0) + 1
        await db.commit()
        return {"success": True, "message": f"已回滚到版本 {version.version_number}", "backup_version_number": backup.version_number}


async def create_resume_share_record(
    resume_id: int,
    password: str | None = None,
    expires_days: int | None = None,
) -> dict[str, Any]:
    async with async_session() as db:
        await _get_resume(db, resume_id)
        token = secrets.token_urlsafe(32)
        password_hash = None
        if password:
            import bcrypt

            password_hash = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
        expires_at = datetime.utcnow() + timedelta(days=expires_days) if expires_days else None
        share = ResumeShare(
            resume_id=resume_id,
            share_token=token,
            password_hash=password_hash,
            expires_at=expires_at,
            is_active=True,
        )
        db.add(share)
        await db.commit()
        await db.refresh(share)
        return {
            "id": share.id,
            "resume_id": share.resume_id,
            "share_token": share.share_token,
            "share_url": f"{FRONTEND_BASE_URL}/share/{share.share_token}",
            "has_password": bool(share.password_hash),
            "expires_at": share.expires_at.isoformat() if share.expires_at else None,
            "created_at": share.created_at.isoformat(),
        }


async def delete_resume_share_record(share_id: int) -> dict[str, Any]:
    async with async_session() as db:
        share = await db.get(ResumeShare, share_id)
        if share is None:
            raise ValueError("分享链接不存在")
        await db.delete(share)
        await db.commit()
        return {"success": True, "message": "分享链接已删除"}


async def toggle_resume_share_record(share_id: int) -> dict[str, Any]:
    async with async_session() as db:
        share = await db.get(ResumeShare, share_id)
        if share is None:
            raise ValueError("分享链接不存在")
        share.is_active = not share.is_active
        await db.commit()
        return {"success": True, "is_active": share.is_active, "message": f"分享链接已{'启用' if share.is_active else '禁用'}"}


async def access_resume_share_record(share_token: str, password: str | None = None) -> dict[str, Any]:
    async with async_session() as db:
        share = (
            await db.execute(
                select(ResumeShare)
                .options(selectinload(ResumeShare.resume).selectinload(Resume.sections))
                .where(ResumeShare.share_token == share_token)
            )
        ).scalar_one_or_none()
        if share is None:
            raise ValueError("分享链接不存在或已失效")
        if not share.is_active:
            raise ValueError("分享链接已被禁用")
        if share.expires_at and datetime.utcnow() > share.expires_at:
            raise ValueError("分享链接已过期")
        if share.password_hash:
            if not password:
                raise ValueError("需要密码")
            import bcrypt

            if not bcrypt.checkpw(password.encode("utf-8"), share.password_hash.encode("utf-8")):
                raise ValueError("密码错误")
        share.view_count += 1
        share.last_viewed_at = datetime.utcnow()
        await db.commit()
        resume = share.resume
        return {
            "resume": {
                "id": resume.id,
                "user_name": resume.user_name,
                "title": resume.title,
                "photo_url": resume.photo_url,
                "summary": resume.summary,
                "contact_json": resume.contact_json,
                "template_id": resume.template_id,
                "style_config": resume.style_config,
                "language": resume.language,
            },
            "sections": [
                {
                    "id": section.id,
                    "section_type": section.section_type,
                    "sort_order": section.sort_order,
                    "title": section.title,
                    "visible": section.visible,
                    "content_json": section.content_json,
                }
                for section in sorted(resume.sections, key=lambda item: item.sort_order)
            ],
        }


async def save_resume_draft_record(**payload: Any) -> dict[str, Any]:
    return save_resume_draft(**payload)


__all__ = [name for name in globals() if not name.startswith("_")]
