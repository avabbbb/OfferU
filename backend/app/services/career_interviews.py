"""Bounded Career Director context and user-submitted interview debriefs."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import and_, select

from app.database import async_session
from app.models.models import (
    AutomationEvent,
    CalendarEvent,
    CareerSource,
    CareerTask,
    EvidenceLink,
    LearningObservation,
    MemoryProposal,
)
from app.services.career_job_assessment import build_job_assessment_context
from app.services.security_redaction import redact_sensitive_text


class _StrictContext(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class InterviewEventContext(_StrictContext):
    calendar_event_id: int = Field(gt=0)
    title: str = Field(max_length=300)
    starts_at: str = Field(max_length=50)
    ends_at: str = Field(default="", max_length=50)
    location: str = Field(default="", max_length=300)
    job_id: int | None = Field(default=None, gt=0)


class InterviewLearningContext(_StrictContext):
    summary: str = Field(default="", max_length=500)
    learning_type: Literal["potential_strength", "weak_area", "interview_assessment"]
    review_status: Literal["accepted", "pending", "deferred", "unreviewed"]
    weak_areas: list[str] = Field(default_factory=list, max_length=6)
    observed_at: str = Field(max_length=50)
    source: str = Field(max_length=160)


class InterviewCareerContext(_StrictContext):
    contract_schema: Literal["offeru.interview_career_context.v1"] = Field(
        default="offeru.interview_career_context.v1", alias="schema"
    )
    interview: InterviewEventContext
    job_assessment: dict[str, Any] | None = None
    previous_learning: list[InterviewLearningContext] = Field(default_factory=list, max_length=8)
    repeated_weak_areas: list[str] = Field(default_factory=list, max_length=8)
    debrief_answers: list[dict[str, str]] = Field(default_factory=list, max_length=3)


def _safe(value: Any, limit: int = 360) -> str:
    return redact_sensitive_text(str(value or "").strip(), max_length=limit).strip()


async def get_interview_career_context(
    *, calendar_event_id: int, automation_event_id: str = ""
) -> dict[str, Any]:
    """Read one scheduled interview, its job plan, and compact prior learning."""

    async with async_session() as db:
        interview = await db.get(CalendarEvent, int(calendar_event_id))
        if interview is None or interview.event_type != "interview":
            raise ValueError("Interview calendar event does not exist")
        job_id = int(interview.related_job_id) if interview.related_job_id else None
        learning_rows = (
            await db.execute(
                select(LearningObservation, CareerSource)
                .join(CareerSource, CareerSource.id == LearningObservation.source_id)
                .where(LearningObservation.status == "active")
                .where(
                    LearningObservation.observation_type.in_(
                        ("interview_completed", "interview_debrief_candidate")
                    )
                )
                .where(CareerSource.status == "active")
                .order_by(LearningObservation.observed_at.desc())
                .limit(8)
            )
        ).all()
        observation_ids = [int(observation.id) for observation, _source in learning_rows]
        review_status_by_observation: dict[int, str] = {}
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
        interview_view = InterviewEventContext(
            calendar_event_id=interview.id,
            title=_safe(interview.title, 300),
            starts_at=interview.start_time.isoformat(),
            ends_at=interview.end_time.isoformat() if interview.end_time else "",
            location=_safe(interview.location, 300),
            job_id=job_id,
        )

    job_context = (
        await build_job_assessment_context(job_id=job_id) if job_id is not None else None
    )
    learning: list[InterviewLearningContext] = []
    weak_area_counts: dict[str, int] = {}
    for observation, source in learning_rows:
        content = observation.content_json if isinstance(observation.content_json, dict) else {}
        learning_type = str(content.get("candidate_type") or "interview_assessment")
        if learning_type not in {"potential_strength", "weak_area", "interview_assessment"}:
            learning_type = "interview_assessment"
        review_status = review_status_by_observation.get(int(observation.id), "unreviewed")
        if review_status not in {"accepted", "pending", "deferred", "unreviewed"}:
            continue
        role_intelligence = (
            content.get("role_intelligence")
            if isinstance(content.get("role_intelligence"), dict)
            else {}
        )
        focuses = role_intelligence.get("focuses") if isinstance(role_intelligence.get("focuses"), list) else []
        weak_areas = [
            _safe(area, 180)
            for focus in focuses
            if isinstance(focus, dict)
            for area in (focus.get("observed_answer_gaps") or [])
            if str(area or "").strip()
        ][:6]
        summary = _safe(content.get("summary"), 500)
        if review_status == "accepted":
            accepted_weak_areas = weak_areas or ([summary] if learning_type == "weak_area" and summary else [])
            for area in accepted_weak_areas:
                weak_area_counts[area] = weak_area_counts.get(area, 0) + 1
        learning.append(InterviewLearningContext(
            summary=summary,
            learning_type=learning_type,
            review_status=review_status,
            weak_areas=(weak_areas or ([summary] if learning_type == "weak_area" and summary else []))
            if review_status == "accepted" else [],
            observed_at=observation.observed_at.isoformat(),
            source=_safe(source.title, 160),
        ))

    debrief_answers: list[dict[str, str]] = []
    if automation_event_id:
        async with async_session() as db:
            event = await db.get(AutomationEvent, automation_event_id)
        if event is None or event.target_id != str(calendar_event_id):
            raise ValueError("Automation event does not match the interview target")
        if event.event_type == "INTERVIEW_DEBRIEF_CREATED":
            event_payload = event.payload_json if isinstance(event.payload_json, dict) else {}
            raw_answers = event_payload.get("answers")
            if isinstance(raw_answers, list):
                debrief_answers = [
                    {
                        "question": _safe(row.get("question"), 500),
                        "answer": _safe(row.get("answer"), 5000),
                    }
                    for row in raw_answers[:3]
                    if isinstance(row, dict)
                ]

    repeated = sorted(
        weak_area_counts,
        key=lambda area: (-weak_area_counts[area], area.casefold()),
    )[:8]
    return InterviewCareerContext(
        interview=interview_view,
        job_assessment=job_context,
        previous_learning=learning,
        repeated_weak_areas=repeated,
        debrief_answers=debrief_answers,
    ).model_dump(mode="json", by_alias=True)


async def submit_interview_debrief(
    *, calendar_event_id: int, answers: list[str]
) -> dict[str, Any]:
    """Persist the owner's answers as one idempotent Career Director event."""

    event_key = f"calendar-interview-completed:{int(calendar_event_id)}"
    async with async_session() as db:
        completed_event = (
            await db.execute(
                select(AutomationEvent).where(AutomationEvent.dedupe_key == event_key)
            )
        ).scalar_one_or_none()
        if completed_event is None or completed_event.status != "completed":
            raise ValueError("The completed interview debrief prompt is not ready")
        task_id = str((completed_event.result_json or {}).get("task_id") or "")
        task = await db.get(CareerTask, task_id) if task_id else None
        task_result = task.result_json if task and isinstance(task.result_json, dict) else {}
        briefing = task_result.get("briefing") if isinstance(task_result.get("briefing"), dict) else {}
        questions = briefing.get("questions") if isinstance(briefing.get("questions"), list) else []
        interview = await db.get(CalendarEvent, int(calendar_event_id))
        if interview is None or interview.event_type != "interview":
            raise ValueError("Interview calendar event does not exist")
        if task is None or task.status != "completed" or not questions:
            raise ValueError("The interview debrief questions are unavailable")
        if len(answers) != len(questions) or len(answers) > 3:
            raise ValueError("Answers must match the current debrief questions")
        normalized_answers = [
            {
                "question": _safe(question.get("question"), 500),
                "answer": _safe(answer, 5000),
            }
            for question, answer in zip(questions, answers, strict=True)
            if isinstance(question, dict)
        ]
        if not any(item["answer"] for item in normalized_answers):
            raise ValueError("At least one interview debrief answer is required")
        company = ""
        role = ""
        if interview.related_job_id:
            from app.models.models import Job

            job = await db.get(Job, interview.related_job_id)
            if job is not None:
                company = _safe(job.company, 200)
                role = _safe(job.title, 200)

    from app.ops import execute_operation

    result = await execute_operation(
        "record_automation_event",
        {
            "event_type": "INTERVIEW_DEBRIEF_CREATED",
            "source": "today_interview_debrief",
            "target_type": "interview",
            "target_id": str(calendar_event_id),
            "payload": {
                "calendar_event_id": int(calendar_event_id),
                "job_id": interview.related_job_id,
                "company": company,
                "role": role,
                "answers": normalized_answers,
                "runtime_provider": "codex",
            },
            "dedupe_key": f"calendar-interview-debrief:{int(calendar_event_id)}",
        },
        surface="interview_debrief_ui",
    )
    if not result.get("ok") or not isinstance(result.get("outputs"), dict):
        raise RuntimeError("Could not start the interview learning review")

    task_id = str(completed_event.result_json.get("task_id") or "")
    if task_id:
        await execute_operation(
            "resolve_automation_inbox_item",
            {"item_id": f"automation_task_{task_id}", "action": "resolve"},
            surface="interview_debrief_ui",
        )
    return result["outputs"]
