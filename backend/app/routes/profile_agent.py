from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import re
from typing import Any, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.llm import chat_completion, extract_json
from app.database import get_db
from app.models.models import ProfileChatSession, ProfileSection, ProfileTargetRole
from app.routes.profile import (
    _extract_resume_base_info,
    _extract_resume_candidates,
    _get_or_create_default_profile,
    _load_profile_bundle,
    _serialize_profile,
)
from app.services.profile_builder_agent import (
    FIELD_LABELS,
    build_initial_agent_state,
    build_next_question,
    build_profile_agent_system_prompt,
    normalize_profile_agent_patch,
    run_profile_agent_loop,
)
from app.services.profile_schema import normalize_base_info_payload
from app.services.resume_parser import parse_resume_file

router = APIRouter()

MAX_AGENT_RESUME_FILE_SIZE = 10 * 1024 * 1024
PROFILE_AGENT_TOPIC = "profile_builder"
PERSONAL_ARCHIVE_SCHEMA_VERSION = "personal.archive.v1"


class ProfileAgentMessageRequest(BaseModel):
    session_id: int
    message: str = Field(..., min_length=1, max_length=8000)


class ProfileAgentApplyRequest(BaseModel):
    session_id: int
    patch: Optional[dict[str, Any]] = None


def _profile_agent_item(kind: str, **payload: Any) -> dict[str, Any]:
    return {"kind": kind, "agent": PROFILE_AGENT_TOPIC, **payload}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _as_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _as_str_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [_as_str(item) for item in value if _as_str(item)]
    text = _as_str(value)
    if not text:
        return []
    return [item.strip() for item in re.split(r"[,，、；;\n|]+", text) if item.strip()]


_DESCRIPTION_BULLET_RE = re.compile(r"^\s*(?:[•·●▪◦*+-]|\d+[.)、]|[（(]?\d+[）)])\s*")


def _description_items(value: Any) -> list[str]:
    if isinstance(value, list):
        items: list[str] = []
        for item in value:
            items.extend(_description_items(item))
        return items

    text = _as_str(value)
    if not text:
        return []

    raw_lines = [line.strip() for line in re.split(r"[\r\n]+", text) if line.strip()]
    if not raw_lines:
        return []

    has_explicit_bullets = any(_DESCRIPTION_BULLET_RE.match(line) for line in raw_lines)
    if not has_explicit_bullets:
        return [re.sub(r"\s+", " ", " ".join(raw_lines)).strip()]

    items: list[str] = []
    current = ""
    for line in raw_lines:
        if _DESCRIPTION_BULLET_RE.match(line):
            if current:
                items.append(current.strip())
            current = _DESCRIPTION_BULLET_RE.sub("", line).strip()
        elif current:
            current = f"{current} {line}".strip()
        else:
            current = line

    if current:
        items.append(current.strip())
    return [item for item in items if item]


def _archive_id(prefix: str, seed: str) -> str:
    digest = hashlib.sha1(seed.encode("utf-8")).hexdigest()[:10]
    return f"{prefix}_{digest}"


def _copy_json(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=False))


def _descriptions(value: Any, fallback: str = "") -> list[str]:
    lines = _description_items(value)
    if not lines and fallback:
        lines = _description_items(fallback)
    return lines or [""]


def _default_resume_archive() -> dict[str, Any]:
    return {
        "basicInfo": {
            "name": "",
            "phone": "",
            "email": "",
            "currentCity": "",
            "jobIntention": "",
            "website": "",
            "github": "",
        },
        "personalSummary": "",
        "education": [],
        "workExperiences": [],
        "internshipExperiences": [],
        "projects": [],
        "skills": [],
        "certificates": [],
        "awards": [],
        "personalExperiences": [],
    }


def _default_application_archive(resume_archive: dict[str, Any]) -> dict[str, Any]:
    return {
        "shared": _copy_json(resume_archive),
        "identityContact": {
            "chineseName": _as_str(resume_archive.get("basicInfo", {}).get("name")),
            "englishOrPinyinName": "",
            "phone": _as_str(resume_archive.get("basicInfo", {}).get("phone")),
            "email": _as_str(resume_archive.get("basicInfo", {}).get("email")),
            "gender": "",
            "birthDate": "",
            "nationalityOrRegion": "",
            "idType": "",
            "idNumber": "",
            "currentCity": _as_str(resume_archive.get("basicInfo", {}).get("currentCity")),
            "currentAddress": "",
            "nativePlace": "",
            "householdRegistration": "",
            "ethnicity": "",
            "politicalStatus": "",
            "maritalStatus": "",
        },
        "jobPreference": {
            "expectedPosition": _as_str(resume_archive.get("basicInfo", {}).get("jobIntention")),
            "expectedPositionCategory": "",
            "expectedCities": [
                _as_str(resume_archive.get("basicInfo", {}).get("currentCity"))
            ]
            if _as_str(resume_archive.get("basicInfo", {}).get("currentCity"))
            else [],
            "expectedSalary": "",
            "employmentType": "",
            "availableStartDate": "",
            "currentJobSearchStatus": "",
            "acceptAdjustment": "",
            "acceptBusinessTravel": "",
            "acceptAssignment": "",
            "acceptShiftWork": "",
        },
        "campusFields": {
            "isFreshGraduate": "",
            "graduationDate": "",
            "studentOrigin": "",
            "studentStatus": "",
            "studentId": "",
            "gpa": "",
            "majorRank": "",
            "transcriptRef": None,
            "thesis": "",
            "patent": "",
            "researchExperiences": [],
            "internshipCertificateRef": None,
        },
        "relationshipCompliance": {
            "familyMembers": [],
            "hasRelativeInTargetCompany": "",
            "relativeName": "",
            "relativeRelation": "",
            "relativeDepartment": "",
            "emergencyContactName": "",
            "emergencyContactRelation": "",
            "emergencyContactPhone": "",
            "backgroundCheckAuthorization": "",
            "hasNonCompete": "",
            "healthDeclaration": "",
        },
        "sourceReferral": {
            "sourceChannel": "",
            "referralCode": "",
            "referralName": "",
            "referralEmployeeId": "",
            "referralContact": "",
            "recommenderInfo": "",
            "notes": "",
        },
        "attachments": {
            "resumeZh": None,
            "resumeEn": None,
            "idPhoto": None,
            "lifePhoto": None,
            "transcript": None,
            "graduationCertificate": None,
            "degreeCertificate": None,
            "chsiMaterials": None,
            "internshipCertificate": None,
            "professionalCertificates": None,
            "otherAttachments": [],
        },
    }


def _default_personal_archive() -> dict[str, Any]:
    resume_archive = _default_resume_archive()
    return {
        "schemaVersion": PERSONAL_ARCHIVE_SCHEMA_VERSION,
        "updatedAt": _now_iso(),
        "resumeArchive": resume_archive,
        "applicationArchive": _default_application_archive(resume_archive),
        "syncSettings": {
            "autoSyncEnabled": True,
            "overriddenFieldPaths": [],
        },
    }


def _valid_personal_archive(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    if value.get("schemaVersion") != PERSONAL_ARCHIVE_SCHEMA_VERSION:
        return None
    return _copy_json(value)


def _section_normalized(item: dict[str, Any]) -> dict[str, Any]:
    content = item.get("content_json") if isinstance(item.get("content_json"), dict) else {}
    normalized = content.get("normalized") if isinstance(content.get("normalized"), dict) else None
    return normalized if isinstance(normalized, dict) else content


def _append_unique(target: list[dict[str, Any]], entry: dict[str, Any], identity_keys: tuple[str, ...]) -> None:
    identity = tuple(_as_str(entry.get(key)) for key in identity_keys)
    if any(tuple(_as_str(existing.get(key)) for key in identity_keys) == identity for existing in target):
        return
    target.append(entry)


def _merge_archive_section(resume_archive: dict[str, Any], section: dict[str, Any]) -> None:
    if not isinstance(section, dict):
        return
    section_type = _as_str(section.get("section_type")).lower()
    title = _as_str(section.get("title"))
    content = section.get("content_json") if isinstance(section.get("content_json"), dict) else {}
    normalized = _section_normalized(section)
    category_label = _as_str(section.get("category_label") or content.get("category_label"))
    hint = f"{section_type} {title} {category_label}".lower()
    bullet = _as_str(content.get("bullet"))

    if section_type == "education":
        entry = {
            "id": _archive_id("edu", title + json.dumps(normalized, ensure_ascii=False)),
            "schoolName": _as_str(normalized.get("school") or normalized.get("school_name") or title),
            "educationLevel": _as_str(normalized.get("degree")),
            "degree": _as_str(normalized.get("degree")),
            "major": _as_str(normalized.get("major")),
            "startDate": _as_str(normalized.get("start_date")),
            "endDate": _as_str(normalized.get("end_date")),
            "gpa": _as_str(normalized.get("gpa")),
            "relatedCourses": _as_str_list(normalized.get("related_courses")),
            "descriptions": _descriptions(normalized.get("description"), bullet),
        }
        _append_unique(resume_archive["education"], entry, ("schoolName", "degree", "major"))
        return

    if section_type == "experience":
        entry = {
            "id": _archive_id("intern" if "实习" in hint else "work", title + json.dumps(normalized, ensure_ascii=False)),
            "companyName": _as_str(normalized.get("company") or title),
            "positionName": _as_str(normalized.get("position")),
            "startDate": _as_str(normalized.get("start_date")),
            "endDate": _as_str(normalized.get("end_date")),
            "descriptions": _descriptions(normalized.get("description"), bullet),
        }
        if "实习" in hint or "intern" in hint:
            _append_unique(resume_archive["internshipExperiences"], entry, ("companyName", "positionName"))
        else:
            entry["department"] = _as_str(normalized.get("department"))
            _append_unique(resume_archive["workExperiences"], entry, ("companyName", "positionName"))
        return

    if section_type == "project":
        entry = {
            "id": _archive_id("proj", title + json.dumps(normalized, ensure_ascii=False)),
            "projectName": _as_str(normalized.get("name") or title),
            "projectRole": _as_str(normalized.get("role")),
            "startDate": _as_str(normalized.get("start_date")),
            "endDate": _as_str(normalized.get("end_date")),
            "projectLink": _as_str(normalized.get("url")),
            "descriptions": _descriptions(normalized.get("description"), bullet),
        }
        _append_unique(resume_archive["projects"], entry, ("projectName", "projectRole"))
        return

    if section_type == "skill":
        skills = _as_str_list(normalized.get("items")) or _as_str_list(bullet) or [_as_str(normalized.get("category") or title)]
        for skill_name in skills:
            entry = {
                "id": _archive_id("skill", skill_name),
                "skillName": skill_name,
                "proficiency": "",
                "remark": "",
            }
            _append_unique(resume_archive["skills"], entry, ("skillName",))
        return

    if section_type == "certificate":
        entry = {
            "id": _archive_id("cert", title + json.dumps(normalized, ensure_ascii=False)),
            "certificateName": _as_str(normalized.get("name") or title),
            "scoreOrLevel": _as_str(normalized.get("score")),
            "acquiredAt": _as_str(normalized.get("date")),
            "issuer": _as_str(normalized.get("issuer")),
        }
        _append_unique(resume_archive["certificates"], entry, ("certificateName", "issuer"))
        return

    if "award" in hint or "奖" in hint:
        entry = {
            "id": _archive_id("award", title + bullet),
            "awardName": title or "获奖经历",
            "issuer": _as_str(normalized.get("issuer")),
            "awardedAt": _as_str(normalized.get("date")),
            "descriptions": _descriptions(normalized.get("description"), bullet),
        }
        _append_unique(resume_archive["awards"], entry, ("awardName", "issuer"))
        return

    entry = {
        "id": _archive_id("personal", title + bullet),
        "experienceTitle": title or "个人经历",
        "startDate": _as_str(normalized.get("start_date")),
        "endDate": _as_str(normalized.get("end_date")),
        "descriptions": _descriptions(normalized.get("description"), bullet),
    }
    _append_unique(resume_archive["personalExperiences"], entry, ("experienceTitle",))


def build_personal_archive_from_agent_patch(
    *,
    existing_base_info: dict[str, Any] | None,
    patch: dict[str, Any],
    existing_archive: dict[str, Any] | None = None,
) -> dict[str, Any]:
    archive = _valid_personal_archive(existing_archive) or _default_personal_archive()
    resume_archive = archive.get("resumeArchive") if isinstance(archive.get("resumeArchive"), dict) else {}
    if not resume_archive:
        resume_archive = _default_resume_archive()
        archive["resumeArchive"] = resume_archive

    base = existing_base_info if isinstance(existing_base_info, dict) else {}
    patch_base = patch.get("base_info") if isinstance(patch.get("base_info"), dict) else {}
    merged_base = {**base, **patch_base}
    basic = resume_archive.setdefault("basicInfo", _default_resume_archive()["basicInfo"])
    basic["name"] = _as_str(merged_base.get("name") or basic.get("name"))
    basic["phone"] = _as_str(merged_base.get("phone") or basic.get("phone"))
    basic["email"] = _as_str(merged_base.get("email") or basic.get("email"))
    basic["currentCity"] = _as_str(merged_base.get("current_city") or merged_base.get("currentCity") or basic.get("currentCity"))
    basic["jobIntention"] = _as_str(
        merged_base.get("job_intention")
        or merged_base.get("jobIntention")
        or (patch.get("target_roles") or [""])[0]
        or basic.get("jobIntention")
    )
    basic["website"] = _as_str(merged_base.get("website") or basic.get("website"))
    basic["github"] = _as_str(merged_base.get("github") or basic.get("github"))
    resume_archive["personalSummary"] = _as_str(
        merged_base.get("summary")
        or merged_base.get("personal_summary")
        or resume_archive.get("personalSummary")
    )

    for key in (
        "education",
        "workExperiences",
        "internshipExperiences",
        "projects",
        "skills",
        "certificates",
        "awards",
        "personalExperiences",
    ):
        if not isinstance(resume_archive.get(key), list):
            resume_archive[key] = []

    for section in patch.get("sections") or []:
        _merge_archive_section(resume_archive, section)

    archive["schemaVersion"] = PERSONAL_ARCHIVE_SCHEMA_VERSION
    archive["updatedAt"] = _now_iso()
    archive["resumeArchive"] = resume_archive
    archive["applicationArchive"] = _default_application_archive(resume_archive)
    sync_settings = archive.get("syncSettings") if isinstance(archive.get("syncSettings"), dict) else {}
    archive["syncSettings"] = {
        "autoSyncEnabled": bool(sync_settings.get("autoSyncEnabled", True)),
        "overriddenFieldPaths": sync_settings.get("overriddenFieldPaths")
        if isinstance(sync_settings.get("overriddenFieldPaths"), list)
        else [],
    }
    return archive


def _extract_agent_state(messages_json: list[Any]) -> dict[str, Any]:
    for item in reversed(messages_json or []):
        if isinstance(item, dict) and item.get("kind") == "profile_agent_state":
            state = item.get("state")
            if isinstance(state, dict):
                return state
    return build_initial_agent_state(resume_text="")


def _extract_pending_patch(messages_json: list[Any]) -> dict[str, Any] | None:
    for item in reversed(messages_json or []):
        if isinstance(item, dict) and item.get("kind") == "profile_agent_patch":
            patch = item.get("patch")
            if isinstance(patch, dict) and not item.get("applied"):
                return patch
    return None


def _update_missing_after_patch(state: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    next_state = dict(state)
    missing = list(next_state.get("missing_fields") or [])
    if patch.get("target_roles") and "target_role" in missing:
        missing.remove("target_role")
    base_info = patch.get("base_info") if isinstance(patch.get("base_info"), dict) else {}
    if any(base_info.get(key) for key in ("phone", "email")) and "contact_info" in missing:
        missing.remove("contact_info")
    if base_info.get("current_city") and "target_city" in missing:
        missing.remove("target_city")
    section_types = {
        str(item.get("section_type") or "")
        for item in (patch.get("sections") if isinstance(patch.get("sections"), list) else [])
        if isinstance(item, dict)
    }
    if section_types.intersection({"experience", "project"}) and "core_experience" in missing:
        missing.remove("core_experience")
    if "skill" in section_types and "skills" in missing:
        missing.remove("skills")
    if patch.get("sections") and "resume" in missing:
        missing.remove("resume")

    next_state["missing_fields"] = missing
    next_state["missing_field_labels"] = [FIELD_LABELS.get(item, item) for item in missing]
    next_state["next_question"] = build_next_question(missing, next_state.get("goal", {}).get("target_role", ""))
    return next_state


async def _parse_uploaded_resume(file: UploadFile | None) -> tuple[str, str]:
    if file is None or not file.filename:
        return "", ""

    filename = file.filename.strip()
    lower = filename.lower()
    if not (lower.endswith(".pdf") or lower.endswith(".docx") or lower.endswith(".txt")):
        raise HTTPException(status_code=400, detail="unsupported file type, only .pdf/.docx/.txt")

    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(status_code=400, detail="empty file")
    if len(file_bytes) > MAX_AGENT_RESUME_FILE_SIZE:
        raise HTTPException(status_code=400, detail="file too large (max 10MB)")

    if lower.endswith(".txt"):
        return filename, file_bytes.decode("utf-8", errors="ignore")

    parsed_text = await parse_resume_file(filename, file_bytes)
    if not parsed_text or not parsed_text.strip():
        raise HTTPException(status_code=400, detail="resume text is empty")
    return filename, parsed_text


def _build_start_patch(
    *,
    base_info: dict[str, Any],
    target_role: str,
    target_city: str,
    candidates: list[dict[str, Any]],
) -> dict[str, Any]:
    patch_base = dict(base_info)
    if target_role and not patch_base.get("job_intention"):
        patch_base["job_intention"] = target_role
    if target_city and not patch_base.get("current_city"):
        patch_base["current_city"] = target_city
    return normalize_profile_agent_patch(
        {
            "action": "propose_patch" if (patch_base or candidates or target_role) else "ask_user",
            "assistant_message": "我已经读完简历并整理出一版档案草稿。你可以先确认写入，再继续让我追问补强。",
            "base_info": patch_base,
            "target_roles": [target_role] if target_role else [],
            "sections": candidates,
            "next_question": "你最想突出哪段经历，或者要我继续追问缺口？",
            "confidence": 0.75,
        }
    )


async def _generate_raw_turn_patch(state: dict[str, Any], messages_json: list[Any], user_message: str) -> dict[str, Any] | None:
    recent = [
        item
        for item in messages_json[-12:]
        if isinstance(item, dict) and item.get("role") in {"user", "assistant"}
    ]
    prompt = build_profile_agent_system_prompt(state)
    user_payload = {
        "state": state,
        "recent_messages": recent,
        "latest_user_message": user_message,
    }
    try:
        llm_result = await chat_completion(
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
            ],
            temperature=0.25,
            json_mode=True,
            max_tokens=1800,
            tier="standard",
        )
        parsed = extract_json(llm_result or "")
    except Exception:
        parsed = None

    if not isinstance(parsed, dict):
        parsed = {
            "action": "propose_patch" if len(user_message.strip()) >= 8 else "ask_user",
            "assistant_message": "我先把你刚补充的内容整理成一条候选档案，你确认后我再写入。",
            "sections": [
                {
                    "section_type": "custom",
                    "title": "补充经历",
                    "content_json": {"description": user_message.strip(), "bullet": user_message.strip()},
                    "confidence": 0.55,
                }
            ]
            if len(user_message.strip()) >= 8
            else [],
            "next_question": state.get("next_question") or "你可以再补充一段具体经历吗？",
        }

    return parsed


async def _load_agent_session(db: AsyncSession, session_id: int) -> ProfileChatSession:
    profile = await _get_or_create_default_profile(db)
    session = (
        await db.execute(
            select(ProfileChatSession).where(
                ProfileChatSession.id == session_id,
                ProfileChatSession.profile_id == profile.id,
                ProfileChatSession.topic == PROFILE_AGENT_TOPIC,
            )
        )
    ).scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="profile agent session not found")
    return session


async def _apply_patch_to_profile(db: AsyncSession, patch: dict[str, Any]) -> dict[str, Any]:
    profile = await _get_or_create_default_profile(db)
    existing_base_info = profile.base_info_json if isinstance(profile.base_info_json, dict) else {}
    base_info = patch.get("base_info") if isinstance(patch.get("base_info"), dict) else {}
    if base_info:
        merged_base = normalize_base_info_payload({**existing_base_info, **base_info})
        profile.base_info_json = {**existing_base_info, **merged_base, **base_info}
        if base_info.get("name"):
            profile.name = str(base_info["name"])[:120]
        if base_info.get("summary") and not profile.headline:
            profile.headline = str(base_info["summary"])[:300]

    existing_roles = {
        role.role_name
        for role in (
            await db.execute(select(ProfileTargetRole).where(ProfileTargetRole.profile_id == profile.id))
        ).scalars().all()
    }
    for index, role_name in enumerate(patch.get("target_roles") or []):
        role = str(role_name).strip()
        if not role or role in existing_roles:
            continue
        db.add(
            ProfileTargetRole(
                profile_id=profile.id,
                role_name=role[:120],
                role_level="",
                fit="primary" if index == 0 else "secondary",
            )
        )
        existing_roles.add(role)

    applied_sections: list[ProfileSection] = []
    max_sort = (
        await db.execute(select(func.max(ProfileSection.sort_order)).where(ProfileSection.profile_id == profile.id))
    ).scalar()
    next_sort = int(max_sort or 0) + 1

    for item in patch.get("sections") or []:
        if not isinstance(item, dict):
            continue
        existing_sections = (
            await db.execute(
                select(ProfileSection)
                .where(
                    ProfileSection.profile_id == profile.id,
                    ProfileSection.section_type == item["section_type"],
                    ProfileSection.title == item["title"],
                    ProfileSection.status == "active",
                )
                .order_by(ProfileSection.id.desc())
            )
        ).scalars().all()
        duplicate = next(
            (section for section in existing_sections if (section.content_json or {}) == item["content_json"]),
            None,
        )
        if duplicate:
            applied_sections.append(duplicate)
            continue

        section = ProfileSection(
            profile_id=profile.id,
            section_type=item["section_type"],
            title=item["title"],
            sort_order=next_sort,
            content_json=item["content_json"],
            source="ai_profile_agent",
            confidence=float(item.get("confidence") or 0.7),
        )
        next_sort += 1
        db.add(section)
        applied_sections.append(section)

    latest_base_info = profile.base_info_json if isinstance(profile.base_info_json, dict) else existing_base_info
    profile.base_info_json = {
        **latest_base_info,
        "personal_archive": build_personal_archive_from_agent_patch(
            existing_base_info=latest_base_info,
            patch=patch,
            existing_archive=latest_base_info.get("personal_archive") if isinstance(latest_base_info, dict) else None,
        ),
    }

    await db.commit()
    for section in applied_sections:
        await db.refresh(section)

    profile, roles, sections = await _load_profile_bundle(db, profile.id)
    return {
        "applied": True,
        "applied_sections_count": len(applied_sections),
        "profile": _serialize_profile(profile, roles, sections),
    }


@router.post("/start")
async def start_profile_agent(
    target_role: str = Form(default=""),
    target_city: str = Form(default=""),
    job_goal: str = Form(default=""),
    resume_text: str = Form(default=""),
    file: UploadFile | None = File(default=None),
    db: AsyncSession = Depends(get_db),
):
    filename, parsed_text = await _parse_uploaded_resume(file)
    source_text = (parsed_text or resume_text or "").strip()
    profile = await _get_or_create_default_profile(db)

    base_info = _extract_resume_base_info(source_text) if source_text else {}
    candidates = await _extract_resume_candidates(source_text) if source_text else []
    state = build_initial_agent_state(
        resume_text=source_text,
        target_role=target_role,
        target_city=target_city,
        job_goal=job_goal,
        extracted_base_info=base_info,
        resume_candidates=candidates,
    )
    patch = _build_start_patch(
        base_info=base_info,
        target_role=target_role.strip(),
        target_city=target_city.strip(),
        candidates=candidates,
    )

    messages_json = [
        _profile_agent_item(
            "profile_agent_start",
            filename=filename,
            resume_text_length=len(source_text),
            target_role=target_role.strip(),
            target_city=target_city.strip(),
            job_goal=job_goal.strip(),
        ),
        _profile_agent_item("profile_agent_state", state=state),
        {"role": "assistant", "topic": PROFILE_AGENT_TOPIC, "content": patch["assistant_message"]},
        _profile_agent_item("profile_agent_patch", patch=patch, applied=False),
    ]

    session = ProfileChatSession(
        profile_id=profile.id,
        topic=PROFILE_AGENT_TOPIC,
        status="active",
        messages_json=messages_json,
        extracted_bullets_count=len(patch.get("sections") or []),
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)

    return {
        "session_id": session.id,
        "state": state,
        "assistant_message": patch["assistant_message"],
        "patch": patch,
    }


@router.post("/message")
async def continue_profile_agent(data: ProfileAgentMessageRequest, db: AsyncSession = Depends(get_db)):
    session = await _load_agent_session(db, data.session_id)
    messages_json = list(session.messages_json or [])
    state = _extract_agent_state(messages_json)
    user_message = data.message.strip()

    messages_json.append({"role": "user", "topic": PROFILE_AGENT_TOPIC, "content": user_message})
    loop_result = await run_profile_agent_loop(
        state=state,
        messages_json=messages_json,
        user_message=user_message,
        generate_patch=_generate_raw_turn_patch,
    )
    patch = loop_result["patch"]
    next_state = _update_missing_after_patch(state, patch) if patch.get("sections") or patch.get("base_info") else state

    messages_json.append({"role": "assistant", "topic": PROFILE_AGENT_TOPIC, "content": patch["assistant_message"]})
    messages_json.append(_profile_agent_item("profile_agent_patch", patch=patch, applied=False))
    messages_json.append(
        _profile_agent_item(
            "profile_agent_loop",
            trace=loop_result["trace"],
            stop_reason=loop_result["stop_reason"],
        )
    )
    messages_json.append(_profile_agent_item("profile_agent_state", state=next_state))
    session.messages_json = messages_json
    session.extracted_bullets_count = int(session.extracted_bullets_count or 0) + len(patch.get("sections") or [])
    if patch["action"] == "finish":
        session.status = "completed"

    await db.commit()

    return {
        "session_id": session.id,
        "state": next_state,
        "assistant_message": patch["assistant_message"],
        "patch": patch,
        "agent_trace": loop_result["trace"],
        "stop_reason": loop_result["stop_reason"],
    }


@router.post("/apply-patch")
async def apply_profile_agent_patch(data: ProfileAgentApplyRequest, db: AsyncSession = Depends(get_db)):
    session = await _load_agent_session(db, data.session_id)
    messages_json = list(session.messages_json or [])
    raw_patch = data.patch if isinstance(data.patch, dict) else _extract_pending_patch(messages_json)
    if not raw_patch:
        raise HTTPException(status_code=400, detail="no pending patch")

    patch = normalize_profile_agent_patch(raw_patch)
    result = await _apply_patch_to_profile(db, patch)

    for item in reversed(messages_json):
        if isinstance(item, dict) and item.get("kind") == "profile_agent_patch" and not item.get("applied"):
            item["applied"] = True
            break
    messages_json.append(_profile_agent_item("profile_agent_apply", patch=patch, result={"applied": True}))
    session.messages_json = messages_json
    await db.commit()

    return result


@router.get("/sessions/{session_id}")
async def get_profile_agent_session(session_id: int, db: AsyncSession = Depends(get_db)):
    session = await _load_agent_session(db, session_id)
    messages_json = list(session.messages_json or [])
    return {
        "id": session.id,
        "status": session.status,
        "state": _extract_agent_state(messages_json),
        "pending_patch": _extract_pending_patch(messages_json),
        "messages_json": messages_json,
    }
