"""Route-independent normalization for the Profile personal archive.

The archive is a projection of a reviewed Profile Agent patch.  Keeping the
projection here prevents persistence operations from importing the HTTP route
that originally contained this transformation.
"""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import re
from typing import Any


PERSONAL_ARCHIVE_SCHEMA_VERSION = "personal.archive.v1"
_DESCRIPTION_BULLET_RE = re.compile(r"^\s*(?:[•·●▪◦*+-]|\d+[.)、]|[（(]?\d+[）)])\s*")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _as_str(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _as_str_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [_as_str(item) for item in value if _as_str(item)]
    text = _as_str(value)
    return [item.strip() for item in re.split(r"[,，、；;\n|]+", text) if item.strip()] if text else []


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
    if not any(_DESCRIPTION_BULLET_RE.match(line) for line in raw_lines):
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
            "name": "", "phone": "", "email": "", "currentCity": "",
            "jobIntention": "", "website": "", "github": "",
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
    basic = resume_archive.get("basicInfo", {})
    current_city = _as_str(basic.get("currentCity"))
    return {
        "shared": _copy_json(resume_archive),
        "identityContact": {
            "chineseName": _as_str(basic.get("name")),
            "englishOrPinyinName": "",
            "phone": _as_str(basic.get("phone")),
            "email": _as_str(basic.get("email")),
            "gender": "", "birthDate": "", "nationalityOrRegion": "",
            "idType": "", "idNumber": "", "currentCity": current_city,
            "currentAddress": "", "nativePlace": "", "householdRegistration": "",
            "ethnicity": "", "politicalStatus": "", "maritalStatus": "",
        },
        "jobPreference": {
            "expectedPosition": _as_str(basic.get("jobIntention")),
            "expectedPositionCategory": "",
            "expectedCities": [current_city] if current_city else [],
            "expectedSalary": "", "employmentType": "", "availableStartDate": "",
            "currentJobSearchStatus": "", "acceptAdjustment": "",
            "acceptBusinessTravel": "", "acceptAssignment": "", "acceptShiftWork": "",
        },
        "campusFields": {
            "isFreshGraduate": "", "graduationDate": "", "studentOrigin": "",
            "studentStatus": "", "studentId": "", "gpa": "", "majorRank": "",
            "transcriptRef": None, "thesis": "", "patent": "",
            "researchExperiences": [], "internshipCertificateRef": None,
        },
        "relationshipCompliance": {
            "familyMembers": [], "hasRelativeInTargetCompany": "", "relativeName": "",
            "relativeRelation": "", "relativeDepartment": "", "emergencyContactName": "",
            "emergencyContactRelation": "", "emergencyContactPhone": "",
            "backgroundCheckAuthorization": "", "hasNonCompete": "", "healthDeclaration": "",
        },
        "sourceReferral": {
            "sourceChannel": "", "referralCode": "", "referralName": "",
            "referralEmployeeId": "", "referralContact": "", "recommenderInfo": "", "notes": "",
        },
        "attachments": {
            "resumeZh": None, "resumeEn": None, "idPhoto": None, "lifePhoto": None,
            "transcript": None, "graduationCertificate": None, "degreeCertificate": None,
            "chsiMaterials": None, "internshipCertificate": None,
            "professionalCertificates": None, "otherAttachments": [],
        },
    }


def _default_personal_archive() -> dict[str, Any]:
    resume_archive = _default_resume_archive()
    return {
        "schemaVersion": PERSONAL_ARCHIVE_SCHEMA_VERSION,
        "updatedAt": _now_iso(),
        "resumeArchive": resume_archive,
        "applicationArchive": _default_application_archive(resume_archive),
        "syncSettings": {"autoSyncEnabled": True, "overriddenFieldPaths": []},
    }


def _valid_personal_archive(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict) or value.get("schemaVersion") != PERSONAL_ARCHIVE_SCHEMA_VERSION:
        return None
    return _copy_json(value)


def _section_normalized(item: dict[str, Any]) -> dict[str, Any]:
    content = item.get("content_json") if isinstance(item.get("content_json"), dict) else {}
    normalized = content.get("normalized") if isinstance(content.get("normalized"), dict) else None
    return normalized if isinstance(normalized, dict) else content


def _append_unique(target: list[dict[str, Any]], entry: dict[str, Any], identity_keys: tuple[str, ...]) -> None:
    identity = tuple(_as_str(entry.get(key)) for key in identity_keys)
    if not any(tuple(_as_str(existing.get(key)) for key in identity_keys) == identity for existing in target):
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
            _append_unique(
                resume_archive["skills"],
                {"id": _archive_id("skill", skill_name), "skillName": skill_name, "proficiency": "", "remark": ""},
                ("skillName",),
            )
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
        "education", "workExperiences", "internshipExperiences", "projects",
        "skills", "certificates", "awards", "personalExperiences",
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


__all__ = ["PERSONAL_ARCHIVE_SCHEMA_VERSION", "build_personal_archive_from_agent_patch"]
