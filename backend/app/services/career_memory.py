from __future__ import annotations

import hashlib
import json
import re
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Optional

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError

from app.database import async_session
from app.models.models import (
    CareerSource,
    EvidenceLink,
    LearningObservation,
    MemoryProposal,
    ProfileSection,
)


TARGET_TIERS = frozenset({"verified_fact", "preference", "career_hypothesis"})
PROPOSAL_STATUSES = frozenset(
    {"pending", "deferred", "applying", "accepted", "rejected", "revoked", "invalidated"}
)
REVIEW_ACTIONS = frozenset({"accept", "reject", "defer", "revoke"})
_TYPE_NAME = re.compile(r"^[a-z][a-z0-9_]{1,79}$")
_SECRET_KEYS = ("password", "secret", "access_token", "refresh_token", "api_key", "credential")


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _canonical_json(payload: Any) -> str:
    try:
        return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError) as exc:
        raise ValueError("字段必须是可 JSON 序列化的数据") from exc


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _clean_type(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field} 必须是字符串")
    clean = value.strip().lower()
    if not _TYPE_NAME.fullmatch(clean):
        raise ValueError(f"{field} 必须是小写字母、数字或下划线组成的稳定类型名")
    return clean


def _clean_text(value: Any, field: str, *, limit: int, required: bool = False) -> str:
    if value is None:
        clean = ""
    elif not isinstance(value, str):
        raise ValueError(f"{field} 必须是字符串")
    else:
        clean = value.strip()
    if required and not clean:
        raise ValueError(f"{field} 不能为空")
    if len(clean) > limit:
        raise ValueError(f"{field} 超过最大长度 {limit}")
    return clean


def _clean_positive_int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{field} 必须是正整数")
    return value


def _validate_json_object(value: Any, field: str, *, required: bool = False) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{field} 必须是对象")
    if required and not value:
        raise ValueError(f"{field} 不能为空")
    if len(_canonical_json(value)) > 50_000:
        raise ValueError(f"{field} 超过最大大小")
    return value


def _assert_no_secret_fields(value: Any, path: str = "metadata") -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            normalized = str(key).strip().lower()
            if any(marker in normalized for marker in _SECRET_KEYS):
                raise ValueError(f"{path}.{key} 不得保存连接密钥")
            _assert_no_secret_fields(item, f"{path}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _assert_no_secret_fields(item, f"{path}[{index}]")


def _parse_datetime(value: Optional[str]) -> datetime:
    if not value:
        return _now()
    if not isinstance(value, str):
        raise ValueError("observed_at 必须是 ISO-8601 字符串")
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("observed_at 必须是 ISO-8601 时间") from exc
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def _serialize_source(source: CareerSource) -> dict[str, Any]:
    return {
        "id": source.id,
        "source_type": source.source_type,
        "external_id": source.external_id,
        "title": source.title or "",
        "locator": source.locator or "",
        "metadata": source.metadata_json or {},
        "status": source.status,
        "created_at": str(source.created_at),
        "updated_at": str(source.updated_at),
        "invalidated_at": str(source.invalidated_at) if source.invalidated_at else None,
    }


def _serialize_observation(
    observation: LearningObservation,
    source: CareerSource,
) -> dict[str, Any]:
    return {
        "id": observation.id,
        "observation_type": observation.observation_type,
        "content": observation.content_json or {},
        "content_hash": observation.content_hash,
        "idempotency_key": observation.idempotency_key,
        "status": observation.status,
        "observed_at": str(observation.observed_at),
        "created_at": str(observation.created_at),
        "source": _serialize_source(source),
    }


def _serialize_proposal(
    proposal: MemoryProposal,
    evidence: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "id": proposal.id,
        "proposal_key": proposal.proposal_key,
        "target_tier": proposal.target_tier,
        "section_type": proposal.section_type,
        "title": proposal.title,
        "before": proposal.before_json or {},
        "after": proposal.after_json or {},
        "reason": proposal.reason or "",
        "impact": proposal.impact_json or [],
        "status": proposal.status,
        "applied_profile_section_id": proposal.applied_profile_section_id,
        "review_note": proposal.review_note or "",
        "evidence": evidence,
        "created_at": str(proposal.created_at),
        "updated_at": str(proposal.updated_at),
        "reviewed_at": str(proposal.reviewed_at) if proposal.reviewed_at else None,
        "invalidated_at": str(proposal.invalidated_at) if proposal.invalidated_at else None,
    }


@asynccontextmanager
async def _observation_session(db: Any = None) -> AsyncIterator[Any]:
    if db is not None:
        yield db
        return
    async with async_session() as owned:
        yield owned


async def record_learning_observation(
    *,
    source_type: str,
    source_external_id: str,
    observation_type: str,
    content: dict[str, Any],
    source_title: str = "",
    source_locator: str = "",
    source_metadata: Optional[dict[str, Any]] = None,
    observed_at: Optional[str] = None,
    idempotency_key: Optional[str] = None,
    _db: Any = None,
    _commit: bool = True,
) -> dict[str, Any]:
    clean_source_type = _clean_type(source_type, "source_type")
    clean_observation_type = _clean_type(observation_type, "observation_type")
    clean_external_id = _clean_text(
        source_external_id,
        "source_external_id",
        limit=255,
        required=True,
    )
    clean_title = _clean_text(source_title, "source_title", limit=300)
    clean_locator = _clean_text(source_locator, "source_locator", limit=2000)
    clean_content = _validate_json_object(content, "content", required=True)
    _assert_no_secret_fields(clean_content, "content")
    clean_metadata = _validate_json_object(
        source_metadata if source_metadata is not None else {},
        "source_metadata",
    )
    _assert_no_secret_fields(clean_metadata)
    canonical = _canonical_json(clean_content)
    content_hash = _sha256(canonical)
    supplied_idempotency = (
        _clean_text(idempotency_key, "idempotency_key", limit=1000, required=True)
        if idempotency_key is not None
        else None
    )
    stable_key = _sha256(
        supplied_idempotency
        or f"{clean_source_type}:{clean_external_id}:{clean_observation_type}:{canonical}"
    )

    async with _observation_session(_db) as db:
        existing = (
            await db.execute(
                select(LearningObservation).where(
                    LearningObservation.idempotency_key == stable_key
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            existing_source = (
                await db.execute(
                    select(CareerSource).where(CareerSource.id == existing.source_id)
                )
            ).scalar_one()
            return {
                **_serialize_observation(existing, existing_source),
                "duplicate": True,
            }

        source = (
            await db.execute(
                select(CareerSource)
                .where(CareerSource.source_type == clean_source_type)
                .where(CareerSource.external_id == clean_external_id)
            )
        ).scalar_one_or_none()
        if source is None:
            source = CareerSource(
                source_type=clean_source_type,
                external_id=clean_external_id,
                title=clean_title,
                locator=clean_locator,
                metadata_json=clean_metadata,
                status="active",
            )
            db.add(source)
            try:
                await db.flush()
            except IntegrityError as exc:
                if not _commit:
                    raise
                await db.rollback()
                source = (
                    await db.execute(
                        select(CareerSource)
                        .where(CareerSource.source_type == clean_source_type)
                        .where(CareerSource.external_id == clean_external_id)
                    )
                ).scalar_one_or_none()
                if source is None:
                    raise ValueError("职业来源创建冲突，且无法读取已存在来源") from exc
                if source.status != "active":
                    raise ValueError("来源已失效，不能继续产生学习观察") from exc
        elif source.status != "active":
            raise ValueError("来源已失效，不能继续产生学习观察")
        else:
            if clean_title and not source.title:
                source.title = clean_title
            if clean_locator and not source.locator:
                source.locator = clean_locator
            if clean_metadata and not source.metadata_json:
                source.metadata_json = clean_metadata

        observation = LearningObservation(
            source_id=source.id,
            observation_type=clean_observation_type,
            content_json=clean_content,
            content_hash=content_hash,
            idempotency_key=stable_key,
            status="active",
            observed_at=_parse_datetime(observed_at),
        )
        db.add(observation)
        try:
            if _commit:
                await db.commit()
            else:
                await db.flush()
        except IntegrityError:
            if not _commit:
                raise
            await db.rollback()
            existing = (
                await db.execute(
                    select(LearningObservation).where(
                        LearningObservation.idempotency_key == stable_key
                    )
                )
            ).scalar_one()
            source = (
                await db.execute(select(CareerSource).where(CareerSource.id == existing.source_id))
            ).scalar_one()
            return {
                **_serialize_observation(existing, source),
                "duplicate": True,
            }
        await db.refresh(source)
        await db.refresh(observation)
        await _index_observation_vector(observation, source)
        return {
            **_serialize_observation(observation, source),
            "duplicate": False,
        }


async def _index_observation_vector(
    observation: LearningObservation,
    source: CareerSource,
) -> None:
    """best-effort 向量索引：Qdrant/embedding 不可用时静默跳过，不阻塞记录。"""
    try:
        content = observation.content_json if isinstance(observation.content_json, dict) else {}
        text_parts = [observation.observation_type]
        for key in ("source_excerpt", "text", "statement", "summary", "title"):
            value = content.get(key)
            if isinstance(value, str) and value.strip():
                text_parts.append(value.strip())
        # 无可读文本（如 reference_only 的对话观察）不索引
        if len(text_parts) <= 1:
            return
        from app.services.semantic_search import get_semantic_search

        await get_semantic_search().index_observation(
            observation.id,
            "\n".join(text_parts),
            payload={
                "observation_type": observation.observation_type,
                "source_type": source.source_type,
            },
        )
    except Exception:
        pass


async def record_conversation_observation(
    *,
    conversation_id: Optional[str],
    turn_index: int,
    user_message: str,
    user_stage: str,
) -> dict[str, Any]:
    clean_conversation_id = _clean_text(
        conversation_id,
        "conversation_id",
        limit=255,
    )
    clean_message = _clean_text(user_message, "user_message", limit=50_000)
    if not clean_conversation_id or not clean_message:
        return {"recorded": False, "reason": "stable conversation source unavailable"}
    if isinstance(turn_index, bool) or not isinstance(turn_index, int) or turn_index <= 0:
        raise ValueError("turn_index 必须是正整数")
    source_message = clean_message
    from app.services.harness_history import get_conversation

    conversation = get_conversation(clean_conversation_id)
    if conversation is not None:
        user_messages = [
            item
            for item in conversation.get("messages", [])
            if isinstance(item, dict) and item.get("role") == "user"
        ]
        if turn_index > len(user_messages):
            raise ValueError("对话来源中的用户轮次已不存在")
        source_message = str(
            user_messages[turn_index - 1].get("content") or ""
        ).strip()
    message_hash = _sha256(source_message)
    observation = await record_learning_observation(
        source_type="conversation",
        source_external_id=clean_conversation_id,
        source_title="OfferU 主 Agent 对话",
        source_locator=f"conversation:{clean_conversation_id}",
        source_metadata={"storage": "reference_only"},
        observation_type="conversation_turn",
        content={
            "turn_index": turn_index,
            "message_sha256": message_hash,
            "message_length": len(source_message),
            "user_stage": _clean_text(user_stage, "user_stage", limit=40) or "unknown",
        },
        idempotency_key=f"{clean_conversation_id}:{turn_index}:{message_hash}",
    )
    return {"recorded": True, **observation}


async def list_learning_observations(
    *,
    status: str = "active",
    observation_type: Optional[str] = None,
    limit: int = 100,
) -> dict[str, Any]:
    clean_status = _clean_text(status, "status", limit=24).lower() or "active"
    if clean_status not in {"active", "invalidated", "all"}:
        raise ValueError("status 必须是 active、invalidated 或 all")
    safe_limit = max(1, min(int(limit), 500))
    query = (
        select(LearningObservation, CareerSource)
        .join(CareerSource, CareerSource.id == LearningObservation.source_id)
        .order_by(LearningObservation.observed_at.desc(), LearningObservation.id.desc())
        .limit(safe_limit)
    )
    if clean_status != "all":
        query = query.where(LearningObservation.status == clean_status)
    if observation_type:
        query = query.where(
            LearningObservation.observation_type
            == _clean_type(observation_type, "observation_type")
        )
    async with async_session() as db:
        rows = (await db.execute(query)).all()
    return {
        "total": len(rows),
        "items": [_serialize_observation(observation, source) for observation, source in rows],
    }


async def create_memory_proposal(
    *,
    observation_id: int,
    target_tier: str,
    section_type: str,
    title: str,
    after: dict[str, Any],
    reason: str,
    before: Optional[dict[str, Any]] = None,
    impact: Optional[list[str]] = None,
) -> dict[str, Any]:
    clean_observation_id = _clean_positive_int(observation_id, "observation_id")
    clean_tier = _clean_text(
        target_tier,
        "target_tier",
        limit=32,
        required=True,
    ).lower()
    if clean_tier not in TARGET_TIERS:
        raise ValueError("target_tier 必须是 verified_fact、preference 或 career_hypothesis")
    from app.services.profile_schema import (
        is_valid_profile_section_type,
        normalize_section_type_alias,
    )

    clean_section_type = normalize_section_type_alias(
        _clean_text(section_type, "section_type", limit=80, required=True).lower()
    )
    if not is_valid_profile_section_type(clean_section_type):
        raise ValueError("section_type 必须是内置档案分类或稳定 custom 分类")
    clean_title = _clean_text(title, "title", limit=220, required=True)
    clean_reason = _clean_text(reason, "reason", limit=4000, required=True)
    clean_before = _validate_json_object(
        before if before is not None else {},
        "before",
    )
    clean_after = _validate_json_object(after, "after", required=True)
    _assert_no_secret_fields(clean_before, "before")
    _assert_no_secret_fields(clean_after, "after")
    raw_impact = impact if impact is not None else []
    if not isinstance(raw_impact, list):
        raise ValueError("impact 必须是字符串数组")
    clean_impact = [
        _clean_text(item, "impact item", limit=500, required=True)
        for item in raw_impact[:20]
    ]
    if len(raw_impact) > 20:
        raise ValueError("impact 最多包含 20 项")
    proposal_key = _sha256(
        _canonical_json(
            {
                "observation_id": clean_observation_id,
                "target_tier": clean_tier,
                "section_type": clean_section_type,
                "title": clean_title,
                "after": clean_after,
            }
        )
    )

    async with async_session() as db:
        observation = (
            await db.execute(
                select(LearningObservation).where(
                    LearningObservation.id == clean_observation_id
                )
            )
        ).scalar_one_or_none()
        if observation is None:
            raise ValueError(f"Learning observation #{observation_id} not found")
        source = (
            await db.execute(select(CareerSource).where(CareerSource.id == observation.source_id))
        ).scalar_one()
        if observation.status != "active" or source.status != "active":
            raise ValueError("失效观察不能生成记忆提案")
        existing = (
            await db.execute(
                select(MemoryProposal).where(MemoryProposal.proposal_key == proposal_key)
            )
        ).scalar_one_or_none()
        if existing is not None:
            evidence = await _proposal_evidence(db, [existing.id])
            return {
                **_serialize_proposal(existing, evidence.get(existing.id, [])),
                "duplicate": True,
            }

        proposal = MemoryProposal(
            proposal_key=proposal_key,
            target_tier=clean_tier,
            section_type=clean_section_type,
            title=clean_title,
            before_json=clean_before,
            after_json=clean_after,
            reason=clean_reason,
            impact_json=clean_impact,
            status="pending",
        )
        db.add(proposal)
        try:
            await db.flush()
        except IntegrityError as exc:
            await db.rollback()
            existing = (
                await db.execute(
                    select(MemoryProposal).where(
                        MemoryProposal.proposal_key == proposal_key
                    )
                )
            ).scalar_one_or_none()
            if existing is None:
                raise ValueError("记忆提案创建冲突，且无法读取已存在提案") from exc
            evidence = await _proposal_evidence(db, [existing.id])
            return {
                **_serialize_proposal(existing, evidence.get(existing.id, [])),
                "duplicate": True,
            }
        db.add(
            EvidenceLink(
                observation_id=observation.id,
                target_type="memory_proposal",
                target_id=proposal.id,
                relation="supports",
                is_active=True,
            )
        )
        await db.commit()
        await db.refresh(proposal)
        evidence = await _proposal_evidence(db, [proposal.id])
        return {
            **_serialize_proposal(proposal, evidence.get(proposal.id, [])),
            "duplicate": False,
        }


async def _proposal_evidence(db: Any, proposal_ids: list[int]) -> dict[int, list[dict[str, Any]]]:
    if not proposal_ids:
        return {}
    rows = (
        await db.execute(
            select(EvidenceLink, LearningObservation, CareerSource)
            .join(LearningObservation, LearningObservation.id == EvidenceLink.observation_id)
            .join(CareerSource, CareerSource.id == LearningObservation.source_id)
            .where(EvidenceLink.target_type == "memory_proposal")
            .where(EvidenceLink.target_id.in_(proposal_ids))
            .order_by(EvidenceLink.id.asc())
        )
    ).all()
    result: dict[int, list[dict[str, Any]]] = {}
    for link, observation, source in rows:
        result.setdefault(link.target_id, []).append(
            {
                "link_id": link.id,
                "active": bool(link.is_active),
                "observation": _serialize_observation(observation, source),
            }
        )
    return result


async def list_memory_inbox(
    *,
    status: str = "pending",
    limit: int = 100,
) -> dict[str, Any]:
    clean_status = _clean_text(status, "status", limit=24).lower() or "pending"
    if clean_status not in PROPOSAL_STATUSES | {"all"}:
        raise ValueError("无效的记忆提案状态")
    safe_limit = max(1, min(int(limit), 500))
    query = select(MemoryProposal).order_by(
        MemoryProposal.created_at.desc(),
        MemoryProposal.id.desc(),
    )
    if clean_status != "all":
        query = query.where(MemoryProposal.status == clean_status)
    query = query.limit(safe_limit)
    async with async_session() as db:
        proposals = (await db.execute(query)).scalars().all()
        evidence = await _proposal_evidence(db, [item.id for item in proposals])
    return {
        "total": len(proposals),
        "items": [_serialize_proposal(item, evidence.get(item.id, [])) for item in proposals],
    }


def _observation_source_excerpt(
    observation: LearningObservation,
    source: CareerSource,
) -> str:
    content = observation.content_json if isinstance(observation.content_json, dict) else {}
    if source.source_type == "conversation":
        from app.services.harness_history import get_conversation

        turn_index = content.get("turn_index")
        expected_hash = content.get("message_sha256")
        if (
            isinstance(turn_index, bool)
            or not isinstance(turn_index, int)
            or turn_index <= 0
            or not isinstance(expected_hash, str)
        ):
            raise ValueError("对话观察缺少可校验的消息引用")
        conversation = get_conversation(source.external_id)
        if conversation is None:
            raise ValueError("对话来源已不存在，不能接受该记忆提案")
        user_messages = [
            item
            for item in conversation.get("messages", [])
            if isinstance(item, dict) and item.get("role") == "user"
        ]
        if turn_index > len(user_messages):
            raise ValueError("对话来源中的用户轮次已不存在")
        source_text = str(user_messages[turn_index - 1].get("content") or "").strip()
        if not source_text or _sha256(source_text) != expected_hash:
            raise ValueError("对话来源内容与学习观察哈希不一致")
        return source_text
    for key in ("source_excerpt", "text", "statement", "summary"):
        value = content.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return _canonical_json(content)


async def review_memory_proposal(
    *,
    proposal_id: int,
    action: str,
    note: str = "",
) -> dict[str, Any]:
    clean_proposal_id = _clean_positive_int(proposal_id, "proposal_id")
    clean_action = _clean_text(action, "action", limit=24, required=True).lower()
    if clean_action not in REVIEW_ACTIONS:
        raise ValueError("action 必须是 accept、reject、defer 或 revoke")
    clean_note = _clean_text(note, "note", limit=2000)

    async with async_session() as db:
        proposal = (
            await db.execute(
                select(MemoryProposal).where(MemoryProposal.id == clean_proposal_id)
            )
        ).scalar_one_or_none()
        if proposal is None:
            raise ValueError(f"Memory proposal #{proposal_id} not found")
        evidence = await _proposal_evidence(db, [proposal.id])

        if clean_action == "defer":
            if proposal.status not in {"pending", "deferred"}:
                raise ValueError("只有待处理提案可以稍后处理")
            proposal.status = "deferred"
            proposal.review_note = clean_note
            proposal.reviewed_at = _now()
            await db.commit()
            await db.refresh(proposal)
            refreshed_evidence = await _proposal_evidence(db, [proposal.id])
            return _serialize_proposal(
                proposal,
                refreshed_evidence.get(proposal.id, []),
            )

        if clean_action == "reject":
            if proposal.status not in {"pending", "deferred"}:
                raise ValueError("只有待处理提案可以拒绝")
            proposal.status = "rejected"
            proposal.review_note = clean_note
            proposal.reviewed_at = _now()
            await db.commit()
            await db.refresh(proposal)
            refreshed_evidence = await _proposal_evidence(db, [proposal.id])
            return _serialize_proposal(
                proposal,
                refreshed_evidence.get(proposal.id, []),
            )

        if clean_action == "revoke":
            if proposal.status != "accepted":
                raise ValueError("只有已接受提案可以撤销")
            section_id = proposal.applied_profile_section_id
            linked_observation_ids = [
                int(item["observation"]["id"]) for item in evidence.get(proposal.id, [])
            ]
            if section_id:
                section_links = (
                    await db.execute(
                        select(EvidenceLink)
                        .where(EvidenceLink.target_type == "profile_section")
                        .where(EvidenceLink.target_id == section_id)
                        .where(EvidenceLink.observation_id.in_(linked_observation_ids))
                    )
                ).scalars().all()
                for link in section_links:
                    link.is_active = False
                    link.invalidated_at = _now()
                await db.flush()
                remaining_links = (
                    await db.execute(
                        select(func.count(EvidenceLink.id))
                        .where(EvidenceLink.target_type == "profile_section")
                        .where(EvidenceLink.target_id == section_id)
                        .where(EvidenceLink.is_active == True)
                    )
                ).scalar_one()
                if not remaining_links:
                    await db.execute(delete(ProfileSection).where(ProfileSection.id == section_id))
            proposal.status = "revoked"
            proposal.review_note = clean_note
            proposal.reviewed_at = _now()
            await db.commit()
            await db.refresh(proposal)
            refreshed_evidence = await _proposal_evidence(db, [proposal.id])
            return _serialize_proposal(
                proposal,
                refreshed_evidence.get(proposal.id, []),
            )

        if proposal.status == "accepted":
            return {
                **_serialize_proposal(proposal, evidence.get(proposal.id, [])),
                "duplicate": True,
            }
        if proposal.status not in {"pending", "deferred", "applying"}:
            raise ValueError("当前提案状态不能接受")
        active_evidence = [
            item
            for item in evidence.get(proposal.id, [])
            if item["active"]
            and item["observation"]["status"] == "active"
            and item["observation"]["source"]["status"] == "active"
        ]
        if len(active_evidence) != 1:
            raise ValueError("提案必须有且仅有一条有效来源观察")
        snapshot = {
            "target_tier": proposal.target_tier,
            "section_type": proposal.section_type,
            "title": proposal.title,
            "after": proposal.after_json or {},
            "observation_id": active_evidence[0]["observation"]["id"],
            "source_locator": active_evidence[0]["observation"]["source"]["locator"],
        }
        source_observation = (
            await db.execute(
                select(LearningObservation).where(
                    LearningObservation.id == snapshot["observation_id"]
                )
            )
        ).scalar_one()
        source = (
            await db.execute(
                select(CareerSource).where(CareerSource.id == source_observation.source_id)
            )
        ).scalar_one()
        source_excerpt = _observation_source_excerpt(
            source_observation,
            source,
        )
        proposal.status = "applying"
        proposal.review_note = clean_note
        await db.commit()

    from app.services.agent_operations import add_profile_evidence

    try:
        applied = await add_profile_evidence(
            section_type=snapshot["section_type"],
            title=snapshot["title"],
            content_json=snapshot["after"],
            source_text=source_excerpt,
            category_label=str(snapshot["after"].get("category_label") or "").strip() or None,
            source_url=snapshot["source_locator"],
            dedup_key=f"memory_proposal:{clean_proposal_id}",
            tier=snapshot["target_tier"],
        )
    except Exception as exc:
        async with async_session() as db:
            proposal = (
                await db.execute(
                    select(MemoryProposal).where(MemoryProposal.id == clean_proposal_id)
                )
            ).scalar_one()
            if proposal.status == "applying":
                proposal.status = "pending"
                proposal.review_note = str(exc)[:2000]
                await db.commit()
        raise
    if applied.get("error"):
        async with async_session() as db:
            proposal = (
                await db.execute(
                    select(MemoryProposal).where(MemoryProposal.id == clean_proposal_id)
                )
            ).scalar_one()
            proposal.status = "pending"
            proposal.review_note = str(applied["error"])[:2000]
            await db.commit()
        return {"error": applied["error"], "fact_gate": applied.get("fact_gate")}

    profile_section_id = int(applied["id"])
    async with async_session() as db:
        proposal = (
            await db.execute(
                select(MemoryProposal).where(MemoryProposal.id == clean_proposal_id)
            )
        ).scalar_one()
        observation = (
            await db.execute(
                select(LearningObservation).where(
                    LearningObservation.id == snapshot["observation_id"]
                )
            )
        ).scalar_one()
        source = (
            await db.execute(select(CareerSource).where(CareerSource.id == observation.source_id))
        ).scalar_one()
        if (
            proposal.status == "invalidated"
            or observation.status != "active"
            or source.status != "active"
        ):
            await db.execute(
                delete(ProfileSection).where(ProfileSection.id == profile_section_id)
            )
            proposal.status = "invalidated"
            proposal.before_json = {}
            proposal.after_json = {}
            proposal.reason = ""
            proposal.impact_json = []
            proposal.review_note = ""
            proposal.invalidated_at = _now()
            await db.commit()
            return {"error": "来源在提案应用期间失效，Profile 写入已撤销"}
        proposal.status = "accepted"
        proposal.applied_profile_section_id = profile_section_id
        proposal.review_note = clean_note
        proposal.reviewed_at = _now()
        existing_link = (
            await db.execute(
                select(EvidenceLink)
                .where(EvidenceLink.observation_id == snapshot["observation_id"])
                .where(EvidenceLink.target_type == "profile_section")
                .where(EvidenceLink.target_id == profile_section_id)
                .where(EvidenceLink.relation == "supports")
            )
        ).scalar_one_or_none()
        if existing_link is None:
            db.add(
                EvidenceLink(
                    observation_id=snapshot["observation_id"],
                    target_type="profile_section",
                    target_id=profile_section_id,
                    relation="supports",
                    is_active=True,
                )
            )
        await db.commit()
        await db.refresh(proposal)
        evidence = await _proposal_evidence(db, [proposal.id])
        return {
            **_serialize_proposal(proposal, evidence.get(proposal.id, [])),
            "profile_write": applied,
            "duplicate": bool(applied.get("duplicate")),
        }


async def invalidate_memory_source(
    *,
    source_id: int,
    reason: str,
) -> dict[str, Any]:
    clean_source_id = _clean_positive_int(source_id, "source_id")
    clean_reason = _clean_text(reason, "reason", limit=500, required=True)
    invalidated_at = _now()
    async with async_session() as db:
        source = (
            await db.execute(select(CareerSource).where(CareerSource.id == clean_source_id))
        ).scalar_one_or_none()
        if source is None:
            raise ValueError(f"Career source #{source_id} not found")
        if source.status == "invalidated":
            return {"source_id": source.id, "invalidated": False, "duplicate": True}

        observations = (
            await db.execute(
                select(LearningObservation).where(LearningObservation.source_id == source.id)
            )
        ).scalars().all()
        observation_ids = [item.id for item in observations]
        links = []
        if observation_ids:
            links = (
                await db.execute(
                    select(EvidenceLink).where(
                        EvidenceLink.observation_id.in_(observation_ids)
                    )
                )
            ).scalars().all()
        affected_proposal_ids = {
            link.target_id for link in links if link.target_type == "memory_proposal"
        }

        for observation in observations:
            observation.status = "invalidated"
            observation.content_json = {}
            observation.invalidated_at = invalidated_at
        for link in links:
            link.is_active = False
            link.invalidated_at = invalidated_at
        await db.flush()

        removed_profile_sections = 0
        invalidated_proposals = 0
        for proposal_id in affected_proposal_ids:
            active_support = (
                await db.execute(
                    select(func.count(EvidenceLink.id))
                    .where(EvidenceLink.target_type == "memory_proposal")
                    .where(EvidenceLink.target_id == proposal_id)
                    .where(EvidenceLink.is_active == True)
                )
            ).scalar_one()
            if active_support:
                continue
            proposal = (
                await db.execute(
                    select(MemoryProposal).where(MemoryProposal.id == proposal_id)
                )
            ).scalar_one_or_none()
            if proposal is None:
                continue
            section_id = proposal.applied_profile_section_id
            if section_id:
                remaining_section_support = (
                    await db.execute(
                        select(func.count(EvidenceLink.id))
                        .where(EvidenceLink.target_type == "profile_section")
                        .where(EvidenceLink.target_id == section_id)
                        .where(EvidenceLink.is_active == True)
                    )
                ).scalar_one()
                if not remaining_section_support:
                    result = await db.execute(
                        delete(ProfileSection).where(ProfileSection.id == section_id)
                    )
                    removed_profile_sections += int(result.rowcount or 0)
            proposal.status = "invalidated"
            proposal.before_json = {}
            proposal.after_json = {}
            proposal.reason = ""
            proposal.impact_json = []
            proposal.review_note = ""
            proposal.invalidated_at = invalidated_at
            invalidated_proposals += 1

        external_hash = _sha256(f"{source.source_type}:{source.external_id}")
        source.external_id = f"invalidated:{source.id}:{external_hash}"
        source.title = ""
        source.locator = ""
        source.metadata_json = {"invalidation_reason": clean_reason}
        source.status = "invalidated"
        source.invalidated_at = invalidated_at
        await db.commit()
        return {
            "source_id": source.id,
            "invalidated": True,
            "duplicate": False,
            "observation_count": len(observations),
            "proposal_count": invalidated_proposals,
            "removed_profile_section_count": removed_profile_sections,
        }
