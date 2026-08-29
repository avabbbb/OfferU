"""Canonical Profile mutation implementations for all control-plane consumers.

The profile routes are compatibility adapters.  They may validate transport
payloads and render responses, but profile writes live here so the Operation
Registry remains the only business mutation gateway.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta
from typing import Any, Optional

from sqlalchemy import func, select

from app.agents.llm import chat_completion, extract_json
from app.database import async_session
from app.models.models import (
    Profile,
    ProfileChatSession,
    ProfileSection,
    ProfileTargetRole,
    SmartFillMapCache,
    SmartFillRun,
    SmartFillRunLog,
)
from app.services.profile_schema import (
    PROFILE_BUILTIN_SECTION_TYPES,
    PROFILE_SECTION_SCHEMA_VERSION,
    canonicalize_profile_section_payload,
    get_category_label,
    is_custom_category_key,
    is_valid_profile_section_type,
    normalize_base_info_payload,
    normalize_section_type_alias,
)

VALID_FITS = {"primary", "secondary", "adjacent"}
VALID_TOPICS = {"education", "experience", "project", "activity", "skill", "general"}
PROFILE_CATEGORY_ORDER = ["education", "experience", "project", "skill", "certificate"]


def _serialize_target_role(role: ProfileTargetRole) -> dict[str, Any]:
    return {
        "id": role.id,
        "profile_id": role.profile_id,
        "role_name": role.role_name,
        "role_level": role.role_level,
        "fit": role.fit,
        "created_at": str(role.created_at),
    }


def _serialize_section(section: ProfileSection) -> dict[str, Any]:
    content_json = section.content_json if isinstance(section.content_json, dict) else {}
    category_key = normalize_section_type_alias(section.section_type)
    if category_key in {"general", "activity", "competition"} or not is_valid_profile_section_type(category_key):
        category_key = "custom:c_legacy"
    category_label = get_category_label(category_key, content_json)
    field_values = content_json.get("field_values") if isinstance(content_json.get("field_values"), dict) else {}
    normalized = content_json.get("normalized") if isinstance(content_json.get("normalized"), dict) else {}
    return {
        "id": section.id,
        "profile_id": section.profile_id,
        "section_type": category_key,
        "raw_section_type": section.section_type,
        "category_key": category_key,
        "category_label": category_label,
        "is_custom_category": is_custom_category_key(category_key),
        "parent_id": section.parent_id,
        "title": section.title,
        "sort_order": section.sort_order,
        "content_json": content_json,
        "field_values": field_values,
        "normalized": normalized,
        "source": section.source,
        "confidence": section.confidence,
        "tier": section.tier,
        "created_at": str(section.created_at),
        "updated_at": str(section.updated_at),
    }


def _serialize_profile(
    profile: Profile,
    roles: list[ProfileTargetRole],
    sections: list[ProfileSection],
) -> dict[str, Any]:
    return {
        "id": profile.id,
        "name": profile.name,
        "headline": profile.headline,
        "exit_story": profile.exit_story,
        "cross_cutting_advantage": profile.cross_cutting_advantage,
        "base_info_json": normalize_base_info_payload(profile.base_info_json),
        "is_default": profile.is_default,
        "created_at": str(profile.created_at),
        "updated_at": str(profile.updated_at),
        "target_roles": [_serialize_target_role(item) for item in roles],
        "sections": [_serialize_section(item) for item in sections],
    }


def _serialize_chat_session(session: ProfileChatSession) -> dict[str, Any]:
    return {
        "id": session.id,
        "profile_id": session.profile_id,
        "topic": session.topic,
        "status": session.status,
        "extracted_bullets_count": session.extracted_bullets_count,
        "created_at": str(session.created_at),
        "updated_at": str(session.updated_at),
    }


async def _get_or_create_default_profile(db) -> Profile:
    profile = (
        await db.execute(
            select(Profile).where(Profile.is_default == True).order_by(Profile.id.asc())
        )
    ).scalars().first()
    if profile:
        return profile
    profile = Profile(
        name="默认档案",
        is_default=True,
        base_info_json=normalize_base_info_payload({"name": ""}),
    )
    db.add(profile)
    await db.flush()
    return profile


async def _load_profile_bundle(db, profile_id: int):
    profile = (await db.execute(select(Profile).where(Profile.id == profile_id))).scalar_one_or_none()
    if not profile:
        raise ValueError("Profile not found")
    roles = (
        await db.execute(
            select(ProfileTargetRole)
            .where(ProfileTargetRole.profile_id == profile_id)
            .order_by(ProfileTargetRole.created_at.desc())
        )
    ).scalars().all()
    sections = (
        await db.execute(
            select(ProfileSection)
            .where(ProfileSection.profile_id == profile_id)
            .where(ProfileSection.status == "active")
            .order_by(ProfileSection.sort_order.asc(), ProfileSection.created_at.asc())
        )
    ).scalars().all()
    return profile, roles, sections


def _normalize_candidate(topic: str, candidate: dict[str, Any]) -> dict[str, Any]:
    section_type = normalize_section_type_alias(
        str(candidate.get("section_type") or topic or "general").strip().lower()
    )
    category_label: Optional[str] = None
    if section_type in {"general", "activity", "competition"} or not is_valid_profile_section_type(section_type):
        section_type = "custom"
        category_label = "自定义分类"
    title = str(candidate.get("title") or "未命名条目").strip()[:220]
    content_json = candidate.get("content_json")
    if not isinstance(content_json, dict):
        content_json = {"bullet": str(candidate.get("content") or candidate.get("bullet") or "").strip()}
    try:
        category_key, resolved_label, _, canonical_content_json = canonicalize_profile_section_payload(
            section_type=section_type,
            category_label=category_label,
            title=title,
            raw_content_json=content_json,
        )
    except ValueError:
        category_key, resolved_label, _, canonical_content_json = canonicalize_profile_section_payload(
            section_type="custom",
            category_label="自定义分类",
            title=title,
            raw_content_json=content_json,
        )
    try:
        confidence = float(candidate.get("confidence", 0.7))
    except (TypeError, ValueError):
        confidence = 0.7
    return {
        "section_type": category_key,
        "category_label": resolved_label,
        "title": title,
        "content_json": canonical_content_json,
        "confidence": min(max(confidence, 0.0), 1.0),
    }


def _html_to_plain_text(html: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html or "")).strip()


def _build_archive_entry(
    section_type: str,
    category_label: str,
    title: str,
    normalized: dict[str, Any],
) -> tuple[str, str, dict[str, Any]] | None:
    if section_type == "custom:c_internship":
        description = normalized.get("description", "")
        bullet = " | ".join(
            [normalized.get("company", ""), normalized.get("position", ""), description]
        ).strip(" |")
        return (
            section_type,
            title,
            {
                "schema_version": PROFILE_SECTION_SCHEMA_VERSION,
                "category_key": section_type,
                "category_label": category_label,
                "field_values": {
                    f"{section_type}.subtitle": title,
                    f"{section_type}.description": description,
                },
                "normalized": normalized,
                "bullet": bullet,
                "title": title,
            },
        )
    try:
        resolved_type, _, _, content_json = canonicalize_profile_section_payload(
            section_type=section_type,
            title=title,
            raw_content_json={"normalized": normalized},
            category_label=category_label,
        )
    except ValueError:
        return None
    return resolved_type, title, content_json


async def _sync_personal_archive_to_sections(profile: Profile, db) -> int:
    base_info = profile.base_info_json or {}
    archive = base_info.get("personal_archive") if isinstance(base_info, dict) else None
    if not isinstance(archive, dict) or archive.get("schemaVersion") != "personal.archive.v1":
        return 0
    resume_archive = archive.get("resumeArchive")
    if not isinstance(resume_archive, dict):
        return 0

    await db.execute(
        ProfileSection.__table__.delete().where(
            ProfileSection.profile_id == profile.id,
            ProfileSection.source == "archive_sync",
        )
    )
    entries: list[tuple[str, str, dict[str, Any]]] = []

    for item in resume_archive.get("education", []):
        if isinstance(item, dict):
            title = str(item.get("schoolName") or "").strip() or "教育经历"
            normalized = {
                "school": item.get("schoolName", ""),
                "degree": item.get("degree") or item.get("educationLevel") or "",
                "major": item.get("major", ""),
                "start_date": item.get("startDate", ""),
                "end_date": item.get("endDate", ""),
                "gpa": item.get("gpa", ""),
                "description": _html_to_plain_text(item.get("description", "")),
            }
            result = _build_archive_entry("education", "教育经历", title, normalized)
            if result:
                entries.append(result)

    for item in resume_archive.get("workExperiences", []):
        if isinstance(item, dict):
            title = str(item.get("companyName") or "").strip() or "工作经历"
            normalized = {
                "company": item.get("companyName", ""),
                "department": item.get("department", ""),
                "position": item.get("positionName", ""),
                "start_date": item.get("startDate", ""),
                "end_date": item.get("endDate", ""),
                "description": _html_to_plain_text(item.get("description", "")),
            }
            result = _build_archive_entry("experience", "工作经历", title, normalized)
            if result:
                entries.append(result)

    for item in resume_archive.get("internshipExperiences", []):
        if isinstance(item, dict):
            title = str(item.get("companyName") or "").strip() or "实习经历"
            normalized = {
                "company": item.get("companyName", ""),
                "position": item.get("positionName", ""),
                "start_date": item.get("startDate", ""),
                "end_date": item.get("endDate", ""),
                "description": _html_to_plain_text(item.get("description", "")),
                "subtitle": title,
            }
            result = _build_archive_entry("custom:c_internship", "实习经历", title, normalized)
            if result:
                entries.append(result)

    for item in resume_archive.get("projects", []):
        if isinstance(item, dict):
            title = str(item.get("projectName") or "").strip() or "项目经历"
            normalized = {
                "name": item.get("projectName", ""),
                "role": item.get("projectRole", ""),
                "url": item.get("projectLink", ""),
                "start_date": item.get("startDate", ""),
                "end_date": item.get("endDate", ""),
                "description": _html_to_plain_text(item.get("description", "")),
            }
            result = _build_archive_entry("project", "项目经历", title, normalized)
            if result:
                entries.append(result)

    skill_groups: dict[str, dict[str, list[str]]] = {}
    for item in resume_archive.get("skills", []):
        if not isinstance(item, dict):
            continue
        proficiency = str(item.get("proficiency") or "").strip() or "技能"
        group = skill_groups.setdefault(proficiency, {"names": [], "remarks": []})
        name = str(item.get("skillName") or "").strip()
        remark = str(item.get("remark") or "").strip()
        if name:
            group["names"].append(name)
        if remark:
            group["remarks"].append(remark)
    for proficiency, group in skill_groups.items():
        result = _build_archive_entry(
            "skill",
            "技能与证书",
            proficiency,
            {
                "category": proficiency,
                "items": group["names"],
                "description": "\n".join(group["remarks"]),
            },
        )
        if result:
            entries.append(result)

    for item in resume_archive.get("certificates", []):
        if isinstance(item, dict):
            title = str(item.get("certificateName") or "").strip() or "证书"
            result = _build_archive_entry(
                "certificate",
                "技能与证书",
                title,
                {
                    "name": item.get("certificateName", ""),
                    "issuer": item.get("issuer", ""),
                    "date": item.get("acquiredAt", ""),
                    "score": item.get("scoreOrLevel", ""),
                    "description": item.get("scoreOrLevel", ""),
                },
            )
            if result:
                entries.append(result)

    for item in resume_archive.get("awards", []):
        if isinstance(item, dict):
            title = str(item.get("awardName") or "").strip() or "获奖经历"
            result = _build_archive_entry(
                "custom:c_awards",
                "获奖经历",
                title,
                {
                    "subtitle": title,
                    "description": _html_to_plain_text(item.get("description", "")),
                    "issuer": item.get("issuer", ""),
                    "date": item.get("awardedAt", ""),
                },
            )
            if result:
                entries.append(result)

    for item in resume_archive.get("personalExperiences", []):
        if isinstance(item, dict):
            title = str(item.get("experienceTitle") or "").strip() or "个人经历"
            result = _build_archive_entry(
                "custom:c_personal",
                "个人经历",
                title,
                {
                    "subtitle": title,
                    "description": _html_to_plain_text(item.get("description", "")),
                    "start_date": item.get("startDate", ""),
                    "end_date": item.get("endDate", ""),
                },
            )
            if result:
                entries.append(result)

    for sort_order, (section_type, title, content_json) in enumerate(entries):
        db.add(
            ProfileSection(
                profile_id=profile.id,
                section_type=section_type,
                title=title,
                sort_order=sort_order,
                content_json=content_json,
                source="archive_sync",
                confidence=1.0,
            )
        )
    await db.flush()
    return len(entries)


async def get_legacy_profile() -> dict[str, Any]:
    async with async_session() as db:
        profile = await _get_or_create_default_profile(db)
        normalized = normalize_base_info_payload(profile.base_info_json)
        if profile.base_info_json != normalized:
            profile.base_info_json = normalized
        await db.commit()
        profile, roles, sections = await _load_profile_bundle(db, profile.id)
        return _serialize_profile(profile, roles, sections)


async def list_target_roles() -> list[dict[str, Any]]:
    async with async_session() as db:
        profile = await _get_or_create_default_profile(db)
        roles = (
            await db.execute(
                select(ProfileTargetRole)
                .where(ProfileTargetRole.profile_id == profile.id)
                .order_by(ProfileTargetRole.created_at.desc())
            )
        ).scalars().all()
        await db.commit()
        return [_serialize_target_role(item) for item in roles]


async def list_profile_chat_sessions(limit: int = 20) -> list[dict[str, Any]]:
    async with async_session() as db:
        profile = await _get_or_create_default_profile(db)
        sessions = (
            await db.execute(
                select(ProfileChatSession)
                .where(ProfileChatSession.profile_id == profile.id)
                .order_by(ProfileChatSession.updated_at.desc(), ProfileChatSession.id.desc())
                .limit(limit)
            )
        ).scalars().all()
        await db.commit()
        return [_serialize_chat_session(item) for item in sessions]


async def get_profile_chat_session(session_id: int) -> dict[str, Any]:
    async with async_session() as db:
        profile = await _get_or_create_default_profile(db)
        session = (
            await db.execute(
                select(ProfileChatSession).where(
                    ProfileChatSession.id == session_id,
                    ProfileChatSession.profile_id == profile.id,
                )
            )
        ).scalar_one_or_none()
        if not session:
            raise ValueError("chat session not found")
        messages_json = list(session.messages_json or [])
        return {
            **_serialize_chat_session(session),
            "messages_json": messages_json,
            "latest_candidates": _extract_last_candidates(messages_json),
        }


async def update_profile(
    name: Optional[str] = None,
    headline: Optional[str] = None,
    exit_story: Optional[str] = None,
    cross_cutting_advantage: Optional[str] = None,
    base_info_json: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    async with async_session() as db:
        profile = await _get_or_create_default_profile(db)
        payload = {
            key: value
            for key, value in {
                "name": name,
                "headline": headline,
                "exit_story": exit_story,
                "cross_cutting_advantage": cross_cutting_advantage,
                "base_info_json": base_info_json,
            }.items()
            if value is not None
        }
        if "base_info_json" in payload:
            payload["base_info_json"] = normalize_base_info_payload(payload["base_info_json"])
        for key, value in payload.items():
            setattr(profile, key, value)
        if "base_info_json" in payload:
            await _sync_personal_archive_to_sections(profile, db)
        await db.commit()
        await db.refresh(profile)
        profile, roles, sections = await _load_profile_bundle(db, profile.id)
        return _serialize_profile(profile, roles, sections)


async def create_target_role(
    role_name: str,
    role_level: str = "",
    fit: str = "primary",
) -> dict[str, Any]:
    normalized_fit = fit.strip().lower()
    if normalized_fit not in VALID_FITS:
        raise ValueError("fit must be primary/secondary/adjacent")
    async with async_session() as db:
        profile = await _get_or_create_default_profile(db)
        role = ProfileTargetRole(
            profile_id=profile.id,
            role_name=role_name.strip(),
            role_level=role_level.strip(),
            fit=normalized_fit,
        )
        db.add(role)
        await db.commit()
        await db.refresh(role)
        return _serialize_target_role(role)


async def delete_target_role(role_id: int) -> dict[str, Any]:
    async with async_session() as db:
        profile = await _get_or_create_default_profile(db)
        role = (
            await db.execute(
                select(ProfileTargetRole).where(
                    ProfileTargetRole.id == role_id,
                    ProfileTargetRole.profile_id == profile.id,
                )
            )
        ).scalar_one_or_none()
        if not role:
            raise ValueError("Target role not found")
        await db.delete(role)
        await db.commit()
        return {"deleted": True}


def _canonical_section_payload(
    section_type: str,
    category_label: Optional[str],
    title: str,
    content_json: Optional[dict[str, Any]],
    tier: Optional[str] = None,
) -> tuple[str, str, dict[str, Any]]:
    normalized_type = normalize_section_type_alias(section_type)
    if normalized_type in {"general", "activity", "competition"} or not is_valid_profile_section_type(normalized_type):
        normalized_type = "custom"
    resolved_type, resolved_label, _, canonical = canonicalize_profile_section_payload(
        section_type=normalized_type,
        category_label=category_label,
        title=title,
        raw_content_json=content_json or {},
        tier=tier,
    )
    return resolved_type, resolved_label, canonical


async def create_profile_section(
    section_type: str,
    category_label: Optional[str] = None,
    title: str = "",
    sort_order: int = 0,
    content_json: Optional[dict[str, Any]] = None,
    source: str = "manual",
    confidence: float = 1.0,
    tier: Optional[str] = None,
) -> dict[str, Any]:
    async with async_session() as db:
        profile = await _get_or_create_default_profile(db)
        resolved_type, resolved_label, canonical = _canonical_section_payload(
            section_type, category_label, title.strip(), content_json, tier
        )
        if source == "onboarding":
            existing_sections = (
                await db.execute(
                    select(ProfileSection).where(
                        ProfileSection.profile_id == profile.id,
                        ProfileSection.source == source,
                        ProfileSection.section_type == resolved_type,
                        ProfileSection.title == (title.strip() or get_category_label(resolved_type, canonical)),
                        ProfileSection.status == "active",
                    )
                )
            ).scalars().all()
            for existing in existing_sections:
                if (existing.content_json or {}) == canonical:
                    return _serialize_section(existing)
        if sort_order <= 0:
            max_sort = (
                await db.execute(
                    select(func.max(ProfileSection.sort_order)).where(
                        ProfileSection.profile_id == profile.id
                    )
                )
            ).scalar()
            sort_order = int(max_sort or 0) + 1
        section = ProfileSection(
            profile_id=profile.id,
            section_type=resolved_type,
            title=title.strip() or get_category_label(resolved_type, canonical),
            sort_order=sort_order,
            content_json=canonical,
            source=source,
            confidence=confidence,
            tier=canonical.get("tier"),
        )
        db.add(section)
        await db.commit()
        await db.refresh(section)
        try:
            from app.services.semantic_search import get_semantic_search

            await get_semantic_search().index_profile_section(
                section_id=section.id,
                title=section.title or "",
                bullet_text=str(canonical.get("bullet") or ""),
                profile_id=profile.id,
            )
        except Exception:
            pass
        return _serialize_section(section)


async def update_profile_section(
    section_id: int,
    section_type: Optional[str] = None,
    category_label: Optional[str] = None,
    title: Optional[str] = None,
    sort_order: Optional[int] = None,
    content_json: Optional[dict[str, Any]] = None,
    source: Optional[str] = None,
    confidence: Optional[float] = None,
) -> dict[str, Any]:
    async with async_session() as db:
        profile = await _get_or_create_default_profile(db)
        section = (
            await db.execute(
                select(ProfileSection).where(
                    ProfileSection.id == section_id,
                    ProfileSection.profile_id == profile.id,
                )
            )
        ).scalar_one_or_none()
        if not section:
            raise ValueError("Profile section not found")
        next_title = str(title if title is not None else section.title or "").strip()
        resolved_type, _, canonical = _canonical_section_payload(
            section_type or section.section_type,
            category_label,
            next_title,
            content_json if content_json is not None else section.content_json,
        )
        section.section_type = resolved_type
        section.title = next_title or get_category_label(resolved_type, canonical)
        section.content_json = canonical
        if sort_order is not None:
            section.sort_order = int(sort_order)
        if source is not None:
            section.source = source
        if confidence is not None:
            section.confidence = float(confidence)
        await db.commit()
        await db.refresh(section)
        try:
            from app.services.semantic_search import get_semantic_search

            await get_semantic_search().index_profile_section(
                section_id=section.id,
                title=section.title or "",
                bullet_text=str(canonical.get("bullet") or ""),
                profile_id=profile.id,
            )
        except Exception:
            pass
        return _serialize_section(section)


async def delete_profile_section(section_id: int) -> dict[str, Any]:
    async with async_session() as db:
        profile = await _get_or_create_default_profile(db)
        section = (
            await db.execute(
                select(ProfileSection).where(
                    ProfileSection.id == section_id,
                    ProfileSection.profile_id == profile.id,
                )
            )
        ).scalar_one_or_none()
        if not section:
            raise ValueError("Profile section not found")
        await db.delete(section)
        await db.commit()
        return {"deleted": True}


async def save_profile_chat_turn(
    topic: str,
    user_message: str,
    assistant_message: str,
    candidates: list[dict[str, Any]],
    topic_complete: bool = False,
    session_id: Optional[int] = None,
) -> dict[str, Any]:
    if topic not in VALID_TOPICS:
        raise ValueError("invalid topic")
    async with async_session() as db:
        profile = await _get_or_create_default_profile(db)
        session = None
        if session_id is not None:
            session = (
                await db.execute(
                    select(ProfileChatSession).where(
                        ProfileChatSession.id == session_id,
                        ProfileChatSession.profile_id == profile.id,
                    )
                )
            ).scalar_one_or_none()
            if not session:
                raise ValueError("chat session not found")
        else:
            session = ProfileChatSession(
                profile_id=profile.id,
                topic=topic,
                status="active",
                messages_json=[],
                extracted_bullets_count=0,
            )
            db.add(session)
            await db.flush()
        messages_json = list(session.messages_json or [])
        messages_json.extend(
            [
                {"role": "user", "topic": topic, "content": user_message},
                {"role": "assistant", "topic": topic, "content": assistant_message},
                {"kind": "bullet_candidates", "topic": topic, "candidates": candidates},
            ]
        )
        session.topic = topic
        session.messages_json = messages_json
        session.extracted_bullets_count = int(session.extracted_bullets_count or 0) + len(candidates)
        await db.commit()
        await db.refresh(session)
        return {
            "session_id": session.id,
            "assistant_message": assistant_message,
            "candidates": candidates,
            "topic_complete": topic_complete,
        }


def _extract_last_candidates(messages_json: list[Any]) -> list[dict[str, Any]]:
    for item in reversed(messages_json or []):
        if isinstance(item, dict) and item.get("kind") == "bullet_candidates":
            candidates = item.get("candidates")
            if isinstance(candidates, list):
                return [item for item in candidates if isinstance(item, dict)]
    return []


async def confirm_profile_bullet(
    session_id: int,
    bullet_index: int,
    edits: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    async with async_session() as db:
        profile = await _get_or_create_default_profile(db)
        session = (
            await db.execute(
                select(ProfileChatSession).where(
                    ProfileChatSession.id == session_id,
                    ProfileChatSession.profile_id == profile.id,
                )
            )
        ).scalar_one_or_none()
        if not session:
            raise ValueError("chat session not found")
        candidates = _extract_last_candidates(session.messages_json or [])
        if bullet_index >= len(candidates):
            raise ValueError("bullet_index out of range")
        candidate = dict(candidates[bullet_index])
        for key in ("section_type", "title", "content_json", "confidence"):
            if isinstance(edits, dict) and key in edits:
                candidate[key] = edits[key]
        candidate = _normalize_candidate(session.topic or "general", candidate)
        existing_sections = (
            await db.execute(
                select(ProfileSection)
                .where(
                    ProfileSection.profile_id == profile.id,
                    ProfileSection.section_type == candidate["section_type"],
                    ProfileSection.title == candidate["title"],
                    ProfileSection.status == "active",
                )
                .order_by(ProfileSection.id.desc())
            )
        ).scalars().all()
        for existing in existing_sections:
            if (existing.content_json or {}) == candidate["content_json"]:
                return _serialize_section(existing)
        max_sort = (
            await db.execute(
                select(func.max(ProfileSection.sort_order)).where(
                    ProfileSection.profile_id == profile.id
                )
            )
        ).scalar()
        section = ProfileSection(
            profile_id=profile.id,
            section_type=candidate["section_type"],
            title=candidate["title"],
            sort_order=int(max_sort or 0) + 1,
            content_json=candidate["content_json"],
            source="ai_chat",
            confidence=candidate["confidence"],
        )
        db.add(section)
        await db.commit()
        await db.refresh(section)
        return _serialize_section(section)


async def save_profile_resume_import(
    filename: str,
    parse_mode: str,
    parsed_text: str,
    parse_diagnostics: dict[str, Any],
    base_info: dict[str, Any],
    candidates: list[dict[str, Any]],
    agent_messages_json: list[dict[str, Any]],
    memory_summary: dict[str, Any],
) -> dict[str, Any]:
    async with async_session() as db:
        profile = await _get_or_create_default_profile(db)
        session = ProfileChatSession(
            profile_id=profile.id,
            topic="general",
            status="completed",
            messages_json=[
                {
                    "role": "assistant",
                    "topic": "general",
                    "content": "已从上传简历中提取候选条目，请逐条确认后入库。",
                },
                {
                    "kind": "resume_import_meta",
                    "filename": filename,
                    "text_length": len(parsed_text),
                    "parse_mode": parse_mode,
                    "base_info": base_info,
                    "parse_diagnostics": parse_diagnostics,
                },
                memory_summary,
                {"kind": "bullet_candidates", "topic": "general", "candidates": candidates},
            ],
            extracted_bullets_count=len(candidates),
        )
        agent_session = ProfileChatSession(
            profile_id=profile.id,
            topic="profile_builder",
            status="active",
            messages_json=agent_messages_json,
            extracted_bullets_count=len(candidates),
        )
        db.add_all([session, agent_session])
        await db.commit()
        await db.refresh(session)
        await db.refresh(agent_session)
        return {
            "session_id": session.id,
            "agent_session_id": agent_session.id,
            "filename": filename,
            "parse_mode": parse_mode,
            "text_length": len(parsed_text),
            "parse_diagnostics": parse_diagnostics,
            "base_info": base_info,
            "bullets": [
                {"index": index, "session_id": session.id, **candidate}
                for index, candidate in enumerate(candidates)
            ],
        }


async def generate_profile_narrative() -> dict[str, Any]:
    async with async_session() as db:
        profile = await _get_or_create_default_profile(db)
        sections = (
            await db.execute(
                select(ProfileSection)
                .where(ProfileSection.profile_id == profile.id)
                .where(ProfileSection.status == "active")
                .order_by(ProfileSection.sort_order.asc(), ProfileSection.created_at.asc())
            )
        ).scalars().all()
        context = "\n".join(
            f"[{item.section_type}] {item.title} {json.dumps(item.content_json, ensure_ascii=False)}"
            for item in sections[:30]
        ) or "暂无条目"
        prompt = (
            "你是求职档案叙事助手。根据给定档案条目，生成严格 JSON: "
            "{\"headline\": string, \"exit_story\": string, "
            "\"cross_cutting_advantage\": string}。不要编造事实，措辞简洁。"
        )
        try:
            raw = await chat_completion(
                messages=[
                    {"role": "system", "content": prompt},
                    {"role": "user", "content": context},
                ],
                temperature=0.3,
                json_mode=True,
                max_tokens=800,
                tier="fast",
            )
            parsed = extract_json(raw or "")
        except Exception:
            parsed = None
        if not isinstance(parsed, dict):
            parsed = {
                "headline": profile.headline or "正在构建中的求职者",
                "exit_story": profile.exit_story or "基于现有经历，持续补全并打磨个人叙事。",
                "cross_cutting_advantage": profile.cross_cutting_advantage or "学习快、执行稳、可迁移能力强。",
            }
        profile.headline = str(parsed.get("headline") or profile.headline or "")
        profile.exit_story = str(parsed.get("exit_story") or profile.exit_story or "")
        profile.cross_cutting_advantage = str(
            parsed.get("cross_cutting_advantage") or profile.cross_cutting_advantage or ""
        )
        await db.commit()
        await db.refresh(profile)
        return {
            "headline": profile.headline,
            "exit_story": profile.exit_story,
            "cross_cutting_advantage": profile.cross_cutting_advantage,
        }


async def save_smart_fill_cache(
    cache_key: str,
    adapter_id: str = "unknown",
    model_signature: str = "",
    ttl_seconds: int = 300,
    mappings: Optional[list[dict[str, Any]]] = None,
    channel: str = "backend",
    fallback_used: bool = False,
    run_id: Optional[str] = None,
) -> dict[str, Any]:
    now = datetime.utcnow()
    expires_at = now + timedelta(seconds=max(30, min(7200, ttl_seconds)))
    async with async_session() as db:
        row = (
            await db.execute(
                select(SmartFillMapCache).where(SmartFillMapCache.cache_key == cache_key)
            )
        ).scalar_one_or_none()
        if row:
            row.adapter_id = adapter_id or "unknown"
            row.model_signature = model_signature or ""
            row.mappings_json = mappings or []
            row.channel = channel or "backend"
            row.fallback_used = bool(fallback_used)
            row.expires_at = expires_at
            if run_id:
                row.run_id = run_id
        else:
            db.add(
                SmartFillMapCache(
                    cache_key=cache_key,
                    adapter_id=adapter_id or "unknown",
                    model_signature=model_signature or "",
                    mappings_json=mappings or [],
                    channel=channel or "backend",
                    fallback_used=bool(fallback_used),
                    expires_at=expires_at,
                    run_id=run_id or None,
                )
            )
        await db.commit()
        return {"ok": True, "saved": True}


async def save_smart_fill_run_logs(
    run_id: str,
    logs: list[dict[str, Any]],
) -> dict[str, Any]:
    async with async_session() as db:
        run = (
            await db.execute(select(SmartFillRun).where(SmartFillRun.run_id == run_id))
        ).scalar_one_or_none()
        if not run:
            run = SmartFillRun(run_id=run_id, status="running", summary_json={})
            db.add(run)
            await db.flush()
        for item in logs:
            raw_ts = item.get("ts")
            try:
                parsed_ts = datetime.fromisoformat(raw_ts) if raw_ts else datetime.utcnow()
            except (TypeError, ValueError):
                parsed_ts = datetime.utcnow()
            db.add(
                SmartFillRunLog(
                    run_id=run_id,
                    stage=str(item.get("stage") or "unknown"),
                    severity=str(item.get("severity") or "info"),
                    scope=str(item.get("scope") or "run"),
                    message=str(item.get("message") or ""),
                    field_id=str(item.get("fieldId") or ""),
                    payload_json=item.get("payload") if isinstance(item.get("payload"), dict) else {},
                    ts=parsed_ts,
                )
            )
        run.updated_at = datetime.utcnow()
        await db.commit()
        return {"ok": True, "inserted": len(logs)}


async def start_smart_fill_run(run_id: str) -> dict[str, Any]:
    async with async_session() as db:
        existing = (
            await db.execute(select(SmartFillRun).where(SmartFillRun.run_id == run_id))
        ).scalar_one_or_none()
        if existing:
            return {"run_id": run_id, "status": existing.status, "reused": True}
        db.add(SmartFillRun(run_id=run_id, status="running", summary_json={}))
        await db.commit()
        return {"run_id": run_id, "status": "running", "reused": False}


async def complete_smart_fill_run(
    run_id: str,
    status: str,
    summary: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    if status not in {"success", "failed", "cancelled"}:
        raise ValueError("invalid SmartFill run status")
    async with async_session() as db:
        run = (
            await db.execute(select(SmartFillRun).where(SmartFillRun.run_id == run_id))
        ).scalar_one_or_none()
        if not run:
            raise ValueError("SmartFill run not found")
        run.status = status
        run.summary_json = summary or {}
        run.updated_at = datetime.utcnow()
        await db.commit()
        return {"run_id": run_id, "status": status, "summary": run.summary_json}
