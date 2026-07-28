from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

from sqlalchemy import func, select

from app.database import async_session
from app.models.models import InterviewScoringSkill


SCORING_SKILL_SCHEMA = "offeru.interview_scoring_skill.v1"
_DEFAULT_PATH = (
    Path(__file__).resolve().parents[1]
    / "agents"
    / "skills"
    / "interview-scoring"
    / "references"
    / "default-rubric.json"
)
_SKILL_ID_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_DIMENSION_KEY_PATTERN = re.compile(r"^[a-z][a-z0-9_]{1,39}$")
_DELIVERY_TERMS = {
    "body_language",
    "cultural_fit",
    "delivery",
    "emotion",
    "eye_contact",
    "face",
    "gesture",
    "hiring_probability",
    "honesty",
    "personality",
    "posture",
    "voice",
    "眼神",
    "姿态",
    "肢体",
    "表情",
    "手势",
    "语音",
    "声线",
    "情绪",
    "性格",
    "诚信",
    "文化匹配",
    "录用",
}
_MANDATORY_PROHIBITED_OUTPUTS = {
    "personality",
    "emotion",
    "honesty",
    "health",
    "protected_trait",
    "job_fitness",
    "hiring_probability",
    "cultural_fit",
    "delivery_score",
    "combined_score",
}

BEHAVIOR_EVENT_TYPES = {
    "person_missing": "未检测到人物",
    "head_drop": "头部下垂",
    "forward_lean": "身体前倾",
    "shoulder_tilt": "肩线倾斜",
    "head_tilt": "头部侧倾",
    "lateral_lean": "身体侧向偏移",
    "gesture_victory": "比耶手势",
    "gesture_thumb_up": "点赞手势",
    "gesture_thumb_down": "拇指向下手势",
    "gesture_open_palm": "张开手掌",
    "gesture_pointing_up": "食指向上",
    "gesture_love": "I Love You 手势",
    "gesture_closed_fist": "握拳",
    "mouth_smile": "嘴角上扬",
    "mouth_smile_jaw_open": "嘴角上扬并张嘴",
    "jaw_open_brow_raise": "张嘴并抬眉",
    "mouth_pucker": "噘嘴动作",
    "brow_down_mouth_frown": "眉部下压或嘴角下沉",
}


def _clean_text(
    value: Any,
    field: str,
    limit: int,
    *,
    required: bool = False,
) -> str:
    if value is None:
        text = ""
    elif isinstance(value, str):
        text = " ".join(value.split())
    else:
        raise ValueError(f"{field} 必须是字符串")
    if required and not text:
        raise ValueError(f"{field} 不能为空")
    if len(text) > limit:
        raise ValueError(f"{field} 超过最大长度 {limit}")
    return text


def _definition_hash(definition: dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(
            definition,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()


def validate_scoring_skill_definition(value: Any) -> dict[str, Any]:
    _REQUIRED_TOP_KEYS = {
        "schema",
        "skill_id",
        "version",
        "name",
        "scope",
        "aggregation",
        "dimensions",
        "score_bands",
        "prompt_instructions",
        "prohibited_outputs",
    }
    # behavior_display 是唯一允许的可选键：只控制报告展示哪些行为统计面板，
    # 不参与任何评分聚合（ADR-0008/0010 边界不变）
    _OPTIONAL_TOP_KEYS = {"behavior_display"}
    if not isinstance(value, dict) or not (
        _REQUIRED_TOP_KEYS
        <= set(value)
        <= _REQUIRED_TOP_KEYS | _OPTIONAL_TOP_KEYS
    ):
        raise ValueError("评分 Skill 顶层字段与 schema 不一致")
    if value.get("schema") != SCORING_SKILL_SCHEMA:
        raise ValueError("评分 Skill schema 不受支持")
    skill_id = _clean_text(value.get("skill_id"), "skill_id", 64, required=True)
    if not _SKILL_ID_PATTERN.fullmatch(skill_id):
        raise ValueError("skill_id 只能使用小写字母、数字和连字符")
    try:
        version = int(value.get("version"))
    except (TypeError, ValueError) as exc:
        raise ValueError("version 必须是正整数") from exc
    if version <= 0:
        raise ValueError("version 必须是正整数")
    if value.get("scope") != "content_only":
        raise ValueError("评分 Skill 只能评价 content_only")
    if value.get("aggregation") != "weighted_mean":
        raise ValueError("首个版本只支持确定性的 weighted_mean")

    raw_dimensions = value.get("dimensions")
    if not isinstance(raw_dimensions, list) or not 2 <= len(raw_dimensions) <= 8:
        raise ValueError("dimensions 必须包含 2-8 个维度")
    dimensions: list[dict[str, Any]] = []
    keys: set[str] = set()
    weight_total = 0.0
    for item in raw_dimensions:
        if not isinstance(item, dict) or set(item) != {
            "key",
            "label",
            "weight",
            "description",
            "evidence_required",
            "allow_not_applicable",
        }:
            raise ValueError("dimension 字段与 schema 不一致")
        key = _clean_text(item.get("key"), "dimension.key", 40, required=True)
        if not _DIMENSION_KEY_PATTERN.fullmatch(key) or key in keys:
            raise ValueError(f"无效或重复的 dimension.key: {key}")
        label = _clean_text(
            item.get("label"),
            "dimension.label",
            80,
            required=True,
        )
        description = _clean_text(
            item.get("description"),
            "dimension.description",
            500,
            required=True,
        )
        semantic_text = f"{key} {label} {description}".lower().replace("-", "_")
        if any(
            term in semantic_text or term.replace("_", " ") in semantic_text
            for term in _DELIVERY_TERMS
        ):
            raise ValueError(f"内容评分维度不得包含表达行为或禁止推断: {key}")
        if item.get("evidence_required") is not True:
            raise ValueError("每个内容评分维度都必须要求回答证据")
        if not isinstance(item.get("allow_not_applicable"), bool):
            raise ValueError("allow_not_applicable 必须是布尔值")
        try:
            weight = float(item.get("weight"))
        except (TypeError, ValueError) as exc:
            raise ValueError("dimension.weight 必须是数字") from exc
        if not 0 < weight <= 1:
            raise ValueError("dimension.weight 必须在 (0, 1] 范围")
        weight_total += weight
        keys.add(key)
        dimensions.append(
            {
                "key": key,
                "label": label,
                "weight": weight,
                "description": description,
                "evidence_required": True,
                "allow_not_applicable": item["allow_not_applicable"],
            }
        )
    if abs(weight_total - 1.0) > 0.001:
        raise ValueError("dimension 权重之和必须为 1")

    raw_bands = value.get("score_bands")
    if not isinstance(raw_bands, list) or not 2 <= len(raw_bands) <= 8:
        raise ValueError("score_bands 必须包含 2-8 个区间")
    bands: list[dict[str, Any]] = []
    previous = 101
    for item in raw_bands:
        if not isinstance(item, dict) or set(item) != {"min", "label"}:
            raise ValueError("score_band 字段与 schema 不一致")
        minimum = int(item.get("min"))
        if not 0 <= minimum <= 100 or minimum >= previous:
            raise ValueError("score_bands 必须按 min 从高到低排列")
        previous = minimum
        bands.append(
            {
                "min": minimum,
                "label": _clean_text(
                    item.get("label"),
                    "score_band.label",
                    80,
                    required=True,
                ),
            }
        )
    if bands[-1]["min"] != 0:
        raise ValueError("score_bands 必须包含 min=0 的兜底区间")

    instructions = value.get("prompt_instructions")
    if not isinstance(instructions, list) or len(instructions) > 8:
        raise ValueError("prompt_instructions 必须是最多 8 条的数组")
    clean_instructions = [
        _clean_text(item, "prompt_instructions", 500, required=True)
        for item in instructions
    ]
    prohibited = value.get("prohibited_outputs")
    if not isinstance(prohibited, list) or len(prohibited) > 30:
        raise ValueError("prohibited_outputs 必须是最多 30 条的数组")
    clean_prohibited = {
        _clean_text(item, "prohibited_outputs", 80, required=True)
        for item in prohibited
    }
    if not _MANDATORY_PROHIBITED_OUTPUTS.issubset(clean_prohibited):
        raise ValueError("评分 Skill 不能移除系统强制禁止的输出")

    # 可选 behavior_display：面板名限 build_behavior_summary 的输出键（展示层，不进分数）
    behavior_display: dict[str, Any] | None = None
    if "behavior_display" in value:
        raw_display = value.get("behavior_display")
        if not isinstance(raw_display, dict) or set(raw_display) != {"panels"}:
            raise ValueError("behavior_display 只能包含 panels 字段")
        raw_panels = raw_display.get("panels")
        if not isinstance(raw_panels, list) or not 1 <= len(raw_panels) <= 8:
            raise ValueError("behavior_display.panels 必须是 1-8 条的数组")
        allowed_panels = {
            "event_counts",
            "duration_ms_by_type",
            "average_confidence_by_type",
            "per_question",
            "observed_window_ms",
            "detectors",
        }
        panels: list[str] = []
        for panel in raw_panels:
            clean_panel = _clean_text(panel, "behavior_display.panels", 60, required=True)
            if clean_panel not in allowed_panels:
                raise ValueError(f"behavior_display 不支持面板: {clean_panel}")
            if clean_panel not in panels:
                panels.append(clean_panel)
        behavior_display = {"panels": panels}

    result = {
        "schema": SCORING_SKILL_SCHEMA,
        "skill_id": skill_id,
        "version": version,
        "name": _clean_text(value.get("name"), "name", 200, required=True),
        "scope": "content_only",
        "aggregation": "weighted_mean",
        "dimensions": dimensions,
        "score_bands": bands,
        "prompt_instructions": clean_instructions,
        "prohibited_outputs": sorted(clean_prohibited),
    }
    if behavior_display is not None:
        result["behavior_display"] = behavior_display
    return result


def _default_definition() -> dict[str, Any]:
    return validate_scoring_skill_definition(
        json.loads(_DEFAULT_PATH.read_text(encoding="utf-8"))
    )


def _skill_summary(skill: InterviewScoringSkill) -> dict[str, Any]:
    return {
        "skill_id": skill.skill_id,
        "version": skill.version,
        "name": skill.name,
        "status": skill.status,
        "definition_hash": skill.definition_hash,
        "is_builtin": bool(skill.is_builtin),
        "created_at": str(skill.created_at),
    }


async def ensure_default_scoring_skill() -> InterviewScoringSkill:
    definition = _default_definition()
    async with async_session() as db:
        existing = (
            await db.execute(
                select(InterviewScoringSkill).where(
                    InterviewScoringSkill.skill_id == definition["skill_id"],
                    InterviewScoringSkill.version == definition["version"],
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            if existing.definition_hash != _definition_hash(definition):
                raise ValueError("内置评分 Skill 与数据库同版本定义不一致")
            return existing
        skill = InterviewScoringSkill(
            skill_id=definition["skill_id"],
            version=definition["version"],
            name=definition["name"],
            definition_json=definition,
            definition_hash=_definition_hash(definition),
            is_builtin=True,
        )
        db.add(skill)
        await db.commit()
        return skill


async def resolve_scoring_skill(
    skill_id: str = "evidence-interview-score",
    version: int | None = None,
) -> InterviewScoringSkill:
    await ensure_default_scoring_skill()
    clean_id = _clean_text(skill_id, "skill_id", 64, required=True)
    query = select(InterviewScoringSkill).where(
        InterviewScoringSkill.skill_id == clean_id,
        InterviewScoringSkill.status == "active",
    )
    if version is not None:
        query = query.where(InterviewScoringSkill.version == int(version))
    else:
        query = query.order_by(InterviewScoringSkill.version.desc())
    async with async_session() as db:
        skill = (await db.execute(query)).scalars().first()
    if skill is None:
        raise ValueError(f"评分 Skill {clean_id}@{version or 'latest'} 不存在")
    validate_scoring_skill_definition(skill.definition_json)
    return skill


async def list_interview_scoring_skills(
    status: str = "active",
    limit: int = 50,
) -> dict[str, Any]:
    await ensure_default_scoring_skill()
    clean_status = _clean_text(status, "status", 24, required=True)
    if clean_status not in {"active", "archived", "all"}:
        raise ValueError("status 必须是 active、archived 或 all")
    query = select(InterviewScoringSkill)
    if clean_status != "all":
        query = query.where(InterviewScoringSkill.status == clean_status)
    async with async_session() as db:
        items = (
            await db.execute(
                query.order_by(
                    InterviewScoringSkill.skill_id.asc(),
                    InterviewScoringSkill.version.desc(),
                ).limit(max(1, min(int(limit), 200)))
            )
        ).scalars().all()
    return {"total": len(items), "items": [_skill_summary(item) for item in items]}


async def get_interview_scoring_skill(
    skill_id: str,
    version: int | None = None,
) -> dict[str, Any]:
    skill = await resolve_scoring_skill(skill_id, version)
    return {**_skill_summary(skill), "definition": skill.definition_json}


async def create_interview_scoring_skill(
    skill_id: str,
    name: str,
    definition: dict[str, Any],
) -> dict[str, Any]:
    clean_id = _clean_text(skill_id, "skill_id", 64, required=True)
    if not _SKILL_ID_PATTERN.fullmatch(clean_id):
        raise ValueError("skill_id 只能使用小写字母、数字和连字符")
    _required_definition_keys = {
        "dimensions",
        "score_bands",
        "prompt_instructions",
        "prohibited_outputs",
    }
    if not isinstance(definition, dict) or not (
        _required_definition_keys
        <= set(definition)
        <= _required_definition_keys | {"behavior_display"}
    ):
        raise ValueError("自定义 definition 字段与 schema 不一致")
    async with async_session() as db:
        latest = (
            await db.execute(
                select(func.max(InterviewScoringSkill.version)).where(
                    InterviewScoringSkill.skill_id == clean_id
                )
            )
        ).scalar_one_or_none()
        version = int(latest or 0) + 1
        payload = validate_scoring_skill_definition(
            {
                "schema": SCORING_SKILL_SCHEMA,
                "skill_id": clean_id,
                "version": version,
                "name": _clean_text(name, "name", 200, required=True),
                "scope": "content_only",
                "aggregation": "weighted_mean",
                **definition,
            }
        )
        skill = InterviewScoringSkill(
            skill_id=clean_id,
            version=version,
            name=payload["name"],
            definition_json=payload,
            definition_hash=_definition_hash(payload),
            is_builtin=False,
        )
        db.add(skill)
        await db.commit()
    return {**_skill_summary(skill), "definition": payload}


def validate_content_evaluation(
    payload: Any,
    *,
    answer: str,
    definition: dict[str, Any],
) -> dict[str, Any]:
    if not isinstance(payload, dict) or set(payload) != {
        "dimensions",
        "strengths",
        "improvements",
        "suggestion",
    }:
        raise ValueError("模型评价字段与评分 Skill 输出契约不一致")
    raw_dimensions = payload.get("dimensions")
    expected_keys = [item["key"] for item in definition["dimensions"]]
    if not isinstance(raw_dimensions, dict) or set(raw_dimensions) != set(expected_keys):
        raise ValueError("模型评价维度与评分 Skill 不一致")
    normalized_answer = " ".join(answer.split())
    dimensions: dict[str, dict[str, Any]] = {}
    applicable_weight = 0.0
    weighted_score = 0.0
    dimension_defs = {item["key"]: item for item in definition["dimensions"]}
    for key in expected_keys:
        item = raw_dimensions[key]
        if not isinstance(item, dict) or set(item) != {
            "score",
            "evidence",
            "missing_evidence",
            "not_applicable",
            "strength",
            "improvement",
        }:
            raise ValueError(f"维度 {key} 字段与输出契约不一致")
        try:
            score = float(item.get("score"))
        except (TypeError, ValueError) as exc:
            raise ValueError(f"维度 {key}.score 必须是数字") from exc
        if not 0 <= score <= 100:
            raise ValueError(f"维度 {key}.score 超出 0-100")
        missing = item.get("missing_evidence")
        not_applicable = item.get("not_applicable")
        if not isinstance(missing, bool) or not isinstance(not_applicable, bool):
            raise ValueError("missing_evidence 与 not_applicable 必须是布尔值")
        definition_item = dimension_defs[key]
        if not_applicable and not definition_item["allow_not_applicable"]:
            raise ValueError(f"维度 {key} 不允许标记为不适用")
        evidence = item.get("evidence")
        if not isinstance(evidence, list) or len(evidence) > 5:
            raise ValueError(f"维度 {key}.evidence 必须是最多 5 条的数组")
        clean_evidence: list[str] = []
        for quote in evidence:
            clean_quote = _clean_text(
                quote, f"{key}.evidence", 240, required=True
            )
            if clean_quote not in normalized_answer:
                raise ValueError(f"维度 {key} 引用了回答中不存在的摘录")
            if clean_quote not in clean_evidence:
                clean_evidence.append(clean_quote)
        if not_applicable:
            if score != 0 or clean_evidence or missing:
                raise ValueError(
                    f"维度 {key} 标记为不适用时 score 必须为 0，且不得附证据或缺证据标记"
                )
        else:
            if missing and clean_evidence:
                raise ValueError(f"维度 {key} 同时标记缺证据并提供摘录")
            if not missing and not clean_evidence:
                raise ValueError(f"维度 {key} 缺少回答摘录")
            if missing and score > 49:
                raise ValueError(f"维度 {key} 缺证据时分数不能高于 49")
            applicable_weight += definition_item["weight"]
            weighted_score += definition_item["weight"] * score
        dimensions[key] = {
            "score": round(score, 1),
            "evidence": clean_evidence,
            "missing_evidence": missing,
            "not_applicable": not_applicable,
            "strength": _clean_text(item.get("strength"), f"{key}.strength", 500),
            "improvement": _clean_text(
                item.get("improvement"),
                f"{key}.improvement",
                500,
            ),
        }
    if applicable_weight <= 0:
        raise ValueError("所有评分维度都被标记为不适用")
    content_score = round(weighted_score / applicable_weight, 1)
    band = next(
        item["label"]
        for item in definition["score_bands"]
        if content_score >= item["min"]
    )

    def clean_list(field: str) -> list[str]:
        values = payload.get(field)
        if not isinstance(values, list) or len(values) > 8:
            raise ValueError(f"{field} 必须是最多 8 条的数组")
        return [
            _clean_text(item, field, 500, required=True)
            for item in values
        ]

    return {
        "content_score": content_score,
        "score_band": band,
        "dimensions": dimensions,
        "strengths": clean_list("strengths"),
        "improvements": clean_list("improvements"),
        "suggestion": _clean_text(
            payload.get("suggestion"),
            "suggestion",
            1200,
        ),
        "aggregation": "weighted_mean",
        "skill_id": definition["skill_id"],
        "skill_version": definition["version"],
    }


def validate_behavior_events(events: Any) -> list[dict[str, Any]]:
    if not isinstance(events, list) or not 1 <= len(events) <= 200:
        raise ValueError("events 必须包含 1-200 条派生事件")
    validated: list[dict[str, Any]] = []
    seen: set[str] = set()
    expected = {
        "event_id",
        "event_type",
        "started_ms",
        "ended_ms",
        "occurrence_count",
        "confidence",
        "detector_id",
        "detector_version",
        "metadata",
    }
    for item in events:
        if not isinstance(item, dict) or set(item) != expected:
            raise ValueError("表达行为事件字段与 schema 不一致")
        event_id = _clean_text(item.get("event_id"), "event_id", 64, required=True)
        if event_id in seen:
            raise ValueError(f"批次中 event_id 重复: {event_id}")
        seen.add(event_id)
        event_type = _clean_text(
            item.get("event_type"), "event_type", 60, required=True
        )
        if event_type not in BEHAVIOR_EVENT_TYPES:
            raise ValueError(f"不支持的表达行为事件: {event_type}")
        try:
            started_ms = int(item.get("started_ms"))
            ended_ms = int(item.get("ended_ms"))
            occurrence_count = int(item.get("occurrence_count"))
            confidence = float(item.get("confidence"))
        except (TypeError, ValueError) as exc:
            raise ValueError("事件时间、次数或置信度类型无效") from exc
        if started_ms < 0 or ended_ms < started_ms or ended_ms > 86_400_000:
            raise ValueError("事件时间范围无效")
        if not 1 <= occurrence_count <= 100 or not 0 <= confidence <= 1:
            raise ValueError("事件次数或置信度超出范围")
        metadata = item.get("metadata")
        if not isinstance(metadata, dict) or set(metadata) - {"question_index"}:
            raise ValueError("事件 metadata 只能包含 question_index")
        question_index = metadata.get("question_index")
        if question_index is not None and (
            not isinstance(question_index, int) or question_index < 0
        ):
            raise ValueError("metadata.question_index 必须是非负整数")
        validated.append(
            {
                "event_id": event_id,
                "event_type": event_type,
                "started_ms": started_ms,
                "ended_ms": ended_ms,
                "occurrence_count": occurrence_count,
                "duration_ms": ended_ms - started_ms,
                "confidence": round(confidence, 4),
                "detector_id": _clean_text(
                    item.get("detector_id"),
                    "detector_id",
                    80,
                    required=True,
                ),
                "detector_version": _clean_text(
                    item.get("detector_version"),
                    "detector_version",
                    80,
                    required=True,
                ),
                "metadata": {"question_index": question_index}
                if question_index is not None
                else {},
            }
        )
    return validated


def build_behavior_summary(events: list[Any]) -> dict[str, Any]:
    counts: dict[str, int] = {}
    durations: dict[str, int] = {}
    confidence_totals: dict[str, float] = {}
    confidence_weights: dict[str, int] = {}
    detectors: set[str] = set()
    starts: list[int] = []
    ends: list[int] = []
    per_question: dict[str, dict[str, Any]] = {}

    def _get(item: Any, key: str) -> Any:
        return getattr(item, key) if hasattr(item, key) else item[key]

    for item in events:
        event_type = str(_get(item, "event_type"))
        count = int(_get(item, "occurrence_count"))
        duration = int(_get(item, "duration_ms"))
        confidence = float(_get(item, "confidence"))
        started = int(_get(item, "started_ms"))
        ended = int(_get(item, "ended_ms"))
        detector_id = str(_get(item, "detector_id"))
        detector_version = str(_get(item, "detector_version"))
        counts[event_type] = counts.get(event_type, 0) + count
        durations[event_type] = durations.get(event_type, 0) + duration
        confidence_totals[event_type] = (
            confidence_totals.get(event_type, 0.0) + confidence * count
        )
        confidence_weights[event_type] = (
            confidence_weights.get(event_type, 0) + count
        )
        detectors.add(f"{detector_id}@{detector_version}")
        starts.append(started)
        ends.append(ended)
        # 按题分解：metadata.question_index 存在时聚合到对应题号（旧数据无此字段）。
        # ORM 对象的列名是 metadata_json（.metadata 是 SQLAlchemy 注册表，不能用）
        if hasattr(item, "metadata_json"):
            metadata = item.metadata_json
        elif isinstance(item, dict):
            metadata = item.get("metadata") or item.get("metadata_json")
        else:
            metadata = None
        question_index = (
            metadata.get("question_index") if isinstance(metadata, dict) else None
        )
        if isinstance(question_index, int) and question_index >= 0:
            bucket = per_question.setdefault(
                str(question_index),
                {"event_counts": {}, "duration_ms_by_type": {}},
            )
            bucket["event_counts"][event_type] = (
                bucket["event_counts"].get(event_type, 0) + count
            )
            bucket["duration_ms_by_type"][event_type] = (
                bucket["duration_ms_by_type"].get(event_type, 0) + duration
            )
    return {
        "event_counts": counts,
        "duration_ms_by_type": durations,
        "average_confidence_by_type": {
            event_type: round(
                confidence_totals[event_type] / confidence_weights[event_type],
                4,
            )
            for event_type in counts
        },
        "event_labels": {
            event_type: BEHAVIOR_EVENT_TYPES[event_type]
            for event_type in counts
        },
        "detectors": sorted(detectors),
        "observed_window_ms": (
            max(ends) - min(starts) if starts and ends else 0
        ),
        "per_question": per_question,
        "privacy": {
            "raw_video_stored": False,
            "frames_stored": False,
            "landmarks_stored": False,
            "face_embeddings_stored": False,
        },
        "interpretation_boundary": (
            "仅为可观察表达行为统计，不代表人格、情绪、诚信、岗位胜任力或录用概率"
        ),
    }


_DRAFT_SKILL_SYSTEM_PROMPT = """你是面试评分 Skill 设计师。为用户起草一份"内容评分" rubric 定义。

硬性边界（违反即被系统拒绝）：
1. scope 只能是 content_only：维度只能评价回答内容（结构、证据、深度、相关性等）。
2. 绝不出现表达行为或禁止推断维度：肢体/表情/手势/眼神/语音/情绪/性格/诚信/文化匹配/录用概率。
3. dimensions 2-8 个；每个含 key(小写下划线)、label、weight(和为1)、description、
   evidence_required=true、allow_not_applicable(bool)。
4. score_bands 2-8 个，按 min 从高到低，必须有 min=0 兜底。
5. prompt_instructions 最多 8 条，指导评价模型如何用证据打分。
6. prohibited_outputs 必须包含: personality, emotion, honesty, health, protected_trait,
   job_fitness, hiring_probability, cultural_fit, delivery_score, combined_score。

输出 JSON 对象，只含四个键：
{"dimensions": [...], "score_bands": [...], "prompt_instructions": [...], "prohibited_outputs": [...]}"""


async def draft_scoring_skill(
    *,
    goal: str,
    target_role: str = "",
    job_id: int | None = None,
) -> dict[str, Any]:
    """LLM 起草评分 Skill 草稿；只返回草稿不落库（用户确认后走 create，HITL）。

    job_id 提供时注入该岗位 role dossier 的面试类 findings 作为维度设计依据。"""
    from app.agents.llm import chat_completion, extract_json

    clean_goal = _clean_text(goal, "goal", 2000, required=True)
    clean_role = _clean_text(target_role, "target_role", 300)

    # 从 B 块的 role dossier 取面试信号作为设计依据
    research_context = ""
    if job_id is not None:
        try:
            from app.models.models import ResearchDossier, ResearchFinding

            async with async_session() as db:
                dossier = (
                    await db.execute(
                        select(ResearchDossier).where(
                            ResearchDossier.dossier_key == f"role:{int(job_id)}"
                        )
                    )
                ).scalar_one_or_none()
                if dossier is not None:
                    findings = (
                        await db.execute(
                            select(ResearchFinding)
                            .where(ResearchFinding.dossier_id == dossier.id)
                            .where(
                                ResearchFinding.finding_type.in_(
                                    (
                                        "interview_process",
                                        "interview_question",
                                        "role_requirement",
                                    )
                                )
                            )
                            .limit(30)
                        )
                    ).scalars().all()
                    if findings:
                        research_context = json.dumps(
                            [
                                {
                                    "type": item.finding_type,
                                    "statement": item.statement,
                                    "evidence_level": item.evidence_level,
                                }
                                for item in findings
                            ],
                            ensure_ascii=False,
                        )[:6000]
        except Exception:
            research_context = ""

    user_prompt = f"目标：{clean_goal}"
    if clean_role:
        user_prompt += f"\n目标岗位：{clean_role}"
    if research_context:
        user_prompt += f"\n\n该岗位调研得到的面试信号（设计维度时参考）：\n{research_context}"

    last_error = ""
    for attempt in range(2):
        prompt = user_prompt
        if last_error:
            prompt += f"\n\n上一次输出未通过校验，错误：{last_error}\n请修正后重新输出。"
        raw = await chat_completion(
            messages=[
                {"role": "system", "content": _DRAFT_SKILL_SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            tier="standard",
            json_mode=True,
            temperature=0.2,
            max_tokens=2500,
        )
        payload = extract_json(raw) if isinstance(raw, str) else None
        if not isinstance(payload, dict):
            last_error = "输出不是 JSON 对象"
            continue
        try:
            validated = validate_scoring_skill_definition(
                {
                    "schema": SCORING_SKILL_SCHEMA,
                    "skill_id": "draft-preview",
                    "version": 1,
                    "name": clean_goal[:200],
                    "scope": "content_only",
                    "aggregation": "weighted_mean",
                    "dimensions": payload.get("dimensions"),
                    "score_bands": payload.get("score_bands"),
                    "prompt_instructions": payload.get("prompt_instructions"),
                    "prohibited_outputs": payload.get("prohibited_outputs"),
                }
            )
        except ValueError as exc:
            last_error = str(exc)[:500]
            continue
        return {
            "draft": {
                "dimensions": validated["dimensions"],
                "score_bands": validated["score_bands"],
                "prompt_instructions": validated["prompt_instructions"],
                "prohibited_outputs": validated["prohibited_outputs"],
            },
            "research_informed": bool(research_context),
            "validation": "passed",
            "next_step": (
                "确认后调用 create_interview_scoring_skill(skill_id, name, definition=draft)"
                " 正式创建；草稿未落库"
            ),
        }
    raise ValueError(f"LLM 两次尝试均未通过评分 Skill 事实门：{last_error}")
