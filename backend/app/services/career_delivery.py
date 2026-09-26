"""Materialize and resolve trustworthy Career Director deliveries.

A delivery is only "ready" when a real CareerArtifact (or an existing
ResumeOptimizationProposal) is persisted, its scope still exists, its
eligibility still holds, and the canonical sources fingerprinted at
generation time have not drifted.  Nothing here invents output: missing or
stale artifacts resolve to honest states, and no code path sends anything.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any

from sqlalchemy import and_, select

from app.database import async_session
from app.models.models import (
    Application,
    ApplicationAttempt,
    ApplicationRecord,
    ApplicationStageEvent,
    CalendarEvent,
    CareerSource,
    EvidenceLink,
    Job,
    LearningObservation,
    MemoryProposal,
    Profile,
    ProfileSection,
    Resume,
    ResumeOptimizationProposal,
    ResumeVersion,
)
from app.services.career_artifacts import career_artifact_store
from app.services.security_redaction import redact_sensitive_text

# ---------------------------------------------------------------------------
# Contract constants
# ---------------------------------------------------------------------------

DELIVERY_STATES = frozenset(
    {"suggested", "preparing", "ready", "blocked", "failed", "stale"}
)

# Frontend artifact_type -> CareerArtifact artifact_type (None = DB proposal).
DELIVERY_ARTIFACT_TYPES: dict[str, str | None] = {
    "tailored_resume_proposal": None,
    "interview_prep": "interview_prep",
    "follow_up_draft": "follow_up_draft",
    "reengagement_candidate": "reengagement_candidate",
}

_APPLIED_STATUSES = {"submitted", "applied", "已投递"}
_RESPONDED_STATUSES = {"responded", "need_action", "已回复", "待处理"}
_INTERVIEW_STATUSES = {"interview", "interviewing", "面试", "面试中"}
_TERMINAL_STATUSES = {"rejected", "offer", "withdrawn", "已拒绝", "已录取", "已撤回"}
_TERMINAL_ATTEMPT_STAGES = {"rejected", "offer", "withdrawn"}
_ELIGIBLE_ATTEMPT_STAGES = {
    "applied",
    "written_test",
    "assessment",
    "interview_1",
    "interview_2",
    "interview_hr",
}
_FOLLOW_UP_MAX_ATTEMPTS = 2
_MAX_PRACTICE_QUESTIONS = 8
_MAX_ANSWER_CHARS = 20_000
_TASK_CANCELLED = {"cancelled"}
_TASK_FAILED = {"failed", "blocked"}
_TASK_LIVE = {"queued", "running", "waiting_for_approval"}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _now_naive() -> datetime:
    return datetime.now().astimezone().replace(tzinfo=None)


def _clean(value: Any, limit: int = 300) -> str:
    return redact_sensitive_text(str(value or "").strip(), max_length=limit).strip()


def _iso(value: Any) -> str:
    return value.isoformat() if isinstance(value, datetime) else str(value or "")[:50]


def _as_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date()
    except ValueError:
        try:
            return date.fromisoformat(text[:10])
        except ValueError:
            return None


def _int_or_none(value: Any) -> int | None:
    try:
        result = int(value)
    except (TypeError, ValueError):
        return None
    return result if result > 0 else None


def _digest(value: Any, limit: int = 60_000) -> str:
    try:
        encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    except (TypeError, ValueError):
        encoded = str(value)
    return hashlib.sha256(encoded[:limit].encode("utf-8")).hexdigest()


def _hash_fields(**fields: Any) -> str:
    return _digest(fields)


# ---------------------------------------------------------------------------
# Source fingerprints
# ---------------------------------------------------------------------------




async def _profile_fingerprint(db: Any, profile_id: int | None) -> str | None:
    profile: Profile | None = None
    if profile_id is not None:
        profile = await db.get(Profile, int(profile_id))
    if profile is None:
        profile = (
            await db.execute(select(Profile).where(Profile.is_default.is_(True)).limit(1))
        ).scalar_one_or_none()
    if profile is None:
        profile = (
            await db.execute(select(Profile).order_by(Profile.id.asc()).limit(1))
        ).scalar_one_or_none()
    if profile is None:
        return None
    sections = (
        await db.execute(
            select(
                ProfileSection.id,
                ProfileSection.section_type,
                ProfileSection.title,
                ProfileSection.content_json,
                ProfileSection.status,
                ProfileSection.updated_at,
            )
            .where(ProfileSection.profile_id == profile.id)
            .where(ProfileSection.status == "active")
            .order_by(ProfileSection.id.asc())
            .limit(200)
        )
    ).all()
    observations = (
        await db.execute(
            select(LearningObservation.id, LearningObservation.content_hash)
            .join(CareerSource, CareerSource.id == LearningObservation.source_id)
            .where(LearningObservation.status == "active")
            .where(CareerSource.status == "active")
            .order_by(LearningObservation.observed_at.desc())
            .limit(30)
        )
    ).all()
    observation_ids = [int(row.id) for row in observations]
    accepted_ids: set[int] = set()
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
                .where(MemoryProposal.status == "accepted")
            )
        ).all()
        accepted_ids = {int(observation_id) for observation_id, _status in proposal_rows}
    return _hash_fields(
        profile_id=int(profile.id),
        updated_at=_iso(profile.updated_at),
        base_info_digest=_digest(profile.base_info_json or {}, 40_000),
        sections=[
            (
                int(row.id),
                row.section_type,
                row.title,
                _digest(row.content_json or {}, 20_000),
                row.status,
                _iso(row.updated_at),
            )
            for row in sections
        ],
        accepted_learning=[
            (int(row.id), str(row.content_hash or ""))
            for row in observations
            if int(row.id) in accepted_ids
        ],
    )


async def _job_fingerprint(db: Any, job_id: int) -> str | None:
    job = await db.get(Job, int(job_id))
    if job is None:
        return None
    return _hash_fields(
        job_id=int(job.id),
        title=job.title,
        company=job.company,
        location=job.location,
        salary_text=job.salary_text,
        education=job.education,
        experience=job.experience,
        job_type=job.job_type,
        is_campus=bool(job.is_campus),
        summary_digest=_digest(job.summary, 30_000),
        raw_digest=_digest(job.raw_description, 60_000),
        keywords=sorted(str(item) for item in (job.keywords or []) if str(item).strip()),
        triage_status=job.triage_status,
    )


async def _calendar_fingerprint(db: Any, event_id: int) -> str | None:
    event = await db.get(CalendarEvent, int(event_id))
    if event is None:
        return None
    return _hash_fields(
        calendar_event_id=int(event.id),
        event_type=event.event_type,
        title=event.title,
        start_time=_iso(event.start_time),
        end_time=_iso(event.end_time),
        location=event.location,
        related_job_id=event.related_job_id,
    )


async def _resume_fingerprint(db: Any, resume_id: int) -> str | None:
    resume = await db.get(Resume, int(resume_id))
    if resume is None:
        return None
    return _hash_fields(
        resume_id=int(resume.id),
        title=resume.title,
        current_version_id=resume.current_version_id,
        workspace_revision=int(resume.workspace_revision or 0),
        updated_at=_iso(resume.updated_at),
    )


async def _resume_attempts_fingerprint(db: Any, resume_id: int) -> str | None:
    resume = await db.get(Resume, int(resume_id))
    if resume is None:
        return None
    attempts = (
        await db.execute(
            select(ApplicationAttempt)
            .where(ApplicationAttempt.resume_id == resume.id)
            .order_by(ApplicationAttempt.created_at.desc(), ApplicationAttempt.id.desc())
            .limit(100)
        )
    ).scalars().all()
    attempt_ids = [int(attempt.id) for attempt in attempts]
    stage_rows: list[tuple[Any, ...]] = []
    if attempt_ids:
        stage_rows = list(
            (
                await db.execute(
                    select(
                        ApplicationStageEvent.application_attempt_id,
                        ApplicationStageEvent.stage,
                        ApplicationStageEvent.occurred_at,
                    )
                    .where(ApplicationStageEvent.application_attempt_id.in_(attempt_ids))
                    .order_by(
                        ApplicationStageEvent.occurred_at.asc(),
                        ApplicationStageEvent.id.asc(),
                    )
                )
            ).all()
        )
    last_stage: dict[int, str] = {}
    for attempt_id, stage, _occurred_at in stage_rows:
        last_stage[int(attempt_id)] = str(stage)
    return _hash_fields(
        resume_id=int(resume.id),
        attempts=[
            (
                int(attempt.id),
                int(attempt.job_id),
                int(attempt.resume_version_id or 0),
                last_stage.get(int(attempt.id), str(attempt.status or "")),
                _iso(attempt.created_at),
            )
            for attempt in attempts
        ],
    )


async def _attempt_fingerprint(db: Any, attempt_id: int) -> str | None:
    attempt = await db.get(ApplicationAttempt, int(attempt_id))
    if attempt is None:
        return None
    stage = await _attempt_stage(db, attempt)
    return _hash_fields(
        attempt_id=int(attempt.id),
        job_id=int(attempt.job_id),
        resume_id=int(attempt.resume_id or 0),
        resume_version_id=int(attempt.resume_version_id or 0),
        status=str(attempt.status or ""),
        stage=stage,
    )


async def _proposal_fingerprint(db: Any, proposal_id: str) -> str | None:
    proposal = await db.get(ResumeOptimizationProposal, str(proposal_id))
    if proposal is None:
        return None
    return _hash_fields(
        proposal_id=str(proposal.proposal_id),
        job_id=int(proposal.job_id),
        status=str(proposal.status or ""),
        source_snapshot_hash=proposal.source_snapshot_hash,
        workspace_snapshot_hash=proposal.workspace_snapshot_hash,
        updated_at=_iso(proposal.updated_at),
        reviewed_at=_iso(proposal.reviewed_at),
    )


async def _application_fingerprint(
    db: Any, application_type: str, application_id: int
) -> str | None:
    state = await _follow_up_state(db, application_type, application_id)
    if not state.get("exists"):
        return None
    return _hash_fields(
        application_type=application_type,
        application_id=int(application_id),
        job_id=state.get("job_id"),
        status=state.get("status_normalized"),
        response_observed=state.get("response_observed"),
        urgency=state.get("urgency"),
        follow_up_count=state.get("follow_up_count"),
        next_follow_up_date=state.get("next_follow_up_date"),
        applied_at=state.get("applied_at"),
    )


async def _fingerprint_entity(db: Any, key: str, scope: dict[str, Any]) -> str | None:
    """Compute one entity fingerprint for a scope key like ``job:12``."""
    if key == "profile":
        return await _profile_fingerprint(db, _int_or_none(scope.get("profile_id")))
    if key.startswith("job:"):
        return await _job_fingerprint(db, int(key.split(":", 1)[1]))
    if key.startswith("calendar_event:"):
        return await _calendar_fingerprint(db, int(key.split(":", 1)[1]))
    if key.startswith("resume_attempts:"):
        return await _resume_attempts_fingerprint(db, int(key.split(":", 1)[1]))
    if key.startswith("resume:"):
        return await _resume_fingerprint(db, int(key.split(":", 1)[1]))
    if key.startswith("attempt:"):
        return await _attempt_fingerprint(db, int(key.split(":", 1)[1]))
    if key.startswith("proposal:"):
        return await _proposal_fingerprint(db, key.split(":", 1)[1])
    if key.startswith("application_record:"):
        return await _application_fingerprint(db, "application_record", int(key.split(":", 1)[1]))
    if key.startswith("application:"):
        return await _application_fingerprint(db, "application", int(key.split(":", 1)[1]))
    return None


async def _fingerprint_scope(
    db: Any, scope: dict[str, Any]
) -> tuple[dict[str, str], list[str]]:
    """Fingerprint every entity in a delivery scope; bounded reads only."""
    keys = scope_fingerprint_keys(scope)
    fingerprints: dict[str, str] = {}
    missing: list[str] = []
    for key in keys:
        value = await _fingerprint_entity(db, key, scope)
        if value is None:
            missing.append(key)
        else:
            fingerprints[key] = value
    return fingerprints, missing


def _merge_provenance_fingerprints(
    fingerprints: dict[str, str],
    captured: dict[str, str],
    scope_keys: list[str],
) -> tuple[dict[str, str], str]:
    """Prefer pre-generation fingerprints for in-scope entities only."""
    merged = dict(fingerprints)
    phase = "materialization"
    scope_set = set(scope_keys)
    for key, value in captured.items():
        if key in scope_set:
            merged[key] = str(value)
    if any(key in scope_set for key in captured):
        phase = "pre_generation"
    return merged, phase


def scope_fingerprint_keys(scope: dict[str, Any]) -> list[str]:
    """Canonical entity-key list for a delivery scope."""
    keys: list[str] = []
    if scope.get("include_profile"):
        keys.append("profile")
    job_id = _int_or_none(scope.get("job_id"))
    if job_id:
        keys.append(f"job:{job_id}")
    application_type = str(scope.get("application_type") or "").strip()
    application_id = _int_or_none(scope.get("application_id"))
    if application_id and application_type in {"application", "application_record"}:
        keys.append(f"{application_type}:{application_id}")
    calendar_event_id = _int_or_none(scope.get("calendar_event_id"))
    if calendar_event_id:
        keys.append(f"calendar_event:{calendar_event_id}")
    attempt_id = _int_or_none(scope.get("application_attempt_id"))
    if attempt_id:
        keys.append(f"attempt:{attempt_id}")
    resume_id = _int_or_none(scope.get("resume_id"))
    if resume_id:
        keys.append(f"resume:{resume_id}")
        if scope.get("include_resume_attempts"):
            keys.append(f"resume_attempts:{resume_id}")
    proposal_id = str(scope.get("proposal_id") or "").strip()
    if proposal_id:
        keys.append(f"proposal:{proposal_id}")
    return keys


def _combine_fingerprints(fingerprints: dict[str, str]) -> str:
    ordered = {key: fingerprints[key] for key in sorted(fingerprints)}
    return _digest(ordered)


async def career_source_fingerprint(
    job_id: int | None = None,
    application_id: int | None = None,
    calendar_event_id: int | None = None,
    *,
    application_type: str | None = None,
    resume_id: int | None = None,
    profile_id: int | None = None,
) -> str:
    """Fingerprint the canonical sources a delivery was generated from.

    Always folds in the Profile + accepted-learning evidence digest so that
    changed evidence invalidates prepared artifacts; missing entities fold in
    as ``missing:<key>`` so callers cannot compare equal to a live state.
    """
    scope: dict[str, Any] = {
        "include_profile": True,
        "job_id": job_id,
        "calendar_event_id": calendar_event_id,
        "resume_id": resume_id,
        "profile_id": profile_id,
    }
    if application_id is not None:
        resolved_type = str(application_type or "").strip()
        if resolved_type not in {"application", "application_record"}:
            resolved_type = "application"
        scope["application_type"] = resolved_type
        scope["application_id"] = application_id
    async with async_session() as db:
        fingerprints, missing = await _fingerprint_scope(db, scope)
    for key in missing:
        fingerprints[f"missing:{key}"] = "absent"
    return _combine_fingerprints(fingerprints)


async def capture_preparation_provenance(task_input: dict[str, Any]) -> dict[str, Any]:
    """Capture canonical source fingerprints BEFORE a director model run.

    Main calls this with the CareerTask input payload and stores the result on
    ``task["preparation_provenance"]`` so deliveries persisted later compare
    against the state the model actually saw.  Scopes only known after the run
    (e.g. a follow-up application id the model picks) are fingerprinted during
    materialization and marked ``capture_phase="materialization"``.
    """
    payload = task_input if isinstance(task_input, dict) else {}
    scope: dict[str, Any] = {
        "include_profile": True,
        "job_id": _int_or_none(payload.get("job_id")),
        "calendar_event_id": _int_or_none(payload.get("calendar_event_id")),
        "profile_id": _int_or_none(payload.get("profile_id")),
        "resume_id": _int_or_none(payload.get("resume_id")),
        "include_resume_attempts": str(payload.get("event_type") or "")
        .strip()
        .upper()
        == "RESUME_UPDATED",
    }
    async with async_session() as db:
        fingerprints, missing = await _fingerprint_scope(db, scope)
    for key in missing:
        fingerprints[f"missing:{key}"] = "absent"
    return {
        "captured_at": _utc_now(),
        "phase": "pre_generation",
        "fingerprints": fingerprints,
    }


# ---------------------------------------------------------------------------
# Follow-up eligibility (canonical cadence, observed response, no sends)
# ---------------------------------------------------------------------------


async def _attempt_stage(db: Any, attempt: ApplicationAttempt) -> str:
    stage_row = (
        await db.execute(
            select(ApplicationStageEvent.stage)
            .where(ApplicationStageEvent.application_attempt_id == attempt.id)
            .order_by(
                ApplicationStageEvent.occurred_at.desc(),
                ApplicationStageEvent.id.desc(),
            )
            .limit(1)
        )
    ).first()
    raw = str(stage_row[0]) if stage_row else str(attempt.status or "")
    normalized = raw.casefold()
    return {
        "submitted": "applied",
        "responded": "applied",
        "interview": "interview_1",
    }.get(normalized, normalized)


async def _follow_up_state(
    db: Any, application_type: str, application_id: int
) -> dict[str, Any]:
    """Read one canonical application's cadence state with bounded queries."""
    from app.services.application_followups import (
        build_follow_up_dashboard,
        follow_up_store,
    )

    entry_row: dict[str, Any]
    if application_type == "application_record":
        record = await db.get(ApplicationRecord, int(application_id))
        if record is None:
            return {"exists": False}
        custom = record.custom_values if isinstance(record.custom_values, dict) else {}
        status = str(custom.get("apply_status") or "待投递").strip()
        entry_row = {
            "application_type": "application_record",
            "application_id": int(record.id),
            "job_id": record.job_ref_id,
            "status": status,
            "follow_up_date": custom.get("follow_up_date"),
            "applied_at": custom.get("applied_at") or custom.get("application_date"),
            "created_at": _iso(record.created_at),
        }
        company = record.company_name or ""
        role = record.job_title or ""
    else:
        application = await db.get(Application, int(application_id))
        if application is None:
            return {"exists": False}
        status = str(application.status or "").strip()
        entry_row = {
            "application_type": "application",
            "application_id": int(application.id),
            "job_id": application.job_id,
            "status": status,
            "follow_up_date": None,
            "applied_at": _as_date(application.submitted_at) or _as_date(
                application.created_at
            ),
            "created_at": _iso(application.created_at),
        }
        company = ""
        role = ""

    events = follow_up_store.list(
        application_type=application_type, application_id=int(application_id)
    )
    normalized = entry_row["status"].casefold()
    response_observed = normalized in (
        _RESPONDED_STATUSES | _INTERVIEW_STATUSES | _TERMINAL_STATUSES
    )
    dashboard = build_follow_up_dashboard([entry_row], events)
    entry = (dashboard.get("entries") or [None])[0]
    urgency = str(entry.get("urgency") or "") if entry else ""
    eligible = (
        entry is not None
        and urgency == "overdue"
        and not response_observed
        and int(entry.get("follow_up_count") or 0) < _FOLLOW_UP_MAX_ATTEMPTS
    )
    reason_code = ""
    if not entry:
        reason_code = "response_observed" if response_observed else "follow_up_not_due"
    elif response_observed:
        reason_code = "response_observed"
    elif urgency == "cold" or int(entry.get("follow_up_count") or 0) >= _FOLLOW_UP_MAX_ATTEMPTS:
        reason_code = "follow_up_exhausted"
    elif urgency != "overdue":
        reason_code = "follow_up_not_due"
    return {
        "exists": True,
        "application_type": application_type,
        "application_id": int(application_id),
        "job_id": entry_row.get("job_id"),
        "company": company,
        "role": role,
        "status": entry_row["status"],
        "status_normalized": normalized,
        "response_observed": response_observed,
        "urgency": urgency,
        "follow_up_count": int(entry.get("follow_up_count") or 0) if entry else len(events),
        "next_follow_up_date": str(entry.get("next_follow_up_date") or "") if entry else "",
        "days_until_follow_up": int(entry.get("days_until_follow_up") or 0) if entry else 0,
        "applied_at": (
            entry_row["applied_at"].isoformat()
            if isinstance(entry_row.get("applied_at"), date)
            else str(entry_row.get("applied_at") or "")[:10]
        ),
        "eligible": eligible,
        "reason_code": reason_code,
    }


async def _attempt_context(
    db: Any, resume_id: int, job_id: int
) -> dict[str, Any]:
    """Resolve the newest application attempt for a resume/job pair."""
    attempt = (
        await db.execute(
            select(ApplicationAttempt)
            .where(ApplicationAttempt.resume_id == int(resume_id))
            .where(ApplicationAttempt.job_id == int(job_id))
            .order_by(ApplicationAttempt.created_at.desc(), ApplicationAttempt.id.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if attempt is None:
        return {"exists": False}
    resume = await db.get(Resume, int(resume_id))
    current_version_id = int(resume.current_version_id or 0) if resume else 0
    version_numbers: dict[int, int] = {}
    for version_id in {int(attempt.resume_version_id or 0), current_version_id}:
        if not version_id:
            continue
        version = await db.get(ResumeVersion, int(version_id))
        if version is not None:
            version_numbers[version_id] = int(version.version_number)
    stage = await _attempt_stage(db, attempt)
    created_at = attempt.created_at
    days_since = (
        max(0, (_now_naive() - created_at).days) if isinstance(created_at, datetime) else 0
    )
    return {
        "exists": True,
        "application_attempt_id": int(attempt.id),
        "applied_resume_version": version_numbers.get(
            int(attempt.resume_version_id or 0), 0
        ),
        "applied_resume_version_id": int(attempt.resume_version_id or 0),
        "current_resume_version": version_numbers.get(current_version_id, 0),
        "current_resume_version_id": current_version_id,
        "current_stage": stage,
        "days_since_application": days_since,
    }


# ---------------------------------------------------------------------------
# Delivery specs
# ---------------------------------------------------------------------------


@dataclass
class _Spec:
    artifact_type: str  # frontend delivery artifact_type
    title: str
    content: str = ""
    action_key: str = ""
    evidence_refs: list[str] = field(default_factory=list)
    scope: dict[str, Any] = field(default_factory=dict)
    practice_plan: dict[str, Any] | None = None
    candidate: dict[str, Any] | None = None  # reengagement plan item
    metadata: dict[str, Any] = field(default_factory=dict)
    blocked_reason: str = ""
    blocked_code: str = ""

    @property
    def store_type(self) -> str | None:
        return DELIVERY_ARTIFACT_TYPES.get(self.artifact_type)

    @property
    def idempotency_key(self) -> str:
        scope = self.scope
        secondary = (
            _int_or_none(scope.get("calendar_event_id"))
            or _int_or_none(scope.get("application_id"))
            or _int_or_none(scope.get("application_attempt_id"))
            or _int_or_none(scope.get("resume_id"))
            or 0
        )
        job_id = _int_or_none(scope.get("job_id")) or 0
        proposal = str(scope.get("proposal_id") or "")
        if proposal:
            secondary = 0
        return (
            f"career-director:{self.task_id}:{self.artifact_type}:"
            f"{job_id}:{secondary}:{proposal}"
        )

    task_id: str = ""


def _task_briefing(task: dict[str, Any]) -> dict[str, Any]:
    result = task.get("result") if isinstance(task.get("result"), dict) else {}
    briefing = result.get("briefing")
    if isinstance(briefing, dict) and briefing:
        return briefing
    checkpoint = (
        task.get("checkpoint") if isinstance(task.get("checkpoint"), dict) else {}
    )
    briefing = checkpoint.get("briefing")
    return briefing if isinstance(briefing, dict) else {}


def _source_contexts(task: dict[str, Any]) -> dict[str, Any]:
    contexts = task.get("source_contexts")
    return contexts if isinstance(contexts, dict) else {}


def _reengagement_context(task: dict[str, Any]) -> dict[str, Any]:
    contexts = _source_contexts(task)
    for key in ("resume_update", "reengagement", "resume_reengagement"):
        value = contexts.get(key)
        if isinstance(value, dict) and isinstance(value.get("candidates"), list):
            return value
    if isinstance(contexts.get("candidates"), list):
        return contexts
    return {}


def _normalize_practice_plan(
    raw: Any, briefing: dict[str, Any]
) -> dict[str, Any] | None:
    questions: list[dict[str, Any]] = []
    duration = 0
    if isinstance(raw, dict):
        duration = _int_or_none(raw.get("duration_minutes")) or 0
        for item in raw.get("questions") or []:
            if not isinstance(item, dict):
                continue
            question = _clean(item.get("question"), 500)
            if not question:
                continue
            questions.append(
                {
                    "question": question,
                    "focus": _clean(item.get("focus"), 240),
                    "minutes": _int_or_none(item.get("minutes")) or 5,
                }
            )
            if len(questions) >= _MAX_PRACTICE_QUESTIONS:
                break
    if not questions:
        lifecycle = (
            briefing.get("interview_lifecycle")
            if isinstance(briefing.get("interview_lifecycle"), dict)
            else {}
        )
        focus_areas = [
            _clean(area, 240)
            for area in (lifecycle.get("focus_areas") or [])
            if isinstance(area, str) and str(area).strip()
        ]
        for index, item in enumerate(lifecycle.get("practice_questions") or []):
            question = _clean(item, 500)
            if not question:
                continue
            questions.append(
                {
                    "question": question,
                    "focus": focus_areas[index] if index < len(focus_areas) else "",
                    "minutes": 5,
                }
            )
            if len(questions) >= _MAX_PRACTICE_QUESTIONS:
                break
    if not questions:
        return None
    if duration <= 0:
        duration = sum(int(item["minutes"]) for item in questions)
    return {"duration_minutes": min(duration, 240), "questions": questions}


def _collect_specs(task: dict[str, Any], briefing: dict[str, Any]) -> list[_Spec]:
    """Deterministically derive expected deliveries; never trusts prose."""
    task_id = str(task.get("task_id") or "")
    specs: list[_Spec] = []
    seen_keys: set[str] = set()

    raw_items = briefing.get("prepared_artifacts")
    if isinstance(raw_items, list):
        for item in raw_items[:8]:
            if not isinstance(item, dict):
                continue
            artifact_type = str(item.get("artifact_type") or "").strip()
            spec = _Spec(
                artifact_type=artifact_type,
                title=_clean(item.get("title"), 200),
                content=_clean(item.get("content_markdown") or item.get("content"), 60_000),
                action_key=_clean(item.get("action_key"), 160),
                evidence_refs=[
                    _clean(ref, 180)
                    for ref in (item.get("evidence_refs") or [])[:12]
                    if str(ref or "").strip()
                ],
                task_id=task_id,
            )
            scope = spec.scope
            scope["include_profile"] = True
            scope["job_id"] = _int_or_none(item.get("job_id"))
            scope["calendar_event_id"] = _int_or_none(item.get("calendar_event_id"))
            record_id = _int_or_none(item.get("application_record_id"))
            if record_id:
                scope["application_type"] = "application_record"
                scope["application_id"] = record_id
            else:
                app_type = str(item.get("application_type") or "application").strip()
                scope["application_type"] = (
                    app_type if app_type in {"application", "application_record"} else "application"
                )
                scope["application_id"] = _int_or_none(item.get("application_id"))
            if artifact_type not in DELIVERY_ARTIFACT_TYPES:
                spec.blocked_reason = "不支持的材料类型"
                spec.blocked_code = "unsupported_artifact_type"
            elif artifact_type == "interview_prep":
                if not scope.get("calendar_event_id"):
                    spec.blocked_reason = "面试准备缺少关联的日历面试"
                    spec.blocked_code = "missing_scope"
                else:
                    spec.practice_plan = _normalize_practice_plan(
                        item.get("practice_plan"), briefing
                    )
            elif artifact_type == "follow_up_draft":
                if not scope.get("application_id"):
                    spec.blocked_reason = "跟进草稿缺少关联的投递记录"
                    spec.blocked_code = "missing_scope"
            if spec.idempotency_key in seen_keys:
                continue
            seen_keys.add(spec.idempotency_key)
            specs.append(spec)

    # Reengagement candidates from the existing resume_update plan.
    resume_update = (
        briefing.get("resume_update")
        if isinstance(briefing.get("resume_update"), dict)
        else {}
    )
    if resume_update:
        resume_id = _int_or_none(
            resume_update.get("resume_id")
            or (task.get("input") or {}).get("resume_id")
            or task.get("target_id")
        )
        context = _reengagement_context(task)
        context_candidates = {
            _int_or_none(candidate.get("job_id")): candidate
            for candidate in context.get("candidates") or []
            if isinstance(candidate, dict)
        }
        evidence_changes = [
            {
                "ref": _clean(entry.get("ref"), 60),
                "text": _clean(entry.get("text"), 200),
            }
            for entry in context.get("added_evidence") or []
            if isinstance(entry, dict)
        ][:8]
        for item in resume_update.get("candidates") or []:
            if not isinstance(item, dict):
                continue
            if item.get("worth_reengaging") is not True:
                continue
            if str(item.get("urgency") or "") == "skip":
                continue
            job_id = _int_or_none(item.get("job_id"))
            if not job_id:
                continue
            spec = _Spec(
                artifact_type="reengagement_candidate",
                title="",
                action_key=_clean(item.get("action_key"), 160),
                evidence_refs=[
                    _clean(ref, 180)
                    for ref in (item.get("evidence_refs") or [])[:8]
                    if str(ref or "").strip()
                ],
                task_id=task_id,
                candidate=item,
            )
            spec.scope.update(
                {
                    "job_id": job_id,
                    "resume_id": resume_id,
                    "include_resume_attempts": True,
                }
            )
            context_candidate = context_candidates.get(job_id)
            if context_candidate:
                spec.scope["application_attempt_id"] = _int_or_none(
                    context_candidate.get("application_attempt_id")
                )
            spec.metadata["context_candidate"] = context_candidate or {}
            spec.metadata["resume_update_summary"] = _clean(
                resume_update.get("summary"), 800
            )
            spec.metadata["added_evidence_summary"] = _clean(
                resume_update.get("added_evidence_summary"), 500
            )
            spec.metadata["evidence_changes"] = evidence_changes
            if spec.idempotency_key in seen_keys:
                continue
            seen_keys.add(spec.idempotency_key)
            specs.append(spec)

    # Resume proposal persisted through the dedicated pipeline.
    result = task.get("result") if isinstance(task.get("result"), dict) else {}
    proposal = (
        result.get("resume_proposal")
        if isinstance(result.get("resume_proposal"), dict)
        else {}
    )
    proposal_id = str(proposal.get("proposal_id") or "").strip()
    if proposal_id:
        spec = _Spec(
            artifact_type="tailored_resume_proposal",
            title=_clean(proposal.get("title") or "岗位简历提案", 200),
            task_id=task_id,
        )
        spec.scope.update(
            {
                "proposal_id": proposal_id,
                "include_profile": True,
                "job_id": _int_or_none(proposal.get("job_id"))
                or _int_or_none((task.get("input") or {}).get("job_id")),
            }
        )
        if spec.idempotency_key not in seen_keys:
            seen_keys.add(spec.idempotency_key)
            specs.append(spec)
    return specs


# ---------------------------------------------------------------------------
# Scope validation + delivery assembly
# ---------------------------------------------------------------------------


async def _validate_scope(
    db: Any, spec: _Spec, *, for_persist: bool
) -> tuple[str, str, dict[str, Any]]:
    """Return ("", "", extras) or (reason, reason_code, extras)."""
    scope = spec.scope
    job_id = _int_or_none(scope.get("job_id"))
    if spec.artifact_type == "interview_prep":
        event_id = _int_or_none(scope.get("calendar_event_id"))
        event = await db.get(CalendarEvent, int(event_id or 0))
        if event is None or event.event_type != "interview":
            return "关联的日历面试不存在", "scope_deleted", {"starts_in_past": False}
        event_job_id = int(event.related_job_id) if event.related_job_id else None
        if job_id and event_job_id and job_id != event_job_id:
            return "面试准备的岗位与日历面试不一致", "scope_mismatch", {}
        if event_job_id and not job_id:
            scope["job_id"] = event_job_id
        starts = event.start_time
        starts_in_past = isinstance(starts, datetime) and starts <= _now_naive()
        if for_persist and starts_in_past:
            return "该面试时间已过", "interview_passed", {"starts_in_past": True}
        return "", "", {"starts_in_past": starts_in_past}
    if spec.artifact_type == "follow_up_draft":
        state = await _follow_up_state(
            db,
            str(scope.get("application_type") or "application"),
            int(scope.get("application_id") or 0),
        )
        if not state.get("exists"):
            return "关联的投递记录已不存在", "scope_deleted", {}
        if job_id and state.get("job_id") and int(state["job_id"]) != job_id:
            return "跟进草稿的投递记录与岗位不一致", "scope_mismatch", {}
        if state.get("job_id") and not job_id:
            scope["job_id"] = _int_or_none(state.get("job_id"))
        if not state.get("eligible"):
            reasons = {
                "response_observed": "该申请已有回复或进展，跟进草稿不再适用",
                "follow_up_not_due": "该申请尚未到跟进时间或已超过跟进节奏",
                "follow_up_exhausted": "该申请已超过跟进次数上限",
            }
            code = str(state.get("reason_code") or "follow_up_not_due")
            return reasons.get(code, "该申请当前不适合跟进"), code, {
                "follow_up": state,
            }
        return "", "", {"follow_up": state}
    if spec.artifact_type == "reengagement_candidate":
        job = await db.get(Job, int(scope.get("job_id") or 0))
        if job is None:
            return "关联的岗位已不存在", "scope_deleted", {}
        resume_id = _int_or_none(scope.get("resume_id"))
        attempt_ctx = spec.metadata.get("context_candidate") or {}
        resolved = await _attempt_context(db, resume_id or 0, int(job.id))
        if not resolved.get("exists"):
            if not attempt_ctx.get("application_attempt_id"):
                return "缺少该候选对应的投递尝试", "missing_provenance", {}
            resolved = {}
        if resolved.get("exists"):
            scope["application_attempt_id"] = resolved["application_attempt_id"]
            attempt_ctx = {
                "application_attempt_id": resolved["application_attempt_id"],
                "applied_resume_version": resolved["applied_resume_version"],
                "applied_resume_version_id": resolved["applied_resume_version_id"],
                "current_resume_version": resolved["current_resume_version"],
                "current_resume_version_id": resolved["current_resume_version_id"],
                "current_stage": resolved["current_stage"],
                "days_since_application": resolved["days_since_application"],
            }
            spec.metadata["context_candidate"] = {
                **(spec.metadata.get("context_candidate") or {}),
                **attempt_ctx,
            }
        stage = str(attempt_ctx.get("current_stage") or resolved.get("current_stage") or "")
        if stage in _TERMINAL_ATTEMPT_STAGES:
            return "该申请已进入终止阶段", "terminal_stage", {}
        applied = int(attempt_ctx.get("applied_resume_version") or 0)
        current = int(attempt_ctx.get("current_resume_version") or 0)
        if applied and current and applied >= current:
            return "该岗位申请已使用最新简历版本", "already_current", {}
        company = _clean(attempt_ctx.get("company") or getattr(job, "company", ""), 180)
        role = _clean(attempt_ctx.get("role") or getattr(job, "title", ""), 220)
        spec.metadata.setdefault("company", company)
        spec.metadata.setdefault("role", role)
        return "", "", {"company": company, "role": role}
    if spec.artifact_type == "tailored_resume_proposal":
        if job_id is not None and not await db.get(Job, int(job_id)):
            return "关联的岗位已不存在", "scope_deleted", {}
        return "", "", {}
    if job_id is not None and not await db.get(Job, int(job_id)):
        return "关联的岗位已不存在", "scope_deleted", {}
    return "", "", {}


def _href(spec: _Spec, artifact_id: str | None) -> str:
    job_id = _int_or_none(spec.scope.get("job_id"))
    base = f"/jobs/{job_id}" if job_id else "/today"
    if spec.artifact_type == "tailored_resume_proposal":
        proposal = str(spec.scope.get("proposal_id") or "")
        return f"{base}?proposal={proposal}" if proposal else base
    return f"{base}?artifact={artifact_id}" if artifact_id else base


def _provenance(
    task_id: str,
    spec: _Spec,
    fingerprints: dict[str, str],
    captured_at: str,
    phase: str,
) -> dict[str, Any]:
    return {
        "task_id": task_id,
        "evidence_refs": list(spec.evidence_refs),
        "source_fingerprint": _combine_fingerprints(fingerprints),
        "last_seen_at": captured_at,
        "fingerprints": fingerprints,
        "capture_phase": phase,
    }


def _delivery(
    task: dict[str, Any],
    spec: _Spec,
    *,
    state: str,
    artifact_id: str | None = None,
    created_at: str | None = None,
    title: str = "",
    reason: str = "",
    reason_code: str = "",
    provenance: dict[str, Any] | None = None,
    extras: dict[str, Any] | None = None,
) -> dict[str, Any]:
    scope = spec.scope
    delivery: dict[str, Any] = {
        "state": state,
        "task_id": str(task.get("task_id") or spec.task_id or ""),
        "artifact_type": spec.artifact_type,
        "artifact_id": artifact_id,
        "job_id": _int_or_none(scope.get("job_id")),
        "application_id": _int_or_none(scope.get("application_id")),
        "application_type": (
            str(scope.get("application_type") or "")
            if _int_or_none(scope.get("application_id"))
            else ""
        ) or None,
        "calendar_event_id": _int_or_none(scope.get("calendar_event_id")),
        "resume_id": _int_or_none(scope.get("resume_id")),
        "application_attempt_id": _int_or_none(scope.get("application_attempt_id")),
        "action_key": spec.action_key or None,
        "title": title or spec.title,
        "href": _href(spec, artifact_id),
        "created_at": created_at,
        "reason": reason,
        "reason_code": reason_code,
        "provenance": provenance
        or {
            "task_id": str(task.get("task_id") or spec.task_id or ""),
            "evidence_refs": list(spec.evidence_refs),
            "source_fingerprint": "",
            "last_seen_at": "",
            "fingerprints": {},
            "capture_phase": "",
        },
    }
    if spec.artifact_type == "follow_up_draft":
        delivery["sent"] = False
    for key, value in (extras or {}).items():
        delivery[key] = value
    return delivery


# ---------------------------------------------------------------------------
# Materialization (writes through the Operation Registry)
# ---------------------------------------------------------------------------


async def _persist_artifact(
    spec: _Spec,
    task: dict[str, Any],
    provenance: dict[str, Any],
) -> dict[str, Any] | None:
    """Persist via the Operation Registry; returns the stored artifact."""
    from app.ops import execute_operation

    scope = spec.scope
    metadata = {
        "idempotency_key": spec.idempotency_key,
        "director": {
            "task_id": str(task.get("task_id") or spec.task_id or ""),
            "event_type": str(
                (task.get("input") or {}).get("event_type") or ""
            ),
            "artifact_type": spec.artifact_type,
            "action_key": spec.action_key,
        },
        "provenance": provenance,
        "scope": {
            "job_id": _int_or_none(scope.get("job_id")),
            "application_type": str(scope.get("application_type") or "") or None,
            "application_id": _int_or_none(scope.get("application_id")),
            "calendar_event_id": _int_or_none(scope.get("calendar_event_id")),
            "resume_id": _int_or_none(scope.get("resume_id")),
            "application_attempt_id": _int_or_none(
                scope.get("application_attempt_id")
            ),
        },
    }
    if spec.practice_plan:
        metadata["practice_plan"] = spec.practice_plan
    if spec.artifact_type == "follow_up_draft":
        follow_up = spec.metadata.get("follow_up") or {}
        metadata["follow_up"] = {
            "application_type": str(scope.get("application_type") or "application"),
            "due_date": follow_up.get("next_follow_up_date"),
            "urgency": follow_up.get("urgency"),
            "follow_up_count": follow_up.get("follow_up_count"),
            "sent": False,
        }
    if spec.artifact_type == "reengagement_candidate":
        candidate = spec.candidate or {}
        attempt_ctx = spec.metadata.get("context_candidate") or {}
        metadata["resume_id"] = _int_or_none(scope.get("resume_id"))
        metadata["resume_version_id"] = _int_or_none(
            attempt_ctx.get("current_resume_version_id")
        )
        metadata["previous_resume_version_id"] = _int_or_none(
            attempt_ctx.get("applied_resume_version_id")
        )
        metadata["applied_resume_version"] = int(
            attempt_ctx.get("applied_resume_version") or 0
        )
        metadata["current_resume_version"] = int(
            attempt_ctx.get("current_resume_version") or 0
        )
        metadata["application_attempt_id"] = _int_or_none(
            scope.get("application_attempt_id")
        )
        metadata["company"] = _clean(
            attempt_ctx.get("company") or candidate.get("company"), 180
        )
        metadata["role"] = _clean(
            attempt_ctx.get("role") or candidate.get("role"), 220
        )
        metadata["current_stage"] = str(attempt_ctx.get("current_stage") or "")
        metadata["days_since_application"] = int(
            attempt_ctx.get("days_since_application") or 0
        )
        metadata["urgency"] = str(candidate.get("urgency") or "monitor")
        metadata["why"] = _clean(candidate.get("why"), 400)
        metadata["suggested_angle"] = _clean(candidate.get("suggested_angle"), 400)
        metadata["evidence_refs"] = list(spec.evidence_refs)
        metadata["evidence_changes"] = spec.metadata.get("evidence_changes") or []
        metadata["resume_update_summary"] = spec.metadata.get(
            "resume_update_summary", ""
        )
        metadata["added_evidence_summary"] = spec.metadata.get(
            "added_evidence_summary", ""
        )
        angle = _clean(candidate.get("suggested_angle"), 400)
        metadata["next_action"] = {
            "kind": "review_reengagement",
            "label": angle or "查看该旧岗位的重新联系建议并决定是否跟进",
            "urgency": str(candidate.get("urgency") or "monitor"),
        }

    result = await execute_operation(
        "save_career_artifact",
        {
            "artifact_type": spec.store_type,
            "title": spec.title,
            "content_markdown": spec.content,
            "related_job_id": _int_or_none(scope.get("job_id")),
            "related_application_id": _int_or_none(scope.get("application_id"))
            if str(scope.get("application_type") or "application") == "application"
            else None,
            "related_application_record_id": _int_or_none(scope.get("application_id"))
            if str(scope.get("application_type") or "") == "application_record"
            else None,
            "metadata": metadata,
        },
        surface="career_director",
        audit=True,
    )
    outputs = result.get("outputs")
    if not result.get("ok") or not isinstance(outputs, dict) or outputs.get("error"):
        return None
    return outputs


def _reengagement_content(spec: _Spec) -> tuple[str, str]:
    candidate = spec.candidate or {}
    attempt_ctx = spec.metadata.get("context_candidate") or {}
    company = _clean(attempt_ctx.get("company") or candidate.get("company"), 180)
    role = _clean(attempt_ctx.get("role") or candidate.get("role"), 220)
    title = f"重新联系候选：{company or '旧岗位'} · {role or '未命名岗位'}"[:200]
    lines = [
        f"# {title}",
        "",
        f"- 岗位：{company or '未知公司'} · {role or '未知岗位'}",
        f"- 当前阶段：{attempt_ctx.get('current_stage') or '未知'}",
        f"- 距投递：{attempt_ctx.get('days_since_application', '未知')} 天",
        f"- 投递时简历版本：v{attempt_ctx.get('applied_resume_version') or '?'} → 当前版本 v{attempt_ctx.get('current_resume_version') or '?'}",
        "",
        "## 为什么现在值得重新联系",
        _clean(candidate.get("why"), 400) or "（未提供理由）",
        "",
        "## 建议角度",
        _clean(candidate.get("suggested_angle"), 400) or "（未提供建议角度）",
        "",
        "## 新增证据",
    ]
    changes = spec.metadata.get("evidence_changes") or []
    if changes:
        lines.extend(
            f"- [{entry.get('ref')}] {entry.get('text')}" for entry in changes
        )
    else:
        lines.append("- 见证据引用。")
    lines.extend(
        [
            "",
            "## 证据引用",
            *[f"- {ref}" for ref in spec.evidence_refs],
            "",
            "> 这只是候选建议：OfferU 没有联系任何人，是否行动由你决定。",
        ]
    )
    return title, "\n".join(lines)[:60_000]


async def materialize_director_deliveries(
    task: dict[str, Any], briefing: dict[str, Any]
) -> list[dict[str, Any]]:
    """Persist model-produced prepared artifacts through the Registry.

    Called before the CareerTask completes; the returned deliveries embed in
    ``task.result.deliveries``.  Anything that cannot be persisted against real
    scope resolves to an honest state instead of a fake artifact.
    """
    briefing = briefing if isinstance(briefing, dict) else {}
    specs = _collect_specs(task, briefing)
    if not specs:
        return []
    captured = (
        task.get("preparation_provenance")
        if isinstance(task.get("preparation_provenance"), dict)
        else {}
    )
    captured_fps = (
        captured.get("fingerprints")
        if isinstance(captured.get("fingerprints"), dict)
        else {}
    )
    async with async_session() as db:
        for spec in specs:
            if spec.blocked_reason:
                continue
            if spec.artifact_type == "tailored_resume_proposal":
                continue  # persisted by the resume pipeline; resolved at read time
            if not spec.content and spec.artifact_type != "reengagement_candidate":
                continue  # no model draft -> stays suggested at read time
            reason, code, extras = await _validate_scope(db, spec, for_persist=True)
            if reason:
                spec.blocked_reason = reason
                spec.blocked_code = code
                continue
            spec.metadata["follow_up"] = extras.get("follow_up") or {}
            if spec.artifact_type == "reengagement_candidate":
                spec.title, spec.content = _reengagement_content(spec)
            scope_keys = scope_fingerprint_keys(spec.scope)
            fingerprints, missing = await _fingerprint_scope(db, spec.scope)
            if missing:
                spec.blocked_reason = "生成依据的源数据已不存在"
                spec.blocked_code = "scope_deleted"
                continue
            fingerprints, phase = _merge_provenance_fingerprints(
                fingerprints, captured_fps, scope_keys
            )
            provenance = _provenance(
                str(task.get("task_id") or spec.task_id or ""),
                spec,
                fingerprints,
                str(captured.get("captured_at") or _utc_now()),
                phase,
            )
            saved = await _persist_artifact(spec, task, provenance)
            if saved is None:
                spec.blocked_reason = "材料持久化失败"
                spec.blocked_code = "persist_failed"
            else:
                spec.metadata["persisted_id"] = saved.get("id")
    return await resolve_deliveries(task, briefing=briefing)


# ---------------------------------------------------------------------------
# Resolution (read path; never trusts output text)
# ---------------------------------------------------------------------------


async def _resolve_proposal(
    db: Any, task: dict[str, Any], spec: _Spec
) -> dict[str, Any]:
    proposal_id = str(spec.scope.get("proposal_id") or "")
    proposal = await db.get(ResumeOptimizationProposal, proposal_id)
    task_status = str(task.get("status") or "")
    if proposal is None:
        if task_status in _TASK_LIVE:
            return _delivery(task, spec, state="preparing")
        reason = "简历提案尚未生成或已被删除"
        if task_status in _TASK_FAILED or task_status in _TASK_CANCELLED:
            reason = str(task.get("error") or "提案任务失败")[:300] or "提案任务失败"
            return _delivery(
                task,
                spec,
                state="failed",
                reason=reason,
                reason_code="task_failed",
            )
        return _delivery(task, spec, state="suggested", reason=reason, reason_code="not_persisted")
    scope_keys = scope_fingerprint_keys(spec.scope)
    fingerprints, missing = await _fingerprint_scope(db, spec.scope)
    stored = {}
    captured_at = ""
    phase = ""
    preparation = (
        task.get("preparation_provenance")
        if isinstance(task.get("preparation_provenance"), dict)
        else {}
    )
    captured = (
        preparation.get("fingerprints")
        if isinstance(preparation.get("fingerprints"), dict)
        else {}
    )
    for key in scope_keys:
        if key in captured:
            stored[key] = str(captured[key])
        elif key in fingerprints:
            stored[key] = fingerprints[key]
        else:
            stored[key] = "absent"
    captured_at = str(preparation.get("captured_at") or "")
    phase = str(preparation.get("phase") or "")
    proposal_status = str(proposal.status or "")
    if proposal_status in {"superseded", "rejected"}:
        return _delivery(
            task,
            spec,
            state="stale",
            artifact_id=proposal_id,
            created_at=_iso(proposal.created_at),
            title=_clean(f"岗位 #{proposal.job_id} 简历提案", 200),
            reason="该简历提案已被取代" if proposal_status == "superseded" else "该简历提案已被拒绝",
            reason_code="proposal_resolved",
            provenance=_provenance(
                str(task.get("task_id") or ""), spec, stored, captured_at, phase
            ),
        )
    if missing:
        return _delivery(
            task,
            spec,
            state="stale",
            artifact_id=proposal_id,
            created_at=_iso(proposal.created_at),
            title=_clean(f"岗位 #{proposal.job_id} 简历提案", 200),
            reason="生成依据的源数据已不存在",
            reason_code="scope_deleted",
            provenance=_provenance(
                str(task.get("task_id") or ""), spec, stored, captured_at, phase
            ),
        )
    if stored and fingerprints != stored:
        changed = sorted(key for key in stored if stored.get(key) != fingerprints.get(key))
        return _delivery(
            task,
            spec,
            state="stale",
            artifact_id=proposal_id,
            created_at=_iso(proposal.created_at),
            title=_clean(f"岗位 #{proposal.job_id} 简历提案", 200),
            reason=f"生成后源数据已变化（{', '.join(changed)}），需重新生成",
            reason_code="source_changed",
            provenance=_provenance(
                str(task.get("task_id") or ""), spec, stored, captured_at, phase
            ),
        )
    return _delivery(
        task,
        spec,
        state="ready",
        artifact_id=proposal_id,
        created_at=_iso(proposal.created_at),
        title=_clean(f"岗位 #{proposal.job_id} 简历提案", 200),
        provenance=_provenance(
            str(task.get("task_id") or ""), spec, stored, captured_at, phase
        ),
    )


async def _resolve_store_spec(
    db: Any, task: dict[str, Any], spec: _Spec
) -> dict[str, Any]:
    store_type = spec.store_type
    artifact = (
        career_artifact_store.find_by_idempotency_key(
            store_type, spec.idempotency_key
        )
        if store_type
        else None
    )
    task_status = str(task.get("status") or "")

    if artifact is None:
        if spec.blocked_reason:
            return _delivery(
                task,
                spec,
                state="blocked",
                reason=spec.blocked_reason,
                reason_code=spec.blocked_code or "blocked",
            )
        if not spec.content and spec.artifact_type != "reengagement_candidate":
            state = (
                "preparing"
                if task_status in _TASK_LIVE
                else "suggested"
            )
            return _delivery(
                task,
                spec,
                state=state,
                reason="模型没有产出材料草稿" if state == "suggested" else "",
                reason_code="no_draft",
            )
        if task_status in _TASK_LIVE:
            return _delivery(task, spec, state="preparing")
        if task_status in _TASK_FAILED or task_status in _TASK_CANCELLED:
            reason = str(task.get("error") or "").strip()[:300]
            return _delivery(
                task,
                spec,
                state="failed",
                reason=reason or "任务未成功，材料没有生成",
                reason_code="task_failed",
            )
        return _delivery(
            task,
            spec,
            state="suggested",
            reason="材料尚未持久化",
            reason_code="not_persisted",
        )

    metadata = artifact.get("metadata") if isinstance(artifact.get("metadata"), dict) else {}
    stored_provenance = (
        metadata.get("provenance") if isinstance(metadata.get("provenance"), dict) else {}
    )
    stored_fps = (
        stored_provenance.get("fingerprints")
        if isinstance(stored_provenance.get("fingerprints"), dict)
        else {}
    )
    # Re-verify scope existence and eligibility against CURRENT state.
    reason, code, extras = await _validate_scope(db, spec, for_persist=False)
    provenance = _provenance(
        str(task.get("task_id") or ""),
        spec,
        {key: str(value) for key, value in stored_fps.items()},
        str(stored_provenance.get("last_seen_at") or ""),
        str(stored_provenance.get("capture_phase") or ""),
    )
    if reason:
        return _delivery(
            task,
            spec,
            state="stale",
            artifact_id=str(artifact.get("id")),
            created_at=str(artifact.get("created_at") or ""),
            title=str(artifact.get("title") or spec.title),
            reason=reason,
            reason_code=code,
            provenance=provenance,
            extras=extras,
        )
    fingerprints, missing = await _fingerprint_scope(db, spec.scope)
    if missing:
        return _delivery(
            task,
            spec,
            state="stale",
            artifact_id=str(artifact.get("id")),
            created_at=str(artifact.get("created_at") or ""),
            title=str(artifact.get("title") or spec.title),
            reason="生成依据的源数据已不存在",
            reason_code="scope_deleted",
            provenance=provenance,
            extras=extras,
        )
    changed = sorted(
        key for key in stored_fps if str(stored_fps.get(key)) != fingerprints.get(key)
    )
    added = sorted(key for key in fingerprints if key not in stored_fps)
    if changed or added:
        keys = changed + [f"{key}(new)" for key in added]
        return _delivery(
            task,
            spec,
            state="stale",
            artifact_id=str(artifact.get("id")),
            created_at=str(artifact.get("created_at") or ""),
            title=str(artifact.get("title") or spec.title),
            reason=f"生成后源数据已变化（{', '.join(keys)}），需重新生成",
            reason_code="source_changed",
            provenance=provenance,
            extras=extras,
        )

    extra_fields: dict[str, Any] = dict(extras)
    if spec.artifact_type == "interview_prep":
        plan = (
            metadata.get("practice_plan")
            if isinstance(metadata.get("practice_plan"), dict)
            else {}
        )
        questions = plan.get("questions") if isinstance(plan.get("questions"), list) else []
        practice = (
            metadata.get("practice") if isinstance(metadata.get("practice"), dict) else {}
        )
        extra_fields["practice"] = {
            "duration_minutes": int(plan.get("duration_minutes") or 0),
            "questions": len(questions),
            "answered": int(practice.get("answered") or 0),
            "total": int(practice.get("total") or len(questions)),
            "completed": bool(practice.get("completed")) if questions else False,
        }
    if spec.artifact_type == "reengagement_candidate":
        extra_fields["next_action"] = metadata.get("next_action") or {}
        extra_fields["company"] = metadata.get("company") or ""
        extra_fields["role"] = metadata.get("role") or ""
    return _delivery(
        task,
        spec,
        state="ready",
        artifact_id=str(artifact.get("id")),
        created_at=str(artifact.get("created_at") or ""),
        title=str(artifact.get("title") or spec.title),
        provenance=provenance,
        extras=extra_fields,
    )


async def resolve_deliveries(
    task: dict[str, Any], briefing: dict[str, Any] | None = None
) -> list[dict[str, Any]]:
    """Resolve real deliveries for a CareerTask; read-only and non-recursive."""
    briefing = briefing if isinstance(briefing, dict) else _task_briefing(task)
    specs = _collect_specs(task, briefing or {})
    if not specs:
        return []
    deliveries: list[dict[str, Any]] = []
    async with async_session() as db:
        for spec in specs:
            if spec.artifact_type == "tailored_resume_proposal":
                deliveries.append(await _resolve_proposal(db, task, spec))
            else:
                deliveries.append(await _resolve_store_spec(db, task, spec))
    rank = {"ready": 0, "preparing": 1, "suggested": 2, "blocked": 3, "stale": 4, "failed": 5}
    deliveries.sort(key=lambda item: (rank.get(str(item.get("state")), 9), str(item.get("artifact_type") or "")))
    return deliveries


# ---------------------------------------------------------------------------
# Prepared-artifact read + practice answer routes (registered by Main)
# ---------------------------------------------------------------------------


def _is_director_artifact(artifact: dict[str, Any]) -> bool:
    metadata = artifact.get("metadata") if isinstance(artifact.get("metadata"), dict) else {}
    director = metadata.get("director")
    return isinstance(director, dict) and bool(director.get("task_id"))


def _scope_from_artifact(artifact: dict[str, Any]) -> dict[str, Any]:
    metadata = artifact.get("metadata") if isinstance(artifact.get("metadata"), dict) else {}
    scope = metadata.get("scope") if isinstance(metadata.get("scope"), dict) else {}
    artifact_type = str(artifact.get("artifact_type") or "")
    return {
        "include_profile": artifact_type in {"interview_prep", "follow_up_draft"},
        "job_id": _int_or_none(scope.get("job_id") or artifact.get("related_job_id")),
        "application_type": str(scope.get("application_type") or "") or None,
        "application_id": _int_or_none(scope.get("application_id")),
        "calendar_event_id": _int_or_none(scope.get("calendar_event_id")),
        "resume_id": _int_or_none(scope.get("resume_id")),
        "application_attempt_id": _int_or_none(scope.get("application_attempt_id")),
        "include_resume_attempts": artifact_type == "reengagement_candidate",
    }


async def _delivery_for_artifact(
    db: Any, artifact: dict[str, Any]
) -> dict[str, Any]:
    """Recompute a delivery for one persisted artifact without a live task."""
    metadata = artifact.get("metadata") if isinstance(artifact.get("metadata"), dict) else {}
    director = metadata.get("director") if isinstance(metadata.get("director"), dict) else {}
    stored_provenance = (
        metadata.get("provenance") if isinstance(metadata.get("provenance"), dict) else {}
    )
    scope = _scope_from_artifact(artifact)
    artifact_type = str(director.get("artifact_type") or "")
    spec = _Spec(
        artifact_type=artifact_type,
        title=str(artifact.get("title") or ""),
        action_key=str(director.get("action_key") or ""),
        evidence_refs=[
            str(ref)
            for ref in (stored_provenance.get("evidence_refs") or [])[:12]
            if str(ref or "").strip()
        ],
        scope=scope,
        task_id=str(director.get("task_id") or ""),
    )
    reason, code, extras = await _validate_scope(db, spec, for_persist=False)
    stored_fps = {
        key: str(value)
        for key, value in (stored_provenance.get("fingerprints") or {}).items()
        if isinstance(key, str)
    }
    provenance = _provenance(
        spec.task_id,
        spec,
        stored_fps,
        str(stored_provenance.get("last_seen_at") or ""),
        str(stored_provenance.get("capture_phase") or ""),
    )
    base = {
        "artifact_id": str(artifact.get("id")),
        "created_at": str(artifact.get("created_at") or ""),
        "title": str(artifact.get("title") or ""),
        "provenance": provenance,
    }
    if reason:
        return _delivery(
            {"task_id": spec.task_id, "status": "completed"},
            spec,
            state="stale",
            reason=reason,
            reason_code=code,
            extras=extras,
            **base,
        )
    fingerprints, missing = await _fingerprint_scope(db, scope)
    if missing:
        return _delivery(
            {"task_id": spec.task_id, "status": "completed"},
            spec,
            state="stale",
            reason="生成依据的源数据已不存在",
            reason_code="scope_deleted",
            extras=extras,
            **base,
        )
    changed = sorted(
        key for key in stored_fps if str(stored_fps.get(key)) != fingerprints.get(key)
    )
    if changed:
        return _delivery(
            {"task_id": spec.task_id, "status": "completed"},
            spec,
            state="stale",
            reason=f"生成后源数据已变化（{', '.join(changed)}），需重新生成",
            reason_code="source_changed",
            extras=extras,
            **base,
        )
    if artifact_type == "interview_prep":
        plan = (
            metadata.get("practice_plan")
            if isinstance(metadata.get("practice_plan"), dict)
            else {}
        )
        questions = plan.get("questions") if isinstance(plan.get("questions"), list) else []
        practice = (
            metadata.get("practice") if isinstance(metadata.get("practice"), dict) else {}
        )
        extras["practice"] = {
            "duration_minutes": int(plan.get("duration_minutes") or 0),
            "questions": len(questions),
            "answered": int(practice.get("answered") or 0),
            "total": int(practice.get("total") or len(questions)),
            "completed": bool(practice.get("completed")) if questions else False,
        }
    if artifact_type == "reengagement_candidate":
        extras["next_action"] = metadata.get("next_action") or {}
        extras["company"] = metadata.get("company") or ""
        extras["role"] = metadata.get("role") or ""
    return _delivery(
        {"task_id": spec.task_id, "status": "completed"},
        spec,
        state="ready",
        extras=extras,
        **base,
    )


async def get_prepared_artifact(artifact_id: str) -> dict[str, Any]:
    """Return one persisted director artifact plus its live delivery state."""
    try:
        artifact = career_artifact_store.get(str(artifact_id or ""))
    except ValueError:
        return {"error": "无效的材料 ID"}
    if artifact is None or not _is_director_artifact(artifact):
        return {"error": f"Prepared artifact {str(artifact_id or '')[:80]} not found"}
    async with async_session() as db:
        delivery = await _delivery_for_artifact(db, artifact)
    return {"artifact": artifact, "delivery": delivery}


async def submit_practice_answer(
    artifact_id: str, question_index: int, answer: str
) -> dict[str, Any]:
    """Persist one interview-prep practice answer on the artifact metadata.

    The artifact content is never rewritten and no Career Truth is touched;
    answers stay reviewable progress on the artifact itself.  Re-submitting the
    same question is idempotent (attempts tracked, content replaced only when
    the answer actually changes).
    """
    try:
        artifact = career_artifact_store.get(str(artifact_id or ""))
    except ValueError:
        return {"error": "无效的材料 ID"}
    if artifact is None or not _is_director_artifact(artifact):
        return {"error": f"Prepared artifact {str(artifact_id or '')[:80]} not found"}
    if artifact.get("artifact_type") != "interview_prep":
        return {"error": "只有面试准备材料支持练习作答"}
    metadata = artifact.get("metadata") if isinstance(artifact.get("metadata"), dict) else {}
    plan = metadata.get("practice_plan") if isinstance(metadata.get("practice_plan"), dict) else {}
    questions = [q for q in (plan.get("questions") or []) if isinstance(q, dict)]
    if not questions:
        return {"error": "该面试准备没有可用的练习问题"}
    try:
        index = int(question_index)
    except (TypeError, ValueError):
        return {"error": "question_index 必须是整数"}
    if index < 0 or index >= len(questions):
        return {"error": f"question_index 超出范围（0-{len(questions) - 1}）"}
    text = _clean(answer, _MAX_ANSWER_CHARS)
    if not text:
        return {"error": "回答内容不能为空"}
    question = str(questions[index].get("question") or "")[:500]

    recorded = career_artifact_store.record_practice_answer(
        str(artifact.get("id")),
        question_index=index,
        question=question,
        answer=text,
    )
    if recorded is None:
        return {"error": "练习进度写入失败"}
    practice = recorded.get("practice") or {}
    return {
        "artifact_id": str(artifact.get("id")),
        "question_index": index,
        "changed": bool(recorded.get("changed")),
        "answer": recorded.get("answer") or {},
        "practice": {
            "answered": int(practice.get("answered") or 0),
            "total": int(practice.get("total") or len(questions)),
            "completed": bool(practice.get("completed")),
        },
    }


__all__ = [
    "DELIVERY_ARTIFACT_TYPES",
    "DELIVERY_STATES",
    "capture_preparation_provenance",
    "career_source_fingerprint",
    "get_prepared_artifact",
    "materialize_director_deliveries",
    "resolve_deliveries",
    "scope_fingerprint_keys",
    "submit_practice_answer",
]
