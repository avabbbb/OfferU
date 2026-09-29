"""Bounded read-only context for RESUME_UPDATED Career Director review.

Filters to recent active applications that used an older canonical Resume
version. The model judges fit and whether new evidence warrants a review; it
never contacts anyone or writes Career Truth.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from app.database import async_session
from app.models.models import (
    ApplicationAttempt,
    ApplicationStageEvent,
    AutomationEvent,
    AutomationInboxItem,
    Job,
    Resume,
    ResumeVersion,
    RoleBenchmarkRun,
)
from app.services.security_redaction import redact_sensitive_text

_REENGAGE_MIN_DAYS = 4
_TERMINAL_STAGES = frozenset({"rejected", "offer", "withdrawn"})


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class ResumeVersionRef(_StrictModel):
    version_id: int = Field(gt=0)
    version_number: int = Field(ge=0)
    change_summary: str = Field(default="", max_length=400)
    created_at: str = Field(default="", max_length=50)


class ResumeEvidenceRef(_StrictModel):
    ref: str = Field(pattern=r"^resume_added_[1-8]$")
    text: str = Field(min_length=1, max_length=200)


class ReengagementCandidate(_StrictModel):
    job_id: int = Field(gt=0)
    company: str = Field(default="", max_length=180)
    role: str = Field(default="", max_length=220)
    job_summary: str = Field(default="", max_length=1200)
    job_description: str = Field(default="", max_length=3000)
    job_keywords: list[str] = Field(default_factory=list, max_length=16)
    job_description_is_untrusted: Literal[True] = True
    role_intelligence_status: str = Field(default="", max_length=24)
    role_intelligence_samples: int = Field(default=0, ge=0)
    evidence_refs: list[str] = Field(default_factory=list, max_length=10)
    application_attempt_id: int = Field(gt=0)
    applied_resume_version: int = Field(ge=0)
    current_resume_version: int = Field(ge=0)
    current_stage: str = Field(default="", max_length=80)
    days_since_application: int = Field(default=0, ge=0)
    previous_suggestion_version: int | None = Field(default=None, ge=0)
    previous_suggestion_status: Literal["pending", "resolved", "dismissed"] | None = None


class SuppressedResumeCandidate(_StrictModel):
    reason: Literal[
        "no_added_resume_evidence",
        "already_on_current_version",
        "terminal_stage",
        "not_submitted_or_active",
        "within_wait_window",
        "candidate_still_pending",
    ]
    job_id: int | None = Field(default=None, gt=0)
    company: str = Field(default="", max_length=180)
    role: str = Field(default="", max_length=220)
    current_stage: str = Field(default="", max_length=80)
    days_since_application: int | None = Field(default=None, ge=0)


class PreviouslySuggestedCandidate(_StrictModel):
    job_id: int = Field(gt=0)
    version_number: int = Field(ge=0)
    status: Literal["pending", "resolved", "dismissed"]
    why: str = Field(default="", max_length=240)


class ResumeUpdateContext(_StrictModel):
    contract_schema: Literal["offeru.resume_update_context.v1"] = Field(
        default="offeru.resume_update_context.v1", alias="schema"
    )
    resume_id: int = Field(gt=0)
    resume_title: str = Field(default="", max_length=300)
    current_version: ResumeVersionRef | None = None
    previous_version: ResumeVersionRef | None = None
    material_change_summary: str = Field(default="", max_length=400)
    added_evidence_hints: list[str] = Field(default_factory=list, max_length=8)
    added_evidence: list[ResumeEvidenceRef] = Field(default_factory=list, max_length=8)
    candidates: list[ReengagementCandidate] = Field(default_factory=list, max_length=8)
    suppressed: list[SuppressedResumeCandidate] = Field(default_factory=list, max_length=12)
    previously_suggested: list[PreviouslySuggestedCandidate] = Field(default_factory=list, max_length=12)


def _safe(value: Any, limit: int = 300) -> str:
    return redact_sensitive_text(str(value or "").strip(), max_length=limit).strip()


def _iso(value: Any) -> str:
    return value.isoformat() if isinstance(value, datetime) else str(value or "")[:50]


def _version_ref(version: ResumeVersion | None) -> ResumeVersionRef | None:
    if version is None:
        return None
    return ResumeVersionRef(
        version_id=int(version.id),
        version_number=int(version.version_number or 0),
        change_summary=_safe(version.change_summary, 400),
        created_at=_iso(version.created_at),
    )


def _section_text(content_snapshot: dict[str, Any]) -> set[str]:
    """Extract comparable resume evidence from a version snapshot."""
    texts: set[str] = set()
    if not isinstance(content_snapshot, dict):
        return texts
    resume = content_snapshot.get("resume") if isinstance(content_snapshot.get("resume"), dict) else {}
    summary = _safe(resume.get("summary"), 500)
    if len(summary) >= 8:
        texts.add(summary[:300])
    sections = content_snapshot.get("sections") or []
    if not isinstance(sections, list):
        return texts
    for section in sections:
        if not isinstance(section, dict):
            continue
        for row in section.get("content_json") or []:
            if not isinstance(row, dict):
                continue
            for key in (
                "description", "bullet", "title", "name", "position", "company",
                "role", "project", "school", "degree", "major", "subtitle", "category",
            ):
                value = str(row.get(key) or "").strip()
                if len(value) >= 8:
                    texts.add(value[:200])
            items = row.get("items")
            if isinstance(items, list):
                for item in items:
                    value = str(item or "").strip()
                    if len(value) >= 4:
                        texts.add(value[:200])
    return texts


def added_resume_evidence(previous_snapshot: dict[str, Any], current_snapshot: dict[str, Any]) -> list[str]:
    """Return bounded additions suitable for deciding whether to wake the Agent."""

    return sorted(_section_text(current_snapshot) - _section_text(previous_snapshot))[:8]


async def get_resume_reengagement_context(
    *, resume_id: int, automation_event_id: str = ""
) -> dict[str, Any]:
    """Read one resume's newest version plus deterministic re-engagement candidates."""

    async with async_session() as db:
        resume = await db.get(Resume, int(resume_id))
        if resume is None:
            raise ValueError("Resume does not exist")
        versions = (
            await db.execute(
                select(ResumeVersion)
                .where(ResumeVersion.resume_id == resume.id)
                .order_by(ResumeVersion.version_number.desc())
                .limit(100)
            )
        ).scalars().all()
        current_version = next(
            (row for row in versions if int(row.id) == int(resume.current_version_id or 0)),
            None,
        )
        if current_version is None and resume.current_version_id:
            pointed_version = await db.get(ResumeVersion, int(resume.current_version_id))
            if pointed_version is not None and int(pointed_version.resume_id) == int(resume.id):
                current_version = pointed_version
        current_version = current_version or (versions[0] if versions else None)
        current_number = int(current_version.version_number) if current_version else 0
        previous_version = next(
            (row for row in versions if int(row.version_number) < current_number),
            None,
        )
        if automation_event_id:
            event = await db.get(AutomationEvent, str(automation_event_id))
            payload = event.payload_json if event and isinstance(event.payload_json, dict) else {}
            if (
                event is None
                or event.event_type != "RESUME_UPDATED"
                or event.target_type != "resume"
                or event.target_id != str(resume.id)
                or int(payload.get("resume_id") or 0) != int(resume.id)
                or int(payload.get("resume_version_id") or 0) != int(current_version.id if current_version else 0)
                or int(payload.get("version_number") or 0) != current_number
            ):
                raise ValueError("Resume context does not match the active AutomationEvent version")

        current_number = int(current_version.version_number) if current_version else 0

        # Diff newest vs previous snapshot for added evidence hints.
        added_hints: list[str] = []
        if current_version and previous_version:
            added_hints = added_resume_evidence(
                previous_version.content_snapshot if isinstance(previous_version.content_snapshot, dict) else {},
                current_version.content_snapshot if isinstance(current_version.content_snapshot, dict) else {},
            )
        if not added_hints:
            return ResumeUpdateContext(
                resume_id=int(resume.id),
                resume_title=_safe(resume.title, 300),
                current_version=_version_ref(current_version),
                previous_version=_version_ref(previous_version),
                material_change_summary=_safe(current_version.change_summary if current_version else "", 400),
                suppressed=[{"reason": "no_added_resume_evidence"}],
            ).model_dump(mode="json", by_alias=True)

        attempts = (
            await db.execute(
                select(ApplicationAttempt, Job)
                .join(Job, Job.id == ApplicationAttempt.job_id)
                .where(ApplicationAttempt.resume_id == resume.id)
                .where(ApplicationAttempt.resume_version_id.is_not(None))
                .order_by(ApplicationAttempt.created_at.desc())
                .limit(200)
            )
        ).all()
        attempt_ids = [int(attempt.id) for attempt, _job in attempts]
        stage_rows = []
        if attempt_ids:
            stage_rows = (
                await db.execute(
                    select(
                        ApplicationStageEvent.application_attempt_id,
                        ApplicationStageEvent.stage,
                        ApplicationStageEvent.occurred_at,
                    )
                    .where(ApplicationStageEvent.application_attempt_id.in_(attempt_ids))
                    .order_by(ApplicationStageEvent.occurred_at.asc(), ApplicationStageEvent.id.asc())
                )
            ).all()
        stage_history: dict[int, list[tuple[str, datetime | None]]] = {}
        for attempt_id, stage, occurred_at in stage_rows:
            stage_history.setdefault(int(attempt_id), []).append((str(stage), occurred_at))

        version_numbers: dict[int, int] = {}
        candidates: list[ReengagementCandidate] = []
        suppressed: list[dict[str, Any]] = []
        seen_jobs: set[int] = set()
        for attempt, job in attempts:
            job_id = int(job.id)
            if job_id in seen_jobs:
                continue
            # The newest application attempt is authoritative. Never resurrect
            # an older one when the latest attempt fails an eligibility check.
            seen_jobs.add(job_id)
            ver_id = int(attempt.resume_version_id or 0)
            if ver_id and ver_id not in version_numbers:
                ver = await db.get(ResumeVersion, ver_id)
                version_numbers[ver_id] = int(ver.version_number) if ver else 0
            applied_version = version_numbers.get(ver_id, 0)
            history = stage_history.get(int(attempt.id), [])
            stage = (history[-1][0] if history else str(attempt.status or "")).casefold()
            stage = {"submitted": "applied", "responded": "applied", "interview": "interview_1"}.get(stage, stage)
            base = {
                "job_id": job_id,
                "company": _safe(job.company, 180),
                "role": _safe(job.title, 220),
                "current_stage": stage,
            }
            if not applied_version or not current_number or applied_version >= current_number:
                suppressed.append({**base, "reason": "already_on_current_version"})
                continue
            if stage in _TERMINAL_STAGES:
                suppressed.append({**base, "reason": "terminal_stage"})
                continue
            if stage not in {"applied", "written_test", "assessment", "interview_1", "interview_2", "interview_hr"}:
                suppressed.append({**base, "reason": "not_submitted_or_active"})
                continue
            application_time = next(
                (
                    occurred_at
                    for event_stage, occurred_at in history
                    if event_stage.casefold() in {"applied", "written_test", "assessment", "interview_1", "interview_2", "interview_hr"}
                    and occurred_at is not None
                ),
                attempt.created_at,
            )
            if application_time is not None and application_time.tzinfo is not None:
                application_time = application_time.astimezone(timezone.utc).replace(tzinfo=None)
            days = max(0, (datetime.now(timezone.utc).replace(tzinfo=None) - application_time).days) if application_time else 0
            if days < _REENGAGE_MIN_DAYS:
                suppressed.append({**base, "reason": "within_wait_window", "days_since_application": days})
                continue
            benchmark = (
                await db.execute(
                    select(RoleBenchmarkRun)
                    .where(RoleBenchmarkRun.target_job_id == job_id)
                    .order_by(RoleBenchmarkRun.created_at.desc())
                    .limit(1)
                )
            ).scalars().first()
            candidates.append(
                ReengagementCandidate(
                    job_id=job_id,
                    company=base["company"],
                    role=base["role"],
                    job_summary=_safe(job.summary, 1200),
                    job_description=_safe(job.raw_description, 3000),
                    job_keywords=[_safe(value, 100) for value in (job.keywords or []) if str(value).strip()][:16],
                    role_intelligence_status=str(benchmark.status if benchmark else "")[:24],
                    role_intelligence_samples=int(benchmark.valid_sample_count or 0) if benchmark else 0,
                    evidence_refs=[
                        *[f"resume_added_{index}" for index in range(1, min(len(added_hints), 8) + 1)],
                        "job.title",
                        *( ["job.description"] if str(job.raw_description or "").strip() else ["job.summary"] ),
                        "application.stage",
                    ],
                    application_attempt_id=int(attempt.id),
                    applied_resume_version=applied_version,
                    current_resume_version=current_number,
                    current_stage=stage,
                    days_since_application=days,
                )
            )
            if len(candidates) >= 8:
                break

        # Keep a pending candidate from reappearing after a newer Resume save.
        # Dismissed/resolved items remain visible to the model as history so it
        # can reconsider only when new evidence materially changes the case.
        prior_suggestions: dict[int, dict[str, Any]] = {}
        prior_items = (
            await db.execute(
                select(AutomationInboxItem)
                .where(AutomationInboxItem.target_type == "resume")
                .order_by(AutomationInboxItem.created_at.desc())
                .limit(500)
            )
        ).scalars().all()
        for item in prior_items:
            payload = item.payload_json if isinstance(item.payload_json, dict) else {}
            if payload.get("event_type") != "RESUME_UPDATED" or int(payload.get("resume_id") or 0) != int(resume.id):
                continue
            plan = payload.get("resume_update") if isinstance(payload.get("resume_update"), dict) else {}
            for previous in plan.get("candidates") or []:
                if not isinstance(previous, dict) or not previous.get("worth_reengaging"):
                    continue
                try:
                    previous_job_id = int(previous.get("job_id") or 0)
                except (TypeError, ValueError):
                    continue
                if previous_job_id <= 0 or previous_job_id in prior_suggestions:
                    continue
                status = str(item.status or "")
                if status not in {"pending", "resolved", "dismissed"}:
                    status = "pending"  # Unknown history stays suppressed conservatively.
                prior_suggestions[previous_job_id] = {
                    "job_id": previous_job_id,
                    "version_number": int(payload.get("version_number") or 0),
                    "status": status,
                    "why": _safe(previous.get("why"), 240),
                }
        if prior_suggestions:
            kept: list[ReengagementCandidate] = []
            for candidate in candidates:
                previous = prior_suggestions.get(candidate.job_id)
                if previous and previous["status"] == "pending":
                    suppressed.append(
                        {
                            "job_id": candidate.job_id,
                            "company": candidate.company,
                            "role": candidate.role,
                            "current_stage": candidate.current_stage,
                            "reason": "candidate_still_pending",
                        }
                    )
                    continue
                if previous:
                    candidate.previous_suggestion_version = int(previous["version_number"])
                    candidate.previous_suggestion_status = str(previous["status"])
                kept.append(candidate)
            candidates = kept[:8]
        previously_suggested = list(prior_suggestions.values())[:12]

    return ResumeUpdateContext(
        resume_id=int(resume.id),
        resume_title=_safe(resume.title, 300),
        current_version=_version_ref(current_version),
        previous_version=_version_ref(previous_version),
        material_change_summary=_safe(current_version.change_summary if current_version else "", 400),
        added_evidence_hints=[_safe(hint, 200) for hint in added_hints],
        added_evidence=[
            ResumeEvidenceRef(ref=f"resume_added_{index}", text=_safe(hint, 200))
            for index, hint in enumerate(added_hints, start=1)
        ],
        candidates=candidates,
        suppressed=suppressed[:12],
        previously_suggested=previously_suggested,
    ).model_dump(mode="json", by_alias=True)
