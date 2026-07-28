from __future__ import annotations

import hashlib
import re
from typing import Any

PROFILE_SECTION_SCHEMA_VERSION = "profile.section.v1"
PROFILE_BASE_SCHEMA_VERSION = "profile.base.v1"

PROFILE_SECTION_TIERS = {
    "verified_fact",
    "preference",
    "career_hypothesis",
}


def normalize_profile_tier(value: Any) -> str | None:
    tier = (str(value).strip().lower() if value is not None else "")
    if not tier:
        return None
    if tier in PROFILE_SECTION_TIERS:
        return tier
    return None

BASE_INFO_FIELD_IDS = {
    "name": "base.full_name",
    "phone": "base.phone",
    "email": "base.email",
    "linkedin": "base.linkedin_url",
    "github": "base.github_url",
    "website": "base.website_url",
    "summary": "base.summary",
}

PROFILE_BUILTIN_CATEGORY_DEFINITIONS: dict[str, dict[str, Any]] = {
    "education": {
        "label": "教育经历",
        "resume_section_type": "education",
        "fields": {
            "school": {
                "id": "education.school_name",
                "aliases": ["school", "school_name", "schoolName"],
            },
            "degree": {
                "id": "education.degree",
                "aliases": ["degree"],
            },
            "major": {
                "id": "education.major",
                "aliases": ["major"],
            },
            "start_date": {
                "id": "education.start_date",
                "aliases": ["start_date", "startDate"],
            },
            "end_date": {
                "id": "education.end_date",
                "aliases": ["end_date", "endDate"],
            },
            "gpa": {
                "id": "education.gpa",
                "aliases": ["gpa"],
            },
            "description": {
                "id": "education.description",
                "aliases": ["description", "desc"],
            },
        },
    },
    "experience": {
        "label": "工作经历",
        "resume_section_type": "experience",
        "fields": {
            "company": {
                "id": "experience.company_name",
                "aliases": ["company", "company_name", "companyName"],
            },
            "position": {
                "id": "experience.position_title",
                "aliases": ["position", "job_title", "positionTitle"],
            },
            "start_date": {
                "id": "experience.start_date",
                "aliases": ["start_date", "startDate"],
            },
            "end_date": {
                "id": "experience.end_date",
                "aliases": ["end_date", "endDate"],
            },
            "description": {
                "id": "experience.description",
                "aliases": ["description", "desc"],
            },
        },
    },
    "project": {
        "label": "项目经历",
        "resume_section_type": "project",
        "fields": {
            "name": {
                "id": "project.name",
                "aliases": ["name", "project_name", "projectName"],
            },
            "role": {
                "id": "project.role",
                "aliases": ["role"],
            },
            "url": {
                "id": "project.url",
                "aliases": ["url", "link"],
            },
            "start_date": {
                "id": "project.start_date",
                "aliases": ["start_date", "startDate"],
            },
            "end_date": {
                "id": "project.end_date",
                "aliases": ["end_date", "endDate"],
            },
            "description": {
                "id": "project.description",
                "aliases": ["description", "desc"],
            },
        },
    },
    "skill": {
        "label": "技能清单",
        "resume_section_type": "skill",
        "fields": {
            "category": {
                "id": "skill.category",
                "aliases": ["category"],
            },
            "items": {
                "id": "skill.items",
                "aliases": ["items", "skill_items", "skillItems"],
            },
        },
    },
    "certificate": {
        "label": "证书资质",
        "resume_section_type": "certificate",
        "fields": {
            "name": {
                "id": "certificate.name",
                "aliases": ["name", "certificate_name", "certificateName"],
            },
            "issuer": {
                "id": "certificate.issuer",
                "aliases": ["issuer", "organization"],
            },
            "date": {
                "id": "certificate.date",
                "aliases": ["date", "issued_date", "issuedDate"],
            },
            "url": {
                "id": "certificate.url",
                "aliases": ["url", "link"],
            },
        },
    },
}

PROFILE_BUILTIN_SECTION_TYPES = set(PROFILE_BUILTIN_CATEGORY_DEFINITIONS.keys())

LEGACY_SECTION_TYPE_ALIASES: dict[str, str] = {
    "internship": "experience",
    "honor": "skill",
    "language": "skill",
}


def _as_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _as_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    text = str(value).strip()
    if not text:
        return []
    return [item.strip() for item in re.split(r"[,，、\n]", text) if item.strip()]


def is_custom_category_key(category_key: str) -> bool:
    return bool(re.fullmatch(r"custom:[a-z0-9_]{6,64}", (category_key or "").strip().lower()))


def is_valid_profile_section_type(section_type: str) -> bool:
    key = (section_type or "").strip().lower()
    return key in PROFILE_BUILTIN_SECTION_TYPES or is_custom_category_key(key)


def normalize_section_type_alias(section_type: str) -> str:
    key = (section_type or "").strip().lower()
    if key in PROFILE_BUILTIN_SECTION_TYPES:
        return key
    if key in LEGACY_SECTION_TYPE_ALIASES:
        return LEGACY_SECTION_TYPE_ALIASES[key]
    if is_custom_category_key(key):
        return key
    if key == "custom":
        return "custom:c_generic"
    return key


def build_custom_category_key(category_label: str) -> str:
    label = _as_str(category_label)
    if not label:
        return "custom:c_generic"
    digest = hashlib.sha1(label.encode("utf-8")).hexdigest()[:10]
    return f"custom:c_{digest}"


def resolve_category_key(section_type: str, category_label: str | None = None) -> tuple[str, str, bool]:
    raw_key = (section_type or "").strip().lower()
    if raw_key in PROFILE_BUILTIN_SECTION_TYPES:
        return raw_key, PROFILE_BUILTIN_CATEGORY_DEFINITIONS[raw_key]["label"], False

    if is_custom_category_key(raw_key):
        label = _as_str(category_label)
        if not label:
            label = "自定义分类"
        return raw_key, label, True

    if raw_key == "custom":
        key = build_custom_category_key(_as_str(category_label))
        label = _as_str(category_label) or "自定义分类"
        return key, label, True

    raise ValueError("invalid section_type")


def get_category_label(category_key: str, content_json: dict[str, Any] | None = None) -> str:
    key = (category_key or "").strip().lower()
    if key in PROFILE_BUILTIN_CATEGORY_DEFINITIONS:
        return PROFILE_BUILTIN_CATEGORY_DEFINITIONS[key]["label"]

    content = content_json if isinstance(content_json, dict) else {}
    label = _as_str(content.get("category_label"))
    if label:
        return label
    if is_custom_category_key(key):
        return "自定义分类"
    return key or "未分类"


def normalize_base_info_payload(raw_base_info: dict[str, Any] | None) -> dict[str, Any]:
    raw = raw_base_info if isinstance(raw_base_info, dict) else {}
    field_values_in = raw.get("field_values") if isinstance(raw.get("field_values"), dict) else {}

    data = {
        "name": _as_str(raw.get("name") or field_values_in.get(BASE_INFO_FIELD_IDS["name"])),
        "phone": _as_str(raw.get("phone") or field_values_in.get(BASE_INFO_FIELD_IDS["phone"])),
        "email": _as_str(raw.get("email") or field_values_in.get(BASE_INFO_FIELD_IDS["email"])),
        "linkedin": _as_str(raw.get("linkedin") or field_values_in.get(BASE_INFO_FIELD_IDS["linkedin"])),
        "github": _as_str(raw.get("github") or field_values_in.get(BASE_INFO_FIELD_IDS["github"])),
        "website": _as_str(raw.get("website") or field_values_in.get(BASE_INFO_FIELD_IDS["website"])),
        "summary": _as_str(raw.get("summary") or field_values_in.get(BASE_INFO_FIELD_IDS["summary"])),
    }

    field_values = {
        BASE_INFO_FIELD_IDS["name"]: data["name"],
        BASE_INFO_FIELD_IDS["phone"]: data["phone"],
        BASE_INFO_FIELD_IDS["email"]: data["email"],
        BASE_INFO_FIELD_IDS["linkedin"]: data["linkedin"],
        BASE_INFO_FIELD_IDS["github"]: data["github"],
        BASE_INFO_FIELD_IDS["website"]: data["website"],
        BASE_INFO_FIELD_IDS["summary"]: data["summary"],
    }

    return {
        **raw,
        **data,
        "schema_version": PROFILE_BASE_SCHEMA_VERSION,
        "field_values": field_values,
    }


def _pick_value(
    raw: dict[str, Any],
    normalized_in: dict[str, Any],
    field_values_in: dict[str, Any],
    field_id: str,
    aliases: list[str],
) -> Any:
    if field_id in field_values_in:
        return field_values_in[field_id]

    for key in aliases:
        if key in normalized_in and normalized_in[key] is not None:
            return normalized_in[key]

    for key in aliases:
        if key in raw and raw[key] is not None:
            return raw[key]

    return None


def _custom_field_id(category_key: str, leaf: str) -> str:
    safe = re.sub(r"[^a-z0-9]+", "_", category_key.lower()).strip("_")
    safe = safe or "custom"
    return f"{safe}.{leaf}"


def canonicalize_profile_content(
    category_key: str,
    title: str,
    raw_content_json: dict[str, Any] | None,
    *,
    category_label: str | None = None,
    tier: Any = None,
) -> dict[str, Any]:
    raw = raw_content_json if isinstance(raw_content_json, dict) else {}
    field_values_in = raw.get("field_values") if isinstance(raw.get("field_values"), dict) else {}
    normalized_in = raw.get("normalized") if isinstance(raw.get("normalized"), dict) else {}
    resolved_tier = normalize_profile_tier(
        tier if tier is not None else raw.get("tier")
    )

    if category_key in PROFILE_BUILTIN_CATEGORY_DEFINITIONS:
        definition = PROFILE_BUILTIN_CATEGORY_DEFINITIONS[category_key]
        fields = definition["fields"]
        normalized: dict[str, Any] = {}
        field_values: dict[str, Any] = {}

        for field_name, field_def in fields.items():
            picked = _pick_value(
                raw=raw,
                normalized_in=normalized_in,
                field_values_in=field_values_in,
                field_id=field_def["id"],
                aliases=field_def["aliases"],
            )
            if field_name == "items":
                value = _as_list(picked)
            else:
                value = _as_str(picked)
            normalized[field_name] = value
            field_values[field_def["id"]] = value

        bullet = _as_str(raw.get("bullet"))
        if not bullet:
            if category_key == "education":
                bullet = " | ".join(
                    [
                        normalized["school"],
                        normalized["degree"],
                        normalized["major"],
                        "-".join([v for v in [normalized["start_date"], normalized["end_date"]] if v]),
                        normalized["description"],
                    ]
                ).strip(" |")
            elif category_key == "experience":
                bullet = " | ".join(
                    [
                        normalized["company"],
                        normalized["position"],
                        "-".join([v for v in [normalized["start_date"], normalized["end_date"]] if v]),
                        normalized["description"],
                    ]
                ).strip(" |")
            elif category_key == "project":
                bullet = " | ".join(
                    [
                        normalized["name"],
                        normalized["role"],
                        "-".join([v for v in [normalized["start_date"], normalized["end_date"]] if v]),
                        normalized["description"],
                    ]
                ).strip(" |")
            elif category_key == "skill":
                bullet = "、".join(normalized["items"]) if normalized["items"] else normalized["category"]
            elif category_key == "certificate":
                bullet = " | ".join(
                    [normalized["name"], normalized["issuer"], normalized["date"]]
                ).strip(" |")

        return {
            "schema_version": PROFILE_SECTION_SCHEMA_VERSION,
            "category_key": category_key,
            "category_label": category_label or definition["label"],
            "field_values": field_values,
            "normalized": normalized,
            "bullet": bullet,
            "title": _as_str(title),
            "tier": resolved_tier,
        }

    # 自定义分类
    subtitle = _as_str(
        _pick_value(
            raw=raw,
            normalized_in=normalized_in,
            field_values_in=field_values_in,
            field_id=_custom_field_id(category_key, "subtitle"),
            aliases=["subtitle", "sub_title"],
        )
    )
    description = _as_str(
        _pick_value(
            raw=raw,
            normalized_in=normalized_in,
            field_values_in=field_values_in,
            field_id=_custom_field_id(category_key, "description"),
            aliases=["description", "desc"],
        )
    )
    highlights = _as_list(
        _pick_value(
            raw=raw,
            normalized_in=normalized_in,
            field_values_in=field_values_in,
            field_id=_custom_field_id(category_key, "highlights"),
            aliases=["highlights", "items"],
        )
    )

    bullet = _as_str(raw.get("bullet"))
    if not bullet:
        bullet = " | ".join([part for part in [subtitle, description] if part])

    field_values = {
        _custom_field_id(category_key, "subtitle"): subtitle,
        _custom_field_id(category_key, "description"): description,
        _custom_field_id(category_key, "highlights"): highlights,
    }

    normalized = {
        "subtitle": subtitle,
        "description": description,
        "highlights": highlights,
    }

    return {
        "schema_version": PROFILE_SECTION_SCHEMA_VERSION,
        "category_key": category_key,
        "category_label": category_label or "自定义分类",
        "field_values": field_values,
        "normalized": normalized,
        "bullet": bullet,
        "title": _as_str(title),
        "tier": resolved_tier,
    }


def canonicalize_profile_section_payload(
    section_type: str,
    title: str,
    raw_content_json: dict[str, Any] | None,
    category_label: str | None = None,
    *,
    tier: Any = None,
) -> tuple[str, str, bool, dict[str, Any]]:
    category_key, resolved_label, is_custom = resolve_category_key(section_type, category_label)
    canonical = canonicalize_profile_content(
        category_key=category_key,
        title=title,
        raw_content_json=raw_content_json,
        category_label=resolved_label,
        tier=tier,
    )
    return category_key, resolved_label, is_custom, canonical


def get_resume_section_type(category_key: str) -> str:
    if category_key in PROFILE_BUILTIN_CATEGORY_DEFINITIONS:
        return PROFILE_BUILTIN_CATEGORY_DEFINITIONS[category_key]["resume_section_type"]
    return "custom"


def to_resume_content_item(category_key: str, canonical_content_json: dict[str, Any], fallback_title: str) -> dict[str, Any]:
    normalized = canonical_content_json.get("normalized") if isinstance(canonical_content_json, dict) else {}
    normalized = normalized if isinstance(normalized, dict) else {}
    bullet = _as_str(canonical_content_json.get("bullet")) if isinstance(canonical_content_json, dict) else ""

    if category_key == "education":
        return {
            "school": _as_str(normalized.get("school") or fallback_title),
            "degree": _as_str(normalized.get("degree")),
            "major": _as_str(normalized.get("major")),
            "gpa": _as_str(normalized.get("gpa")),
            "startDate": _as_str(normalized.get("start_date")),
            "endDate": _as_str(normalized.get("end_date")),
            "description": _as_str(normalized.get("description") or bullet),
        }

    if category_key == "experience":
        return {
            "company": _as_str(normalized.get("company") or fallback_title),
            "position": _as_str(normalized.get("position")),
            "startDate": _as_str(normalized.get("start_date")),
            "endDate": _as_str(normalized.get("end_date")),
            "description": _as_str(normalized.get("description") or bullet),
        }

    if category_key == "project":
        return {
            "name": _as_str(normalized.get("name") or fallback_title),
            "role": _as_str(normalized.get("role")),
            "url": _as_str(normalized.get("url")),
            "startDate": _as_str(normalized.get("start_date")),
            "endDate": _as_str(normalized.get("end_date")),
            "description": _as_str(normalized.get("description") or bullet),
        }

    if category_key == "skill":
        return {
            "category": _as_str(normalized.get("category") or fallback_title or "技能"),
            "items": _as_list(normalized.get("items") or bullet),
        }

    if category_key == "certificate":
        return {
            "name": _as_str(normalized.get("name") or fallback_title),
            "issuer": _as_str(normalized.get("issuer")),
            "date": _as_str(normalized.get("date")),
            "url": _as_str(normalized.get("url")),
        }

    return {
        "subtitle": _as_str(normalized.get("subtitle") or fallback_title),
        "description": _as_str(normalized.get("description") or bullet),
    }
