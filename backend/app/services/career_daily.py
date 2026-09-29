"""Bounded read-only context for a daily Career Director review."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import date, datetime, timedelta
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import and_, select

from app.database import async_session
from app.models.models import (
    AutomationInboxItem,
    CalendarEvent,
    EvidenceLink,
    LearningObservation,
    MemoryProposal,
    Profile,
    ProfileSection,
    Resume,
)
from app.services.security_redaction import redact_sensitive_text


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class DailyPipelineItem(_StrictModel):
    job_id: int = Field(gt=0)
    company: str = Field(max_length=180)
    role: str = Field(max_length=220)
    stage: str = Field(max_length=80)
    next_action: str = Field(max_length=300)
    last_event_at: str = Field(default="", max_length=50)
    pending_review: bool = False


class DailyInterview(_StrictModel):
    event_id: int
    title: str = Field(max_length=220)
    starts_at: str = Field(max_length=50)
    hours_until: float
    job_id: int | None = Field(default=None, gt=0)


class DailyFollowUp(_StrictModel):
    application_type: Literal["application", "application_record"]
    application_id: int = Field(gt=0)
    job_id: int | None = Field(default=None, gt=0)
    company: str = Field(max_length=180)
    role: str = Field(max_length=220)
    due_date: str = Field(max_length=20)
    days_until: int
    urgency: Literal["urgent", "overdue", "waiting", "cold"]


class DailyProposal(_StrictModel):
    """One bounded pointer to pending human review; proposal inputs stay hidden."""

    ref: str = Field(max_length=180)
    title: str = Field(max_length=220)
    reason: str = Field(default="", max_length=400)
    created_at: str = Field(default="", max_length=50)


class DailyChange(_StrictModel):
    kind: Literal["profile", "resume"]
    ref: str = Field(max_length=180)
    title: str = Field(max_length=220)
    changed_at: str = Field(max_length=50)
    revision: int | None = Field(default=None, ge=0)


class DailyLearning(_StrictModel):
    ref: str = Field(max_length=180)
    summary: str = Field(max_length=500)
    learning_type: Literal["interview_assessment", "potential_strength", "weak_area"] = "interview_assessment"
    review_status: Literal["accepted", "pending", "deferred", "rejected", "unreviewed", "inactive"] = "unreviewed"
    weak_areas: list[str] = Field(default_factory=list, max_length=6)
    observed_at: str = Field(max_length=50)


class IgnoredSuggestion(_StrictModel):
    dedupe_key: str = Field(min_length=1, max_length=180)
    objective: str = Field(max_length=300)
    why_now: str = Field(max_length=500)
    fingerprint: str = Field(min_length=1, max_length=64)
    dismissals: int = Field(ge=1, le=30)
    last_ignored_at: str = Field(max_length=50)


class DailyResumeState(_StrictModel):
    current_resume_id: int | None = Field(default=None, gt=0)
    current_version_number: int = Field(default=0, ge=0)
    workspace_revision: int = Field(default=0, ge=0)
    material_change_summary: str = Field(default="", max_length=400)
    jobs_using_older_resume: list[dict[str, Any]] = Field(default_factory=list, max_length=12)


class DailyRoleFamilyFunnel(_StrictModel):
    role_family: str = Field(min_length=1, max_length=160)
    saved: int = Field(default=0, ge=0)
    applied: int = Field(default=0, ge=0)
    interview: int = Field(default=0, ge=0)
    offer: int = Field(default=0, ge=0)
    rejected: int = Field(default=0, ge=0)


class DailyCareerContext(_StrictModel):
    contract_schema: Literal["offeru.daily_career_context.v2"] = Field(
        default="offeru.daily_career_context.v2", alias="schema"
    )
    review_date: date
    career_stage: dict[str, Any] | None = None
    strategy_pack: str = Field(default="", max_length=60)
    pipeline: list[DailyPipelineItem] = Field(default_factory=list, max_length=12)
    follow_ups_due: list[DailyFollowUp] = Field(default_factory=list, max_length=10)
    upcoming_interviews: list[DailyInterview] = Field(default_factory=list, max_length=8)
    pending_proposals: list[DailyProposal] = Field(default_factory=list, max_length=12)
    recent_changes: list[DailyChange] = Field(default_factory=list, max_length=12)
    interview_learning: list[DailyLearning] = Field(default_factory=list, max_length=6)
    ignored_suggestions: list[IgnoredSuggestion] = Field(default_factory=list, max_length=20)
    resume: DailyResumeState = Field(default_factory=DailyResumeState)
    role_family_funnel: list[DailyRoleFamilyFunnel] = Field(default_factory=list, max_length=12)


def _safe(value: Any, limit: int = 300) -> str:
    return redact_sensitive_text(str(value or "").strip(), max_length=limit).strip()


def _iso(value: Any) -> str:
    return value.isoformat() if isinstance(value, datetime) else str(value or "")[:50]


def action_fingerprint(action: dict[str, Any]) -> str:
    """Create a stable, evidence-sensitive signature for repeat-dismissal policy."""

    target = action.get("target_ref") if isinstance(action.get("target_ref"), dict) else {}
    signature = {
        "target": [str(target.get("kind") or ""), str(target.get("id") or "")],
        "skill": re.sub(r"\s+", " ", str(action.get("skill") or "").casefold()).strip(),
        "objective": re.sub(r"\s+", " ", str(action.get("objective") or "").casefold()).strip(),
        "why_now": re.sub(r"\s+", " ", str(action.get("why_now") or "").casefold()).strip(),
    }
    encoded = json.dumps(signature, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


async def build_daily_career_context(
    *, profile_id: int | None = None, review_date: date | None = None
) -> dict[str, Any]:
    """Collect only bounded, sanitized state needed to rank today's work."""

    from app.services.agent_operations import get_application_progress_board, list_follow_up_cadence

    today = review_date or datetime.now().astimezone().date()
    now = datetime.now().astimezone().replace(tzinfo=None)
    cutoff = now - timedelta(days=30)
    upcoming_cutoff = now + timedelta(days=14)

    board = await get_application_progress_board(status="active", include_timeline=False)
    pipeline: list[dict[str, Any]] = []
    for company_group in board.get("companies") or []:
        if not isinstance(company_group, dict):
            continue
        for record in company_group.get("records") or []:
            if not isinstance(record, dict) or not record.get("job_id"):
                continue
            pipeline.append(
                DailyPipelineItem(
                    job_id=int(record["job_id"]),
                    company=_safe(company_group.get("company"), 180),
                    role=_safe(record.get("job_title"), 220),
                    stage=_safe(record.get("current_stage"), 80),
                    next_action=_safe(record.get("next_action"), 300),
                    last_event_at=_iso(record.get("last_event_at")),
                    pending_review=int(record.get("pending_candidates") or 0) > 0,
                ).model_dump()
            )
    pipeline.sort(
        key=lambda item: (
            not item["pending_review"],
            not bool(item["next_action"]),
            item["last_event_at"],
        )
    )

    cadence = await list_follow_up_cadence()
    follow_ups: list[dict[str, Any]] = []
    for row in cadence.get("entries") or []:
        if not isinstance(row, dict) or row.get("urgency") not in {"urgent", "overdue", "waiting"}:
            continue
        if int(row.get("days_until_follow_up") or 0) > 1:
            continue
        follow_ups.append(
            DailyFollowUp(
                application_type=row.get("application_type"),
                application_id=int(row.get("application_id") or 0),
                job_id=int(row["job_id"]) if row.get("job_id") else None,
                company=_safe(row.get("company"), 180),
                role=_safe(row.get("role"), 220),
                due_date=_safe(row.get("next_follow_up_date"), 20),
                days_until=int(row.get("days_until_follow_up") or 0),
                urgency=row.get("urgency"),
            ).model_dump()
        )
        if len(follow_ups) == 10:
            break

    async with async_session() as db:
        calendar_query = (
            select(CalendarEvent)
            .where(CalendarEvent.event_type == "interview")
            .where(CalendarEvent.start_time >= now)
            .where(CalendarEvent.start_time <= upcoming_cutoff)
            .order_by(CalendarEvent.start_time.asc())
            .limit(8)
        )
        events = (await db.execute(calendar_query)).scalars().all()
        interviews = [
            DailyInterview(
                event_id=event.id,
                title=_safe(event.title, 220),
                starts_at=_iso(event.start_time),
                hours_until=round((event.start_time - now).total_seconds() / 3600, 1),
                job_id=event.related_job_id,
            ).model_dump()
            for event in events
        ]

        pending_memory = (
            await db.execute(
                select(MemoryProposal)
                .where(MemoryProposal.status == "pending")
                .order_by(MemoryProposal.created_at.asc())
                .limit(8)
            )
        ).scalars().all()
        pending_inbox = (
            await db.execute(
                select(AutomationInboxItem)
                .where(AutomationInboxItem.status == "pending")
                .where(AutomationInboxItem.category == "needs_approval")
                .order_by(AutomationInboxItem.created_at.asc())
                .limit(8)
            )
        ).scalars().all()
        proposals: list[dict[str, Any]] = [
            DailyProposal(
                ref=f"memory-proposal:{row.id}",
                title=_safe(row.title, 220),
                reason=_safe(row.reason, 400),
                created_at=_iso(row.created_at),
            ).model_dump()
            for row in pending_memory
        ]
        proposals.extend(
            DailyProposal(
                ref=f"inbox:{row.item_id}",
                title=_safe(row.title, 220),
                reason=_safe(row.body, 400),
                created_at=_iso(row.created_at),
            ).model_dump()
            for row in pending_inbox
        )

        recent_changes: list[dict[str, Any]] = []
        profile_query = select(Profile).where(Profile.updated_at >= cutoff)
        if profile_id is not None:
            profile_query = profile_query.where(Profile.id == profile_id)
        changed_profiles = (await db.execute(profile_query.order_by(Profile.updated_at.desc()).limit(2))).scalars().all()
        recent_changes.extend(
            DailyChange(
                kind="profile",
                ref=f"profile:{row.id}",
                title="个人档案",
                changed_at=_iso(row.updated_at),
            ).model_dump()
            for row in changed_profiles
        )
        section_query = select(ProfileSection).where(ProfileSection.updated_at >= cutoff).where(
            ProfileSection.status == "active"
        )
        if profile_id is not None:
            section_query = section_query.where(ProfileSection.profile_id == profile_id)
        sections = (await db.execute(section_query.order_by(ProfileSection.updated_at.desc()).limit(6))).scalars().all()
        recent_changes.extend(
            DailyChange(
                kind="profile",
                ref=f"profile-section:{row.id}",
                title=_safe(row.title or row.section_type, 220),
                changed_at=_iso(row.updated_at),
            ).model_dump()
            for row in sections
        )
        resume_query = select(Resume).where(Resume.updated_at >= cutoff)
        if profile_id is not None:
            resume_query = resume_query.where(
                (Resume.source_profile_id == profile_id) | (Resume.source_profile_id.is_(None))
            )
        resumes = (await db.execute(resume_query.order_by(Resume.updated_at.desc()).limit(6))).scalars().all()
        recent_changes.extend(
            DailyChange(
                kind="resume",
                ref=f"resume:{row.id}",
                title=_safe(row.title, 220),
                changed_at=_iso(row.updated_at),
                revision=int(row.workspace_revision or 0),
            ).model_dump()
            for row in resumes
        )

        observations = (
            await db.execute(
                select(LearningObservation)
                .where(LearningObservation.status == "active")
                .where(
                    LearningObservation.observation_type.in_(
                        ("interview_completed", "interview_debrief_candidate")
                    )
                )
                .where(LearningObservation.observed_at >= cutoff)
                .order_by(LearningObservation.observed_at.desc())
                .limit(6)
            )
        ).scalars().all()
        review_status_by_observation: dict[int, str] = {}
        observation_ids = [int(observation.id) for observation in observations]
        if observation_ids:
            proposal_rows = (
                await db.execute(
                    select(EvidenceLink.observation_id, MemoryProposal.status)
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
                    .order_by(MemoryProposal.created_at.desc())
                )
            ).all()
            for observation_id, status in proposal_rows:
                review_status_by_observation.setdefault(int(observation_id), str(status))
        learning: list[dict[str, Any]] = []
        for observation in observations:
            content = observation.content_json if isinstance(observation.content_json, dict) else {}
            learning_type = str(content.get("candidate_type") or "interview_assessment")
            if learning_type not in {"interview_assessment", "potential_strength", "weak_area"}:
                learning_type = "interview_assessment"
            raw_review_status = review_status_by_observation.get(int(observation.id), "unreviewed")
            review_status = raw_review_status if raw_review_status in {
                "accepted", "pending", "deferred", "rejected"
            } else "inactive" if raw_review_status != "unreviewed" else "unreviewed"
            focuses = content.get("focuses") if isinstance(content.get("focuses"), list) else []
            weak_areas = [
                _safe(item.get("capability") or item.get("training_priority"), 120)
                for item in focuses
                if isinstance(item, dict) and (item.get("capability") or item.get("training_priority"))
            ][:6]
            if review_status != "accepted":
                weak_areas = []
            elif not weak_areas and learning_type == "weak_area" and content.get("summary"):
                weak_areas = [_safe(content.get("summary"), 120)]
            learning.append(
                DailyLearning(
                    ref=f"learning-observation:{observation.id}",
                    summary=_safe(content.get("summary"), 500),
                    learning_type=learning_type,
                    review_status=review_status,
                    weak_areas=weak_areas,
                    observed_at=_iso(observation.observed_at),
                ).model_dump()
            )

        dismissed_rows = (
            await db.execute(
                select(AutomationInboxItem)
                .where(AutomationInboxItem.status == "dismissed")
                .where(AutomationInboxItem.target_type == "career_brief")
                .where(AutomationInboxItem.updated_at >= cutoff)
                .order_by(AutomationInboxItem.updated_at.desc())
                .limit(30)
            )
        ).scalars().all()

    ignored_map: dict[str, dict[str, Any]] = {}
    for row in dismissed_rows:
        payload = row.payload_json if isinstance(row.payload_json, dict) else {}
        briefing = payload.get("briefing") if isinstance(payload.get("briefing"), dict) else {}
        for action in briefing.get("actions") or []:
            if not isinstance(action, dict):
                continue
            key = str(action.get("dedupe_key") or "").strip()
            if not key:
                continue
            entry = ignored_map.setdefault(
                key,
                {
                    "dedupe_key": key,
                    "objective": _safe(action.get("objective"), 300),
                    "why_now": _safe(action.get("why_now"), 500),
                    "fingerprint": action_fingerprint(action),
                    "dismissals": 0,
                    "last_ignored_at": _iso(row.updated_at),
                },
            )
            entry["dismissals"] += 1
            if _iso(row.updated_at) > entry["last_ignored_at"]:
                entry["last_ignored_at"] = _iso(row.updated_at)

    from app.services.career_director import (
        _build_pipeline_digest,
        _build_resume_state,
    )

    async with async_session() as db:
        resume_state = await _build_resume_state(db, profile_id)
        pipeline_digest = await _build_pipeline_digest(db)
        profile_row = await db.get(Profile, int(profile_id)) if profile_id else None
        base_info = profile_row.base_info_json if profile_row and isinstance(profile_row.base_info_json, dict) else {}
        stage_raw = base_info.get("career_stage_correction")
        career_stage = stage_raw if isinstance(stage_raw, dict) else None
        strategy_pack = ""
        if isinstance(career_stage, dict):
            strategy_pack = "campus_search.v1" if career_stage.get("track") == "campus" else "experienced_search.v1"

    return DailyCareerContext(
        review_date=today,
        career_stage=career_stage,
        strategy_pack=strategy_pack,
        pipeline=pipeline[:12],
        follow_ups_due=follow_ups,
        upcoming_interviews=interviews,
        pending_proposals=proposals[:12],
        recent_changes=recent_changes[:12],
        interview_learning=learning,
        ignored_suggestions=[
            IgnoredSuggestion.model_validate(item).model_dump()
            for item in ignored_map.values()
        ][:20],
        resume=DailyResumeState(
            current_resume_id=resume_state.current_resume_id,
            current_version_number=resume_state.current_version_number or 0,
            workspace_revision=resume_state.workspace_revision,
            material_change_summary=resume_state.material_change_summary,
            jobs_using_older_resume=[
                ref.model_dump(mode="json") for ref in resume_state.jobs_using_older_resume
            ],
        ),
        role_family_funnel=[
            DailyRoleFamilyFunnel.model_validate(row.model_dump())
            for row in pipeline_digest.role_family_funnel
        ],
    ).model_dump(mode="json", by_alias=True)


def suppress_repeatedly_ignored_actions(
    briefing: dict[str, Any], daily_context: dict[str, Any]
) -> dict[str, Any]:
    """Fail closed against exact suggestions dismissed on multiple recent days."""

    ignored = {
        str(item.get("dedupe_key"))
        for item in daily_context.get("ignored_suggestions") or []
        if isinstance(item, dict) and int(item.get("dismissals") or 0) >= 2
    }
    ignored_fingerprints = {
        str(item.get("fingerprint"))
        for item in daily_context.get("ignored_suggestions") or []
        if isinstance(item, dict) and int(item.get("dismissals") or 0) >= 2 and item.get("fingerprint")
    }
    if not ignored and not ignored_fingerprints:
        return briefing
    result = dict(briefing)
    result["actions"] = [
        action
        for action in briefing.get("actions") or []
        if not isinstance(action, dict)
        or (
            action.get("dedupe_key") not in ignored
            and action_fingerprint(action) not in ignored_fingerprints
        )
    ]
    return result
