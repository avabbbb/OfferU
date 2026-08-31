"""Explicit Demo/Fixture data scope used by the local data-safety boundary."""

from __future__ import annotations

from typing import Any, Iterable

from sqlalchemy import delete, or_, select

from app.database import async_session
from app.models.models import (
    AgentRunEvent,
    AgentRunRecord,
    Application,
    ApplicationAttempt,
    ApplicationProgressCandidate,
    ApplicationRecord,
    ApplicationStageEvent,
    ApplicationTableRecord,
    AuthorizedResearchCapture,
    AuthorizedResearchSession,
    AutomationEvent,
    AutomationInboxItem,
    CalendarEvent,
    CareerTask,
    CareerTaskEvent,
    ExternalProgressSignal,
    HostedExecutorEvent,
    HostedExecutorSession,
    Interview,
    InterviewBehaviorEvent,
    InterviewEvaluationRun,
    InterviewExperience,
    InterviewMessage,
    InterviewQuestion,
    Job,
    JobResearchRun,
    JobSearchTask,
    ResearchDossier,
    ResearchEvidenceSnapshot,
    ResearchFinding,
    Resume,
    ResumeOptimizationProposal,
    ResumeSection,
    ResumeShare,
    ResumeVersion,
    RoleBenchmarkDocument,
    RoleBenchmarkRun,
    RoleCapabilityObservation,
    RoleDeltaSignal,
)
from app.services.career_artifacts import career_artifact_store
from app.services.data_safety import DataSafetyError


# These values are reserved for an explicitly synthetic local workspace. A
# real imported job must never match this pair accidentally.
DEMO_JOB_SOURCE = "offeru-demo"
DEMO_BATCH_ID = "offeru-demo-v1"
DEMO_TASK_SOURCE = "offeru-demo"


def _as_ints(values: Iterable[Any]) -> set[int]:
    return {int(value) for value in values if value is not None}


async def _ids(db: Any, model: Any, column: Any, condition: Any) -> set[int]:
    result = await db.execute(select(column).select_from(model).where(condition))
    return _as_ints(result.scalars().all())


async def _strings(db: Any, model: Any, column: Any, condition: Any) -> set[str]:
    result = await db.execute(select(column).select_from(model).where(condition))
    return {str(value) for value in result.scalars().all() if value is not None}


async def _delete_rows(
    db: Any,
    model: Any,
    condition: Any,
    counts: dict[str, int],
    name: str,
) -> None:
    result = await db.execute(delete(model).where(condition))
    counts[name] = int(result.rowcount or 0)


def _target_conditions(
    *,
    job_ids: set[int],
    application_ids: set[int],
    resume_ids: set[int],
    interview_ids: set[int],
) -> tuple[list[Any], list[Any], list[Any]]:
    task_conditions: list[Any] = []
    event_conditions: list[Any] = []
    inbox_conditions: list[Any] = []
    if job_ids:
        values = [str(value) for value in job_ids]
        task_conditions.append((CareerTask.target_type == "job") & CareerTask.target_id.in_(values))
        event_conditions.append((AutomationEvent.target_type == "job") & AutomationEvent.target_id.in_(values))
        inbox_conditions.append((AutomationInboxItem.target_type == "job") & AutomationInboxItem.target_id.in_(values))
    if application_ids:
        values = [str(value) for value in application_ids]
        task_conditions.append((CareerTask.target_type == "application") & CareerTask.target_id.in_(values))
        event_conditions.append((AutomationEvent.target_type == "application") & AutomationEvent.target_id.in_(values))
        inbox_conditions.append((AutomationInboxItem.target_type == "application") & AutomationInboxItem.target_id.in_(values))
    if resume_ids:
        values = [str(value) for value in resume_ids]
        task_conditions.append((CareerTask.target_type == "resume") & CareerTask.target_id.in_(values))
        event_conditions.append((AutomationEvent.target_type == "resume") & AutomationEvent.target_id.in_(values))
        inbox_conditions.append((AutomationInboxItem.target_type == "resume") & AutomationInboxItem.target_id.in_(values))
    if interview_ids:
        values = [str(value) for value in interview_ids]
        task_conditions.append((CareerTask.target_type == "interview") & CareerTask.target_id.in_(values))
        event_conditions.append((AutomationEvent.target_type == "interview") & AutomationEvent.target_id.in_(values))
        inbox_conditions.append((AutomationInboxItem.target_type == "interview") & AutomationInboxItem.target_id.in_(values))
    return task_conditions, event_conditions, inbox_conditions


async def reset_demo_data(*, user_confirmed: bool) -> dict[str, Any]:
    """Delete only records in the reserved synthetic Demo scope.

    This operation intentionally does not accept arbitrary IDs and never
    touches Profile, user-created Jobs, provider credentials, backups, or
    shared application tables. An empty scope is a successful, visible no-op.
    """

    if user_confirmed is not True:
        raise DataSafetyError("重置 Demo 数据必须由使用者明确确认。")

    counts: dict[str, int] = {}
    async with async_session() as db:
        job_ids = await _ids(
            db,
            Job,
            Job.id,
            (Job.source == DEMO_JOB_SOURCE) & (Job.batch_id == DEMO_BATCH_ID),
        )
        if not job_ids:
            return {
                "reset": False,
                "scope": {"source": DEMO_JOB_SOURCE, "batch_id": DEMO_BATCH_ID},
                "reason": "no_marked_demo_data",
                "deleted": {},
                "real_data_preserved": True,
            }

        application_ids = await _ids(
            db,
            Application,
            Application.id,
            Application.job_id.in_(job_ids),
        )
        attempt_ids = await _ids(
            db,
            ApplicationAttempt,
            ApplicationAttempt.id,
            ApplicationAttempt.job_id.in_(job_ids),
        )
        resume_conditions: list[Any] = [Resume.target_job_id.in_(job_ids)]
        if application_ids:
            resume_conditions.append(Resume.application_id.in_(application_ids))
        resume_ids = await _ids(db, Resume, Resume.id, or_(*resume_conditions))
        while resume_ids:
            child_ids = await _ids(
                db,
                Resume,
                Resume.id,
                Resume.source_resume_id.in_(resume_ids),
            )
            next_ids = child_ids - resume_ids
            if not next_ids:
                break
            resume_ids.update(next_ids)

        interview_ids = await _ids(
            db,
            Interview,
            Interview.id,
            or_(
                Interview.target_job_id.in_(job_ids),
                Interview.resume_id.in_(resume_ids) if resume_ids else False,
            ),
        )
        experience_ids = await _ids(
            db,
            InterviewExperience,
            InterviewExperience.id,
            InterviewExperience.job_id.in_(job_ids),
        )
        task_target_conditions, event_target_conditions, inbox_target_conditions = _target_conditions(
            job_ids=job_ids,
            application_ids=application_ids,
            resume_ids=resume_ids,
            interview_ids=interview_ids,
        )
        task_conditions = [CareerTask.source == DEMO_TASK_SOURCE, *task_target_conditions]
        task_ids = await _strings(db, CareerTask, CareerTask.task_id, or_(*task_conditions))
        search_task_ids = await _strings(
            db,
            JobSearchTask,
            JobSearchTask.task_id,
            JobSearchTask.primary_job_id.in_(job_ids),
        )
        task_ids.update(search_task_ids)

        # Remove the strictest children first because several legacy tables
        # use RESTRICT rather than relying on SQLite's cascade behavior.
        if interview_ids:
            await _delete_rows(
                db,
                InterviewEvaluationRun,
                InterviewEvaluationRun.interview_id.in_(interview_ids),
                counts,
                "interview_evaluation_runs",
            )
            await _delete_rows(
                db,
                InterviewBehaviorEvent,
                InterviewBehaviorEvent.interview_id.in_(interview_ids),
                counts,
                "interview_behavior_events",
            )
            await _delete_rows(
                db,
                InterviewMessage,
                InterviewMessage.interview_id.in_(interview_ids),
                counts,
                "interview_messages",
            )
        if experience_ids or job_ids:
            await _delete_rows(
                db,
                InterviewQuestion,
                or_(
                    InterviewQuestion.experience_id.in_(experience_ids),
                    InterviewQuestion.job_id.in_(job_ids),
                ),
                counts,
                "interview_questions",
            )

        candidate_ids = await _ids(
            db,
            ApplicationProgressCandidate,
            ApplicationProgressCandidate.id,
            or_(
                ApplicationProgressCandidate.suggested_attempt_id.in_(attempt_ids)
                if attempt_ids
                else False,
                ApplicationProgressCandidate.selected_attempt_id.in_(attempt_ids)
                if attempt_ids
                else False,
            ),
        )
        signal_ids: set[int] = set()
        if candidate_ids:
            signal_ids = await _ids(
                db,
                ApplicationProgressCandidate,
                ApplicationProgressCandidate.signal_id,
                ApplicationProgressCandidate.id.in_(candidate_ids),
            )
        stage_conditions: list[Any] = [
            ApplicationStageEvent.application_attempt_id.in_(attempt_ids)
            if attempt_ids
            else False,
            ApplicationStageEvent.candidate_id.in_(candidate_ids)
            if candidate_ids
            else False,
            ApplicationStageEvent.signal_id.in_(signal_ids) if signal_ids else False,
        ]
        await _delete_rows(
            db,
            ApplicationStageEvent,
            or_(*stage_conditions),
            counts,
            "application_stage_events",
        )
        if candidate_ids:
            await _delete_rows(
                db,
                ApplicationProgressCandidate,
                ApplicationProgressCandidate.id.in_(candidate_ids),
                counts,
                "application_progress_candidates",
            )
        if signal_ids:
            await _delete_rows(
                db,
                ExternalProgressSignal,
                ExternalProgressSignal.id.in_(signal_ids),
                counts,
                "external_progress_signals",
            )
        await _delete_rows(
            db,
            CalendarEvent,
            or_(
                CalendarEvent.related_job_id.in_(job_ids),
                CalendarEvent.related_signal_id.in_(signal_ids) if signal_ids else False,
            ),
            counts,
            "calendar_events",
        )
        await _delete_rows(
            db,
            AuthorizedResearchCapture,
            AuthorizedResearchCapture.job_id.in_(job_ids),
            counts,
            "authorized_research_captures",
        )
        await _delete_rows(
            db,
            AuthorizedResearchSession,
            AuthorizedResearchSession.job_id.in_(job_ids),
            counts,
            "authorized_research_sessions",
        )

        if task_ids:
            await _delete_rows(
                db,
                AgentRunEvent,
                AgentRunEvent.run_id.in_(
                    await _strings(
                        db,
                        AgentRunRecord,
                        AgentRunRecord.run_id,
                        AgentRunRecord.task_id.in_(task_ids),
                    )
                ),
                counts,
                "agent_run_events",
            )
            await _delete_rows(
                db,
                AgentRunRecord,
                AgentRunRecord.task_id.in_(task_ids),
                counts,
                "agent_runs",
            )
            await _delete_rows(
                db,
                HostedExecutorEvent,
                HostedExecutorEvent.session_id.in_(
                    await _strings(
                        db,
                        HostedExecutorSession,
                        HostedExecutorSession.session_id,
                        HostedExecutorSession.task_id.in_(task_ids),
                    )
                ),
                counts,
                "hosted_executor_events",
            )
            await _delete_rows(
                db,
                HostedExecutorSession,
                HostedExecutorSession.task_id.in_(task_ids),
                counts,
                "hosted_executor_sessions",
            )
            await _delete_rows(
                db,
                CareerTaskEvent,
                CareerTaskEvent.task_id.in_(task_ids),
                counts,
                "career_task_events",
            )

        if inbox_target_conditions:
            await _delete_rows(db, AutomationInboxItem, or_(*inbox_target_conditions), counts, "automation_inbox_items")
        if event_target_conditions:
            await _delete_rows(db, AutomationEvent, or_(*event_target_conditions), counts, "automation_events")
        if task_target_conditions:
            await _delete_rows(db, CareerTask, or_(*task_target_conditions), counts, "career_tasks")
        await _delete_rows(
            db,
            CareerTask,
            CareerTask.source == DEMO_TASK_SOURCE,
            counts,
            "career_tasks_by_demo_source",
        )
        await _delete_rows(
            db,
            AutomationEvent,
            AutomationEvent.source == DEMO_TASK_SOURCE,
            counts,
            "automation_events_by_demo_source",
        )
        await _delete_rows(
            db,
            AutomationInboxItem,
            AutomationInboxItem.target_id == DEMO_BATCH_ID,
            counts,
            "automation_inbox_items_by_demo_scope",
        )

        if experience_ids:
            await _delete_rows(
                db,
                InterviewExperience,
                InterviewExperience.id.in_(experience_ids),
                counts,
                "interview_experiences",
            )
        if interview_ids:
            await _delete_rows(
                db,
                Interview,
                Interview.id.in_(interview_ids),
                counts,
                "interviews",
            )

        await _delete_rows(
            db,
            ResumeOptimizationProposal,
            ResumeOptimizationProposal.job_id.in_(job_ids),
            counts,
            "resume_optimization_proposals",
        )
        if resume_ids:
            await _delete_rows(db, ResumeShare, ResumeShare.resume_id.in_(resume_ids), counts, "resume_shares")
            await _delete_rows(db, ResumeVersion, ResumeVersion.resume_id.in_(resume_ids), counts, "resume_versions")
            await _delete_rows(db, ResumeSection, ResumeSection.resume_id.in_(resume_ids), counts, "resume_sections")
            await _delete_rows(db, Resume, Resume.id.in_(resume_ids), counts, "resumes")

        if application_ids:
            await _delete_rows(db, Application, Application.id.in_(application_ids), counts, "applications")
        if attempt_ids:
            await _delete_rows(db, ApplicationAttempt, ApplicationAttempt.id.in_(attempt_ids), counts, "application_attempts")

        record_ids = await _ids(
            db,
            ApplicationRecord,
            ApplicationRecord.id,
            ApplicationRecord.job_ref_id.in_(job_ids),
        )
        if record_ids:
            await _delete_rows(db, ApplicationTableRecord, ApplicationTableRecord.record_id.in_(record_ids), counts, "application_table_records")
            await _delete_rows(db, ApplicationRecord, ApplicationRecord.id.in_(record_ids), counts, "application_records")

        benchmark_run_ids = await _strings(
            db,
            RoleBenchmarkRun,
            RoleBenchmarkRun.run_id,
            RoleBenchmarkRun.target_job_id.in_(job_ids),
        )
        if benchmark_run_ids:
            await _delete_rows(db, RoleCapabilityObservation, RoleCapabilityObservation.run_id.in_(benchmark_run_ids), counts, "role_capability_observations")
            await _delete_rows(db, RoleDeltaSignal, RoleDeltaSignal.run_id.in_(benchmark_run_ids), counts, "role_delta_signals")
            await _delete_rows(db, RoleBenchmarkDocument, RoleBenchmarkDocument.run_id.in_(benchmark_run_ids), counts, "role_benchmark_documents")
            await _delete_rows(db, RoleBenchmarkRun, RoleBenchmarkRun.run_id.in_(benchmark_run_ids), counts, "role_benchmark_runs")

        research_run_ids = await _strings(
            db,
            JobResearchRun,
            JobResearchRun.run_id,
            JobResearchRun.job_id.in_(job_ids),
        )
        dossier_ids = await _ids(
            db,
            ResearchDossier,
            ResearchDossier.id,
            ResearchDossier.job_id.in_(job_ids),
        )
        if research_run_ids:
            await _delete_rows(db, ResearchEvidenceSnapshot, ResearchEvidenceSnapshot.run_id.in_(research_run_ids), counts, "research_evidence_snapshots")
            await _delete_rows(db, ResearchFinding, ResearchFinding.run_id.in_(research_run_ids), counts, "research_findings")
            await _delete_rows(db, JobResearchRun, JobResearchRun.run_id.in_(research_run_ids), counts, "job_research_runs")
        if dossier_ids:
            await _delete_rows(db, ResearchDossier, ResearchDossier.id.in_(dossier_ids), counts, "research_dossiers")

        search_task_ids = await _strings(
            db,
            JobSearchTask,
            JobSearchTask.task_id,
            JobSearchTask.primary_job_id.in_(job_ids),
        )
        if search_task_ids:
            await _delete_rows(db, JobSearchTask, JobSearchTask.task_id.in_(search_task_ids), counts, "job_search_tasks")

        artifact_result = career_artifact_store.delete_for_scope(job_ids=job_ids, application_ids=application_ids)
        counts["career_artifacts"] = int(artifact_result.get("deleted", 0))
        await _delete_rows(db, Job, Job.id.in_(job_ids), counts, "jobs")

        # Batch is a bookkeeping marker, not a user-facing workspace. Only the
        # reserved exact ID is eligible for cleanup.
        from app.models.models import Batch

        await _delete_rows(db, Batch, Batch.id == DEMO_BATCH_ID, counts, "batches")
        await db.commit()

    return {
        "reset": True,
        "scope": {"source": DEMO_JOB_SOURCE, "batch_id": DEMO_BATCH_ID},
        "matched_jobs": len(job_ids),
        "deleted": {key: value for key, value in counts.items() if value},
        "real_data_preserved": True,
    }
