from __future__ import annotations

import re
from typing import Any, Optional

from sqlalchemy import select

from app.database import async_session
from app.models.models import CareerSource, LearningObservation, ProfileSection
from app.services.career_memory import create_memory_proposal


TARGET_TIERS = frozenset({"verified_fact", "preference", "career_hypothesis"})
_TYPE_NAME = re.compile(r"^[a-z][a-z0-9_]{1,59}$")


def _clean_text(value: Any, field: str, *, limit: int, required: bool = False) -> str:
    text = str(value or "").strip()
    if required and not text:
        raise ValueError(f"{field} 不能为空")
    if len(text) > limit:
        raise ValueError(f"{field} 最长 {limit} 个字符")
    return text


def _candidate(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("memory candidate 必须是对象")
    target_tier = _clean_text(
        value.get("target_tier"),
        "target_tier",
        limit=32,
        required=True,
    ).lower()
    if target_tier not in TARGET_TIERS:
        raise ValueError("memory candidate target_tier 无效")
    section_type = _clean_text(
        value.get("section_type"),
        "section_type",
        limit=60,
        required=True,
    ).lower()
    if not _TYPE_NAME.fullmatch(section_type):
        raise ValueError("memory candidate section_type 格式无效")
    title = _clean_text(value.get("title"), "title", limit=220, required=True)
    after = value.get("after")
    if not isinstance(after, dict) or not after:
        raise ValueError("memory candidate after 必须是非空对象")
    reason = _clean_text(value.get("reason"), "reason", limit=4000, required=True)
    impact = value.get("impact") or []
    if not isinstance(impact, list):
        raise ValueError("memory candidate impact 必须是数组")
    clean_impact = [
        _clean_text(item, "impact item", limit=500, required=True)
        for item in impact[:20]
    ]
    return {
        "target_tier": target_tier,
        "section_type": section_type,
        "title": title,
        "after": after,
        "reason": reason,
        "impact": clean_impact,
    }


async def _current_value(candidate: dict[str, Any]) -> dict[str, Any]:
    async with async_session() as db:
        current = (
            await db.execute(
                select(ProfileSection)
                .where(ProfileSection.tier == candidate["target_tier"])
                .where(ProfileSection.section_type == candidate["section_type"])
                .where(ProfileSection.title == candidate["title"])
                .order_by(ProfileSection.updated_at.desc(), ProfileSection.id.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
    return dict(current.content_json or {}) if current is not None else {}


async def consolidate_memory_observations(
    *,
    observation_ids: Optional[list[int]] = None,
    limit: int = 100,
) -> dict[str, Any]:
    """把已结构化候选巩固为收件箱提案，不调用模型且不写 Profile。"""
    safe_limit = max(1, min(int(limit), 500))
    query = (
        select(LearningObservation, CareerSource)
        .join(CareerSource, CareerSource.id == LearningObservation.source_id)
        .where(LearningObservation.status == "active")
        .where(CareerSource.status == "active")
        .order_by(LearningObservation.observed_at.asc(), LearningObservation.id.asc())
        .limit(safe_limit)
    )
    if observation_ids is not None:
        clean_id_set: set[int] = set()
        for item in observation_ids:
            if isinstance(item, bool):
                continue
            try:
                clean_id = int(item)
            except (TypeError, ValueError):
                raise ValueError("observation_ids 必须只包含正整数")
            if clean_id <= 0:
                raise ValueError("observation_ids 必须只包含正整数")
            clean_id_set.add(clean_id)
        clean_ids = sorted(clean_id_set)
        if not clean_ids:
            return {
                "processed_observations": 0,
                "created": 0,
                "duplicates": 0,
                "skipped": [],
                "errors": [],
                "proposals": [],
            }
        query = query.where(LearningObservation.id.in_(clean_ids))

    async with async_session() as db:
        rows = (await db.execute(query)).all()

    proposals: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    created = 0
    duplicates = 0
    for observation, _source in rows:
        content = observation.content_json if isinstance(observation.content_json, dict) else {}
        candidates = content.get("memory_candidates")
        if not isinstance(candidates, list) or not candidates:
            skipped.append(
                {
                    "observation_id": observation.id,
                    "reason": "没有经过上游事实门生成的结构化 memory_candidates",
                }
            )
            continue
        for index, raw in enumerate(candidates[:20]):
            try:
                candidate = _candidate(raw)
                proposal = await create_memory_proposal(
                    observation_id=observation.id,
                    target_tier=candidate["target_tier"],
                    section_type=candidate["section_type"],
                    title=candidate["title"],
                    before=await _current_value(candidate),
                    after=candidate["after"],
                    reason=candidate["reason"],
                    impact=candidate["impact"],
                )
                proposals.append(proposal)
                if proposal.get("duplicate"):
                    duplicates += 1
                else:
                    created += 1
            except Exception as exc:
                errors.append(
                    {
                        "observation_id": observation.id,
                        "candidate_index": index,
                        "error": str(exc)[:1000],
                    }
                )
    return {
        "processed_observations": len(rows),
        "created": created,
        "duplicates": duplicates,
        "skipped": skipped,
        "errors": errors,
        "proposals": proposals,
    }
