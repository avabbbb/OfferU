# =============================================
# Profile 路由 — 个人档案与对话引导 API
# =============================================
# GET    /api/profile/                     获取默认档案
# PUT    /api/profile/                     更新档案主信息
# GET    /api/profile/target-roles         获取目标岗位
# POST   /api/profile/target-roles         创建目标岗位
# DELETE /api/profile/target-roles/{id}    删除目标岗位
# POST   /api/profile/sections             手动新增条目
# PUT    /api/profile/sections/{id}        更新条目
# DELETE /api/profile/sections/{id}        删除条目
# POST   /api/profile/chat                 SSE 对话引导并产出 bullet 候选
# GET    /api/profile/chat/sessions        会话列表
# GET    /api/profile/chat/sessions/{id}   会话详情
# POST   /api/profile/chat/confirm         确认候选并入库
# POST   /api/profile/import-resume        上传简历并提取候选条目
# POST   /api/profile/generate-narrative   生成叙事字段
# =============================================

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timedelta
from typing import Any, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.llm import chat_completion, extract_json
from app.database import get_db
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
from app.services.profile_builder_agent import build_initial_agent_state, normalize_profile_agent_patch

try:
    from app.agents.skills.conversational_extractor import generate_instant_draft as _generate_instant_draft
except Exception:
    _generate_instant_draft = None

router = APIRouter()

VALID_TOPICS = {"education", "experience", "project", "activity", "skill", "general"}
VALID_FITS = {"primary", "secondary", "adjacent"}
VALID_SECTION_TYPES = set(PROFILE_BUILTIN_SECTION_TYPES).union(
    {"general", "custom", "internship", "activity", "competition", "honor", "language"}
)
PROFILE_CATEGORY_ORDER = ["education", "experience", "project", "skill", "certificate"]
ALLOWED_RESUME_IMPORT_EXTENSIONS = {".pdf", ".docx"}
MAX_RESUME_IMPORT_FILE_SIZE = 10 * 1024 * 1024
RESUME_IMPORT_MODES = {"ai", "mechanical"}
PROFILE_AGENT_TOPIC = "profile_builder"


class ProfileUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    headline: Optional[str] = Field(default=None, max_length=300)
    exit_story: Optional[str] = None
    cross_cutting_advantage: Optional[str] = None
    base_info_json: Optional[dict] = None


class TargetRoleCreateRequest(BaseModel):
    role_name: str = Field(..., min_length=1, max_length=120)
    role_level: str = Field(default="", max_length=60)
    fit: str = Field(default="primary")


class ProfileSectionCreateRequest(BaseModel):
    section_type: str = Field(..., min_length=1, max_length=60)
    category_label: Optional[str] = Field(default=None, max_length=80)
    title: str = Field(default="", max_length=220)
    sort_order: int = 0
    content_json: dict = Field(default_factory=dict)
    source: str = Field(default="manual", max_length=30)
    confidence: float = Field(default=1.0, ge=0, le=1)


class ProfileSectionUpdateRequest(BaseModel):
    section_type: Optional[str] = Field(default=None, min_length=1, max_length=60)
    category_label: Optional[str] = Field(default=None, max_length=80)
    title: Optional[str] = Field(default=None, max_length=220)
    sort_order: Optional[int] = None
    content_json: Optional[dict] = None
    source: Optional[str] = Field(default=None, max_length=30)
    confidence: Optional[float] = Field(default=None, ge=0, le=1)


class ProfileChatRequest(BaseModel):
    topic: str = Field(default="general")
    message: str = Field(..., min_length=1)
    session_id: Optional[int] = None


class ProfileChatConfirmRequest(BaseModel):
    session_id: int
    bullet_index: int = Field(..., ge=0)
    edits: Optional[dict] = None


class InstantDraftRequest(BaseModel):
    experiences: list[str] = Field(..., min_length=1, max_length=20)
    target_roles: list[str] = Field(default_factory=list)


class SmartFillPingRequest(BaseModel):
    mode: str = "smart-fill"


class SmartFillFieldItem(BaseModel):
    fieldId: str = Field(..., min_length=1, max_length=120)
    label: str = ""
    placeholder: str = ""
    name: str = ""
    inputType: str = ""
    options: list[str] = Field(default_factory=list)
    required: bool = False
    nearbyText: str = ""


class SmartFillMapRequest(BaseModel):
    fields: list[SmartFillFieldItem] = Field(default_factory=list)
    profile: Optional[dict[str, Any]] = None
    profileValues: list[dict[str, str]] = Field(default_factory=list)
    catalog: list[dict[str, Any]] = Field(default_factory=list)


class SmartFillOptionMatchRequest(BaseModel):
    candidates: list[str] = Field(default_factory=list)
    resume_value: str = ""
    level1_title: str = ""
    level2_title: str = ""


class SmartFillFieldMapFragment(BaseModel):
    module_name: str = Field(..., min_length=1, max_length=100)
    field_label: str = Field(..., min_length=1, max_length=100)
    item_index: int = Field(default=0, ge=0)


class SmartFillFieldMapRequest(BaseModel):
    fragments: list[SmartFillFieldMapFragment] = Field(default_factory=list)
    profile: Optional[dict[str, Any]] = None


class SmartFillModuleCountRequest(BaseModel):
    profile: Optional[dict[str, Any]] = None


class SmartFillCacheGetRequest(BaseModel):
    cacheKey: str = Field(..., min_length=4, max_length=128)
    adapterId: str = Field(default="unknown", max_length=50)
    modelSignature: str = Field(default="", max_length=128)


class SmartFillCacheSetRequest(BaseModel):
    cacheKey: str = Field(..., min_length=4, max_length=128)
    adapterId: str = Field(default="unknown", max_length=50)
    modelSignature: str = Field(default="", max_length=128)
    ttlSeconds: int = Field(default=300, ge=30, le=7200)
    mappings: list[dict[str, Any]] = Field(default_factory=list)
    channel: str = Field(default="backend", max_length=30)
    fallbackUsed: bool = False
    runId: Optional[str] = Field(default=None, max_length=64)


class SmartFillRunLogItem(BaseModel):
    stage: str = Field(..., min_length=1, max_length=40)
    severity: str = Field(default="info", max_length=20)
    scope: str = Field(default="run", max_length=20)
    message: str = Field(default="", max_length=500)
    payload: Optional[dict[str, Any]] = None
    fieldId: Optional[str] = Field(default=None, max_length=120)
    ts: Optional[str] = Field(default=None, max_length=40)


class SmartFillRunLogRequest(BaseModel):
    runId: str = Field(..., min_length=6, max_length=64)
    logs: list[SmartFillRunLogItem] = Field(default_factory=list)


def _serialize_target_role(role: ProfileTargetRole) -> dict:
    return {
        "id": role.id,
        "profile_id": role.profile_id,
        "role_name": role.role_name,
        "role_level": role.role_level,
        "fit": role.fit,
        "created_at": str(role.created_at),
    }


def _serialize_section(section: ProfileSection) -> dict:
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
        "created_at": str(section.created_at),
        "updated_at": str(section.updated_at),
    }


def _serialize_profile(profile: Profile, roles: list[ProfileTargetRole], sections: list[ProfileSection]) -> dict:
    base_info_json = normalize_base_info_payload(profile.base_info_json)
    return {
        "id": profile.id,
        "name": profile.name,
        "headline": profile.headline,
        "exit_story": profile.exit_story,
        "cross_cutting_advantage": profile.cross_cutting_advantage,
        "base_info_json": base_info_json,
        "is_default": profile.is_default,
        "created_at": str(profile.created_at),
        "updated_at": str(profile.updated_at),
        "target_roles": [_serialize_target_role(item) for item in roles],
        "sections": [_serialize_section(item) for item in sections],
    }


def _serialize_chat_session(session: ProfileChatSession) -> dict:
    return {
        "id": session.id,
        "profile_id": session.profile_id,
        "topic": session.topic,
        "status": session.status,
        "extracted_bullets_count": session.extracted_bullets_count,
        "created_at": str(session.created_at),
        "updated_at": str(session.updated_at),
    }


def _sse(event: str, payload: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _extract_last_candidates(messages_json: list[Any]) -> list[dict[str, Any]]:
    for item in reversed(messages_json or []):
        if isinstance(item, dict) and item.get("kind") == "bullet_candidates":
            candidates = item.get("candidates")
            if isinstance(candidates, list):
                return candidates
    return []


async def _get_or_create_default_profile(db: AsyncSession) -> Profile:
    existing = (
        await db.execute(
            select(Profile).where(Profile.is_default == True).order_by(Profile.id.asc())
        )
    ).scalars().first()
    if existing:
        return existing

    profile = Profile(
        name="默认档案",
        is_default=True,
        base_info_json=normalize_base_info_payload({"name": ""}),
    )
    db.add(profile)
    await db.flush()
    return profile


async def _load_profile_bundle(db: AsyncSession, profile_id: int) -> tuple[Profile, list[ProfileTargetRole], list[ProfileSection]]:
    profile = (
        await db.execute(select(Profile).where(Profile.id == profile_id))
    ).scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

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
            .order_by(ProfileSection.sort_order.asc(), ProfileSection.created_at.asc())
        )
    ).scalars().all()

    return profile, roles, sections


def _normalize_candidate(topic: str, candidate: dict[str, Any]) -> dict[str, Any]:
    raw_section_type = (candidate.get("section_type") or topic or "general").strip().lower()
    section_type = normalize_section_type_alias(raw_section_type)
    category_label: Optional[str] = None

    if section_type in {"general", "activity", "competition"}:
        section_type = "custom"
        category_label = "自定义分类"

    if not is_valid_profile_section_type(section_type):
        section_type = "custom"
        category_label = "自定义分类"

    title = (candidate.get("title") or "未命名条目").strip()[:220]
    content_json = candidate.get("content_json")
    if not isinstance(content_json, dict):
        raw = str(candidate.get("content") or candidate.get("bullet") or "").strip()
        content_json = {"bullet": raw}

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

    confidence = candidate.get("confidence", 0.7)
    try:
        confidence = float(confidence)
    except Exception:
        confidence = 0.7
    confidence = min(max(confidence, 0.0), 1.0)

    return {
        "section_type": category_key,
        "category_label": resolved_label,
        "title": title,
        "content_json": canonical_content_json,
        "confidence": confidence,
    }


def _fallback_chat_payload(topic: str, user_message: str) -> dict[str, Any]:
    normalized_topic = normalize_section_type_alias(topic)
    if normalized_topic in {"general", "activity", "competition"}:
        normalized_topic = "custom"
    if not is_valid_profile_section_type(normalized_topic):
        normalized_topic = "custom"

    return {
        "assistant_message": (
            "这段已经能成为可写进简历的素材，我先帮你留一条候选。"
            "如果要写得更像样，还差几个 proof points：金额、人数/规模、你具体做的动作、最后结果。"
            "你记得哪个先补哪个。"
        ),
        "bullet_candidates": [
            {
                "section_type": normalized_topic,
                "title": "待确认经历条目",
                "content_json": {"bullet": user_message.strip()},
                "confidence": 0.55,
            }
        ],
        "topic_complete": False,
    }


def _build_profile_chat_prompt(topic: str) -> str:
    topic_label = {
        "education": "教育经历",
        "experience": "实习/工作经历",
        "project": "项目经历",
        "activity": "校园/社团/比赛经历",
        "skill": "技能与证书",
        "general": "综合档案",
    }.get(topic, "综合档案")

    return (
        f"你是 OfferU 的求职档案构建助手，也是一位职业教练。当前主题：{topic_label}。\n"
        "你的目标不是让用户机械填写表单，而是把随口说出的经历转成可复用的简历事实源。\n"
        "如果信息不够，不要硬写漂亮话；只问一个最关键追问，帮助用户补齐背景-动作-结果和 proof points。\n"
        "JSON 格式:\n"
        '{"assistant_message": "对用户的回复。先肯定素材价值，再指出还缺什么；如果足够，则说明已整理候选条目",\n'
        ' "bullet_candidates": [\n'
        '   {"section_type": "education|experience|project|skill|certificate",\n'
        '    "title": "条目标题",\n'
        '    "content_json": {见下方字段规范},\n'
        '    "confidence": 0.0-1.0}\n'
        ' ],\n'
        ' "topic_complete": false}\n\n'
        "## content_json 字段规范（必须按类型填写对应字段名）：\n"
        "education: {\"school\":学校, \"degree\":学位, \"major\":专业, \"start_date\":\"\", \"end_date\":\"\", \"gpa\":\"\", \"description\":描述, \"bullet\":一行摘要}\n"
        "experience: {\"company\":公司, \"position\":职位, \"start_date\":\"\", \"end_date\":\"\", \"description\":用•分隔的多条业绩描述, \"bullet\":一行摘要}\n"
        "project: {\"name\":项目名, \"role\":角色, \"start_date\":\"\", \"end_date\":\"\", \"description\":用•分隔的多条描述, \"bullet\":一行摘要含量化数据}\n"
        "skill: {\"category\":技能分类, \"items\":[技能1,技能2,...], \"bullet\":逗号分隔技能}\n"
        "certificate: {\"name\":证书名, \"issuer\":颁发机构, \"date\":日期, \"bullet\":一行摘要}\n\n"
        "## 核心规则：\n"
        "1. 严禁编造事实，所有数字必须来自用户原文。\n"
        "2. description 中必须保留用户提到的所有量化数据：人数、金额、时长、排名、覆盖范围、增长/下降比例。\n"
        "3. bullet 是一行浓缩摘要，格式：关键词1 | 关键词2 | 量化成果。\n"
        "4. 候选条目 1-3 条，confidence: 1.0=用户明确说了, 0.7=可直接确认, 0.5以下=需继续追问。\n"
        "5. 如果用户只说了短句，也要给出可回答的下一问，例如：你联系了多少人、拉到多少钱、活动规模多大、最后结果如何。\n"
    )


async def _generate_chat_payload(topic: str, user_message: str) -> dict[str, Any]:
    prompt = _build_profile_chat_prompt(topic)

    try:
        llm_result = await chat_completion(
            messages=[
                {"role": "system", "content": prompt},
                {
                    "role": "user",
                    "content": f"topic={topic}\nuser_input={user_message}",
                },
            ],
            temperature=0.2,
            json_mode=True,
            max_tokens=1000,
            tier="standard",
        )
    except Exception:
        return _fallback_chat_payload(topic, user_message)

    parsed = extract_json(llm_result or "")
    if not isinstance(parsed, dict):
        return _fallback_chat_payload(topic, user_message)

    assistant_message = str(parsed.get("assistant_message") or "我已整理候选条目，请确认。")
    raw_candidates = parsed.get("bullet_candidates")
    if not isinstance(raw_candidates, list) or len(raw_candidates) == 0:
        return _fallback_chat_payload(topic, user_message)

    candidates = [_normalize_candidate(topic, item) for item in raw_candidates[:3] if isinstance(item, dict)]
    if not candidates:
        return _fallback_chat_payload(topic, user_message)

    return {
        "assistant_message": assistant_message,
        "bullet_candidates": candidates,
        "topic_complete": bool(parsed.get("topic_complete", False)),
    }


EMAIL_RE = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.IGNORECASE)
PHONE_RE = re.compile(r"(?:\+?86[-\s]?)?(1[3-9]\d{9})")
URL_RE = re.compile(r"https?://[^\s，,；;]+|(?:github|linkedin)\.com/[^\s，,；;]+", re.IGNORECASE)
DATE_TOKEN_PATTERN = r"(?:19|20)\d{2}(?:[./-]\d{1,2}|年\s*\d{1,2}\s*月?)?"
DATE_RANGE_RE = re.compile(
    rf"(?P<start>{DATE_TOKEN_PATTERN})\s*(?:-|–|—|~|至|到)\s*"
    rf"(?P<end>至今|现在|目前|{DATE_TOKEN_PATTERN})",
    re.IGNORECASE,
)

SECTION_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("education", re.compile(r"^(教育经历|教育背景|学历|教育|主修课程|课程)$", re.IGNORECASE)),
    ("internship", re.compile(r"^(实习经历|实习经验|实习)$", re.IGNORECASE)),
    ("experience", re.compile(r"^(工作经历|工作经验|实践经历|社会实践|校园经历)$", re.IGNORECASE)),
    ("project", re.compile(r"^(项目经历|项目经验|项目|科研经历|研究经历)$", re.IGNORECASE)),
    ("skill", re.compile(r"^(技能|技能清单|专业技能|技能与证书|技能特长|技术栈|工具)$", re.IGNORECASE)),
    ("certificate", re.compile(r"^(证书|证书资质|语言能力|语言|英语|英语水平|语言水平|资质证书)$", re.IGNORECASE)),
    ("award", re.compile(r"^(获奖经历|荣誉奖项|奖项|荣誉|奖励)$", re.IGNORECASE)),
    ("summary", re.compile(r"^(个人简介|自我评价|个人总结|Profile|Summary)$", re.IGNORECASE)),
]


def _clean_resume_line(raw: str) -> str:
    line = (raw or "").strip().lstrip("-*•·●▪▫").strip()
    line = re.sub(r"\s+", " ", line)
    return line.strip()


def _split_label_value(line: str) -> tuple[str, str] | None:
    match = re.match(r"^([^:：]{1,18})[:：]\s*(.+)$", line)
    if not match:
        return None
    return match.group(1).strip(), match.group(2).strip()


def _section_from_heading(line: str) -> tuple[str | None, str]:
    label_value = _split_label_value(line)
    heading = label_value[0] if label_value else line
    remainder = label_value[1] if label_value else ""
    heading = heading.strip()
    for section_key, pattern in SECTION_PATTERNS:
        if pattern.match(heading):
            return section_key, remainder
    return None, ""


def _is_contact_or_base_line(line: str) -> bool:
    if EMAIL_RE.search(line) or PHONE_RE.search(line):
        return True
    label_value = _split_label_value(line)
    if not label_value:
        return False
    label = label_value[0]
    return bool(
        re.search(
            r"姓名|邮箱|邮件|电话|手机|联系方式|微信|现居|所在地|城市|地址|求职意向|期望职位|目标岗位|GitHub|LinkedIn|个人网站|网站",
            label,
            re.IGNORECASE,
        )
    )


def _extract_labeled_value(lines: list[str], pattern: str) -> str:
    regex = re.compile(pattern, re.IGNORECASE)
    for line in lines:
        label_value = _split_label_value(line)
        if label_value and regex.search(label_value[0]):
            return label_value[1].strip()
    return ""


def _extract_resume_base_info(resume_text: str) -> dict[str, str]:
    lines = [_clean_resume_line(raw) for raw in (resume_text or "").splitlines()]
    lines = [line for line in lines if line]
    joined = "\n".join(lines)

    base_info: dict[str, str] = {}

    email = EMAIL_RE.search(joined)
    if email:
        base_info["email"] = email.group(0)

    phone = PHONE_RE.search(joined)
    if phone:
        base_info["phone"] = phone.group(1)

    website_candidates = URL_RE.findall(joined)
    for url in website_candidates:
        normalized_url = url if url.startswith("http") else f"https://{url}"
        if "github.com" in normalized_url.lower() and "github" not in base_info:
            base_info["github"] = normalized_url
        elif "linkedin.com" in normalized_url.lower() and "linkedin" not in base_info:
            base_info["linkedin"] = normalized_url
        elif "website" not in base_info:
            base_info["website"] = normalized_url

    name = _extract_labeled_value(lines, r"姓名|名字")
    if not name:
        for line in lines[:8]:
            section_key, _ = _section_from_heading(line)
            if section_key or _is_contact_or_base_line(line):
                continue
            if len(line) <= 12 and not re.search(r"\d|@|简历|求职|岗位|电话|邮箱", line, re.IGNORECASE):
                name = line
                break
    if name:
        base_info["name"] = name

    city = _extract_labeled_value(lines, r"现居|所在地|城市|地址")
    if city:
        base_info["current_city"] = city

    job_intention = _extract_labeled_value(lines, r"求职意向|期望职位|目标岗位|应聘岗位")
    if job_intention:
        base_info["job_intention"] = job_intention

    summary = _extract_labeled_value(lines, r"个人简介|自我评价|个人总结|Summary|Profile")
    if not summary:
        collecting = False
        summary_lines: list[str] = []
        for line in lines:
            section_key, remainder = _section_from_heading(line)
            if section_key == "summary":
                collecting = True
                if remainder:
                    summary_lines.append(remainder)
                continue
            if collecting and section_key:
                break
            if collecting and not _is_contact_or_base_line(line):
                summary_lines.append(line)
            if len(summary_lines) >= 3:
                break
        summary = " ".join(summary_lines).strip()
    if summary:
        base_info["summary"] = summary
        base_info["personal_summary"] = summary

    return base_info


def _extract_date_range(line: str) -> tuple[str, str]:
    match = DATE_RANGE_RE.search(line)
    if not match:
        return "", ""
    return re.sub(r"\s+", "", match.group("start")), re.sub(r"\s+", "", match.group("end"))


def _first_match(pattern: str, text: str, default: str = "") -> str:
    match = re.search(pattern, text, re.IGNORECASE)
    return match.group(1).strip() if match else default


def _strip_heading_prefix(line: str) -> str:
    label_value = _split_label_value(line)
    if label_value:
        return label_value[1].strip()
    return re.sub(
        r"^(教育经历|教育背景|实习经历|工作经历|项目经历|技能|技能清单|证书|语言能力|获奖经历|荣誉奖项)\s*",
        "",
        line,
        flags=re.IGNORECASE,
    ).strip()


def _infer_resume_section(line: str, current_section: str | None) -> str:
    if re.search(r"六级|四级|CET|IELTS|TOEFL|雅思|托福|资格证|普通话", line, re.IGNORECASE):
        return "certificate"
    if re.search(r"获奖|奖学金|一等奖|二等奖|三等奖|优秀|荣誉", line, re.IGNORECASE):
        return "award"
    if current_section in {"education", "internship", "experience", "project", "skill", "certificate", "award"}:
        return current_section
    if re.search(r"大学|学院|学校|本科|硕士|博士|学士|大专|GPA|绩点|专业", line, re.IGNORECASE):
        return "education"
    if re.search(r"六级|四级|CET|IELTS|TOEFL|雅思|托福|证书|资格证|普通话", line, re.IGNORECASE):
        return "certificate"
    if re.search(r"Python|SQL|Excel|Office|Tableau|PowerBI|React|Java|熟练|技能", line, re.IGNORECASE):
        return "skill"
    if re.search(r"项目|系统|平台|模型|课题|研究|算法|数据分析", line, re.IGNORECASE):
        return "project"
    if re.search(r"公司|集团|银行|科技|咨询|证券|实习|运营|产品|工程师|分析师|研究员|助理|负责", line, re.IGNORECASE):
        return "experience"
    if re.search(r"获奖|奖学金|一等奖|二等奖|三等奖|优秀|荣誉", line, re.IGNORECASE):
        return "award"
    return "custom"


def _candidate_from_resume_line(line: str, current_section: str | None, index: int) -> dict[str, Any] | None:
    text = _strip_heading_prefix(line)
    if len(text) < 4 or _is_contact_or_base_line(text):
        return None

    section_key = _infer_resume_section(text, current_section)
    start_date, end_date = _extract_date_range(text)

    if section_key == "education":
        school = _first_match(r"([\w\u4e00-\u9fa5·（）() -]{2,40}(?:大学|学院|学校|University|College))", text)
        degree = _first_match(r"(博士|硕士|研究生|本科|学士|大专|专科)", text)
        gpa = _first_match(r"(?:GPA|绩点)[:：]?\s*([0-9.]+(?:/[0-9.]+)?)", text)
        major = _first_match(r"(?:专业[:：]?\s*)([\w\u4e00-\u9fa5·（）() -]{2,40})", text)
        if not major and school:
            rest = text.replace(school, " ").replace(degree, " ")
            rest = DATE_RANGE_RE.sub(" ", rest)
            rest = re.sub(r"(?:GPA|绩点)[:：]?\s*[0-9.]+(?:/[0-9.]+)?", " ", rest, flags=re.IGNORECASE).strip()
            major = rest[:40].strip(" ，,|")
        return {
            "section_type": "education",
            "title": school or "教育经历",
            "content_json": {
                "school": school or text[:40],
                "degree": degree,
                "major": major,
                "start_date": start_date,
                "end_date": end_date,
                "gpa": gpa,
                "description": text,
                "bullet": text,
            },
            "confidence": 0.62,
        }

    if section_key in {"experience", "internship"}:
        company = _first_match(
            r"([\w\u4e00-\u9fa5·（）()& -]{2,50}(?:公司|集团|银行|科技|咨询|证券|中心|研究院|实验室|事务所|有限|股份))",
            text,
        )
        compact = DATE_RANGE_RE.sub(" ", text)
        position = ""
        if company:
            tail = compact.replace(company, " ", 1).strip(" ，,|-")
            position = re.split(r"负责|参与|完成|主导|协助", tail, maxsplit=1)[0].strip(" ，,|-")
        if not position:
            position = _first_match(r"((?:产品|运营|数据|市场|研发|算法|后端|前端|财务|咨询|人力|销售|研究|分析)[\w\u4e00-\u9fa5]{0,16}(?:实习生|助理|经理|工程师|分析师|研究员)?)", text)
        is_internship = section_key == "internship" or "实习" in text or "实习" in (current_section or "")
        title = f"实习经历 - {company}" if is_internship and company else (company or ("实习经历" if is_internship else "工作经历"))
        return {
            "section_type": "experience",
            "title": title,
            "content_json": {
                "company": company or text[:40],
                "position": position,
                "start_date": start_date,
                "end_date": end_date,
                "description": text,
                "bullet": text,
            },
            "confidence": 0.62,
        }

    if section_key == "project":
        name = _first_match(r"([\w\u4e00-\u9fa5·（）() -]{2,50}(?:项目|系统|平台|模型|课题|研究))", text)
        if not name:
            name = re.split(r"负责|参与|完成|主导|协助|[:：|]", text, maxsplit=1)[0].strip()[:50]
        return {
            "section_type": "project",
            "title": name or "项目经历",
            "content_json": {
                "name": name or text[:40],
                "role": "",
                "start_date": start_date,
                "end_date": end_date,
                "description": text,
                "bullet": text,
            },
            "confidence": 0.6,
        }

    if section_key == "skill":
        cleaned = re.sub(r"^(技能|技能清单|专业技能)[:：]?", "", text, flags=re.IGNORECASE).strip()
        items = [item.strip() for item in re.split(r"[,，、；;|/\n]", cleaned) if item.strip()]
        return {
            "section_type": "skill",
            "title": "技能清单",
            "content_json": {
                "category": "技能",
                "items": items or [cleaned],
                "bullet": cleaned,
            },
            "confidence": 0.58,
        }

    if section_key == "certificate":
        return {
            "section_type": "certificate",
            "title": "证书资质",
            "content_json": {
                "name": text,
                "issuer": "",
                "date": "",
                "bullet": text,
            },
            "confidence": 0.58,
        }

    if section_key == "award":
        return {
            "section_type": "custom",
            "title": "获奖经历",
            "content_json": {
                "subtitle": "获奖经历",
                "description": text,
                "bullet": text,
            },
            "confidence": 0.55,
        }

    return {
        "section_type": "custom",
        "title": f"个人经历 {index + 1}",
        "content_json": {
            "subtitle": f"个人经历 {index + 1}",
            "description": text,
            "bullet": text,
        },
        "confidence": 0.5,
    }


def _fallback_resume_candidates(resume_text: str) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    seen: set[str] = set()
    current_section: str | None = None
    grouped_section: str | None = None
    grouped_lines: list[str] = []

    def flush_group() -> None:
        nonlocal grouped_section, grouped_lines
        if not grouped_lines:
            return
        text = "\n".join(grouped_lines).strip()
        grouped_lines = []
        section = grouped_section
        grouped_section = None
        if not text:
            return
        key = text.lower()
        if key in seen:
            return
        seen.add(key)
        candidate = _candidate_from_resume_line(text, section, len(candidates))
        if candidate:
            candidates.append(_normalize_candidate(candidate["section_type"], candidate))

    for raw in (resume_text or "").splitlines():
        line = _clean_resume_line(raw)
        if not line:
            continue
        section_key, remainder = _section_from_heading(line)
        line_section = current_section
        if section_key:
            if not remainder:
                current_section = section_key
                continue
            line_section = section_key
            line = remainder

        if line_section == "summary" or _is_contact_or_base_line(line):
            continue
        if len(line) < 4:
            continue

        if line_section in {"experience", "internship", "project"}:
            if grouped_section and grouped_section != line_section:
                flush_group()
            grouped_section = line_section
            grouped_lines.append(line)
            continue

        flush_group()

        key = line.lower()
        if key in seen:
            continue
        seen.add(key)

        candidate = _candidate_from_resume_line(line, line_section, len(candidates))
        if candidate:
            candidates.append(_normalize_candidate(candidate["section_type"], candidate))
        if len(candidates) >= 12:
            break

    flush_group()

    if not candidates and (resume_text or "").strip():
        snippet = " ".join((resume_text or "").split())
        candidates.append(
            _normalize_candidate(
                "custom",
                {
                    "section_type": "custom",
                    "title": "个人经历 1",
                    "content_json": {"subtitle": "个人经历 1", "description": snippet[:180], "bullet": snippet[:180]},
                    "confidence": 0.55,
                },
            )
        )
    return candidates


def _candidate_normalized(candidate: dict[str, Any]) -> dict[str, Any]:
    content_json = candidate.get("content_json") if isinstance(candidate, dict) else {}
    if not isinstance(content_json, dict):
        return {}
    normalized = content_json.get("normalized")
    return normalized if isinstance(normalized, dict) else {}


def _candidate_merge_key(candidate: dict[str, Any]) -> tuple[str, str] | None:
    section_type = normalize_section_type_alias(str(candidate.get("section_type") or ""))
    if section_type not in {"experience", "project"}:
        return None

    normalized = _candidate_normalized(candidate)
    if section_type == "experience":
        company = str(normalized.get("company") or "").strip()
        if company:
            return section_type, company.lower()
    if section_type == "project":
        name = str(normalized.get("name") or "").strip()
        if name:
            return section_type, name.lower()

    title = str(candidate.get("title") or "").strip()
    if title:
        return section_type, title.lower()
    return None


def _append_unique_text(parts: list[str], value: Any) -> None:
    text = re.sub(r"\s+", " ", str(value or "")).strip(" ;；|")
    if text and text not in parts:
        parts.append(text)


def _merged_description(parts: list[str]) -> str:
    return "；".join(part for part in parts if part).strip("；")


def _coalesce_resume_entry_candidates(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge LLM-split sentences back into one experience/project entry."""
    merged: list[dict[str, Any]] = []
    index_by_key: dict[tuple[str, str], int] = {}
    descriptions_by_key: dict[tuple[str, str], list[str]] = {}

    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        key = _candidate_merge_key(candidate)
        if key is None:
            merged.append(candidate)
            continue

        normalized = _candidate_normalized(candidate)
        if key not in index_by_key:
            index_by_key[key] = len(merged)
            merged.append(candidate)
            descriptions_by_key[key] = []
            _append_unique_text(descriptions_by_key[key], normalized.get("description"))
            content_json = candidate.get("content_json")
            if isinstance(content_json, dict):
                _append_unique_text(descriptions_by_key[key], content_json.get("bullet"))
            continue

        target = merged[index_by_key[key]]
        target_normalized = _candidate_normalized(target)
        parts = descriptions_by_key[key]
        _append_unique_text(parts, target_normalized.get("description"))
        _append_unique_text(parts, normalized.get("description"))
        content_json = candidate.get("content_json")
        if isinstance(content_json, dict):
            _append_unique_text(parts, content_json.get("bullet"))

        target_content_json = target.get("content_json")
        if not isinstance(target_content_json, dict):
            continue

        description = _merged_description(parts)
        target_normalized["description"] = description
        target_content_json["normalized"] = target_normalized

        field_values = target_content_json.get("field_values")
        if isinstance(field_values, dict):
            field_id = "project.description" if key[0] == "project" else "experience.description"
            field_values[field_id] = description
            target_content_json["field_values"] = field_values

        target_content_json["bullet"] = description
        target["content_json"] = target_content_json
        target["confidence"] = max(float(target.get("confidence") or 0), float(candidate.get("confidence") or 0))

    return merged


def _structured_entry_type(value: Any) -> str:
    raw = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    aliases = {
        "work": "experience",
        "work_experience": "experience",
        "professional_experience": "experience",
        "job": "experience",
        "intern": "experience",
        "internship": "experience",
        "internship_experience": "experience",
        "project_experience": "project",
        "research": "project",
        "research_experience": "project",
        "education_background": "education",
        "school": "education",
        "skills": "skill",
        "cert": "certificate",
        "certification": "certificate",
        "award": "custom",
        "honor": "custom",
        "summary": "custom",
        "personal": "custom",
    }
    return aliases.get(raw, raw if raw in PROFILE_BUILTIN_SECTION_TYPES else "custom")


def _structured_text(value: Any) -> str:
    if isinstance(value, list):
        return "\n".join(str(item).strip() for item in value if str(item).strip())
    return str(value or "").strip()


def _candidate_from_structured_resume_entry(entry: dict[str, Any]) -> dict[str, Any] | None:
    if not isinstance(entry, dict):
        return None

    section_type = _structured_entry_type(
        entry.get("entry_type") or entry.get("section_type") or entry.get("type") or entry.get("category")
    )
    if isinstance(entry.get("content_json"), dict):
        legacy_candidate = dict(entry)
        legacy_candidate["section_type"] = section_type
        return _normalize_candidate(section_type, legacy_candidate)

    title = _structured_text(entry.get("title") or entry.get("name") or entry.get("organization"))
    organization = _structured_text(entry.get("organization") or entry.get("company") or entry.get("school"))
    role = _structured_text(entry.get("role") or entry.get("position") or entry.get("position_name"))
    start_date = _structured_text(entry.get("start_date") or entry.get("startDate"))
    end_date = _structured_text(entry.get("end_date") or entry.get("endDate"))
    description = _structured_text(entry.get("description") or entry.get("details") or entry.get("achievements"))
    confidence = entry.get("confidence", 0.72)

    if not any([title, organization, role, description]):
        return None

    if section_type == "education":
        return _normalize_candidate(
            "education",
            {
                "section_type": "education",
                "title": title or organization or "教育经历",
                "content_json": {
                    "school": organization or title,
                    "degree": _structured_text(entry.get("degree")),
                    "major": _structured_text(entry.get("major")),
                    "start_date": start_date,
                    "end_date": end_date,
                    "gpa": _structured_text(entry.get("gpa")),
                    "description": description,
                    "bullet": description or title or organization,
                },
                "confidence": confidence,
            },
        )

    if section_type == "experience":
        department = _structured_text(entry.get("department"))
        return _normalize_candidate(
            "experience",
            {
                "section_type": "experience",
                "title": title or organization or "工作经历",
                "content_json": {
                    "company": organization or title,
                    "position": role,
                    "department": department,
                    "start_date": start_date,
                    "end_date": end_date,
                    "description": description,
                    "bullet": description or " | ".join(part for part in [organization, role] if part),
                },
                "confidence": confidence,
            },
        )

    if section_type == "project":
        return _normalize_candidate(
            "project",
            {
                "section_type": "project",
                "title": title or "项目经历",
                "content_json": {
                    "name": title,
                    "role": role,
                    "url": _structured_text(entry.get("url") or entry.get("link")),
                    "start_date": start_date,
                    "end_date": end_date,
                    "description": description,
                    "bullet": description or title,
                },
                "confidence": confidence,
            },
        )

    if section_type == "skill":
        skill_text = description or _structured_text(entry.get("items") or entry.get("skills")) or title
        return _normalize_candidate(
            "skill",
            {
                "section_type": "skill",
                "title": title or "技能清单",
                "content_json": {
                    "category": title or "技能",
                    "items": [skill_text] if skill_text else [],
                    "bullet": skill_text,
                },
                "confidence": confidence,
            },
        )

    if section_type == "certificate":
        return _normalize_candidate(
            "certificate",
            {
                "section_type": "certificate",
                "title": title or "证书资质",
                "content_json": {
                    "name": title,
                    "issuer": organization,
                    "date": end_date or start_date,
                    "url": _structured_text(entry.get("url") or entry.get("link")),
                    "bullet": description or title,
                },
                "confidence": confidence,
            },
        )

    return _normalize_candidate(
        "custom",
        {
            "section_type": "custom",
            "title": title or "个人经历",
            "content_json": {
                "subtitle": title or organization,
                "description": description or " | ".join(part for part in [organization, role] if part),
                "bullet": description or title or organization,
            },
            "confidence": confidence,
        },
    )


def _candidates_from_structured_resume_payload(parsed: dict[str, Any]) -> list[dict[str, Any]]:
    raw_entries = parsed.get("entries")
    if not isinstance(raw_entries, list) or not raw_entries:
        raw_entries = parsed.get("bullets")
    if not isinstance(raw_entries, list) or not raw_entries:
        raw_entries = parsed.get("bullet_candidates")
    if not isinstance(raw_entries, list):
        return []

    candidates = [
        candidate
        for item in raw_entries[:16]
        if isinstance(item, dict)
        for candidate in [_candidate_from_structured_resume_entry(item)]
        if candidate is not None
    ]
    return _coalesce_resume_entry_candidates(candidates)


def _base_info_from_structured_resume_payload(parsed: dict[str, Any]) -> dict[str, str]:
    raw = parsed.get("base_info")
    if not isinstance(raw, dict):
        return {}
    aliases = {
        "name": ["name", "full_name", "fullName"],
        "phone": ["phone", "mobile", "telephone"],
        "email": ["email", "mail"],
        "current_city": ["current_city", "currentCity", "city", "location"],
        "job_intention": ["job_intention", "jobIntention", "target_role", "targetRole"],
        "summary": ["summary", "personal_summary", "personalSummary", "profile"],
        "personal_summary": ["personal_summary", "personalSummary", "summary", "profile"],
        "website": ["website", "personal_website", "personalWebsite"],
        "github": ["github", "github_url", "githubUrl"],
        "linkedin": ["linkedin", "linkedin_url", "linkedinUrl"],
    }
    out: dict[str, str] = {}
    for target, keys in aliases.items():
        for key in keys:
            value = _structured_text(raw.get(key))
            if value:
                out[target] = value
                break
    return out


async def _extract_resume_import_payload(resume_text: str) -> dict[str, Any]:
    prompt = (
        "你是求职档案结构化助手。从简历文本中抽取 3-12 条可入库的事实 bullet，输出严格JSON。\n"
        "JSON 格式: {\"bullets\": [{\"section_type\": string, \"title\": string, \"content_json\": object, \"confidence\": number}]}\n\n"
        "## content_json 字段规范（必须按类型填写对应字段名）：\n"
        "education: {\"school\":学校, \"degree\":学位, \"major\":专业, \"start_date\":\"\", \"end_date\":\"\", \"gpa\":\"\", \"description\":描述, \"bullet\":一行摘要}\n"
        "experience: {\"company\":公司, \"position\":职位, \"start_date\":\"\", \"end_date\":\"\", \"description\":用•分隔的多条业绩, \"bullet\":一行摘要}\n"
        "project: {\"name\":项目名, \"role\":角色, \"start_date\":\"\", \"end_date\":\"\", \"description\":用•分隔的多条描述, \"bullet\":一行摘要含量化数据}\n"
        "skill: {\"category\":技能分类, \"items\":[技能1,技能2,...], \"bullet\":逗号分隔技能}\n"
        "certificate: {\"name\":证书名, \"issuer\":颁发机构, \"date\":日期, \"bullet\":一行摘要}\n\n"
        "section_type 仅允许 education/experience/project/activity/skill/certificate/honor/language/general。\n"
        "要求: 1) 只改写不编造；2) 所有数字必须来自原文；3) description 保留完整量化数据；4) confidence 在 0-1。"
    )
    prompt += (
        "\n\nIMPORTANT: The source may come from PDF text extraction. PDF visual line wraps are not separate resume bullets. "
        "Return JSON with this shape whenever possible: "
        "{\"base_info\":{\"name\":\"\",\"phone\":\"\",\"email\":\"\",\"current_city\":\"\",\"job_intention\":\"\",\"summary\":\"\"},"
        "\"entries\":[{\"entry_type\":\"education|work|internship|project|skill|certificate|award|personal\","
        "\"title\":\"\",\"organization\":\"\",\"department\":\"\",\"role\":\"\",\"start_date\":\"\",\"end_date\":\"\","
        "\"description\":\"one complete textarea-ready description string\",\"items\":[],\"confidence\":0.0}]}. "
        "Merge wrapped lines that belong to the same sentence or responsibility. "
        "Treat one company role, internship, or project as ONE candidate entry, with all of its sentence-level details inside content_json.description. "
        "Do not split a single project into multiple candidates just because the PDF text has multiple visual lines. "
        "The JSON key is still named bullets for API compatibility, but each item must represent a complete resume entry, not one sentence. "
        "For the attached resume pattern, keep the China Telecom role as one work entry and its numbered AIGC/video items as project entries only when they have distinct project names. "
        "For experience/project description, use one string. Only insert newlines or bullet markers when the original text has explicit bullet points, numbering, or clearly separate achievements. "
        "For skill entries, do not reduce the original skill paragraph into short keywords. Copy the original skill section wording into description; items may stay empty. "
        "Do not create a separate candidate or description item from each visual line. "
        "Keep Chinese text as valid UTF-8; never output mojibake or question marks for Chinese characters."
    )

    try:
        llm_result = await chat_completion(
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": resume_text[:12000]},
            ],
            temperature=0.2,
            json_mode=True,
            max_tokens=1800,
            tier="standard",
        )
        parsed = extract_json(llm_result or "")
    except Exception:
        parsed = None

    if not isinstance(parsed, dict):
        return {
            "base_info": {},
            "candidates": _coalesce_resume_entry_candidates(_fallback_resume_candidates(resume_text)),
        }

    candidates = _candidates_from_structured_resume_payload(parsed)
    if not candidates:
        candidates = _coalesce_resume_entry_candidates(_fallback_resume_candidates(resume_text))
    return {
        "base_info": _base_info_from_structured_resume_payload(parsed),
        "candidates": candidates,
    }


async def _extract_resume_candidates(resume_text: str) -> list[dict[str, Any]]:
    payload = await _extract_resume_import_payload(resume_text)
    candidates = payload.get("candidates")
    return candidates if isinstance(candidates, list) else []


def _normalize_resume_import_mode(value: str | None) -> str:
    raw = str(value or "ai").strip().lower().replace("-", "_")
    aliases = {
        "llm": "ai",
        "agent": "ai",
        "smart": "ai",
        "manual": "mechanical",
        "classic": "mechanical",
        "regex": "mechanical",
        "rule": "mechanical",
        "rules": "mechanical",
        "original": "mechanical",
        "legacy": "mechanical",
    }
    mode = aliases.get(raw, raw)
    if mode not in RESUME_IMPORT_MODES:
        raise HTTPException(status_code=400, detail="invalid parse_mode, use ai or mechanical")
    return mode


async def _extract_resume_import_payload_by_mode(resume_text: str, parse_mode: str) -> dict[str, Any]:
    if parse_mode == "mechanical":
        return {
            "base_info": {},
            "candidates": _coalesce_resume_entry_candidates(_fallback_resume_candidates(resume_text)),
        }
    return await _extract_resume_import_payload(resume_text)


def _resume_import_memory_summary(
    *,
    filename: str,
    parse_mode: str,
    parsed_text: str,
    base_info: dict[str, Any],
    candidates: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "kind": "resume_parse_memory",
        "source": "resume_import",
        "filename": filename,
        "parse_mode": parse_mode,
        "text_length": len(parsed_text),
        "base_info": base_info,
        "candidate_count": len(candidates),
        "candidate_titles": [str(item.get("title") or "").strip() for item in candidates[:12] if isinstance(item, dict)],
    }


def _build_resume_import_agent_messages(
    *,
    filename: str,
    parse_mode: str,
    parsed_text: str,
    base_info: dict[str, Any],
    candidates: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    target_role = str(base_info.get("job_intention") or "").strip()
    target_city = str(base_info.get("current_city") or "").strip()
    state = build_initial_agent_state(
        resume_text=parsed_text,
        target_role=target_role,
        target_city=target_city,
        job_goal="",
        extracted_base_info=base_info,
        resume_candidates=candidates,
    )
    mode_label = "AI 精准解析" if parse_mode == "ai" else "原版机械解析"
    patch = normalize_profile_agent_patch(
        {
            "action": "propose_patch" if (base_info or candidates) else "ask_user",
            "assistant_message": (
                f"我已经用{mode_label}读完这份简历，并把解析结果同步成档案记忆。"
                "你可以先确认写入，也可以直接问我哪段经历需要合并、补强或改写。"
            ),
            "base_info": base_info,
            "target_roles": [target_role] if target_role else [],
            "sections": candidates,
            "next_question": "要不要我先检查哪些经历被拆错、哪些经历最该合并成一个描述框？",
            "confidence": 0.78 if parse_mode == "ai" else 0.62,
        }
    )
    messages_json = [
        {
            "kind": "profile_agent_start",
            "agent": PROFILE_AGENT_TOPIC,
            "source": "resume_import",
            "filename": filename,
            "parse_mode": parse_mode,
            "resume_text_length": len(parsed_text),
            "target_role": target_role,
            "target_city": target_city,
            "job_goal": "",
        },
        _resume_import_memory_summary(
            filename=filename,
            parse_mode=parse_mode,
            parsed_text=parsed_text,
            base_info=base_info,
            candidates=candidates,
        ),
        {"kind": "profile_agent_state", "agent": PROFILE_AGENT_TOPIC, "state": state},
        {"role": "assistant", "topic": PROFILE_AGENT_TOPIC, "content": patch["assistant_message"]},
        {"kind": "profile_agent_patch", "agent": PROFILE_AGENT_TOPIC, "patch": patch, "applied": False},
    ]
    return messages_json, patch


@router.get("/")
async def get_profile(db: AsyncSession = Depends(get_db)):
    profile = await _get_or_create_default_profile(db)
    normalized_base_info = normalize_base_info_payload(profile.base_info_json)
    if profile.base_info_json != normalized_base_info:
        profile.base_info_json = normalized_base_info
    await db.commit()

    profile, roles, sections = await _load_profile_bundle(db, profile.id)
    return _serialize_profile(profile, roles, sections)


@router.get("/categories")
async def list_profile_categories(db: AsyncSession = Depends(get_db)):
    profile = await _get_or_create_default_profile(db)
    sections = (
        await db.execute(
            select(ProfileSection)
            .where(ProfileSection.profile_id == profile.id)
            .order_by(ProfileSection.updated_at.desc(), ProfileSection.id.desc())
        )
    ).scalars().all()

    custom_map: dict[str, str] = {}
    for section in sections:
        category_key = normalize_section_type_alias(section.section_type)
        if category_key in {"general", "activity", "competition"} or not is_valid_profile_section_type(category_key):
            category_key = "custom:c_legacy"
        if category_key in PROFILE_BUILTIN_SECTION_TYPES:
            continue
        if not is_custom_category_key(category_key):
            continue
        if category_key in custom_map:
            continue
        content_json = section.content_json if isinstance(section.content_json, dict) else {}
        custom_map[category_key] = get_category_label(category_key, content_json)

    builtin = [
        {
            "key": key,
            "label": get_category_label(key),
            "is_custom": False,
        }
        for key in PROFILE_CATEGORY_ORDER
    ]
    custom = [
        {"key": key, "label": label, "is_custom": True}
        for key, label in sorted(custom_map.items(), key=lambda item: item[1])
    ]

    return {
        "builtin": builtin,
        "custom": custom,
        "all": [*builtin, *custom],
    }


@router.get("/smart-fill/catalog")
async def smart_fill_catalog(db: AsyncSession = Depends(get_db)):
    profile = await _get_or_create_default_profile(db)
    normalized_base_info = normalize_base_info_payload(profile.base_info_json)
    if profile.base_info_json != normalized_base_info:
        profile.base_info_json = normalized_base_info
    await db.commit()

    profile, roles, sections = await _load_profile_bundle(db, profile.id)
    profile_payload = _serialize_profile(profile, roles, sections)
    catalog = _build_smartfill_catalog_from_profile(profile_payload)
    public_catalog = [{key: value for key, value in item.items() if key != "value"} for item in catalog]
    return {
        "ok": True,
        "profileVersion": "smartfill.catalog.v1",
        "catalog": public_catalog,
        "count": len(public_catalog),
        "signature": _smartfill_signature(*[item.get("signature", "") for item in public_catalog]),
    }


def _html_to_plain_text(html: str) -> str:
    text = re.sub(r"<[^>]+>", " ", html or "")
    text = re.sub(r"\s+", " ", text).strip()
    return text


_EXPERIENCE_MAPPED_CUSTOM_TYPES = {"custom:c_internship"}


def _build_archive_entry(section_type: str, category_label: str, title: str, normalized: dict) -> tuple[str, str, dict] | None:
    if section_type in _EXPERIENCE_MAPPED_CUSTOM_TYPES:
        desc = normalized.get("description", "")
        bullet = " | ".join(
            [normalized.get("company", ""), normalized.get("position", ""), desc]
        ).strip(" |")
        content_json = {
            "schema_version": PROFILE_SECTION_SCHEMA_VERSION,
            "category_key": section_type,
            "category_label": category_label,
            "field_values": {
                f"{section_type}.subtitle": title,
                f"{section_type}.description": desc,
            },
            "normalized": normalized,
            "bullet": bullet,
            "title": title,
        }
        return section_type, title, content_json
    try:
        resolved_type, resolved_label, _, content_json = canonicalize_profile_section_payload(
            section_type=section_type,
            title=title,
            raw_content_json={"normalized": normalized},
            category_label=category_label,
        )
        return resolved_type, title, content_json
    except ValueError:
        return None


async def _sync_personal_archive_to_sections(profile: Profile, db: AsyncSession) -> int:
    base_info = profile.base_info_json or {}
    personal_archive = base_info.get("personal_archive")
    if not isinstance(personal_archive, dict):
        return 0
    if personal_archive.get("schemaVersion") != "personal.archive.v1":
        return 0

    resume_archive = personal_archive.get("resumeArchive")
    if not isinstance(resume_archive, dict):
        return 0

    await db.execute(
        ProfileSection.__table__.delete().where(
            ProfileSection.profile_id == profile.id,
            ProfileSection.source == "archive_sync",
        )
    )

    sort_order = 0
    entries: list[tuple[str, str, dict]] = []

    for item in resume_archive.get("education", []):
        if not isinstance(item, dict):
            continue
        title = (item.get("schoolName") or "").strip() or "教育经历"
        normalized = {
            "school": item.get("schoolName", ""),
            "degree": (item.get("degree") or item.get("educationLevel") or ""),
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
        if not isinstance(item, dict):
            continue
        title = (item.get("companyName") or "").strip() or "工作经历"
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
        if not isinstance(item, dict):
            continue
        title = (item.get("companyName") or "").strip() or "实习经历"
        desc = _html_to_plain_text(item.get("description", ""))
        normalized = {
            "company": item.get("companyName", ""),
            "position": item.get("positionName", ""),
            "start_date": item.get("startDate", ""),
            "end_date": item.get("endDate", ""),
            "description": desc,
            "subtitle": title,
        }
        result = _build_archive_entry("custom:c_internship", "实习经历", title, normalized)
        if result:
            entries.append(result)

    for item in resume_archive.get("projects", []):
        if not isinstance(item, dict):
            continue
        title = (item.get("projectName") or "").strip() or "项目经历"
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

    skill_groups: dict[str, dict] = {}
    for item in resume_archive.get("skills", []):
        if not isinstance(item, dict):
            continue
        proficiency = (item.get("proficiency") or "").strip() or "技能"
        if proficiency not in skill_groups:
            skill_groups[proficiency] = {"names": [], "remarks": []}
        name = (item.get("skillName") or "").strip()
        if name:
            skill_groups[proficiency]["names"].append(name)
        remark = (item.get("remark") or "").strip()
        if remark:
            skill_groups[proficiency]["remarks"].append(remark)

    for proficiency, group in skill_groups.items():
        normalized = {
            "category": proficiency,
            "items": group["names"],
            "description": "\n".join(group["remarks"]) if group["remarks"] else "",
        }
        result = _build_archive_entry("skill", "技能与证书", proficiency, normalized)
        if result:
            entries.append(result)

    for item in resume_archive.get("certificates", []):
        if not isinstance(item, dict):
            continue
        title = (item.get("certificateName") or "").strip() or "证书"
        normalized = {
            "name": item.get("certificateName", ""),
            "issuer": item.get("issuer", ""),
            "date": item.get("acquiredAt", ""),
            "score": item.get("scoreOrLevel", ""),
            "description": item.get("scoreOrLevel", ""),
        }
        result = _build_archive_entry("certificate", "技能与证书", title, normalized)
        if result:
            entries.append(result)

    for item in resume_archive.get("awards", []):
        if not isinstance(item, dict):
            continue
        title = (item.get("awardName") or "").strip() or "获奖经历"
        desc = _html_to_plain_text(item.get("description", ""))
        normalized = {
            "subtitle": title,
            "description": desc,
            "issuer": item.get("issuer", ""),
            "date": item.get("awardedAt", ""),
        }
        result = _build_archive_entry("custom:c_awards", "获奖经历", title, normalized)
        if result:
            entries.append(result)

    for item in resume_archive.get("personalExperiences", []):
        if not isinstance(item, dict):
            continue
        title = (item.get("experienceTitle") or "").strip() or "个人经历"
        desc = _html_to_plain_text(item.get("description", ""))
        normalized = {
            "subtitle": title,
            "description": desc,
            "start_date": item.get("startDate", ""),
            "end_date": item.get("endDate", ""),
        }
        result = _build_archive_entry("custom:c_personal", "个人经历", title, normalized)
        if result:
            entries.append(result)

    for resolved_type, title, content_json in entries:
        section = ProfileSection(
            profile_id=profile.id,
            section_type=resolved_type,
            title=title,
            sort_order=sort_order,
            content_json=content_json,
            source="archive_sync",
            confidence=1.0,
        )
        db.add(section)
        sort_order += 1

    await db.flush()
    return sort_order


@router.put("/")
async def update_profile(data: ProfileUpdateRequest, db: AsyncSession = Depends(get_db)):
    profile = await _get_or_create_default_profile(db)

    payload = data.model_dump(exclude_none=True)
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


@router.get("/target-roles")
async def list_target_roles(db: AsyncSession = Depends(get_db)):
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


@router.post("/target-roles")
async def create_target_role(data: TargetRoleCreateRequest, db: AsyncSession = Depends(get_db)):
    fit = data.fit.strip().lower()
    if fit not in VALID_FITS:
        raise HTTPException(status_code=400, detail="fit must be primary/secondary/adjacent")

    profile = await _get_or_create_default_profile(db)

    role = ProfileTargetRole(
        profile_id=profile.id,
        role_name=data.role_name.strip(),
        role_level=data.role_level.strip(),
        fit=fit,
    )
    db.add(role)
    await db.commit()
    await db.refresh(role)
    return _serialize_target_role(role)


@router.delete("/target-roles/{role_id}")
async def delete_target_role(role_id: int, db: AsyncSession = Depends(get_db)):
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
        raise HTTPException(status_code=404, detail="Target role not found")

    await db.delete(role)
    await db.commit()
    return {"deleted": True}


@router.post("/sections")
async def create_profile_section(data: ProfileSectionCreateRequest, db: AsyncSession = Depends(get_db)):
    profile = await _get_or_create_default_profile(db)

    try:
        normalized_section_type = normalize_section_type_alias(data.section_type)
        if normalized_section_type in {"general", "activity", "competition"}:
            normalized_section_type = "custom"
        if not is_valid_profile_section_type(normalized_section_type):
            normalized_section_type = "custom"

        section_type, _, _, canonical_content_json = canonicalize_profile_section_payload(
            section_type=normalized_section_type,
            category_label=data.category_label,
            title=data.title.strip(),
            raw_content_json=data.content_json,
        )
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid section_type")

    sort_order = data.sort_order
    if sort_order <= 0:
        max_sort = (
            await db.execute(
                select(func.max(ProfileSection.sort_order)).where(ProfileSection.profile_id == profile.id)
            )
        ).scalar()
        sort_order = int(max_sort or 0) + 1

    section = ProfileSection(
        profile_id=profile.id,
        section_type=section_type,
        title=data.title.strip() or get_category_label(section_type, canonical_content_json),
        sort_order=sort_order,
        content_json=canonical_content_json,
        source=data.source,
        confidence=data.confidence,
    )
    db.add(section)
    await db.commit()
    await db.refresh(section)

    # 自动索引到 Vector DB
    try:
        from app.services.semantic_search import get_semantic_search
        semantic = get_semantic_search()
        bullet_text = canonical_content_json.get("bullet", "") if isinstance(canonical_content_json, dict) else ""
        await semantic.index_profile_section(
            section_id=section.id,
            title=section.title or "",
            bullet_text=bullet_text,
            profile_id=profile.id,
        )
        _logger.info(f"[Vector DB] Indexed section {section.id}")
    except Exception as e:
        _logger.error(f"[Vector DB] Failed to index section {section.id}: {e}")
        # 索引失败不影响主流程

    return _serialize_section(section)


@router.put("/sections/{section_id}")
async def update_profile_section(
    section_id: int,
    data: ProfileSectionUpdateRequest,
    db: AsyncSession = Depends(get_db),
):
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
        raise HTTPException(status_code=404, detail="Profile section not found")

    payload = data.model_dump(exclude_none=True)

    next_section_type = normalize_section_type_alias(str(payload.get("section_type") or section.section_type))
    if next_section_type in {"general", "activity", "competition"}:
        next_section_type = "custom"
    if not is_valid_profile_section_type(next_section_type):
        next_section_type = "custom"
    next_title = str(payload.get("title") or section.title or "").strip()
    next_content_json = payload.get("content_json") if "content_json" in payload else section.content_json
    next_category_label = payload.get("category_label")

    try:
        resolved_section_type, _, _, canonical_content_json = canonicalize_profile_section_payload(
            section_type=next_section_type,
            category_label=next_category_label,
            title=next_title,
            raw_content_json=next_content_json,
        )
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid section_type")

    if not next_title:
        next_title = get_category_label(resolved_section_type, canonical_content_json)

    section.section_type = resolved_section_type
    section.title = next_title
    section.content_json = canonical_content_json

    if "sort_order" in payload and payload["sort_order"] is not None:
        section.sort_order = int(payload["sort_order"])
    if "source" in payload and payload["source"] is not None:
        section.source = str(payload["source"])
    if "confidence" in payload and payload["confidence"] is not None:
        section.confidence = float(payload["confidence"])

    await db.commit()
    await db.refresh(section)

    # 自动更新 Vector DB 索引
    try:
        from app.services.semantic_search import get_semantic_search
        semantic = get_semantic_search()
        bullet_text = canonical_content_json.get("bullet", "") if isinstance(canonical_content_json, dict) else ""
        await semantic.index_profile_section(
            section_id=section.id,
            title=section.title or "",
            bullet_text=bullet_text,
            profile_id=profile.id,
        )
        _logger.info(f"[Vector DB] Updated index for section {section.id}")
    except Exception as e:
        _logger.error(f"[Vector DB] Failed to update index for section {section.id}: {e}")

    return _serialize_section(section)


@router.delete("/sections/{section_id}")
async def delete_profile_section(section_id: int, db: AsyncSession = Depends(get_db)):
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
        raise HTTPException(status_code=404, detail="Profile section not found")

    await db.delete(section)
    await db.commit()
    return {"deleted": True}


@router.post("/chat")
async def profile_chat(data: ProfileChatRequest, db: AsyncSession = Depends(get_db)):
    topic = data.topic.strip().lower()
    if topic not in VALID_TOPICS:
        raise HTTPException(status_code=400, detail="invalid topic")

    user_message = data.message.strip()
    if not user_message:
        raise HTTPException(status_code=400, detail="message is required")

    async def event_stream():
        try:
            profile = await _get_or_create_default_profile(db)

            if data.session_id is not None:
                session = (
                    await db.execute(
                        select(ProfileChatSession).where(
                            ProfileChatSession.id == data.session_id,
                            ProfileChatSession.profile_id == profile.id,
                        )
                    )
                ).scalar_one_or_none()
                if not session:
                    yield _sse("error", {"message": "chat session not found"})
                    return
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
                await db.commit()

            messages_json = list(session.messages_json or [])
            messages_json.append({"role": "user", "topic": topic, "content": user_message})

            payload = await _generate_chat_payload(topic, user_message)
            assistant_message = payload["assistant_message"]
            candidates = payload["bullet_candidates"]
            topic_complete = bool(payload.get("topic_complete", False))

            messages_json.append({"role": "assistant", "topic": topic, "content": assistant_message})
            messages_json.append({"kind": "bullet_candidates", "topic": topic, "candidates": candidates})

            session.topic = topic
            session.messages_json = messages_json
            session.extracted_bullets_count = int(session.extracted_bullets_count or 0) + len(candidates)

            await db.commit()

            yield _sse("ai_message", {"content": assistant_message, "session_id": session.id})
            for idx, candidate in enumerate(candidates):
                event_payload = {"index": idx, "session_id": session.id, **candidate}
                yield _sse("bullet_candidate", event_payload)

            if topic_complete:
                yield _sse("topic_complete", {"topic": topic, "bullets_extracted": len(candidates)})

            yield _sse("done", {"session_id": session.id})
        except Exception:
            await db.rollback()
            yield _sse("error", {"message": "profile chat failed"})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/chat/sessions")
async def list_profile_chat_sessions(
    limit: int = Query(default=20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
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


@router.get("/chat/sessions/{session_id}")
async def get_profile_chat_session(session_id: int, db: AsyncSession = Depends(get_db)):
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
        raise HTTPException(status_code=404, detail="chat session not found")

    messages_json = list(session.messages_json or [])
    return {
        **_serialize_chat_session(session),
        "messages_json": messages_json,
        "latest_candidates": _extract_last_candidates(messages_json),
    }


@router.post("/chat/confirm")
async def confirm_profile_bullet(data: ProfileChatConfirmRequest, db: AsyncSession = Depends(get_db)):
    profile = await _get_or_create_default_profile(db)

    session = (
        await db.execute(
            select(ProfileChatSession).where(
                ProfileChatSession.id == data.session_id,
                ProfileChatSession.profile_id == profile.id,
            )
        )
    ).scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="chat session not found")

    candidates = _extract_last_candidates(session.messages_json or [])
    if data.bullet_index >= len(candidates):
        raise HTTPException(status_code=400, detail="bullet_index out of range")

    candidate = dict(candidates[data.bullet_index])
    if data.edits:
        for key in ("section_type", "title", "content_json", "confidence"):
            if key in data.edits:
                candidate[key] = data.edits[key]

    candidate = _normalize_candidate(session.topic or "general", candidate)

    # 幂等保护：同一档案下若已存在同类型+同标题+同内容条目，则直接返回，避免重复入库
    existing_sections = (
        await db.execute(
            select(ProfileSection)
            .where(
                ProfileSection.profile_id == profile.id,
                ProfileSection.section_type == candidate["section_type"],
                ProfileSection.title == candidate["title"],
            )
            .order_by(ProfileSection.id.desc())
        )
    ).scalars().all()
    for existing in existing_sections:
        if (existing.content_json or {}) == candidate["content_json"]:
            return _serialize_section(existing)

    max_sort = (
        await db.execute(
            select(func.max(ProfileSection.sort_order)).where(ProfileSection.profile_id == profile.id)
        )
    ).scalar()
    next_sort = int(max_sort or 0) + 1

    section = ProfileSection(
        profile_id=profile.id,
        section_type=candidate["section_type"],
        title=candidate["title"],
        sort_order=next_sort,
        content_json=candidate["content_json"],
        source="ai_chat",
        confidence=candidate["confidence"],
    )
    db.add(section)
    await db.commit()
    await db.refresh(section)

    return _serialize_section(section)


@router.post("/import-resume")
async def import_profile_resume(
    file: UploadFile = File(...),
    parse_mode: str = Query(default="ai"),
    db: AsyncSession = Depends(get_db),
):
    normalized_parse_mode = _normalize_resume_import_mode(parse_mode)
    if not file.filename:
        raise HTTPException(status_code=400, detail="missing filename")

    filename = file.filename.strip()
    lower = filename.lower()
    if not any(lower.endswith(ext) for ext in ALLOWED_RESUME_IMPORT_EXTENSIONS):
        raise HTTPException(status_code=400, detail="unsupported file type, only .pdf/.docx")

    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(status_code=400, detail="empty file")
    if len(file_bytes) > MAX_RESUME_IMPORT_FILE_SIZE:
        raise HTTPException(status_code=400, detail="file too large (max 10MB)")

    from app.services.resume_parser import parse_resume_document

    parsed_document = await parse_resume_document(filename, file_bytes)
    parsed_text = parsed_document.text if parsed_document else ""
    parse_diagnostics = parsed_document.public_dict() if parsed_document else {}
    if not parsed_text or not parsed_text.strip():
        ocr_unavailable = any(
            "ocr_unavailable" in str(warning)
            for warning in parse_diagnostics.get("warnings", [])
        )
        detail = (
            "这是扫描版 PDF，但本机 OCR 不可用；请安装 Tesseract（中文 chi_sim + 英文 eng）后重试"
            if ocr_unavailable
            else "resume text is empty"
        )
        raise HTTPException(status_code=400, detail=detail)

    profile = await _get_or_create_default_profile(db)
    base_info = _extract_resume_base_info(parsed_text)
    import_payload = await _extract_resume_import_payload_by_mode(parsed_text, normalized_parse_mode)
    llm_base_info = import_payload.get("base_info") if isinstance(import_payload, dict) else {}
    if isinstance(llm_base_info, dict):
        for key, value in llm_base_info.items():
            text_value = str(value or "").strip()
            if text_value and not str(base_info.get(key, "")).strip():
                base_info[key] = text_value
    candidates = import_payload.get("candidates") if isinstance(import_payload, dict) else []
    if not isinstance(candidates, list):
        candidates = _coalesce_resume_entry_candidates(_fallback_resume_candidates(parsed_text))
    from app.services.resume_parser import locate_resume_source_pages

    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        source_pages = (
            locate_resume_source_pages(parsed_document, candidate)
            if parsed_document.parser != "python-docx"
            else []
        )
        candidate["source_pages"] = source_pages
        candidate["source_ref"] = (
            "、".join(f"第{page_number}页" for page_number in source_pages)
            if source_pages
            else (
                "Word 文档正文"
                if parsed_document.parser == "python-docx"
                else "未能精确定位原文页码"
            )
        )

    memory_summary = _resume_import_memory_summary(
        filename=filename,
        parse_mode=normalized_parse_mode,
        parsed_text=parsed_text,
        base_info=base_info,
        candidates=candidates,
    )
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
                "parse_mode": normalized_parse_mode,
                "base_info": base_info,
                "parse_diagnostics": parse_diagnostics,
            },
            memory_summary,
            {
                "kind": "bullet_candidates",
                "topic": "general",
                "candidates": candidates,
            },
        ],
        extracted_bullets_count=len(candidates),
    )
    db.add(session)
    agent_messages_json, _agent_patch = _build_resume_import_agent_messages(
        filename=filename,
        parse_mode=normalized_parse_mode,
        parsed_text=parsed_text,
        base_info=base_info,
        candidates=candidates,
    )
    agent_session = ProfileChatSession(
        profile_id=profile.id,
        topic=PROFILE_AGENT_TOPIC,
        status="active",
        messages_json=agent_messages_json,
        extracted_bullets_count=len(candidates),
    )
    db.add(agent_session)
    await db.commit()
    await db.refresh(session)
    await db.refresh(agent_session)

    bullets = [
        {
            "index": idx,
            "session_id": session.id,
            **candidate,
        }
        for idx, candidate in enumerate(candidates)
    ]

    return {
        "session_id": session.id,
        "agent_session_id": agent_session.id,
        "filename": filename,
        "parse_mode": normalized_parse_mode,
        "text_length": len(parsed_text),
        "parse_diagnostics": parse_diagnostics,
        "base_info": base_info,
        "bullets": bullets,
    }


@router.post("/generate-narrative")
async def generate_narrative(db: AsyncSession = Depends(get_db)):
    profile = await _get_or_create_default_profile(db)
    sections = (
        await db.execute(
            select(ProfileSection)
            .where(ProfileSection.profile_id == profile.id)
            .order_by(ProfileSection.sort_order.asc(), ProfileSection.created_at.asc())
        )
    ).scalars().all()

    section_texts = []
    for item in sections[:30]:
        section_texts.append(f"[{item.section_type}] {item.title} {json.dumps(item.content_json, ensure_ascii=False)}")

    context_text = "\n".join(section_texts) if section_texts else "暂无条目"

    prompt = (
        "你是求职档案叙事助手。根据给定档案条目，生成严格 JSON: "
        "{\"headline\": string, \"exit_story\": string, \"cross_cutting_advantage\": string}。"
        "不要编造事实，措辞简洁。"
    )

    try:
        llm_result = await chat_completion(
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": context_text},
            ],
            temperature=0.3,
            json_mode=True,
            max_tokens=800,
            tier="fast",
        )
        parsed = extract_json(llm_result or "")
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


@router.post("/instant-draft")
async def instant_draft(data: InstantDraftRequest):
    """Step 2.5 即时价值钩子：根据经历标题快速生成简历草稿框架。"""
    experiences = [item.strip() for item in data.experiences if isinstance(item, str) and item.strip()]
    if not experiences:
        raise HTTPException(status_code=400, detail="请至少提供一段经历名称")

    target_roles = [item.strip() for item in data.target_roles if isinstance(item, str) and item.strip()]

    if _generate_instant_draft is not None:
        try:
            generated = await _generate_instant_draft(experiences=experiences, target_roles=target_roles)
            if isinstance(generated, dict) and generated:
                return generated
        except Exception:
            pass

    role_text = "、".join(target_roles) if target_roles else "通用岗位"
    sections = []
    for exp in experiences[:5]:
        sections.append(
            {
                "section_type": "project",
                "title": exp,
                "bullets": [
                    f"负责{exp}相关事项，完成关键任务，[具体成果待补充]",
                    "与团队协作推进项目落地，[数据指标待补充]",
                ],
            }
        )

    return {
        "headline": f"面向{role_text}方向的候选人",
        "sections": sections,
        "missing_hints": ["请补充量化结果（如增长、转化、效率）", "请补充时间范围和你的具体角色"],
        "encouragement": "你已经有很好的素材，补上细节后会非常有竞争力。",
    }


def _collect_profile_strings(payload: Any, output: set[str]) -> None:
    if isinstance(payload, str):
        value = payload.strip()
        if value:
            output.add(value)
        return

    if isinstance(payload, list):
        for item in payload:
            _collect_profile_strings(item, output)
        return

    if isinstance(payload, dict):
        for item in payload.values():
            _collect_profile_strings(item, output)
        return


def _is_enum_compatible(value: str) -> bool:
    normalized = value.strip().lower()
    if not normalized:
        return False
    allowed = {
        "男",
        "女",
        "不便透露",
        "已婚",
        "未婚",
        "离异",
        "丧偶",
        "是",
        "否",
        "yes",
        "no",
        "male",
        "female",
    }
    return normalized in allowed


def _sanitize_ai_mappings(
    parsed: dict[str, Any],
    fields: list[SmartFillFieldItem],
    catalog: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    mappings = parsed.get("mappings")
    if not isinstance(mappings, list):
        return []

    field_ids = {item.fieldId for item in fields}
    catalog_by_path = {str(item.get("path") or ""): item for item in catalog if isinstance(item, dict)}
    catalog_by_key = {str(item.get("key") or ""): item for item in catalog if isinstance(item, dict)}

    result: list[dict[str, Any]] = []
    for row in mappings:
        if not isinstance(row, dict):
            continue
        field_id = str(row.get("fieldId") or "").strip()
        profile_path = str(row.get("profilePath") or row.get("sourcePath") or row.get("resumePath") or "").strip()
        catalog_key = str(row.get("catalogKey") or row.get("key") or "").strip()
        reason = str(row.get("reason") or "").strip()
        transform = row.get("transform") if isinstance(row.get("transform"), dict) else {"type": "none"}
        confidence_raw = row.get("confidence")
        try:
            confidence = float(confidence_raw)
        except (TypeError, ValueError):
            confidence = 0.0
        confidence = max(0.0, min(1.0, confidence))

        if not field_id or field_id not in field_ids:
            continue
        item = catalog_by_path.get(profile_path) or catalog_by_key.get(catalog_key)
        if not item:
            continue

        result.append(
            {
                "fieldId": field_id,
                "profilePath": str(item.get("path") or profile_path),
                "catalogKey": str(item.get("key") or catalog_key or item.get("path") or ""),
                "intent": str(item.get("label") or ""),
                "category": str(item.get("categoryLabel") or ""),
                "itemIndex": item.get("itemIndex"),
                "transform": transform,
                "confidence": confidence,
                "reason": reason,
            }
        )
    return result


def _new_smartfill_run_id() -> str:
    return f"sf-{uuid.uuid4().hex[:20]}"


async def _ensure_smartfill_run(db: AsyncSession, run_id: str, status: str = "running") -> SmartFillRun:
    existing = (
        await db.execute(
            select(SmartFillRun).where(SmartFillRun.run_id == run_id)
        )
    ).scalar_one_or_none()
    if existing:
        return existing
    row = SmartFillRun(run_id=run_id, status=status, summary_json={})
    db.add(row)
    await db.flush()
    return row


def _parse_dt_iso(value: Optional[str]) -> datetime:
    if not value:
        return datetime.utcnow()
    text = value.strip()
    if not text:
        return datetime.utcnow()
    text = text.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text).replace(tzinfo=None)
    except Exception:
        return datetime.utcnow()


SMART_FILL_KEY_LABELS = {
    "name": "姓名",
    "fullName": "姓名",
    "phone": "手机号",
    "email": "邮箱",
    "current_city": "所在城市",
    "city": "所在城市",
    "job_intention": "目标岗位",
    "summary": "个人简介",
    "personal_summary": "个人简介",
    "school": "学校名称",
    "schoolName": "学校名称",
    "degree": "学位",
    "major": "专业",
    "educationLevel": "学历",
    "relatedCourses": "相关课程",
    "courses": "相关课程",
    "start_date": "开始时间",
    "startDate": "开始时间",
    "end_date": "结束时间",
    "endDate": "结束时间",
    "gpa": "GPA",
    "company": "公司名称",
    "companyName": "公司名称",
    "position": "职位名称",
    "jobTitle": "职位名称",
    "positionName": "职位名称",
    "department": "部门",
    "role": "担任角色",
    "projectName": "项目名称",
    "projectRole": "项目角色",
    "projectLink": "项目链接",
    "description": "描述",
    "descriptions": "描述列表",
    "skillName": "技能名称",
    "proficiency": "掌握程度",
    "remark": "备注",
    "certificateName": "证书名称",
    "scoreOrLevel": "证书成绩/等级",
    "acquiredAt": "获得时间",
    "issuer": "颁发机构",
    "awardName": "奖项名称",
    "awardedAt": "获奖时间",
    "experienceTitle": "经历名称",
    "fileName": "附件名称",
    "chineseName": "中文姓名",
    "englishOrPinyinName": "英文/拼音姓名",
    "gender": "性别",
    "birthDate": "出生日期",
    "nationalityOrRegion": "国籍/地区",
    "idType": "证件类型",
    "idNumber": "证件号码",
    "currentAddress": "现居住地址",
    "nativePlace": "籍贯",
    "householdRegistration": "户籍所在地",
    "ethnicity": "民族",
    "politicalStatus": "政治面貌",
    "maritalStatus": "婚姻状况",
    "expectedPosition": "期望职位",
    "expectedPositionCategory": "期望职位类别",
    "expectedCities": "期望城市",
    "expectedSalary": "期望薪资",
    "employmentType": "工作类型",
    "availableStartDate": "到岗时间",
    "currentJobSearchStatus": "求职状态",
    "acceptAdjustment": "是否接受调剂",
    "acceptBusinessTravel": "是否接受出差",
    "acceptAssignment": "是否接受外派",
    "acceptShiftWork": "是否接受倒班",
    "isFreshGraduate": "是否应届生",
    "graduationDate": "毕业时间",
    "studentOrigin": "生源地",
    "studentStatus": "学生状态",
    "studentId": "学号",
    "majorRank": "专业排名",
    "thesis": "论文题目",
    "patent": "专利",
    "researchExperiences": "科研经历",
    "relation": "关系",
    "contact": "联系电话",
    "hasRelativeInTargetCompany": "是否有亲属在目标公司",
    "emergencyContactName": "紧急联系人姓名",
    "emergencyContactRelation": "紧急联系人关系",
    "emergencyContactPhone": "紧急联系人电话",
    "backgroundCheckAuthorization": "背调授权",
    "hasNonCompete": "是否有竞业限制",
    "healthDeclaration": "健康声明",
    "sourceChannel": "来源渠道",
    "referralCode": "内推码",
    "referralName": "内推人姓名",
    "referralEmployeeId": "内推人工号",
    "referralContact": "内推人联系方式",
    "recommenderInfo": "推荐信息",
    "notes": "备注",
    "url": "链接",
    "link": "链接",
}


def _smartfill_str(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (str, int, float, bool)):
        return str(value).strip()
    return ""


def _smartfill_scalar_list_text(value: list[Any]) -> str:
    parts = [_smartfill_str(item) for item in value]
    return "; ".join(part for part in parts if part)


def _smartfill_label_for_key(key: str) -> str:
    if key in SMART_FILL_KEY_LABELS:
        return SMART_FILL_KEY_LABELS[key]
    tail = re.split(r"[._-]", key)[-1] if key else key
    return SMART_FILL_KEY_LABELS.get(tail, tail or "字段")


def _smartfill_value_type(label: str, path: str, value: str) -> str:
    text = f"{label} {path}".lower()
    if re.search(r"email|邮箱|邮件", text):
        return "email"
    if re.search(r"phone|mobile|tel|手机|电话|联系方式", text):
        return "phone"
    if re.search(r"url|link|github|linkedin|website|链接|网址|主页|作品|论文", text):
        return "url"
    if re.search(r"idnumber|identity|身份证|证件号|证件号码", text):
        return "id-number"
    if re.search(r"date|time|日期|时间|开始|结束|出生|毕业|入学|到岗", text):
        return "date-range" if _smartfill_is_date_range_value(value) else "date"
    if re.search(r"gender|sex|性别|学历|学位|政治面貌|婚姻|是否|状态|类型", text):
        return "choice"
    if re.search(r"课程|技能|skills|items|relatedcourses", text):
        return "multi-choice"
    if re.search(r"gpa|score|rank|height|weight|薪资|分数|成绩|排名", text) and re.search(r"\d", value):
        return "number"
    if len(value) > 120 or re.search(r"description|summary|content|描述|简介|评价|职责|内容", text):
        return "long-text"
    return "text"


def _smartfill_is_date_range_value(value: str) -> bool:
    text = _smartfill_str(value)
    if not text:
        return False
    date_token = r"(?:19|20)\d{2}(?:[-/.年]\s?\d{1,2})?(?:[-/.月]\s?\d{1,2})?"
    return bool(re.search(fr"{date_token}\s*(?:至|到|~|—|–|\s-\s)\s*{date_token}", text))


def _smartfill_signature(*parts: Any) -> str:
    text = "::".join(str(part or "") for part in parts)
    hash_value = 2166136261
    for char in text:
        hash_value ^= ord(char)
        hash_value += (hash_value << 1) + (hash_value << 4) + (hash_value << 7) + (hash_value << 8) + (hash_value << 24)
    return f"{hash_value & 0xFFFFFFFF:08x}"


def _smartfill_section_type(category_key: str, category_label: str, path: str) -> str:
    source = f"{category_key} {category_label} {path}"
    if re.search(r"education|教育|学校", source, re.I):
        return "education"
    if re.search(r"intern|实习", source, re.I):
        return "internship"
    if re.search(r"experience|work|工作", source, re.I):
        return "work"
    if re.search(r"project|项目", source, re.I):
        return "project"
    if re.search(r"certificate|证书|语言", source, re.I):
        return "certificate"
    if re.search(r"award|honou?r|奖|荣誉", source, re.I):
        return "award"
    if re.search(r"skill|技能", source, re.I):
        return "skill"
    if re.search(r"basic|identity|基本|身份|联系", source, re.I):
        return "basic"
    return "general"


def _push_smartfill_catalog_item(
    output: list[dict[str, Any]],
    seen: set[str],
    *,
    path: str,
    label: str,
    value: str,
    category_key: str,
    category_label: str,
    section_type: str = "",
    item_index: Optional[int] = None,
    aliases: Optional[list[str]] = None,
    source_ref: str = "",
) -> None:
    value = _smartfill_str(value)
    if not value:
        return
    if value.strip().startswith(("{", "[")) and value.strip().endswith(("}", "]")):
        return
    if path in seen:
        return
    seen.add(path)
    resolved_section_type = section_type or _smartfill_section_type(category_key, category_label, path)
    value_type = _smartfill_value_type(label, path, value)
    signature = _smartfill_signature(path, label, category_label, item_index or "", value_type)
    clean_aliases = []
    for alias in [label, *(aliases or [])]:
        alias_text = _smartfill_str(alias)
        if alias_text and alias_text not in clean_aliases:
            clean_aliases.append(alias_text)
    output.append(
        {
            "key": path,
            "path": path,
            "label": label,
            "categoryKey": category_key or resolved_section_type,
            "categoryLabel": category_label,
            "sectionType": resolved_section_type,
            "itemIndex": item_index,
            "valueType": value_type,
            "aliases": clean_aliases,
            "sourceRef": source_ref or f"{category_label}/{label}",
            "signature": signature,
            "value": value,
        }
    )


def _flatten_smartfill_payload(
    output: list[dict[str, Any]],
    seen: set[str],
    *,
    base_path: str,
    payload: Any,
    category_key: str,
    category_label: str,
    section_type: str,
    item_index: Optional[int] = None,
) -> None:
    if isinstance(payload, list):
        if all(not isinstance(item, (dict, list)) for item in payload):
            text = _smartfill_scalar_list_text(payload)
            if text:
                key = base_path.rsplit(".", 1)[-1] if base_path else category_label
                label = _smartfill_label_for_key(key)
                _push_smartfill_catalog_item(
                    output,
                    seen,
                    path=base_path,
                    label=label,
                    value=text,
                    category_key=category_key,
                    category_label=category_label,
                    section_type=section_type,
                    item_index=item_index,
                    aliases=[key, label],
                    source_ref=f"{category_label}{f'/第{item_index}条' if item_index else ''}/{label}",
                )
            return
        for index, item in enumerate(payload):
            _flatten_smartfill_payload(
                output,
                seen,
                base_path=f"{base_path}.{index}",
                payload=item,
                category_key=category_key,
                category_label=category_label,
                section_type=section_type,
                item_index=index + 1,
            )
        return

    if isinstance(payload, dict):
        for key, value in payload.items():
            if key in {"id", "source", "confidence"}:
                continue
            if base_path.startswith("applicationArchive.attachments.") and key not in {"fileName", "url", "link"}:
                continue
            if base_path.startswith("applicationArchive.") and key in {"fileType", "fileSize", "uploadedAt", "fieldType"}:
                continue
            next_path = f"{base_path}.{key}" if base_path else key
            if isinstance(value, (dict, list)):
                _flatten_smartfill_payload(
                    output,
                    seen,
                    base_path=next_path,
                    payload=value,
                    category_key=category_key,
                    category_label=category_label,
                    section_type=section_type,
                    item_index=item_index,
                )
                continue
            text = _smartfill_str(value)
            if not text:
                continue
            label = _smartfill_label_for_key(key)
            _push_smartfill_catalog_item(
                output,
                seen,
                path=next_path,
                label=label,
                value=text,
                category_key=category_key,
                category_label=category_label,
                section_type=section_type,
                item_index=item_index,
                aliases=[key, label],
                source_ref=f"{category_label}{f'/第{item_index}条' if item_index else ''}/{label}",
            )
        return

    text = _smartfill_str(payload)
    if text:
        _push_smartfill_catalog_item(
            output,
            seen,
            path=base_path,
            label=category_label,
            value=text,
            category_key=category_key,
            category_label=category_label,
            section_type=section_type,
            item_index=item_index,
            aliases=[category_label],
        )


def _smartfill_profile_view(profile_payload: dict[str, Any]) -> dict[str, Any]:
    payload = profile_payload if isinstance(profile_payload, dict) else {}
    sections = payload.get("sections") if isinstance(payload.get("sections"), list) else []

    direct_basic = payload.get("basic") if isinstance(payload.get("basic"), dict) else {}
    direct_resume = payload.get("resumeArchive") if isinstance(payload.get("resumeArchive"), dict) else {}
    direct_application = payload.get("applicationArchive") if isinstance(payload.get("applicationArchive"), dict) else {}
    if direct_basic or direct_resume or direct_application:
        return {
            "basic": direct_basic,
            "resumeArchive": direct_resume,
            "applicationArchive": direct_application,
            "sections": sections,
        }

    base_info_json = payload.get("base_info_json") if isinstance(payload.get("base_info_json"), dict) else {}
    personal_archive = base_info_json.get("personal_archive") if isinstance(base_info_json.get("personal_archive"), dict) else {}
    resume_archive_legacy = personal_archive.get("resumeArchive") if isinstance(personal_archive.get("resumeArchive"), dict) else {}
    application_archive_legacy = personal_archive.get("applicationArchive") if isinstance(personal_archive.get("applicationArchive"), dict) else {}
    resume_basic = resume_archive_legacy.get("basicInfo") if isinstance(resume_archive_legacy.get("basicInfo"), dict) else {}

    if resume_archive_legacy or application_archive_legacy:
        return {
            "basic": {
                "fullName": _smartfill_str(resume_basic.get("name") or base_info_json.get("name") or payload.get("name")),
                "phone": _smartfill_str(resume_basic.get("phone") or base_info_json.get("phone") or payload.get("phone")),
                "email": _smartfill_str(resume_basic.get("email") or base_info_json.get("email") or payload.get("email")),
                "city": _smartfill_str(
                    resume_basic.get("currentCity")
                    or base_info_json.get("current_city")
                    or payload.get("current_city")
                ),
                "targetRole": _smartfill_str(
                    resume_basic.get("jobIntention")
                    or base_info_json.get("job_intention")
                    or payload.get("job_intention")
                ),
                "website": _smartfill_str(resume_basic.get("website") or base_info_json.get("website") or payload.get("website")),
                "github": _smartfill_str(resume_basic.get("github") or base_info_json.get("github") or payload.get("github")),
                "linkedin": _smartfill_str(resume_basic.get("linkedin") or base_info_json.get("linkedin") or payload.get("linkedin")),
                "summary": _smartfill_str(
                    resume_archive_legacy.get("personalSummary")
                    or base_info_json.get("personal_summary")
                    or base_info_json.get("summary")
                    or payload.get("personal_summary")
                    or payload.get("summary")
                    or payload.get("headline")
                ),
            },
            "resumeArchive": resume_archive_legacy,
            "applicationArchive": application_archive_legacy,
            "sections": sections,
        }

    return {
        "basic": {
            "fullName": _smartfill_str(base_info_json.get("name") or payload.get("name")),
            "phone": _smartfill_str(base_info_json.get("phone") or payload.get("phone")),
            "email": _smartfill_str(base_info_json.get("email") or payload.get("email")),
            "city": _smartfill_str(base_info_json.get("current_city") or payload.get("current_city")),
            "targetRole": _smartfill_str(base_info_json.get("job_intention") or payload.get("job_intention")),
            "website": _smartfill_str(base_info_json.get("website") or payload.get("website")),
            "github": _smartfill_str(base_info_json.get("github") or payload.get("github")),
            "linkedin": _smartfill_str(base_info_json.get("linkedin") or payload.get("linkedin")),
            "summary": _smartfill_str(
                base_info_json.get("personal_summary")
                or base_info_json.get("summary")
                or payload.get("personal_summary")
                or payload.get("summary")
                or payload.get("headline")
            ),
        },
        "resumeArchive": {},
        "applicationArchive": {},
        "sections": sections,
    }


def _build_smartfill_catalog_from_profile(profile_payload: dict[str, Any]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    seen: set[str] = set()
    profile_view = _smartfill_profile_view(profile_payload)

    basic = profile_view.get("basic") if isinstance(profile_view.get("basic"), dict) else {}
    basic_map = {
        "fullName": "姓名",
        "phone": "手机号",
        "email": "邮箱",
        "city": "所在城市",
        "targetRole": "目标岗位",
        "website": "个人网站",
        "github": "GitHub",
        "linkedin": "LinkedIn",
        "summary": "个人简介",
    }
    for key, label in basic_map.items():
        value = _smartfill_str(basic.get(key))
        _push_smartfill_catalog_item(
            output,
            seen,
            path=f"basic.{key}",
            label=label,
            value=value,
            category_key="basic",
            category_label="基本信息",
            section_type="basic",
            aliases=[label, key],
            source_ref=f"基本信息/{label}",
        )

    resume_archive = profile_view.get("resumeArchive") if isinstance(profile_view.get("resumeArchive"), dict) else {}
    resume_sections = [
        ("education", "教育经历", "education"),
        ("workExperiences", "工作经历", "work"),
        ("internshipExperiences", "实习经历", "internship"),
        ("projects", "项目经历", "project"),
        ("skills", "技能", "skill"),
        ("certificates", "证书", "certificate"),
        ("awards", "获奖经历", "award"),
        ("personalExperiences", "个人经历", "experience"),
    ]
    for key, label, section_type in resume_sections:
        _flatten_smartfill_payload(
            output,
            seen,
            base_path=f"resumeArchive.{key}",
            payload=resume_archive.get(key),
            category_key=section_type,
            category_label=label,
            section_type=section_type,
        )

    app_archive = profile_view.get("applicationArchive") if isinstance(profile_view.get("applicationArchive"), dict) else {}
    for key, value in app_archive.items():
        if not isinstance(value, dict):
            continue
        category_label = {
            "shared": "共享信息",
            "identityContact": "身份联系",
            "jobPreference": "求职偏好",
            "campusFields": "校招专项",
            "relationshipCompliance": "关系合规",
            "sourceReferral": "来源推荐",
            "attachments": "附件",
        }.get(key, key)
        _flatten_smartfill_payload(
            output,
            seen,
            base_path=f"applicationArchive.{key}",
            payload=value,
            category_key=key,
            category_label=category_label,
            section_type=_smartfill_section_type(key, category_label, key),
        )

    for section_index, section in enumerate(profile_view.get("sections") or []):
        if not isinstance(section, dict):
            continue
        category_key = _smartfill_str(section.get("category_key") or section.get("section_type") or f"section{section_index}")
        category_label = _smartfill_str(section.get("category_label") or section.get("title") or category_key)
        content = section.get("content_json") if isinstance(section.get("content_json"), dict) else {}
        normalized = content.get("normalized") if isinstance(content.get("normalized"), dict) else content
        _flatten_smartfill_payload(
            output,
            seen,
            base_path=f"sections.{section_index}.{category_key}",
            payload=normalized,
            category_key=category_key,
            category_label=category_label,
            section_type=_smartfill_section_type(category_key, category_label, category_key),
        )

    return output


def _sanitize_smartfill_catalog(catalog: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in catalog:
        if not isinstance(row, dict):
            continue
        path = _smartfill_str(row.get("path") or row.get("key"))
        label = _smartfill_str(row.get("label"))
        if not path or not label or path in seen:
            continue
        seen.add(path)
        result.append(
            {
                "key": _smartfill_str(row.get("key") or path),
                "path": path,
                "label": label,
                "categoryKey": _smartfill_str(row.get("categoryKey") or row.get("sectionType")),
                "categoryLabel": _smartfill_str(row.get("categoryLabel") or row.get("category")),
                "sectionType": _smartfill_str(row.get("sectionType") or row.get("categoryKey") or "general"),
                "itemIndex": row.get("itemIndex") if isinstance(row.get("itemIndex"), int) else None,
                "valueType": _smartfill_str(row.get("valueType") or "text"),
                "aliases": [str(item).strip() for item in row.get("aliases") or [] if str(item).strip()][:12],
                "sourceRef": _smartfill_str(row.get("sourceRef")),
                "signature": _smartfill_str(row.get("signature") or _smartfill_signature(path, label)),
            }
        )
    return result


@router.post("/smart-fill/ping")
async def smart_fill_ping(_data: SmartFillPingRequest):
    """
    检查后端 AI 通道可用性。
    不暴露任何敏感信息，仅返回是否可用与简短原因。
    """
    try:
        result = await chat_completion(
            messages=[
                {"role": "system", "content": "你是连通性探针，只回复 pong。"},
                {"role": "user", "content": "ping"},
            ],
            temperature=0,
            json_mode=False,
            max_tokens=8,
            tier="fast",
        )
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"AI 服务不可用: {exc}") from exc

    if not result:
        raise HTTPException(status_code=503, detail="AI 服务不可用: empty response")

    return {"ok": True, "message": "pong"}


@router.post("/smart-fill/cache/get")
async def smart_fill_cache_get(data: SmartFillCacheGetRequest, db: AsyncSession = Depends(get_db)):
    now = datetime.utcnow()
    row = (
        await db.execute(
            select(SmartFillMapCache).where(
                SmartFillMapCache.cache_key == data.cacheKey,
                SmartFillMapCache.expires_at > now,
            )
        )
    ).scalar_one_or_none()
    if not row:
        return {"ok": True, "hit": False, "mappings": []}

    mappings = row.mappings_json if isinstance(row.mappings_json, list) else []
    return {
        "ok": True,
        "hit": True,
        "mappings": mappings,
        "channel": row.channel or "backend",
        "fallbackUsed": bool(row.fallback_used),
        "runId": row.run_id or "",
    }


@router.post("/smart-fill/cache/set")
async def smart_fill_cache_set(data: SmartFillCacheSetRequest, db: AsyncSession = Depends(get_db)):
    now = datetime.utcnow()
    expires_at = now + timedelta(seconds=max(30, min(7200, data.ttlSeconds)))
    existing = (
        await db.execute(
            select(SmartFillMapCache).where(SmartFillMapCache.cache_key == data.cacheKey)
        )
    ).scalar_one_or_none()

    if existing:
        existing.adapter_id = data.adapterId or "unknown"
        existing.model_signature = data.modelSignature or ""
        existing.mappings_json = data.mappings
        existing.channel = data.channel or "backend"
        existing.fallback_used = bool(data.fallbackUsed)
        existing.expires_at = expires_at
        if data.runId:
            existing.run_id = data.runId
    else:
        row = SmartFillMapCache(
            cache_key=data.cacheKey,
            adapter_id=data.adapterId or "unknown",
            model_signature=data.modelSignature or "",
            mappings_json=data.mappings,
            channel=data.channel or "backend",
            fallback_used=bool(data.fallbackUsed),
            expires_at=expires_at,
            run_id=data.runId or None,
        )
        db.add(row)

    await db.commit()
    return {"ok": True, "saved": True}


@router.post("/smart-fill/runs/log")
async def smart_fill_runs_log(data: SmartFillRunLogRequest, db: AsyncSession = Depends(get_db)):
    run = await _ensure_smartfill_run(db, data.runId, status="running")
    inserted = 0
    for item in data.logs:
        row = SmartFillRunLog(
            run_id=data.runId,
            stage=item.stage,
            severity=item.severity or "info",
            scope=item.scope or "run",
            message=item.message or "",
            field_id=item.fieldId or "",
            payload_json=item.payload if isinstance(item.payload, dict) else {},
            ts=_parse_dt_iso(item.ts),
        )
        db.add(row)
        inserted += 1

    run.updated_at = datetime.utcnow()
    await db.commit()
    return {"ok": True, "inserted": inserted}


@router.get("/smart-fill/runs/{run_id}")
async def smart_fill_run_summary(run_id: str, db: AsyncSession = Depends(get_db)):
    run = (
        await db.execute(
            select(SmartFillRun).where(SmartFillRun.run_id == run_id)
        )
    ).scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404, detail="run not found")

    logs = (
        await db.execute(
            select(SmartFillRunLog)
            .where(SmartFillRunLog.run_id == run_id)
            .order_by(SmartFillRunLog.ts.asc(), SmartFillRunLog.id.asc())
        )
    ).scalars().all()
    return {
        "ok": True,
        "runId": run.run_id,
        "status": run.status,
        "summary": run.summary_json if isinstance(run.summary_json, dict) else {},
        "logCount": len(logs),
    }


@router.get("/smart-fill/runs/{run_id}/export")
async def smart_fill_run_export(run_id: str, db: AsyncSession = Depends(get_db)):
    run = (
        await db.execute(
            select(SmartFillRun).where(SmartFillRun.run_id == run_id)
        )
    ).scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404, detail="run not found")

    logs = (
        await db.execute(
            select(SmartFillRunLog)
            .where(SmartFillRunLog.run_id == run_id)
            .order_by(SmartFillRunLog.ts.asc(), SmartFillRunLog.id.asc())
        )
    ).scalars().all()
    return {
        "ok": True,
        "runId": run.run_id,
        "status": run.status,
        "summary": run.summary_json if isinstance(run.summary_json, dict) else {},
        "logs": [
            {
                "stage": row.stage,
                "severity": row.severity,
                "scope": row.scope,
                "message": row.message,
                "fieldId": row.field_id,
                "payload": row.payload_json if isinstance(row.payload_json, dict) else {},
                "ts": row.ts.isoformat() if isinstance(row.ts, datetime) else str(row.ts),
            }
            for row in logs
        ],
    }


@router.post("/smart-fill/map")
async def smart_fill_map(data: SmartFillMapRequest, db: AsyncSession = Depends(get_db)):
    """
    后端 AI 通道：仅返回字段映射建议，不执行任何 DOM 写入。
    """
    fields = data.fields or []
    run_id = _new_smartfill_run_id()
    await _ensure_smartfill_run(db, run_id, status="running")
    await db.commit()
    if len(fields) == 0:
        return {"ok": True, "mappings": [], "runId": run_id}

    profile_payload: dict[str, Any]
    if isinstance(data.profile, dict) and data.profile:
        profile_payload = data.profile
    else:
        profile = await _get_or_create_default_profile(db)
        normalized_base_info = normalize_base_info_payload(profile.base_info_json)
        if profile.base_info_json != normalized_base_info:
            profile.base_info_json = normalized_base_info
            await db.commit()
        profile, roles, sections = await _load_profile_bundle(db, profile.id)
        profile_payload = _serialize_profile(profile, roles, sections)

    if data.catalog:
        public_catalog = _sanitize_smartfill_catalog(data.catalog)
        private_catalog = []
        value_by_path: dict[str, str] = {}
        for row in data.profileValues:
            if isinstance(row, dict):
                path = str(row.get("path") or row.get("key") or "").strip()
                value = str(row.get("value") or "").strip()
                if path and value:
                    value_by_path[path] = value
        for row in public_catalog:
            with_value = dict(row)
            if with_value["path"] in value_by_path:
                with_value["value"] = value_by_path[with_value["path"]]
            private_catalog.append(with_value)
    else:
        private_catalog = _build_smartfill_catalog_from_profile(profile_payload)
        public_catalog = [{key: value for key, value in item.items() if key != "value"} for item in private_catalog]

    prompt = (
        "你是招聘表单字段映射助手。"
        "请严格输出 JSON：{\"mappings\":[{\"fieldId\":\"...\",\"profilePath\":\"...\",\"catalogKey\":\"...\",\"confidence\":0-1,\"transform\":{\"type\":\"none\"},\"reason\":\"...\"}]}。"
        "只能从 catalog 中选择已有 path/key，不要输出用户真实值，不要编造。"
        "如果字段语义不明确，宁可不返回映射。"
    )

    try:
        llm_result = await chat_completion(
            messages=[
                {"role": "system", "content": prompt},
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "fields": [item.model_dump() for item in fields],
                            "catalog": public_catalog,
                        },
                        ensure_ascii=False,
                    ),
                },
            ],
            temperature=0.1,
            json_mode=True,
            max_tokens=1200,
            tier="fast",
        )
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"AI 映射失败: {exc}") from exc

    parsed = extract_json(llm_result or "")
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=502, detail="AI 映射返回格式异常")

    mappings = _sanitize_ai_mappings(parsed, fields, private_catalog)
    run = (
        await db.execute(
            select(SmartFillRun).where(SmartFillRun.run_id == run_id)
        )
    ).scalar_one_or_none()
    if run:
        run.status = "success"
        run.summary_json = {
            "mappingCount": len(mappings),
            "fieldCount": len(fields),
        }
    await db.commit()
    return {"ok": True, "mappings": mappings, "runId": run_id}


@router.post("/smart-fill/option-match")
async def smart_fill_option_match(data: SmartFillOptionMatchRequest):
    from app.services.option_matcher import option_match

    result = option_match(
        candidates=data.candidates,
        resume_value=data.resume_value,
        level1_title=data.level1_title,
        level2_title=data.level2_title,
    )

    if result["matchType"] == "NONE" and data.candidates and data.resume_value:
        try:
            ai_result = await _ai_option_match(
                candidates=data.candidates,
                resume_value=data.resume_value,
                level1_title=data.level1_title,
                level2_title=data.level2_title,
            )
            if ai_result:
                return ai_result
        except Exception:
            pass

    return {"ok": True, **result}


@router.post("/smart-fill/field-map")
async def smart_fill_field_map(data: SmartFillFieldMapRequest, db: AsyncSession = Depends(get_db)):
    from app.services.field_mapper import field_map

    if not data.fragments:
        return {"ok": True, "mappings": []}

    archive: dict[str, Any]
    if isinstance(data.profile, dict) and data.profile:
        archive = data.profile
    else:
        profile = await _get_or_create_default_profile(db)
        normalized_base_info = normalize_base_info_payload(profile.base_info_json)
        if profile.base_info_json != normalized_base_info:
            profile.base_info_json = normalized_base_info
            await db.commit()
        profile, roles, sections = await _load_profile_bundle(db, profile.id)
        profile_payload = _serialize_profile(profile, roles, sections)
        profile_view = _smartfill_profile_view(profile_payload)
        ra = profile_view.get("resumeArchive") or {}
        aa = profile_view.get("applicationArchive") or {}
        basic = profile_view.get("basic") or {}
        if not ra.get("basicInfo"):
            ra["basicInfo"] = {
                "name": basic.get("fullName", ""),
                "phone": basic.get("phone", ""),
                "email": basic.get("email", ""),
                "currentCity": basic.get("city", ""),
                "jobIntention": basic.get("targetRole", ""),
                "website": basic.get("website", ""),
                "github": basic.get("github", ""),
            }
        if not ra.get("personalSummary") and basic.get("summary"):
            ra["personalSummary"] = basic["summary"]
        archive = {"resumeArchive": ra, "applicationArchive": aa}

    fragments = [f.model_dump() for f in data.fragments]
    mappings = field_map(fragments, archive)

    return {"ok": True, "mappings": mappings}


@router.post("/smart-fill/module-count")
async def smart_fill_module_count(data: SmartFillModuleCountRequest, db: AsyncSession = Depends(get_db)):
    archive: dict[str, Any]
    if isinstance(data.profile, dict) and data.profile:
        archive = data.profile
    else:
        profile = await _get_or_create_default_profile(db)
        normalized_base_info = normalize_base_info_payload(profile.base_info_json)
        if profile.base_info_json != normalized_base_info:
            profile.base_info_json = normalized_base_info
            await db.commit()
        profile, roles, sections = await _load_profile_bundle(db, profile.id)
        profile_payload = _serialize_profile(profile, roles, sections)
        profile_view = _smartfill_profile_view(profile_payload)
        ra = profile_view.get("resumeArchive") or {}
        aa = profile_view.get("applicationArchive") or {}
        archive = {"resumeArchive": ra, "applicationArchive": aa}

    ra = archive.get("resumeArchive", {})
    aa = archive.get("applicationArchive", {})

    repeatable_modules = [
        ("education", "教育经历", "educationList"),
        ("workExperiences", "工作经历", "workList"),
        ("internshipExperiences", "实习经历", "internshipList"),
        ("projects", "项目经历", "projectList"),
        ("skills", "技能", "skillList"),
        ("certificates", "证书", "certificateList"),
        ("awards", "获奖经历", "awardList"),
        ("personalExperiences", "个人经历", "personalExperienceList"),
    ]

    modules = []
    modules.append({"module_name": "基本信息", "field_name": "basicInfo", "count": 1})
    modules.append({"module_name": "身份联系", "field_name": "identityContact", "count": 1})
    modules.append({"module_name": "求职偏好", "field_name": "jobPreference", "count": 1})
    modules.append({"module_name": "校招专项", "field_name": "campusFields", "count": 1})
    modules.append({"module_name": "关系合规", "field_name": "relationshipCompliance", "count": 1})
    modules.append({"module_name": "来源推荐", "field_name": "sourceReferral", "count": 1})

    for key, display_name, field_name in repeatable_modules:
        arr = ra.get(key, [])
        count = len(arr) if isinstance(arr, list) else 0
        modules.append({"module_name": display_name, "field_name": field_name, "count": count})

    family_members = aa.get("relationshipCompliance", {}).get("familyMembers", [])
    if isinstance(family_members, list):
        modules.append({"module_name": "家庭关系", "field_name": "familyMembers", "count": len(family_members)})

    return {"ok": True, "modules": modules}


async def _ai_option_match(
    candidates: list[str],
    resume_value: str,
    level1_title: str,
    level2_title: str,
) -> Optional[dict]:
    prompt = (
        "你是招聘表单选项匹配助手。根据简历值和候选选项，选出最佳匹配。"
        "严格输出 JSON: {\"value\": \"最佳选项文本\", \"confidence\": 0.9}。"
        "如果无法匹配，输出 {\"value\": \"\", \"confidence\": 0.0}。"
        "只从候选选项中选择，不要编造选项。"
    )
    user_content = json.dumps(
        {
            "candidates": candidates,
            "resume_value": resume_value,
            "level1_title": level1_title,
            "level2_title": level2_title,
        },
        ensure_ascii=False,
    )

    llm_result = await chat_completion(
        messages=[
            {"role": "system", "content": prompt},
            {"role": "user", "content": user_content},
        ],
        temperature=0.1,
        json_mode=True,
        max_tokens=200,
        tier="fast",
    )

    parsed = extract_json(llm_result or "")
    if not isinstance(parsed, dict):
        return None

    value = str(parsed.get("value") or "").strip()
    if not value:
        return None

    for c in candidates:
        if c.strip() == value:
            confidence = float(parsed.get("confidence") or 0.9)
            return {"ok": True, "value": c, "matchType": "AI", "confidence": min(1.0, max(0.0, confidence))}

    best_fuzzy: Optional[dict] = None
    best_fuzzy_len = 0
    for c in candidates:
        c_stripped = c.strip()
        if value in c_stripped or c_stripped in value:
            overlap = min(len(value), len(c_stripped))
            if overlap > best_fuzzy_len and overlap >= max(len(value), len(c_stripped)) * 0.4:
                best_fuzzy_len = overlap
                confidence = float(parsed.get("confidence") or 0.9)
                best_fuzzy = {"ok": True, "value": c, "matchType": "AI", "confidence": min(1.0, max(0.0, confidence))}
    if best_fuzzy:
        return best_fuzzy

    return None
