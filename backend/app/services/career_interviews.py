"""Bounded Career Director context and user-submitted interview debriefs."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from app.database import async_session
from app.models.models import (
    AutomationEvent,
    CalendarEvent,
    CareerTask,
    InterviewNotification,
)
from app.services.career_job_assessment import build_job_assessment_context
from app.services.career_learning import (
    LearningEvidence,
    REVIEW_STATUSES,
    load_learning_evidence,
    project_learning,
)
from app.services.security_redaction import redact_sensitive_text


class _StrictContext(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


INTERVIEW_LIFECYCLE_STATUSES = frozenset(
    {
        "scheduled",
        "assumed_elapsed",
        "user_confirmed_completed",
        "cancelled",
        "rescheduled",
    }
)


class InterviewEventContext(_StrictContext):
    calendar_event_id: int = Field(gt=0)
    title: str = Field(max_length=300)
    starts_at: str = Field(max_length=50)
    ends_at: str = Field(default="", max_length=50)
    location: str = Field(default="", max_length=300)
    job_id: int | None = Field(default=None, gt=0)
    status: Literal[
        "scheduled",
        "assumed_elapsed",
        "user_confirmed_completed",
        "cancelled",
        "rescheduled",
    ] = "scheduled"
    status_basis: str = Field(default="", max_length=160)
    confirmed_at: str = Field(default="", max_length=50)


class InterviewLearningContext(_StrictContext):
    summary: str = Field(default="", max_length=500)
    learning_type: Literal["potential_strength", "weak_area", "interview_assessment"]
    review_status: Literal[
        "accepted",
        "pending",
        "deferred",
        "unreviewed",
        "rejected",
        "revoked",
        "invalidated",
        "superseded",
        "applying",
    ]
    weak_areas: list[str] = Field(default_factory=list, max_length=6)
    observation_id: int | None = Field(default=None, gt=0)
    proposal_id: int | None = Field(default=None, gt=0)
    interview_key: str = Field(default="", max_length=80)
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
    evidence_gap: list[dict[str, Any]] = Field(default_factory=list, max_length=8)
    asked_frequency: list[dict[str, Any]] = Field(default_factory=list, max_length=8)
    learning_confidence: Literal["low", "medium", "high"] = "low"
    debrief_answers: list[dict[str, str]] = Field(default_factory=list, max_length=3)


def _safe(value: Any, limit: int = 360) -> str:
    return redact_sensitive_text(str(value or "").strip(), max_length=limit).strip()


def _naive(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is not None:
        return value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


async def load_interview_lifecycle_states(
    db: Any, events: list[CalendarEvent]
) -> dict[int, dict[str, Any]]:
    """Derive each interview's lifecycle status from canonical fields only.

    - ``user_confirmed_completed``: an INTERVIEW_DEBRIEF_CREATED event exists —
      only the owner's debrief submission confirms the interview happened.
    - ``cancelled``: the linked InterviewNotification is a rejection.
    - ``rescheduled``: a sibling interview shares the same notification/signal
      id with a later start_time (the new slot is canonical).
    - ``assumed_elapsed``: end_time (or start+1h) passed with no confirmation —
      elapsed never implies completed.
    - ``scheduled``: everything else, including currently-in-progress events.
    """

    result: dict[int, dict[str, Any]] = {}
    if not events:
        return result
    target_ids = [str(int(event.id)) for event in events]
    debrief_rows = (
        await db.execute(
            select(AutomationEvent.target_id, AutomationEvent.created_at)
            .where(AutomationEvent.event_type == "INTERVIEW_DEBRIEF_CREATED")
            .where(AutomationEvent.target_type == "interview")
            .where(AutomationEvent.target_id.in_(target_ids))
            .order_by(AutomationEvent.created_at.desc())
        )
    ).all()
    confirmed_at_by_id = {
        int(target_id): created_at for target_id, created_at in debrief_rows
    }

    notification_ids = {
        int(event.related_notification_id)
        for event in events
        if event.related_notification_id
    }
    signal_ids = {
        int(event.related_signal_id) for event in events if event.related_signal_id
    }
    rejected_notifications: set[int] = set()
    if notification_ids:
        rejected_notifications = {
            int(row_id)
            for (row_id,) in (
                await db.execute(
                    select(InterviewNotification.id).where(
                        InterviewNotification.id.in_(notification_ids),
                        InterviewNotification.category == "rejection",
                    )
                )
            ).all()
        }

    # Pull sibling interviews sharing the same notification/signal so a
    # re-issued slot marks the earlier row rescheduled even when the caller
    # only asked about one event.
    siblings: dict[tuple[str, int], list[CalendarEvent]] = {}
    if notification_ids or signal_ids:
        from sqlalchemy import or_

        conditions = []
        if notification_ids:
            conditions.append(
                CalendarEvent.related_notification_id.in_(notification_ids)
            )
        if signal_ids:
            conditions.append(CalendarEvent.related_signal_id.in_(signal_ids))
        sibling_rows = (
            await db.execute(
                select(CalendarEvent)
                .where(CalendarEvent.event_type == "interview")
                .where(or_(*conditions))
            )
        ).scalars().all()
        grouped = {int(event.id): event for event in events}
        for row in sibling_rows:
            grouped.setdefault(int(row.id), row)
        for event in grouped.values():
            if event.related_notification_id:
                siblings.setdefault(
                    ("notification", int(event.related_notification_id)), []
                ).append(event)
            if event.related_signal_id:
                siblings.setdefault(
                    ("signal", int(event.related_signal_id)), []
                ).append(event)
    else:
        for event in events:
            if event.related_notification_id:
                siblings.setdefault(
                    ("notification", int(event.related_notification_id)), []
                ).append(event)
            if event.related_signal_id:
                siblings.setdefault(
                    ("signal", int(event.related_signal_id)), []
                ).append(event)
    rescheduled_by: dict[int, int] = {}
    for group in siblings.values():
        if len(group) < 2:
            continue
        latest = max(group, key=lambda item: _naive(item.start_time) or datetime.min)
        latest_start = _naive(latest.start_time) or datetime.min
        for item in group:
            if int(item.id) == int(latest.id):
                continue
            start = _naive(item.start_time) or datetime.min
            if start < latest_start:
                rescheduled_by[int(item.id)] = int(latest.id)

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    for event in events:
        event_id = int(event.id)
        start = _naive(event.start_time)
        end = _naive(event.end_time) or (
            start + timedelta(hours=1) if start is not None else None
        )
        confirmed_at = confirmed_at_by_id.get(event_id)
        if confirmed_at is not None:
            status, basis = "user_confirmed_completed", "debrief_submitted"
        elif int(event.related_notification_id or 0) in rejected_notifications:
            status, basis = "cancelled", "notification_category:rejection"
        elif event_id in rescheduled_by:
            status, basis = "rescheduled", f"superseded_by:{rescheduled_by[event_id]}"
        elif end is not None and end <= now:
            status, basis = "assumed_elapsed", "end_time_passed"
        else:
            status, basis = "scheduled", "future_or_in_progress"
        result[event_id] = {
            "status": status,
            "status_basis": basis,
            "confirmed_at": confirmed_at.isoformat() if confirmed_at else "",
        }
    return result


def _learning_context(item: LearningEvidence) -> InterviewLearningContext | None:
    review_status = (
        item.review_status if item.review_status in REVIEW_STATUSES else "unreviewed"
    )
    learning_type = item.candidate_type or "interview_assessment"
    if learning_type not in {"potential_strength", "weak_area", "interview_assessment"}:
        learning_type = "interview_assessment"
    weak_areas = item.weak_topics[:6] if item.accepted else []
    if not weak_areas and item.accepted and learning_type == "weak_area" and item.summary:
        weak_areas = [item.summary]
    return InterviewLearningContext(
        summary=item.summary,
        learning_type=learning_type,
        review_status=review_status,  # type: ignore[arg-type]
        weak_areas=weak_areas,
        observation_id=item.observation_id,
        proposal_id=item.proposal_id,
        interview_key=item.interview_key,
        observed_at=item.observed_at,
        source=item.source_title,
    )


async def get_interview_career_context(
    *, calendar_event_id: int, automation_event_id: str = ""
) -> dict[str, Any]:
    """Read one interview's real lifecycle status, job plan, and reviewed learning."""

    async with async_session() as db:
        interview = await db.get(CalendarEvent, int(calendar_event_id))
        if interview is None or interview.event_type != "interview":
            raise ValueError("Interview calendar event does not exist")
        job_id = int(interview.related_job_id) if interview.related_job_id else None
        states = await load_interview_lifecycle_states(db, [interview])
        state = states.get(int(interview.id), {})
        items = await load_learning_evidence(db, limit=200)
        interview_view = InterviewEventContext(
            calendar_event_id=interview.id,
            title=_safe(interview.title, 300),
            starts_at=interview.start_time.isoformat(),
            ends_at=interview.end_time.isoformat() if interview.end_time else "",
            location=_safe(interview.location, 300),
            job_id=job_id,
            status=state.get("status") or "scheduled",
            status_basis=state.get("status_basis") or "",
            confirmed_at=state.get("confirmed_at") or "",
        )

    job_context = (
        await build_job_assessment_context(job_id=job_id) if job_id is not None else None
    )
    projection = project_learning(items)
    learning = [
        view
        for view in (_learning_context(item) for item in items[:8])
        if view is not None
    ]

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

    return InterviewCareerContext(
        interview=interview_view,
        job_assessment=job_context,
        previous_learning=learning,
        repeated_weak_areas=projection.repeated_weak_areas,
        evidence_gap=[
            row.model_dump(mode="json") for row in projection.evidence_gap[:8]
        ],
        asked_frequency=[
            row.model_dump(mode="json") for row in projection.asked_frequency[:8]
        ],
        learning_confidence=projection.confidence,
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
