"""Export the local user's career data without exporting connection secrets."""

from __future__ import annotations

from datetime import date, datetime, timezone
import re
from typing import Any

from sqlalchemy import select

from app.database import async_session
from app.models.models import (
    Application,
    ApplicationAttempt,
    ApplicationProgressCandidate,
    ApplicationRecord,
    ApplicationStageEvent,
    ApplicationTable,
    ApplicationTableRecord,
    AutomationEvent,
    AutomationInboxItem,
    CalendarEvent,
    CareerSource,
    CareerTask,
    CareerTaskEvent,
    EvidenceLink,
    ExternalProgressSignal,
    Interview,
    InterviewBehaviorEvent,
    InterviewEvaluationRun,
    InterviewExperience,
    InterviewMessage,
    InterviewQuestion,
    Job,
    JobResearchRun,
    LearningObservation,
    MemoryProposal,
    Pool,
    Profile,
    ProfileSection,
    ProfileTargetRole,
    ResearchDossier,
    ResearchEvidenceSnapshot,
    ResearchFinding,
    Resume,
    ResumeOptimizationProposal,
    ResumeSection,
    ResumeVersion,
    RoleBenchmarkDocument,
    RoleBenchmarkRun,
    RoleCapabilityObservation,
    RoleDeltaSignal,
)
from app.services.career_artifacts import career_artifact_store


_REDACTED_KEY = re.compile(
    r"(?:api[_-]?key|token|authorization|"
    r"password|secret|credential|cookie|session[_-]?token|share[_-]?token)",
    re.IGNORECASE,
)

# These are durable user-facing career records. Connection accounts, provider
# configs, audit inputs, and temporary browser state intentionally stay out.
_EXPORT_COLLECTIONS: tuple[tuple[str, type[Any]], ...] = (
    ("profiles", Profile),
    ("profile_target_roles", ProfileTargetRole),
    ("profile_sections", ProfileSection),
    ("jobs", Job),
    ("pools", Pool),
    ("research_dossiers", ResearchDossier),
    ("job_research_runs", JobResearchRun),
    ("research_evidence_snapshots", ResearchEvidenceSnapshot),
    ("research_findings", ResearchFinding),
    ("role_benchmark_runs", RoleBenchmarkRun),
    ("role_benchmark_documents", RoleBenchmarkDocument),
    ("role_capability_observations", RoleCapabilityObservation),
    ("role_delta_signals", RoleDeltaSignal),
    ("resumes", Resume),
    ("resume_sections", ResumeSection),
    ("resume_versions", ResumeVersion),
    ("resume_optimization_proposals", ResumeOptimizationProposal),
    ("applications", Application),
    ("application_attempts", ApplicationAttempt),
    ("application_progress_candidates", ApplicationProgressCandidate),
    ("application_stage_events", ApplicationStageEvent),
    ("application_records", ApplicationRecord),
    ("application_tables", ApplicationTable),
    ("application_table_records", ApplicationTableRecord),
    ("calendar_events", CalendarEvent),
    ("interviews", Interview),
    ("interview_messages", InterviewMessage),
    ("interview_behavior_events", InterviewBehaviorEvent),
    ("interview_evaluation_runs", InterviewEvaluationRun),
    ("interview_experiences", InterviewExperience),
    ("interview_questions", InterviewQuestion),
    ("career_sources", CareerSource),
    ("learning_observations", LearningObservation),
    ("memory_proposals", MemoryProposal),
    ("evidence_links", EvidenceLink),
    ("career_tasks", CareerTask),
    ("career_task_events", CareerTaskEvent),
    ("automation_events", AutomationEvent),
    ("automation_inbox_items", AutomationInboxItem),
    ("external_progress_signals", ExternalProgressSignal),
)


def _safe_value(value: Any, key: str = "") -> Any:
    if _REDACTED_KEY.search(key):
        return "[redacted]"
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(item_key): _safe_value(item_value, str(item_key)) for item_key, item_value in value.items()}
    if isinstance(value, (list, tuple)):
        return [_safe_value(item, key) for item in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _serialize_row(row: Any) -> dict[str, Any]:
    return {
        column.key: _safe_value(getattr(row, column.key), column.key)
        for column in row.__table__.columns
    }


async def export_user_data() -> dict[str, Any]:
    """Return a portable snapshot of core local career state.

    This is deliberately read-only. Provider credentials, email account
    credentials, share passwords/tokens, operation audit payloads, and browser
    session state are not part of the export.
    """

    sections: dict[str, list[dict[str, Any]]] = {}
    async with async_session() as db:
        for name, model in _EXPORT_COLLECTIONS:
            rows = (await db.execute(select(model))).scalars().all()
            sections[name] = [_serialize_row(row) for row in rows]

    artifacts = career_artifact_store.export_all()
    sections["career_artifacts"] = artifacts["items"]
    counts = {name: len(items) for name, items in sections.items()}
    return {
        "schema_version": "offeru.internal-beta.export.v1",
        "exported_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "scope": "local_core_career_state",
        "redactions": [
            "provider and connection credentials",
            "email account credentials and browser session state",
            "resume share tokens and passwords",
            "operation audit payloads",
        ],
        "counts": counts,
        "data": sections,
    }
