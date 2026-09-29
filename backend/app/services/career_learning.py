"""Unified read-only Career Learning projection seam (P4).

Every Career Director surface — the global CareerSnapshot, the per-interview
context, and the daily review — projects learning evidence through this module
so the semantics stay identical everywhere:

- ``evidence_gap`` counts only *accepted* learning: the observation must be
  ``active``, its CareerSource must be ``active``, an ``is_active`` EvidenceLink
  must connect it to a MemoryProposal whose current status is ``accepted``.
  Pending, deferred, rejected, revoked, invalidated or superseded review states
  never count, and a source invalidation removes the item entirely.
- ``repeated_weak_areas`` additionally requires >=2 distinct interview/source
  keys. Multiple observations of the same interview collapse to one key, so a
  topic repeated only inside one interview never qualifies.
- ``asked_frequency`` (what interviews asked about or trained on) is review-
  independent and never treated as weakness; a causal ``interview_debrief``
  candidate stays a hypothesis and never becomes performance.
- Aggregates carry provenance (observation ids, interview keys, proposal ids)
  and uncertainty (confidence, unverified source counts). Timestamps stay
  timestamps: an elapsed schedule never masquerades as user confirmation.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import and_, select

from app.models.models import (
    CareerSource,
    EvidenceLink,
    LearningObservation,
    MemoryProposal,
)
from app.services.security_redaction import redact_sensitive_text

INTERVIEW_OBSERVATION_TYPES = (
    "interview_completed",
    "interview_debrief_candidate",
)

ACCEPTED_REVIEW_STATUS = "accepted"
UNREVIEWED_REVIEW_STATUS = "unreviewed"
PENDING_REVIEW_STATUSES = frozenset({"pending", "applying", "deferred"})
REJECTED_REVIEW_STATUSES = frozenset(
    {"rejected", "revoked", "invalidated", "superseded"}
)
REVIEW_STATUSES = frozenset(
    {ACCEPTED_REVIEW_STATUS, UNREVIEWED_REVIEW_STATUS}
    | PENDING_REVIEW_STATUSES
    | REJECTED_REVIEW_STATUSES
)

_WHITESPACE = re.compile(r"\s+")
_TOPIC_LIMIT = 180


class _StrictLearning(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


def normalize_topic(value: Any, *, limit: int = _TOPIC_LIMIT) -> str:
    """Conservative exact-topic key: trim, collapse whitespace, casefold only."""

    if not isinstance(value, str):
        return ""
    return _WHITESPACE.sub(" ", value.strip()).casefold()[:limit]


def _safe_topic(value: Any, *, limit: int = _TOPIC_LIMIT) -> str:
    if not isinstance(value, str):
        return ""
    return redact_sensitive_text(value.strip(), max_length=limit).strip()


def _iso(value: Any) -> str:
    return value.isoformat() if isinstance(value, datetime) else str(value or "")[:50]


def _focus_dicts(content: dict[str, Any]) -> list[dict[str, Any]]:
    """Collect capability focus dicts from both stored shapes."""

    focuses: list[dict[str, Any]] = []
    role_intel = content.get("role_intelligence")
    for container in (role_intel if isinstance(role_intel, dict) else {}, content):
        rows = container.get("focuses")
        if isinstance(rows, list):
            focuses.extend(item for item in rows if isinstance(item, dict))
    return focuses


class LearningEvidence(_StrictLearning):
    """One active learning observation with its memory review state."""

    observation_id: int = Field(gt=0)
    observation_type: str = Field(min_length=1, max_length=80)
    source_id: int = Field(gt=0)
    source_type: str = Field(default="", max_length=60)
    source_title: str = Field(default="", max_length=300)
    interview_key: str = Field(min_length=1, max_length=80)
    review_status: str = Field(default=UNREVIEWED_REVIEW_STATUS, max_length=24)
    proposal_id: int | None = Field(default=None, gt=0)
    accepted: bool = False
    summary: str = Field(default="", max_length=500)
    candidate_type: str = Field(default="", max_length=40)
    asked_topics: list[str] = Field(default_factory=list, max_length=12)
    weak_topics: list[str] = Field(default_factory=list, max_length=12)
    performance: dict[str, Any] = Field(default_factory=dict)
    causal_hypothesis: str = Field(default="", max_length=500)
    has_user_feedback: bool = False
    observed_at: str = Field(default="", max_length=50)


class LearningTopicEvidence(_StrictLearning):
    """Aggregate for one normalized topic with full provenance."""

    topic: str = Field(min_length=1, max_length=_TOPIC_LIMIT)
    distinct_sources: int = Field(default=0, ge=0)
    observation_ids: list[int] = Field(default_factory=list, max_length=24)
    interview_keys: list[str] = Field(default_factory=list, max_length=24)
    proposal_ids: list[int] = Field(default_factory=list, max_length=24)
    latest_observed_at: str = Field(default="", max_length=50)
    unverified_sources: int = Field(default=0, ge=0)
    repeated: bool = False
    confidence: Literal["low", "medium", "high"] = "low"


class LearningProjection(_StrictLearning):
    """Unified learning projection shared by snapshot/interview/daily readers."""

    items: list[LearningEvidence] = Field(default_factory=list)
    asked_frequency: list[LearningTopicEvidence] = Field(default_factory=list)
    evidence_gap: list[LearningTopicEvidence] = Field(default_factory=list)
    repeated_weak_areas: list[str] = Field(default_factory=list)
    recurring_question_themes: list[str] = Field(default_factory=list)
    performance_assessment: list[dict[str, Any]] = Field(default_factory=list)
    user_feedback: list[dict[str, Any]] = Field(default_factory=list)
    accepted_learning: list[dict[str, Any]] = Field(default_factory=list)
    causal_hypothesis: list[dict[str, Any]] = Field(default_factory=list)
    pending_review_count: int = Field(default=0, ge=0)
    findings_count: int = Field(default=0, ge=0)
    confidence: Literal["low", "medium", "high"] = "low"


def _interview_key(observation: LearningObservation, source: CareerSource) -> str:
    """Distinct-source key: one interview collapses all its observations."""

    content = (
        observation.content_json if isinstance(observation.content_json, dict) else {}
    )
    for key, prefix in (
        ("calendar_event_id", "calendar"),
        ("interview_id", "interview"),
    ):
        raw = content.get(key)
        if isinstance(raw, bool):
            continue
        if isinstance(raw, int) and raw > 0:
            return f"{prefix}:{raw}"
        if isinstance(raw, str) and raw.strip().isdigit():
            return f"{prefix}:{int(raw.strip())}"
    return f"source:{int(source.id)}"


def _extract_item(
    observation: LearningObservation,
    source: CareerSource,
    review_status: str,
    proposal_id: int | None,
) -> LearningEvidence:
    content = (
        observation.content_json if isinstance(observation.content_json, dict) else {}
    )
    candidate_type = str(content.get("candidate_type") or "").strip()
    summary = _safe_topic(content.get("summary"), limit=500)

    weak_topics: dict[str, str] = {}

    def _add_weak(raw: Any) -> None:
        text = _safe_topic(raw)
        if text:
            weak_topics.setdefault(normalize_topic(text), text)

    for area in content.get("weak_areas") or []:
        _add_weak(area)
    for focus in _focus_dicts(content):
        for gap in focus.get("observed_answer_gaps") or []:
            _add_weak(gap)
    if candidate_type == "weak_area" and not weak_topics and summary:
        _add_weak(summary)

    asked_topics: dict[str, str] = {}

    def _add_asked(raw: Any, *, limit: int = _TOPIC_LIMIT) -> None:
        text = _safe_topic(raw, limit=limit)
        if text:
            asked_topics.setdefault(normalize_topic(text), text)

    for theme in content.get("question_themes") or []:
        _add_asked(theme, limit=120)
    for focus in _focus_dicts(content):
        _add_asked(focus.get("capability"), limit=160)

    performance: dict[str, Any] = {}
    for key in ("content_score", "score_scope", "scoring_skill_id", "scoring_skill_version"):
        value = content.get(key)
        if value is not None and value != "":
            performance[key] = value
    dimension_scores = content.get("dimension_scores")
    if isinstance(dimension_scores, dict) and dimension_scores:
        performance["dimension_scores"] = {
            str(k): v for k, v in list(dimension_scores.items())[:12]
        }

    is_debrief_candidate = observation.observation_type == "interview_debrief_candidate"
    hypothesis = ""
    if is_debrief_candidate:
        title = _safe_topic(content.get("title"), limit=180)
        hypothesis = f"{title} — {summary}" if title and summary else (summary or title)
    has_user_feedback = bool(
        is_debrief_candidate and str(content.get("source_excerpt") or "").strip()
    )

    return LearningEvidence(
        observation_id=int(observation.id),
        observation_type=str(observation.observation_type),
        source_id=int(source.id),
        source_type=str(source.source_type or ""),
        source_title=_safe_topic(source.title, limit=160),
        interview_key=_interview_key(observation, source),
        review_status=review_status,
        proposal_id=proposal_id,
        accepted=review_status == ACCEPTED_REVIEW_STATUS,
        summary=summary,
        candidate_type=candidate_type,
        asked_topics=list(asked_topics.values())[:12],
        weak_topics=list(weak_topics.values())[:12],
        performance=performance,
        causal_hypothesis=hypothesis,
        has_user_feedback=has_user_feedback,
        observed_at=_iso(observation.observed_at or observation.created_at),
    )


async def load_learning_evidence(
    db: Any,
    *,
    observation_types: tuple[str, ...] | list[str] | None = INTERVIEW_OBSERVATION_TYPES,
    since: datetime | None = None,
    limit: int = 200,
) -> list[LearningEvidence]:
    """Load active observations on active sources with their review state.

    An observation's review state is the newest active ``memory_proposal``
    EvidenceLink target's status; ``unreviewed`` when no such link exists.
    Invalidated sources/observations are excluded, never projected as stale.
    """

    query = (
        select(LearningObservation, CareerSource)
        .join(CareerSource, CareerSource.id == LearningObservation.source_id)
        .where(LearningObservation.status == "active")
        .where(CareerSource.status == "active")
        .order_by(
            LearningObservation.observed_at.desc(), LearningObservation.id.desc()
        )
        .limit(max(1, min(int(limit or 200), 500)))
    )
    if observation_types:
        query = query.where(
            LearningObservation.observation_type.in_(tuple(observation_types))
        )
    if since is not None:
        query = query.where(LearningObservation.observed_at >= since)
    rows = (await db.execute(query)).all()

    review_by_observation: dict[int, tuple[str, int]] = {}
    observation_ids = [int(observation.id) for observation, _source in rows]
    if observation_ids:
        proposal_rows = (
            await db.execute(
                select(
                    EvidenceLink.observation_id,
                    MemoryProposal.id,
                    MemoryProposal.status,
                )
                .select_from(EvidenceLink)
                .join(
                    MemoryProposal,
                    and_(
                        EvidenceLink.target_type == "memory_proposal",
                        EvidenceLink.target_id == MemoryProposal.id,
                    ),
                )
                .where(EvidenceLink.is_active.is_(True))
                .where(EvidenceLink.observation_id.in_(observation_ids))
                .order_by(MemoryProposal.created_at.desc(), MemoryProposal.id.desc())
            )
        ).all()
        for observation_id, proposal_id, status in proposal_rows:
            review_by_observation.setdefault(
                int(observation_id), (str(status), int(proposal_id))
            )

    return [
        _extract_item(
            observation,
            source,
            *review_by_observation.get(
                int(observation.id), (UNREVIEWED_REVIEW_STATUS, None)
            ),
        )
        for observation, source in rows
    ]


def _confidence_for(distinct: int) -> str:
    if distinct >= 3:
        return "high"
    if distinct >= 2:
        return "medium"
    return "low"


def _topic_evidence(
    items: list[LearningEvidence],
    topics_of: Any,
    *,
    accepted_only: bool,
    track_unverified: bool,
    min_distinct: int,
) -> list[LearningTopicEvidence]:
    grouped: dict[str, dict[str, Any]] = {}
    for item in items:
        if accepted_only and not item.accepted:
            continue
        seen_here: set[str] = set()
        for topic in topics_of(item):
            normalized = normalize_topic(topic)
            if not normalized or normalized in seen_here:
                continue
            seen_here.add(normalized)
            entry = grouped.setdefault(
                normalized,
                {
                    "topic": topic,
                    "keys": set(),
                    "observation_ids": [],
                    "proposal_ids": [],
                    "latest_observed_at": "",
                },
            )
            entry["keys"].add(item.interview_key)
            entry["observation_ids"].append(item.observation_id)
            if item.proposal_id is not None:
                entry["proposal_ids"].append(item.proposal_id)
            if item.observed_at > entry["latest_observed_at"]:
                entry["latest_observed_at"] = item.observed_at
                entry["topic"] = topic

    unverified_keys: dict[str, set[str]] = {}
    if track_unverified:
        for item in items:
            if item.accepted:
                continue
            for topic in topics_of(item):
                normalized = normalize_topic(topic)
                if normalized:
                    unverified_keys.setdefault(normalized, set()).add(
                        item.interview_key
                    )

    evidence = [
        LearningTopicEvidence(
            topic=str(data["topic"]),
            distinct_sources=len(data["keys"]),
            observation_ids=sorted(set(data["observation_ids"]))[:24],
            interview_keys=sorted(data["keys"])[:24],
            proposal_ids=sorted(set(data["proposal_ids"]))[:24],
            latest_observed_at=str(data["latest_observed_at"]),
            unverified_sources=len(unverified_keys.get(normalized, set())),
            repeated=len(data["keys"]) >= min_distinct,
            confidence=_confidence_for(len(data["keys"])),
        )
        for normalized, data in grouped.items()
    ]
    # Stable two-pass order: topic name, then most-recent, then evidence volume.
    evidence.sort(key=lambda row: row.topic.casefold())
    evidence.sort(key=lambda row: row.latest_observed_at, reverse=True)
    evidence.sort(key=lambda row: row.distinct_sources, reverse=True)
    return evidence


def project_learning(items: list[LearningEvidence]) -> LearningProjection:
    """Aggregate loaded evidence into review-safe facets.

    ``evidence_gap``/``repeated_weak_areas`` count only accepted items and
    require >= min_distinct separate interview/source keys to repeat. Asked
    frequency and causal hypotheses are surfaced separately so they can never
    be mistaken for observed performance or weakness.
    """

    evidence_gap = _topic_evidence(
        items,
        lambda item: item.weak_topics,
        accepted_only=True,
        track_unverified=True,
        min_distinct=2,
    )
    asked_frequency = _topic_evidence(
        items,
        lambda item: item.asked_topics,
        accepted_only=False,
        track_unverified=False,
        min_distinct=2,
    )
    repeated_weak = [
        row.topic for row in evidence_gap if row.repeated
    ][:8]
    recurring_themes = [
        row.topic for row in asked_frequency if row.repeated
    ][:8]

    performance_rows: dict[str, dict[str, Any]] = {}
    for item in items:
        if not item.performance:
            continue
        row = performance_rows.setdefault(
            item.interview_key,
            {
                "interview_key": item.interview_key,
                "observed_at": item.observed_at,
                "review_status": item.review_status,
                "accepted": item.accepted,
                "performance": item.performance,
            },
        )
        if item.observed_at > row["observed_at"]:
            row["observed_at"] = item.observed_at
            row["review_status"] = item.review_status
            row["accepted"] = item.accepted
            row["performance"] = item.performance
    performance_assessment = sorted(
        performance_rows.values(), key=lambda row: row["observed_at"], reverse=True
    )[:12]

    user_feedback = [
        {
            "observation_id": item.observation_id,
            "interview_key": item.interview_key,
            "review_status": item.review_status,
            "observed_at": item.observed_at,
        }
        for item in items
        if item.has_user_feedback
    ][:24]
    accepted_learning = [
        {
            "observation_id": item.observation_id,
            "proposal_id": item.proposal_id,
            "interview_key": item.interview_key,
            "weak_topics": item.weak_topics,
            "observed_at": item.observed_at,
        }
        for item in items
        if item.accepted
    ][:24]
    causal_hypothesis = [
        {
            "observation_id": item.observation_id,
            "proposal_id": item.proposal_id,
            "hypothesis": item.causal_hypothesis,
            "candidate_type": item.candidate_type,
            "review_status": item.review_status,
            "interview_key": item.interview_key,
            "observed_at": item.observed_at,
        }
        for item in items
        if item.causal_hypothesis
    ][:24]
    pending_review = sum(
        1
        for item in items
        if item.review_status in PENDING_REVIEW_STATUSES
        or item.review_status == UNREVIEWED_REVIEW_STATUS
    )
    max_distinct = max((row.distinct_sources for row in evidence_gap), default=0)
    return LearningProjection(
        items=items,
        asked_frequency=asked_frequency,
        evidence_gap=evidence_gap,
        repeated_weak_areas=repeated_weak,
        recurring_question_themes=recurring_themes,
        performance_assessment=performance_assessment,
        user_feedback=user_feedback,
        accepted_learning=accepted_learning,
        causal_hypothesis=causal_hypothesis,
        pending_review_count=pending_review,
        findings_count=len(items),
        confidence=_confidence_for(max_distinct),
    )
