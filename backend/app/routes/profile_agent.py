from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import re
from typing import Any, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from app.agents.llm import chat_completion, extract_json
from app.routes.profile import (
    _extract_resume_base_info,
    _extract_resume_candidates,
)
from app.services.profile_builder_agent import (
    FIELD_LABELS,
    build_initial_agent_state,
    build_next_question,
    build_profile_agent_system_prompt,
    generate_raw_turn_patch as _generate_raw_turn_patch,
    normalize_profile_agent_patch,
    run_profile_agent_loop,
)
from app.services.profile_archive import build_personal_archive_from_agent_patch as _build_personal_archive
from app.services.resume_parser import parse_resume_file

router = APIRouter()

MAX_AGENT_RESUME_FILE_SIZE = 10 * 1024 * 1024
PROFILE_AGENT_TOPIC = "profile_builder"
PERSONAL_ARCHIVE_SCHEMA_VERSION = "personal.archive.v1"


async def _execute_operation(name: str, args: dict[str, Any]) -> Any:
    from app.ops import execute_operation

    result = await execute_operation(name, args, surface="profile_agent_api")
    if not result.get("ok"):
        detail = "；".join(str(item) for item in result.get("errors") or [])
        status = 404 if "not found" in detail.lower() or "不存在" in detail else 400
        raise HTTPException(status_code=status, detail=detail or "操作失败")
    return result.get("outputs")


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
    return _build_personal_archive(
        existing_base_info=existing_base_info,
        patch=patch,
        existing_archive=existing_archive,
    )


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


@router.post("/start")
async def start_profile_agent(
    target_role: str = Form(default=""),
    target_city: str = Form(default=""),
    job_goal: str = Form(default=""),
    resume_text: str = Form(default=""),
    file: UploadFile | None = File(default=None),
):
    filename, parsed_text = await _parse_uploaded_resume(file)
    source_text = (parsed_text or resume_text or "").strip()

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

    return await _execute_operation(
        "start_profile_agent_session",
        {"state": state, "patch": patch, "messages_json": messages_json},
    )


@router.post("/message")
async def continue_profile_agent(data: ProfileAgentMessageRequest):
    return await _execute_operation(
        "continue_profile_agent_session",
        data.model_dump(),
    )


@router.post("/apply-patch")
async def apply_profile_agent_patch(data: ProfileAgentApplyRequest):
    return await _execute_operation(
        "apply_profile_agent_patch",
        data.model_dump(exclude_none=True),
    )


@router.get("/sessions/{session_id}")
async def get_profile_agent_session(session_id: int):
    return await _execute_operation(
        "get_profile_agent_session",
        {"session_id": session_id},
    )
