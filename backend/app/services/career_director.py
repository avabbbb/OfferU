"""Strict contracts and read-only Career State projection for Career Director.

Learning facets are projected through app.services.career_learning so the
snapshot, interview context and daily review share identical review semantics.
"""

from __future__ import annotations

import json
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import func, select, update

from app.database import async_session
from app.models.models import (
    ApplicationAttempt,
    ApplicationStageEvent,
    AutomationInboxItem,
    CareerTask,
    Job,
    LearningObservation,
    MemoryProposal,
    Profile,
    ProfileSection,
    ProfileTargetRole,
    Resume,
    ResumeVersion,
    RoleBenchmarkDocument,
)
from app.services.security_redaction import redact_sensitive_text

CareerTrack = Literal["campus", "experienced"]
CareerSubstage = Literal[
    "internship",
    "fresh_graduate",
    "early_career",
    "experienced_ic",
    "manager",
    "executive",
    "career_switch",
]
CareerConfidence = Literal["high", "medium", "low"]
AutonomyLevel = Literal["L0", "L1", "L2", "L3"]


class _StrictContract(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class CareerStageAssessment(_StrictContract):
    track: CareerTrack
    substage: CareerSubstage
    confidence: CareerConfidence
    basis: list[str] = Field(min_length=1, max_length=8)

    @model_validator(mode="after")
    def validate_track(self) -> "CareerStageAssessment":
        campus_substages = {"internship", "fresh_graduate"}
        experienced_substages = {"early_career", "experienced_ic", "manager", "executive"}
        if self.substage in campus_substages and self.track != "campus":
            raise ValueError("internship/fresh_graduate must use campus track")
        if self.substage in experienced_substages and self.track != "experienced":
            raise ValueError("experienced substages must use experienced track")
        return self


class CareerStageCorrection(_StrictContract):
    contract_schema: Literal["offeru.career_stage_correction.v1"] = Field(
        default="offeru.career_stage_correction.v1", alias="schema"
    )
    track: CareerTrack
    substage: CareerSubstage

    @model_validator(mode="after")
    def validate_track(self) -> "CareerStageCorrection":
        CareerStageAssessment(
            track=self.track,
            substage=self.substage,
            confidence="high",
            basis=["user-confirmed"],
        )
        return self


class CareerProfileCoverage(_StrictContract):
    strong_evidence: list[str] = Field(default_factory=list, max_length=30)
    weak_evidence: list[str] = Field(default_factory=list, max_length=30)
    missing_evidence: list[str] = Field(default_factory=list, max_length=20)
    unknowns: list[str] = Field(default_factory=list, max_length=20)
    underexpressed_strengths: list[str] = Field(default_factory=list, max_length=20)


class CareerIdentity(_StrictContract):
    career_stage: CareerStageAssessment | None = None
    career_stage_source: Literal["user_confirmed"] | None = None
    experience_years: float | None = Field(default=None, ge=0, le=80)
    current_role: str | None = Field(default=None, max_length=200)
    employment_state: str | None = Field(default=None, max_length=120)


class CareerGoals(_StrictContract):
    primary_roles: list[str] = Field(default_factory=list, max_length=20)
    secondary_roles: list[str] = Field(default_factory=list, max_length=20)
    locations: list[str] = Field(default_factory=list, max_length=20)
    compensation: str | None = Field(default=None, max_length=160)
    timing: str | None = Field(default=None, max_length=160)


class CareerResumeJobRef(_StrictContract):
    job_id: int = Field(gt=0)
    company: str = Field(default="", max_length=180)
    role: str = Field(default="", max_length=220)
    application_attempt_id: int | None = Field(default=None, gt=0)
    applied_resume_version: int | None = Field(default=None, ge=0)
    current_stage: str = Field(default="", max_length=80)


class CareerResumeState(_StrictContract):
    current_resume_id: int | None = Field(default=None, gt=0)
    current_version_id: int | None = Field(default=None, gt=0)
    current_version_number: int | None = Field(default=None, ge=0)
    workspace_revision: int = Field(default=0, ge=0)
    material_change_summary: str = Field(default="", max_length=400)
    has_material_change: bool = False
    jobs_using_older_resume: list[CareerResumeJobRef] = Field(default_factory=list, max_length=12)


class CareerLearningDigest(_StrictContract):
    repeated_weak_areas: list[str] = Field(default_factory=list, max_length=8)
    recurring_question_themes: list[str] = Field(default_factory=list, max_length=8)
    evidence_gap: list[dict[str, Any]] = Field(default_factory=list, max_length=8)
    asked_frequency: list[dict[str, Any]] = Field(default_factory=list, max_length=8)
    accepted_learning_count: int = Field(default=0, ge=0)
    pending_review_count: int = Field(default=0, ge=0)
    user_feedback_count: int = Field(default=0, ge=0)
    causal_hypothesis_count: int = Field(default=0, ge=0)
    confidence: Literal["low", "medium", "high"] = "low"
    recent_findings_count: int = Field(default=0, ge=0)
    user_corrections_count: int = Field(default=0, ge=0)

class CareerAttention(_StrictContract):
    pending_proposals: int = Field(default=0, ge=0)
    pending_memory_items: int = Field(default=0, ge=0)
    automation_inbox_pending: int = Field(default=0, ge=0)
    blocked_tasks: int = Field(default=0, ge=0)


class RoleFamilyFunnel(_StrictContract):
    role_family: str = Field(min_length=1, max_length=160)
    saved: int = Field(default=0, ge=0)
    applied: int = Field(default=0, ge=0)
    interview: int = Field(default=0, ge=0)
    offer: int = Field(default=0, ge=0)
    rejected: int = Field(default=0, ge=0)


class CareerPipelineDigest(_StrictContract):
    active_count: int = Field(default=0, ge=0)
    no_response_count: int = Field(default=0, ge=0)
    interview_count: int = Field(default=0, ge=0)
    rejected_count: int = Field(default=0, ge=0)
    offer_count: int = Field(default=0, ge=0)
    role_family_funnel: list[RoleFamilyFunnel] = Field(default_factory=list, max_length=12)


class CareerSnapshot(_StrictContract):
    contract_schema: Literal["offeru.career_snapshot.v2"] = Field(
        default="offeru.career_snapshot.v2", alias="schema"
    )
    profile_id: int | None = None
    identity: CareerIdentity
    goals: CareerGoals
    profile_coverage: CareerProfileCoverage
    resume: CareerResumeState = Field(default_factory=CareerResumeState)
    learning: CareerLearningDigest = Field(default_factory=CareerLearningDigest)
    attention: CareerAttention = Field(default_factory=CareerAttention)
    pipeline: CareerPipelineDigest = Field(default_factory=CareerPipelineDigest)
    strategy_pack: Literal["campus_search.v1", "experienced_search.v1"] | None = None


class CareerPriority(_StrictContract):
    priority: str = Field(min_length=1, max_length=240)
    why_now: str = Field(min_length=1, max_length=500)
    evidence_refs: list[str] = Field(default_factory=list, max_length=12)
    deadline: str | None = Field(default=None, max_length=80)
    confidence: CareerConfidence


class CareerActionTarget(_StrictContract):
    kind: Literal["profile", "job", "application", "interview", "follow_up"]
    id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_.:-]{1,160}$")


class CareerAction(_StrictContract):
    objective: str = Field(min_length=1, max_length=300)
    why_now: str = Field(min_length=1, max_length=500)
    action_key: str = Field(default="", max_length=80, pattern=r"^[a-z0-9_.-]{0,80}$")
    strategy_scope: Literal[
        "campus_search.v1", "experienced_search.v1", "agnostic"
    ] = "agnostic"
    evidence_refs: list[str] = Field(default_factory=list, max_length=12)
    skill: str = Field(default="", max_length=120)
    suggested_operations: list[str] = Field(default_factory=list, max_length=8)
    target_ref: CareerActionTarget | None = None
    autonomy_level: AutonomyLevel
    expected_outcome: str = Field(min_length=1, max_length=400)
    requires_user: bool
    dedupe_key: str = Field(min_length=1, max_length=180, pattern=r"^[A-Za-z0-9_.:-]{1,180}$")

    @model_validator(mode="after")
    def protected_actions_need_user(self) -> "CareerAction":
        if self.autonomy_level in {"L2", "L3"} and not self.requires_user:
            raise ValueError("L2/L3 Career Director actions must require the user")
        return self


class CareerQuestion(_StrictContract):
    question: str = Field(min_length=1, max_length=500)
    why_needed: str = Field(min_length=1, max_length=400)
    unlocks: str = Field(min_length=1, max_length=400)
    optional: bool = True


class JobEvidenceAlignment(_StrictContract):
    requirement: str = Field(min_length=1, max_length=260)
    evidence_ref: str = Field(min_length=1, max_length=180)
    match: Literal["strong", "partial", "missing"]
    rationale: str = Field(min_length=1, max_length=400)


class JobEvidenceGap(_StrictContract):
    requirement: str = Field(min_length=1, max_length=260)
    why_missing: str = Field(min_length=1, max_length=400)
    evidence_to_seek: str = Field(min_length=1, max_length=400)


class CareerCapabilityNeed(_StrictContract):
    relevance: Literal["needed", "useful", "not_now"]
    rationale: str = Field(min_length=1, max_length=400)


class JobAssessmentPlan(_StrictContract):
    job_id: int = Field(gt=0)
    fit: Literal["strong_match", "plausible_match", "stretch", "weak_match", "insufficient_evidence"]
    fit_rationale: str = Field(min_length=1, max_length=700)
    application_priority: Literal["high", "normal", "low", "hold"]
    evidence_alignment: list[JobEvidenceAlignment] = Field(default_factory=list, max_length=8)
    evidence_gaps: list[JobEvidenceGap] = Field(default_factory=list, max_length=8)
    role_intelligence: CareerCapabilityNeed
    resume_prep: CareerCapabilityNeed
    interview_prep: CareerCapabilityNeed
    recommended_operations: list[
        Literal[
            "build_role_benchmark",
            "prepare_resume_optimization",
            "prepare_role_interview_focus",
            "create_application_packet",
        ]
    ] = Field(default_factory=list, max_length=4)


class InterviewLearningCandidate(_StrictContract):
    candidate_type: Literal["potential_strength", "weak_area"]
    title: str = Field(min_length=1, max_length=180)
    summary: str = Field(min_length=1, max_length=500)
    answer_index: int = Field(ge=0, le=2)
    source_excerpt: str = Field(min_length=1, max_length=400)
    review_reason: str = Field(min_length=1, max_length=500)


class InterviewLifecyclePlan(_StrictContract):
    mode: Literal["prepare", "debrief", "learning_review"]
    calendar_event_id: int = Field(gt=0)
    summary: str = Field(min_length=1, max_length=1000)
    focus_areas: list[str] = Field(default_factory=list, max_length=6)
    practice_questions: list[str] = Field(default_factory=list, max_length=6)
    learning_candidates: list[InterviewLearningCandidate] = Field(
        default_factory=list, max_length=5
    )


class ReengagementPlanItem(_StrictContract):
    job_id: int = Field(gt=0)
    worth_reengaging: bool
    why: str = Field(min_length=1, max_length=400)
    suggested_angle: str = Field(default="", max_length=400)
    urgency: Literal["now", "soon", "monitor", "skip"] = "monitor"
    evidence_refs: list[str] = Field(default_factory=list, max_length=8)
    company: str = Field(default="", max_length=180)
    role: str = Field(default="", max_length=220)


class ResumeUpdatePlan(_StrictContract):
    resume_id: int = Field(gt=0)
    summary: str = Field(min_length=1, max_length=800)
    added_evidence_summary: str = Field(default="", max_length=500)
    candidates: list[ReengagementPlanItem] = Field(default_factory=list, max_length=8)



_SectionId = Annotated[int, Field(gt=0)]


class ResumePreparationRow(_StrictContract):
    """Existing resume row schema echoed by the verified row context."""

    section_type: str = Field(min_length=1, max_length=80)
    title: str = Field(default="", max_length=220)
    sort_order: int = Field(default=0, ge=0)
    visible: bool = True
    content_json: dict[str, Any] = Field(default_factory=dict)
    source_section_ids: list[_SectionId] = Field(default_factory=list, max_length=12)


class ResumePreparationRationale(_StrictContract):
    source_section_ids: list[_SectionId] = Field(default_factory=list, max_length=12)
    requirement: str = Field(min_length=1, max_length=500)
    why: str = Field(min_length=1, max_length=500)


class ResumePreparationQuestion(_StrictContract):
    question: str = Field(min_length=1, max_length=500)
    why_needed: str = Field(min_length=1, max_length=400)
    source_section_ids: list[_SectionId] = Field(default_factory=list, max_length=12)
    requirement: str = Field(min_length=1, max_length=500)


class ResumePreparationGap(_StrictContract):
    requirement: str = Field(min_length=1, max_length=500)
    status: Literal["unknown", "missing"]
    explanation: str = Field(min_length=1, max_length=500)


class ResumePreparation(_StrictContract):
    """Bounded resume tailoring proposal bound to a source fingerprint.

    ``source_fingerprint`` must echo the fingerprint emitted by
    ``get_resume_preparation_context``; persistence fails closed on mismatch so
    an in-flight source mutation can never be persisted. ``job_id`` /
    ``replaces_proposal_id`` are optional echoes that must agree with the task
    target when present.
    """

    source_fingerprint: str = Field(min_length=1, max_length=128)
    job_id: int | None = Field(default=None, gt=0)
    replaces_proposal_id: str | None = Field(default=None, max_length=160)
    rows: list[ResumePreparationRow] = Field(default_factory=list, max_length=40)
    rationale: list[ResumePreparationRationale] = Field(
        default_factory=list, max_length=20
    )
    questions: list[ResumePreparationQuestion] = Field(
        default_factory=list, max_length=3
    )
    gaps: list[ResumePreparationGap] = Field(default_factory=list, max_length=20)


class PreparedPracticeQuestion(_StrictContract):
    question: str = Field(min_length=1, max_length=500)
    focus: str = Field(default="", max_length=300)
    minutes: int = Field(gt=0, le=180)


class PreparedPracticePlan(_StrictContract):
    duration_minutes: int = Field(gt=0, le=600)
    questions: list[PreparedPracticeQuestion] = Field(
        default_factory=list, max_length=12
    )


class PreparedArtifact(_StrictContract):
    """A persisted-in-review deliverable the briefing materializes later."""

    artifact_type: Literal[
        "interview_prep", "follow_up_draft", "reengagement_candidate"
    ]
    title: str = Field(min_length=1, max_length=240)
    content_markdown: str = Field(min_length=1, max_length=20000)
    job_id: int | None = Field(default=None, gt=0)
    application_id: int | None = Field(default=None, gt=0)
    calendar_event_id: int | None = Field(default=None, gt=0)
    action_key: str = Field(
        default="", max_length=80, pattern=r"^[a-z0-9_.-]{0,80}$"
    )
    evidence_refs: list[str] = Field(default_factory=list, max_length=12)
    practice_plan: PreparedPracticePlan | None = None





class CareerBriefing(_StrictContract):
    contract_schema: Literal["offeru.career_briefing.v1"] = Field(
        default="offeru.career_briefing.v1", alias="schema"
    )
    career_stage: CareerStageAssessment
    strategy_pack: Literal["campus_search.v1", "experienced_search.v1"]
    situation_summary: str = Field(min_length=1, max_length=1200)
    profile_coverage: CareerProfileCoverage
    job_assessment: JobAssessmentPlan | None = None
    interview_lifecycle: InterviewLifecyclePlan | None = None
    resume_update: ResumeUpdatePlan | None = None
    resume_preparation: ResumePreparation | None = None
    prepared_artifacts: list[PreparedArtifact] = Field(
        default_factory=list, max_length=3
    )
    priorities: list[CareerPriority] = Field(default_factory=list, max_length=3)
    actions: list[CareerAction] = Field(default_factory=list, max_length=3)
    questions: list[CareerQuestion] = Field(default_factory=list, max_length=3)
    risks: list[str] = Field(default_factory=list, max_length=8)
    opportunities: list[str] = Field(default_factory=list, max_length=8)

    @model_validator(mode="after")
    def strategy_matches_track(self) -> "CareerBriefing":
        expected = (
            "campus_search.v1"
            if self.career_stage.track == "campus"
            else "experienced_search.v1"
        )
        if self.strategy_pack != expected:
            raise ValueError("strategy_pack must match the assessed career track")
        return self


def _safe_text(value: Any, *, limit: int = 360) -> str:
    if value is None:
        return ""
    return redact_sensitive_text(str(value).strip(), max_length=limit).strip()


def _archive_section(base_info: dict[str, Any], key: str, child: str) -> dict[str, Any]:
    archive = base_info.get("personal_archive")
    if not isinstance(archive, dict):
        return {}
    parent = archive.get(key)
    if not isinstance(parent, dict):
        return {}
    value = parent.get(child)
    return value if isinstance(value, dict) else {}


def _career_section_summary(section: ProfileSection) -> str:
    content = section.content_json if isinstance(section.content_json, dict) else {}
    normalized = content.get("normalized") if isinstance(content.get("normalized"), dict) else {}
    text = content.get("bullet") or content.get("description")
    if not text:
        text = "；".join(
            str(value)
            for value in normalized.values()
            if isinstance(value, (str, int, float)) and str(value).strip()
        )
    title = _safe_text(section.title, limit=120)
    summary = _safe_text(text, limit=260)
    display = " — ".join(part for part in (title, summary) if part)
    return f"profile-section:{section.id} {display}"[:420]


def _track_from_stage(stage: dict[str, Any] | None) -> str | None:
    if not isinstance(stage, dict):
        return None
    track = str(stage.get("track") or "").strip()
    return track if track in {"campus", "experienced"} else None


async def _build_resume_state(db: Any, profile_id: int | None) -> CareerResumeState:
    """Read canonical Resume truth: current version and which jobs used older ones."""
    resume_query = select(Resume).order_by(Resume.updated_at.desc())
    if profile_id is not None:
        resume_query = resume_query.where(
            (Resume.source_profile_id == profile_id) | (Resume.source_profile_id.is_(None))
        )
    resumes = (await db.execute(resume_query.limit(20))).scalars().all()
    if not resumes:
        return CareerResumeState()
    current = next((row for row in resumes if row.is_primary), resumes[0])
    current_version: ResumeVersion | None = None
    if current.current_version_id:
        current_version = await db.get(ResumeVersion, int(current.current_version_id))
    if current_version is None:
        current_version = (
            await db.execute(
                select(ResumeVersion)
                .where(ResumeVersion.resume_id == current.id)
                .order_by(ResumeVersion.version_number.desc())
                .limit(1)
            )
        ).scalars().first()
    current_version_number = int(current_version.version_number) if current_version else 0

    attempts = (
        await db.execute(
            select(ApplicationAttempt, Job)
            .join(Job, Job.id == ApplicationAttempt.job_id)
            .where(ApplicationAttempt.resume_version_id.is_not(None))
            .order_by(ApplicationAttempt.created_at.desc())
            .limit(200)
        )
    ).all()
    stage_rows = (
        await db.execute(
            select(ApplicationStageEvent.application_attempt_id, ApplicationStageEvent.stage, ApplicationStageEvent.occurred_at)
            .order_by(ApplicationStageEvent.occurred_at.desc())
        )
    ).all()
    latest_stage: dict[int, str] = {}
    for attempt_id, stage, _occurred in stage_rows:
        latest_stage.setdefault(int(attempt_id), str(stage))

    version_numbers: dict[int, int] = {}
    older_refs: list[CareerResumeJobRef] = []
    seen_jobs: set[int] = set()
    terminal = {"rejected", "offer", "withdrawn"}
    for attempt, job in attempts:
        if int(job.id) in seen_jobs:
            continue
        if attempt.resume_id is not None and int(attempt.resume_id) != int(current.id):
            continue
        ver_id = int(attempt.resume_version_id or 0)
        if ver_id and ver_id not in version_numbers:
            ver = await db.get(ResumeVersion, ver_id)
            version_numbers[ver_id] = int(ver.version_number) if ver else 0
        applied_version = version_numbers.get(ver_id, 0)
        stage = latest_stage.get(int(attempt.id), str(attempt.status or ""))
        if applied_version and current_version_number and applied_version < current_version_number:
            if stage.casefold() in terminal:
                continue
            seen_jobs.add(int(job.id))
            older_refs.append(
                CareerResumeJobRef(
                    job_id=int(job.id),
                    company=_safe_text(job.company, limit=180),
                    role=_safe_text(job.title, limit=220),
                    application_attempt_id=int(attempt.id),
                    applied_resume_version=applied_version,
                    current_stage=_safe_text(stage, limit=80),
                )
            )
        if len(older_refs) >= 12:
            break
    return CareerResumeState(
        current_resume_id=int(current.id),
        current_version_id=int(current_version.id) if current_version else None,
        current_version_number=current_version_number,
        workspace_revision=int(current.workspace_revision or 0),
        material_change_summary=_safe_text(current_version.change_summary if current_version else "", limit=400),
        has_material_change=bool(older_refs),
        jobs_using_older_resume=older_refs,
    )


async def _build_learning_digest(db: Any) -> CareerLearningDigest:
    """Project reviewed learning through the shared career_learning seam.

    Weak areas only count once accepted through the memory inbox on >=2
    distinct interviews; pending/unreviewed items surface as uncertainty,
    never as performance. Asked frequency stays a separate facet.
    """

    from app.services.career_learning import load_learning_evidence, project_learning

    items = await load_learning_evidence(
        db,
        observation_types=None,
        limit=200,
    )
    projection = project_learning(items)
    corrections = (
        await db.execute(
            select(func.count(MemoryProposal.id)).where(MemoryProposal.review_note.like("%stage%"))
        )
    ).scalar_one() or 0
    return CareerLearningDigest(
        repeated_weak_areas=projection.repeated_weak_areas,
        recurring_question_themes=projection.recurring_question_themes,
        evidence_gap=[row.model_dump(mode="json") for row in projection.evidence_gap[:8]],
        asked_frequency=[row.model_dump(mode="json") for row in projection.asked_frequency[:8]],
        accepted_learning_count=len(projection.accepted_learning),
        pending_review_count=projection.pending_review_count,
        user_feedback_count=len(projection.user_feedback),
        causal_hypothesis_count=len(projection.causal_hypothesis),
        confidence=projection.confidence,
        recent_findings_count=projection.findings_count,
        user_corrections_count=int(corrections),
    )


async def _build_attention(db: Any) -> CareerAttention:
    pending_memory = (
        await db.execute(select(func.count(MemoryProposal.id)).where(MemoryProposal.status == "pending"))
    ).scalar_one() or 0
    inbox_pending = (
        await db.execute(select(func.count(AutomationInboxItem.item_id)).where(AutomationInboxItem.status == "pending"))
    ).scalar_one() or 0
    blocked = (
        await db.execute(select(func.count(CareerTask.task_id)).where(CareerTask.status == "blocked"))
    ).scalar_one() or 0
    pending_proposals = (
        await db.execute(
            select(func.count(AutomationInboxItem.item_id)).where(
                AutomationInboxItem.status == "pending",
                AutomationInboxItem.category == "needs_approval",
            )
        )
    ).scalar_one() or 0
    return CareerAttention(
        pending_proposals=int(pending_proposals),
        pending_memory_items=int(pending_memory),
        automation_inbox_pending=int(inbox_pending),
        blocked_tasks=int(blocked),
    )


async def _build_pipeline_digest(db: Any) -> CareerPipelineDigest:
    attempts = (await db.execute(select(ApplicationAttempt))).scalars().all()
    latest_stage: dict[int, str] = {}
    stage_rows = (
        await db.execute(
            select(ApplicationStageEvent.application_attempt_id, ApplicationStageEvent.stage, ApplicationStageEvent.occurred_at)
            .order_by(ApplicationStageEvent.occurred_at.asc())
        )
    ).all()
    for attempt_id, stage, _occurred in stage_rows:
        latest_stage[int(attempt_id)] = str(stage)

    job_ids = [int(a.job_id) for a in attempts]
    jobs = {int(j.id): j for j in (await db.execute(select(Job).where(Job.id.in_(job_ids or [0])))).scalars().all()}
    family_rows = (
        await db.execute(
            select(RoleBenchmarkDocument.job_id, RoleBenchmarkDocument.role_family)
            .where(RoleBenchmarkDocument.job_id.is_not(None))
            .where(RoleBenchmarkDocument.role_family != "")
            .order_by(RoleBenchmarkDocument.created_at.desc())
        )
    ).all()
    family_by_job: dict[int, str] = {}
    for job_id, family in family_rows:
        family_by_job.setdefault(int(job_id), _safe_text(family, limit=160))

    counts = {"active": 0, "no_response": 0, "interview": 0, "rejected": 0, "offer": 0}
    funnel: dict[str, dict[str, int]] = {}
    saved_jobs = (await db.execute(select(func.count(Job.id)))).scalar_one() or 0
    for attempt in attempts:
        stage = latest_stage.get(int(attempt.id), str(attempt.status or "prepared")).casefold()
        family = family_by_job.get(int(attempt.job_id), "unclassified")
        bucket = funnel.setdefault(family, {"saved": 0, "applied": 0, "interview": 0, "offer": 0, "rejected": 0})
        bucket["saved"] += 1
        if stage in {"applied", "written_test", "assessment"}:
            counts["active"] += 1
            counts["no_response"] += 1
            bucket["applied"] += 1
        elif stage.startswith("interview"):
            counts["interview"] += 1
            bucket["interview"] += 1
        elif stage == "offer":
            counts["offer"] += 1
            bucket["offer"] += 1
        elif stage in {"rejected", "withdrawn"}:
            counts["rejected"] += 1
            bucket["rejected"] += 1
        else:
            counts["active"] += 1
    digest = CareerPipelineDigest(
        active_count=counts["active"],
        no_response_count=counts["no_response"],
        interview_count=counts["interview"],
        rejected_count=counts["rejected"],
        offer_count=counts["offer"],
        role_family_funnel=[
            RoleFamilyFunnel(role_family=name, **buckets)
            for name, buckets in sorted(funnel.items(), key=lambda kv: -sum(kv[1].values()))
        ][:12],
    )
    return digest


def _confirmed_stage(base_info: dict[str, Any]) -> CareerStageAssessment | None:
    raw = base_info.get("career_stage_correction")
    if raw is None:
        return None
    correction = CareerStageCorrection.model_validate(raw)
    return CareerStageAssessment(
        track=correction.track,
        substage=correction.substage,
        confidence="high",
        basis=["user-confirmed"],
    )


def _make_snapshot(
    *,
    profile_id: int | None,
    base_info: dict[str, Any],
    roles: list[ProfileTargetRole],
    sections: list[ProfileSection],
    resume: CareerResumeState | None = None,
    learning: CareerLearningDigest | None = None,
    attention: CareerAttention | None = None,
    pipeline: CareerPipelineDigest | None = None,
) -> CareerSnapshot:
    preferences = _archive_section(base_info, "applicationArchive", "jobPreference")
    campus = _archive_section(base_info, "applicationArchive", "campusFields")
    primary = [
        _safe_text(role.role_name, limit=120)
        for role in roles
        if role.fit == "primary" and str(role.role_name or "").strip()
    ]
    secondary = [
        _safe_text(role.role_name, limit=120)
        for role in roles
        if role.fit != "primary" and str(role.role_name or "").strip()
    ]
    raw_locations = preferences.get("expectedCities") or base_info.get("target_locations") or []
    locations = (
        [_safe_text(item, limit=100) for item in raw_locations if str(item).strip()]
        if isinstance(raw_locations, list)
        else [_safe_text(raw_locations, limit=100)]
        if str(raw_locations or "").strip()
        else []
    )
    strong: list[str] = []
    weak: list[str] = []
    has_education = False
    has_work_or_project = False
    for section in sections:
        section_type = str(section.section_type or "").casefold()
        has_education |= section_type == "education"
        has_work_or_project |= section_type in {"experience", "project"}
        summary = _career_section_summary(section)
        if not summary:
            continue
        if section.tier == "verified_fact" and float(section.confidence or 0) >= 0.75:
            strong.append(summary)
        elif section.tier != "preference":
            weak.append(summary)

    missing: list[str] = []
    unknowns: list[str] = []
    if not primary and not secondary:
        missing.append("目标岗位方向")
        unknowns.append("想优先尝试哪些岗位方向")
    if not has_education:
        unknowns.append("教育经历与毕业时间")
    if not has_work_or_project:
        missing.append("可验证的工作或项目经历")
    if not _confirmed_stage(base_info):
        unknowns.append("当前职业阶段尚未确认")

    state = _safe_text(
        preferences.get("currentJobSearchStatus")
        or base_info.get("employment_state"),
        limit=120,
    )
    compensation = _safe_text(
        preferences.get("expectedSalary") or base_info.get("expected_salary"),
        limit=160,
    )
    timing = _safe_text(
        preferences.get("availableStartDate")
        or base_info.get("target_timing")
        or campus.get("graduationDate"),
        limit=160,
    )
    confirmed = _confirmed_stage(base_info)
    return CareerSnapshot(
        profile_id=profile_id,
        identity=CareerIdentity(
            career_stage=confirmed,
            career_stage_source="user_confirmed" if confirmed else None,
            experience_years=(
                float(base_info["experience_years"])
                if isinstance(base_info.get("experience_years"), (int, float))
                and not isinstance(base_info.get("experience_years"), bool)
                and float(base_info["experience_years"]) >= 0
                else None
            ),
            current_role=_safe_text(base_info.get("current_role"), limit=200) or None,
            employment_state=state or None,
        ),
        goals=CareerGoals(
            primary_roles=primary,
            secondary_roles=secondary,
            locations=locations,
            compensation=compensation or None,
            timing=timing or None,
        ),
        profile_coverage=CareerProfileCoverage(
            strong_evidence=strong[:30],
            weak_evidence=weak[:30],
            missing_evidence=missing,
            unknowns=unknowns,
            underexpressed_strengths=[],
        ),
        resume=resume or CareerResumeState(),
        learning=learning or CareerLearningDigest(),
        attention=attention or CareerAttention(),
        pipeline=pipeline or CareerPipelineDigest(),
        strategy_pack=(
            "campus_search.v1" if _track_from_stage(confirmed.model_dump() if confirmed else None) == "campus"
            else "experienced_search.v1" if confirmed
            else None
        ),
    )


async def build_career_snapshot() -> dict[str, Any]:
    """Read canonical Profile truth without creating or normalizing rows."""

    async with async_session() as db:
        profile = (
            await db.execute(
                select(Profile)
                .where(Profile.is_default.is_(True))
                .order_by(Profile.id.asc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if profile is None:
            return _make_snapshot(
                profile_id=None,
                base_info={},
                roles=[],
                sections=[],
            ).model_dump(mode="json", by_alias=True)
        resume_state = await _build_resume_state(db, profile.id)
        learning_digest = await _build_learning_digest(db)
        attention = await _build_attention(db)
        pipeline_digest = await _build_pipeline_digest(db)
        roles = (
            await db.execute(
                select(ProfileTargetRole)
                .where(ProfileTargetRole.profile_id == profile.id)
                .order_by(ProfileTargetRole.created_at.asc(), ProfileTargetRole.id.asc())
            )
        ).scalars().all()
        sections = (
            await db.execute(
                select(ProfileSection)
                .where(ProfileSection.profile_id == profile.id)
                .where(ProfileSection.status == "active")
                .order_by(ProfileSection.sort_order.asc(), ProfileSection.created_at.asc())
            )
        ).scalars().all()
        base_info = (
            profile.base_info_json
            if isinstance(profile.base_info_json, dict)
            else {}
        )
        return _make_snapshot(
            profile_id=profile.id,
            base_info=base_info,
            roles=roles,
            sections=sections,
            resume=resume_state,
            learning=learning_digest,
            attention=attention,
            pipeline=pipeline_digest,
        ).model_dump(mode="json", by_alias=True)


async def correct_career_stage(*, track: CareerTrack, substage: CareerSubstage) -> dict[str, Any]:
    """Persist an explicit user correction as a narrow atomic Profile JSON update."""

    correction = CareerStageCorrection(track=track, substage=substage)
    async with async_session() as db:
        profile_id = (
            await db.execute(
                select(Profile.id)
                .where(Profile.is_default.is_(True))
                .order_by(Profile.id.asc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if profile_id is None:
            raise ValueError("先建立个人档案后才能确认职业方向")
        result = await db.execute(
            update(Profile)
            .where(Profile.id == profile_id)
            .values(
                base_info_json=func.json_set(
                    Profile.base_info_json,
                    "$.career_stage_correction",
                    func.json(json.dumps(correction.model_dump(mode="json", by_alias=True), ensure_ascii=False)),
                ),
                updated_at=func.now(),
            )
        )
        if result.rowcount != 1:
            raise ValueError("个人档案已变化，请刷新后重试")
        await db.commit()
    return {"changed": True, "snapshot": await build_career_snapshot()}


def parse_career_briefing_response(
    response: Any,
    *,
    confirmed_stage: CareerStageAssessment | None = None,
) -> dict[str, Any]:
    """Validate one model-issued CareerBriefing; never infer one in code."""

    if not isinstance(response, str) or not response.strip():
        raise ValueError("Career Director 没有返回结构化结果")
    try:
        payload = json.loads(response.strip())
    except json.JSONDecodeError as exc:
        raise ValueError("Career Director 输出必须是原始 JSON object") from exc
    if not isinstance(payload, dict):
        raise ValueError("Career Director 输出必须是 JSON object")
    briefing = CareerBriefing.model_validate(payload)
    if confirmed_stage is not None:
        # A user-confirmed stage is canonical. Keep the model's briefing, but
        # never let its stage or strategy pack undo the user's correction.
        briefing = briefing.model_copy(
            update={
                "career_stage": confirmed_stage,
                "strategy_pack": (
                    "campus_search.v1"
                    if confirmed_stage.track == "campus"
                    else "experienced_search.v1"
                ),
            }
        )
    return briefing.model_dump(mode="json", by_alias=True)


CAREER_BRIEFING_SCHEMA: dict[str, Any] = CareerBriefing.model_json_schema(by_alias=True)
