"""Read-only, bounded context used for first-party Job Saved assessment."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from app.database import async_session
from app.models.models import (
    ApplicationAttempt,
    CalendarEvent,
    CareerTask,
    Job,
    ResumeOptimizationProposal,
    RoleBenchmarkRun,
)
from app.services.security_redaction import redact_sensitive_text


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class JobAssessmentTarget(_StrictModel):
    job_id: int = Field(gt=0)
    title: str = Field(max_length=500)
    company: str = Field(max_length=300)
    location: str = Field(default="", max_length=300)
    salary: str = Field(default="", max_length=100)
    experience: str = Field(default="", max_length=100)
    education: str = Field(default="", max_length=50)
    job_type: str = Field(default="", max_length=50)
    is_campus: bool
    summary: str = Field(default="", max_length=1800)
    keywords: list[str] = Field(default_factory=list, max_length=40)
    description: str = Field(default="", max_length=9000)
    description_is_untrusted: Literal[True] = True


class JobRoleIntelligenceState(_StrictModel):
    task_status: str = Field(default="not_started", max_length=32)
    task_id: str = Field(default="", max_length=80)
    benchmark_run_id: str = Field(default="", max_length=64)
    benchmark_status: str = Field(default="", max_length=24)
    valid_sample_count: int = Field(default=0, ge=0)
    data_mode: str = Field(default="", max_length=40)
    updated_at: str = Field(default="", max_length=50)


class JobExistingApplication(_StrictModel):
    application_attempt_id: int = Field(gt=0)
    status: str = Field(max_length=50)
    created_at: str = Field(max_length=50)


class JobExistingMaterial(_StrictModel):
    proposal_id: str = Field(max_length=64)
    status: str = Field(max_length=24)
    updated_at: str = Field(max_length=50)


class JobUpcomingInterview(_StrictModel):
    event_id: int = Field(gt=0)
    title: str = Field(max_length=220)
    starts_at: str = Field(max_length=50)


class JobAssessmentContext(_StrictModel):
    contract_schema: Literal["offeru.job_assessment_context.v1"] = Field(
        default="offeru.job_assessment_context.v1", alias="schema"
    )
    job: JobAssessmentTarget
    role_intelligence: JobRoleIntelligenceState
    application_attempts: list[JobExistingApplication] = Field(default_factory=list, max_length=5)
    resume_materials: list[JobExistingMaterial] = Field(default_factory=list, max_length=5)
    upcoming_interviews: list[JobUpcomingInterview] = Field(default_factory=list, max_length=5)


def _safe(value: Any, limit: int) -> str:
    return redact_sensitive_text(str(value or "").strip(), max_length=limit).strip()


def _iso(value: Any) -> str:
    return value.isoformat() if isinstance(value, datetime) else str(value or "")[:50]


async def build_job_assessment_context(*, job_id: int) -> dict[str, Any]:
    """Read one canonical Job Workspace plus compact existing task state."""

    clean_job_id = int(job_id)
    async with async_session() as db:
        job = await db.get(Job, clean_job_id)
        if job is None:
            raise ValueError(f"Job #{clean_job_id} 不存在")

        role_task = (
            await db.execute(
                select(CareerTask)
                .where(CareerTask.task_type == "role_intelligence")
                .where(CareerTask.target_type == "job")
                .where(CareerTask.target_id == str(clean_job_id))
                .order_by(CareerTask.created_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        benchmark = (
            await db.execute(
                select(RoleBenchmarkRun)
                .where(RoleBenchmarkRun.target_job_id == clean_job_id)
                .order_by(RoleBenchmarkRun.created_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        applications = (
            await db.execute(
                select(ApplicationAttempt)
                .where(ApplicationAttempt.job_id == clean_job_id)
                .order_by(ApplicationAttempt.created_at.desc(), ApplicationAttempt.id.desc())
                .limit(5)
            )
        ).scalars().all()
        materials = (
            await db.execute(
                select(ResumeOptimizationProposal)
                .where(ResumeOptimizationProposal.job_id == clean_job_id)
                .order_by(ResumeOptimizationProposal.updated_at.desc())
                .limit(5)
            )
        ).scalars().all()
        now = datetime.now().astimezone().replace(tzinfo=None)
        events = (
            await db.execute(
                select(CalendarEvent)
                .where(CalendarEvent.event_type == "interview")
                .where(CalendarEvent.related_job_id == clean_job_id)
                .where(CalendarEvent.start_time >= now)
                .where(CalendarEvent.start_time <= now + timedelta(days=30))
                .order_by(CalendarEvent.start_time.asc())
                .limit(5)
            )
        ).scalars().all()

        job_context = JobAssessmentTarget(
            job_id=clean_job_id,
            title=_safe(job.title, 500),
            company=_safe(job.company, 300),
            location=_safe(job.location, 300),
            salary=_safe(job.salary_text, 100),
            experience=_safe(job.experience, 100),
            education=_safe(job.education, 50),
            job_type=_safe(job.job_type, 50),
            is_campus=bool(job.is_campus),
            summary=_safe(job.summary, 1800),
            keywords=[_safe(value, 100) for value in (job.keywords or []) if str(value).strip()][:40],
            description=_safe(job.raw_description, 9000),
        )
        benchmark_result = benchmark.result_json if benchmark and isinstance(benchmark.result_json, dict) else {}
        return JobAssessmentContext(
            job=job_context,
            role_intelligence=JobRoleIntelligenceState(
                task_status=role_task.status if role_task else "not_started",
                task_id=role_task.task_id if role_task else "",
                benchmark_run_id=benchmark.run_id if benchmark else "",
                benchmark_status=benchmark.status if benchmark else "",
                valid_sample_count=int(benchmark.valid_sample_count or 0) if benchmark else 0,
                data_mode=_safe(benchmark_result.get("data_mode"), 40),
                updated_at=_iso(benchmark.updated_at if benchmark else None),
            ),
            application_attempts=[
                JobExistingApplication(
                    application_attempt_id=row.id,
                    status=_safe(row.status, 50),
                    created_at=_iso(row.created_at),
                )
                for row in applications
            ],
            resume_materials=[
                JobExistingMaterial(
                    proposal_id=row.proposal_id,
                    status=_safe(row.status, 24),
                    updated_at=_iso(row.updated_at),
                )
                for row in materials
            ],
            upcoming_interviews=[
                JobUpcomingInterview(
                    event_id=event.id,
                    title=_safe(event.title, 220),
                    starts_at=_iso(event.start_time),
                )
                for event in events
            ],
        ).model_dump(mode="json", by_alias=True)
