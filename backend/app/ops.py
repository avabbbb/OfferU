from __future__ import annotations

import hashlib
import inspect
import json
import time
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

from pydantic import BaseModel, ConfigDict, Field, PositiveInt, ValidationError, model_validator
from sqlalchemy.exc import IntegrityError
from sqlalchemy import func, select, update

from app.database import async_session
from app.services.job_ingest import JobIngestItem, import_job_batch
from app.services.agent_operations import (
    activate_authorized_research_read_only,
    add_profile_evidence,
    analyze_application_patterns,
    begin_gmail_oauth,
    complete_gmail_oauth,
    complete_authorized_research_session,
    connect_imap_account,
    cancel_job_research,
    create_ai_interview,
    create_application,
    create_interview_scoring_skill,
    create_memory_proposal,
    build_job_projection,
    derive_career_model,
    list_career_ledger,
    cancel_authorized_research_session,
    capture_authorized_research_page,
    classify_progress_signal,
    consolidate_memory_observations,
    distill_memory,
    draft_interview_scoring_skill,
    export_resume_pdf,
    generate_cover_letter,
    get_application_workspace,
    get_application_progress_candidate,
    get_application_progress_board,
    get_application_progress_overview,
    get_ai_interview,
    get_ai_interview_runtime,
    get_authorized_research_session,
    get_career_artifact,
    get_job,
    get_job_research,
    get_hosted_executor_session,
    get_pre_application_state,
    get_interview_scoring_skill,
    get_profile,
    get_resume,
    get_resume_optimization,
    get_work_source,
    get_work_source_sync_run,
    get_batch_job_evaluation,
    get_email_sync_run,
    import_jd,
    inspect_resume_document,
    invalidate_memory_source,
    invalidate_work_source,
    create_application_attempt,
    validate_fact_gate,
    job_stats,
    list_agent_runs_summary,
    list_applications,
    list_ai_interviews,
    list_authorized_research_sessions,
    list_application_progress_candidates,
    list_application_records,
    list_application_events,
    list_career_artifacts,
    list_calendar_events,
    list_follow_up_cadence,
    list_jobs,
    list_job_research_runs,
    list_hosted_executor_sessions,
    list_interview_questions,
    list_interview_scoring_skills,
    list_learning_observations,
    list_memory_inbox,
    list_pools,
    list_batch_job_evaluations,
    list_coding_agents,
    list_email_accounts,
    list_email_sync_runs,
    list_work_sources,
    list_work_source_sync_runs,
    list_profile_evidence,
    list_resume_optimizations,
    list_resumes,
    prepare_pre_application_decision,
    prepare_resume_optimization,
    promote_session_memory,
    register_work_source,
    refresh_job_research_report,
    ingest_application_signal,
    ingest_interview_behavior_events,
    record_follow_up,
    revoke_email_account,
    restart_ai_interview,
    review_memory_proposal,
    review_job_research,
    review_pre_application_decision,
    review_resume_optimization,
    review_application_progress,
    save_career_artifact,
    search_memory,
    start_batch_job_evaluation,
    start_authorized_research_session,
    resume_batch_job_evaluation,
    resume_job_research,
    resume_work_source_sync,
    start_work_source_sync,
    start_job_research,
    sync_email_notifications,
    submit_ai_interview_answer,
    update_application_record,
    update_application_status,
    email_connection_status,
    delete_ai_interview,
)
from app.models.models import AgentWorkspaceState, Job, OperationAuditLog, Pool


OperationFn = Callable[..., Awaitable[Any]]


class _StrictOperationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")


class GetJobInput(_StrictOperationInput):
    job_id: int = Field(gt=0)


class ListJobResearchRunsInput(_StrictOperationInput):
    job_id: int | None = Field(default=None, gt=0)
    status: str | None = Field(default=None, min_length=1, max_length=32)
    limit: int = Field(default=20, ge=1, le=100)


class GetJobResearchInput(_StrictOperationInput):
    run_id: str = Field(min_length=1, max_length=80)


class ReviewJobResearchInput(_StrictOperationInput):
    run_id: str = Field(min_length=1, max_length=80)
    action: str = Field(pattern="^(accept|reject)$")
    note: str = Field(default="", max_length=2000)


class StartJobResearchInput(_StrictOperationInput):
    job_id: int = Field(gt=0)
    runtime_id: str = Field(
        default="codex",
        pattern="^(codex|claude|omp|pi|opencode)$",
    )


class ResumeJobResearchInput(_StrictOperationInput):
    run_id: str = Field(min_length=1, max_length=80)


class ListHostedExecutorSessionsInput(_StrictOperationInput):
    task_type: str | None = Field(default=None, min_length=1, max_length=80)
    task_id: str | None = Field(default=None, min_length=1, max_length=80)
    limit: int = Field(default=20, ge=1, le=100)


class GetHostedExecutorSessionInput(_StrictOperationInput):
    session_id: str = Field(min_length=1, max_length=64)


class GetPreApplicationStateInput(_StrictOperationInput):
    job_id: int = Field(gt=0)


class PreparePreApplicationDecisionInput(_StrictOperationInput):
    job_id: int = Field(gt=0)
    research_run_id: str | None = Field(default=None, min_length=1, max_length=80)


class ReviewPreApplicationDecisionInput(_StrictOperationInput):
    decision_id: str = Field(min_length=1, max_length=80)
    final_decision: str = Field(
        pattern="^(go|conditional_go|no_go|insufficient_evidence)$"
    )
    note: str = Field(default="", max_length=2000)


class PrepareResumeOptimizationInput(_StrictOperationInput):
    job_id: int = Field(gt=0)
    profile_id: int | None = Field(default=None, gt=0)
    reference_resume_id: int | None = Field(default=None, gt=0)
    research_run_id: str | None = Field(default=None, min_length=1, max_length=80)
    candidate_rows: list[dict[str, Any]] | None = Field(default=None)
    candidate_original_rows: list[dict[str, Any]] | None = Field(default=None)
    source_session_id: str | None = Field(default=None, min_length=1, max_length=60)


class ListCalendarEventsInput(_StrictOperationInput):
    start: str | None = Field(default=None, min_length=1, max_length=64)
    end: str | None = Field(default=None, min_length=1, max_length=64)
    related_job_id: int | None = Field(default=None, gt=0)
    limit: int = Field(default=100, ge=1, le=500)


class ListInterviewQuestionsInput(_StrictOperationInput):
    company: str | None = Field(default=None, min_length=1, max_length=300)
    role: str | None = Field(default=None, min_length=1, max_length=300)
    job_id: int | None = Field(default=None, gt=0)
    category: str | None = Field(default=None, min_length=1, max_length=80)
    limit: int = Field(default=100, ge=1, le=500)


class ListAgentRunsInput(_StrictOperationInput):
    conversation_id: str | None = Field(default=None, min_length=1, max_length=120)
    task_id: str | None = Field(default=None, min_length=1, max_length=120)
    limit: int = Field(default=20, ge=1, le=100)


class AgentPlaybookInput(_StrictOperationInput):
    detail: str = Field(default="compact", pattern="^(compact|full)$")


class WorkflowCatalogInput(_StrictOperationInput):
    pass


class WorkflowPlanInput(_StrictOperationInput):
    goal: str = Field(min_length=1, max_length=1000)
    limit: int = Field(default=20, ge=1, le=100)


class ListOperationAuditInput(_StrictOperationInput):
    operation: str | None = Field(default=None, min_length=1, max_length=120)
    surface: str | None = Field(default=None, min_length=1, max_length=80)
    limit: int = Field(default=50, ge=1, le=200)


class CurrentViewInput(_StrictOperationInput):
    scope: str = Field(default="default", min_length=1, max_length=80)


class SetCurrentViewInput(CurrentViewInput):
    route: str = Field(default="", max_length=300)
    title: str = Field(default="", max_length=300)
    entity_type: str = Field(default="", max_length=80)
    entity_id: str = Field(default="", max_length=120)
    selection: dict[str, Any] = Field(default_factory=dict)
    filters: dict[str, Any] = Field(default_factory=dict)
    context: dict[str, Any] = Field(default_factory=dict)
    updated_by: str = Field(default="ui", min_length=1, max_length=80)


class ListPoolsInput(_StrictOperationInput):
    pass


class ListJobsInput(_StrictOperationInput):
    triage_status: str | None = Field(
        default=None,
        pattern="^(inbox|picked|ignored)$",
    )
    pool_id: int | None = Field(default=None, gt=0)
    keyword: str | None = Field(default=None, min_length=1, max_length=300)
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=20, ge=1, le=100)


class TriageJobInput(_StrictOperationInput):
    job_id: int = Field(gt=0)
    status: str = Field(
        pattern="^(inbox|picked|ignored)$",
    )
    pool_id: int | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def validate_pool_status(self):
        if self.pool_id is not None and self.status != "picked":
            raise ValueError("pool_id can only be used with status=picked")
        return self


class BatchTriageInput(_StrictOperationInput):
    job_ids: list[PositiveInt] = Field(min_length=1, max_length=500)
    status: str = Field(
        pattern="^(inbox|picked|ignored)$",
    )
    pool_id: int | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def validate_pool_status(self):
        if self.pool_id is not None and self.status != "picked":
            raise ValueError("pool_id can only be used with status=picked")
        return self


class CreatePoolInput(_StrictOperationInput):
    name: str = Field(min_length=1, max_length=100)
    scope: str = Field(default="picked", pattern="^(inbox|picked|ignored)$")
    description: str = Field(default="", max_length=2000)
    color: str = Field(default="#3B82F6", pattern="^#[0-9A-Fa-f]{6}$")
    sort_order: int = Field(default=0, ge=0, le=100000)


class UpdatePoolInput(_StrictOperationInput):
    pool_id: int = Field(gt=0)
    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=2000)
    color: str | None = Field(default=None, pattern="^#[0-9A-Fa-f]{6}$")
    sort_order: int | None = Field(default=None, ge=0, le=100000)


class PoolIdInput(_StrictOperationInput):
    pool_id: int = Field(gt=0)


class UpdateJobInput(_StrictOperationInput):
    job_id: int = Field(gt=0)
    triage_status: str | None = Field(
        default=None,
        pattern="^(inbox|picked|ignored)$",
    )
    pool_id: int | None = Field(default=None, gt=0)
    clear_pool: bool = False

    @model_validator(mode="after")
    def validate_update(self):
        if self.triage_status is None and self.pool_id is None and not self.clear_pool:
            raise ValueError("no update fields provided")
        if self.pool_id is not None and self.clear_pool:
            raise ValueError("pool_id and clear_pool are mutually exclusive")
        if self.pool_id is not None and self.triage_status not in {None, "picked"}:
            raise ValueError("pool_id can only be used with triage_status=picked")
        return self


class BatchUpdateJobsInput(_StrictOperationInput):
    job_ids: list[PositiveInt] = Field(min_length=1, max_length=500)
    triage_status: str | None = Field(
        default=None,
        pattern="^(inbox|picked|ignored)$",
    )
    pool_id: int | None = Field(default=None, gt=0)
    clear_pool: bool = False

    @model_validator(mode="after")
    def validate_update(self):
        if self.triage_status is None and self.pool_id is None and not self.clear_pool:
            raise ValueError("no update fields provided")
        if self.pool_id is not None and self.clear_pool:
            raise ValueError("pool_id and clear_pool are mutually exclusive")
        if self.pool_id is not None and self.triage_status not in {None, "picked"}:
            raise ValueError("pool_id can only be used with triage_status=picked")
        return self


class JobStatsInput(_StrictOperationInput):
    pass


class GetProfileInput(_StrictOperationInput):
    pass


class InspectResumeDocumentInput(_StrictOperationInput):
    file_path: str = Field(min_length=1, max_length=2048)


class ListProfileEvidenceInput(_StrictOperationInput):
    section_type: str | None = Field(
        default=None,
        pattern="^(education|experience|project|skill|certificate|custom|custom:[a-z0-9_]{6,64})$",
    )
    limit: int = Field(default=100, ge=1, le=500)


class AddProfileEvidenceInput(_StrictOperationInput):
    section_type: str = Field(
        pattern="^(education|experience|project|skill|certificate|custom|custom:[a-z0-9_]{6,64})$",
    )
    title: str = Field(min_length=1, max_length=220)
    content_json: dict[str, Any] = Field(min_length=1)
    source_text: str = Field(min_length=1, max_length=20_000)
    category_label: str | None = Field(default=None, max_length=220)
    source_url: str | None = Field(default=None, max_length=2048)
    dedup_key: str | None = Field(default=None, max_length=500)
    tier: str | None = Field(
        default=None,
        pattern="^(verified_fact|preference|career_hypothesis)$",
    )
    # ADR-0048 偏好门：tier=preference 时必填，direct=使用者明确陈述，proposal=收件箱提案确认
    preference_confirmation: str | None = Field(
        default=None,
        pattern="^(direct|proposal)$",
    )
    # 自回声来源（来源=声明本身）时，只有使用者明确确认才放行
    user_confirmed: bool = False


class ListLearningObservationsInput(_StrictOperationInput):
    status: str = Field(default="active", pattern="^(active|invalidated|all)$")
    observation_type: str | None = Field(
        default=None,
        pattern="^[a-z][a-z0-9_]{1,79}$",
    )
    limit: int = Field(default=100, ge=1, le=500)


class ListMemoryInboxInput(_StrictOperationInput):
    status: str = Field(
        default="pending",
        pattern="^(pending|deferred|applying|accepted|rejected|revoked|invalidated|all)$",
    )
    limit: int = Field(default=100, ge=1, le=500)


class CreateMemoryProposalInput(_StrictOperationInput):
    observation_id: int = Field(gt=0)
    target_tier: str = Field(
        pattern="^(verified_fact|preference|career_hypothesis)$",
    )
    section_type: str = Field(
        pattern="^(education|experience|project|skill|certificate|activity|honor|language|general|custom|custom:[a-z0-9_]{6,64})$",
    )
    title: str = Field(min_length=1, max_length=220)
    after: dict[str, Any] = Field(min_length=1)
    reason: str = Field(min_length=1, max_length=4000)
    before: dict[str, Any] | None = None
    impact: list[str] | None = Field(default=None, max_length=20)
    supersedes_proposal_id: int | None = Field(default=None, gt=0)


class DeriveCareerModelInput(_StrictOperationInput):
    pass


class ListCareerLedgerInput(_StrictOperationInput):
    status: str = Field(
        default="all",
        pattern="^(pending|deferred|applying|accepted|rejected|revoked|invalidated|all)$",
    )
    limit: int = Field(default=100, ge=1, le=500)


class SaveCareerArtifactInput(_StrictOperationInput):
    artifact_type: str = Field(
        pattern=(
            "^(application_answers|application_email|company_research|cover_letter|"
            "follow_up_draft|interview_debrief|interview_prep|interview_risk_review|"
            "job_evaluation|offer_review|pattern_analysis|reply_digest|skill_gap)$"
        )
    )
    title: str = Field(min_length=1, max_length=300)
    content_markdown: str = Field(min_length=1, max_length=200_000)
    related_job_id: int | None = Field(default=None, gt=0)
    related_application_id: int | None = Field(default=None, gt=0)
    related_application_record_id: int | None = Field(default=None, gt=0)
    metadata: dict[str, Any] | None = None


class ListCareerArtifactsInput(_StrictOperationInput):
    artifact_type: str | None = Field(
        default=None,
        pattern=(
            "^(application_answers|application_email|company_research|cover_letter|"
            "follow_up_draft|interview_debrief|interview_prep|interview_risk_review|"
            "job_evaluation|offer_review|pattern_analysis|reply_digest|skill_gap)$"
        ),
    )
    limit: int = Field(default=100, ge=1, le=500)


class ReviewMemoryProposalInput(_StrictOperationInput):
    proposal_id: int = Field(gt=0)
    action: str = Field(pattern="^(accept|reject|defer|revoke)$")
    note: str = Field(default="", max_length=2000)


class InvalidateMemorySourceInput(_StrictOperationInput):
    source_id: int = Field(gt=0)
    reason: str = Field(min_length=1, max_length=500)


class ConsolidateMemoryObservationsInput(_StrictOperationInput):
    observation_ids: list[PositiveInt] | None = Field(default=None, max_length=500)
    limit: int = Field(default=100, ge=1, le=500)


class ValidateFactGateInput(_StrictOperationInput):
    source_facts: dict[str, Any]
    generated: dict[str, Any]


class CreateApplicationAttemptInput(_StrictOperationInput):
    job_id: int = Field(gt=0)
    resume_id: int | None = Field(default=None, gt=0)
    resume_version_id: int | None = Field(default=None, gt=0)
    cover_letter: str = Field(default="", max_length=60_000)
    notes: str = Field(default="", max_length=60_000)


class ImportJobBatchInput(_StrictOperationInput):
    """批量岗位导入（EXT-JOB-002）：逐条 hash_key 幂等，batch_id 为批次幂等键。"""

    jobs: list[JobIngestItem] = Field(min_length=1, max_length=500)
    source: str = Field(default="manual", min_length=1, max_length=40)
    batch_id: str | None = Field(default=None, min_length=1, max_length=64)
    keywords: list[str] = Field(default_factory=list, max_length=50)
    location: str = Field(default="", max_length=200)


class ListApplicationsInput(_StrictOperationInput):
    status: str | None = Field(
        default=None,
        pattern="^(pending|submitted|responded|interview|rejected|offer)$",
    )
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=20, ge=1, le=100)


class CreateApplicationInput(_StrictOperationInput):
    job_id: int = Field(gt=0)
    notes: str | None = Field(default=None, max_length=60_000)


class UpdateApplicationStatusInput(_StrictOperationInput):
    application_id: int = Field(gt=0)
    status: str = Field(
        pattern="^(pending|submitted|responded|interview|rejected|offer)$",
    )
    notes: str | None = Field(default=None, max_length=60_000)


class IngestApplicationSignalInput(_StrictOperationInput):
    channel: str = Field(pattern="^(email|sms_forward)$")
    account_ref: str = Field(min_length=1, max_length=160)
    external_message_id: str = Field(min_length=1, max_length=500)
    sender: str = Field(max_length=500)
    subject: str = Field(max_length=500)
    body: str = Field(min_length=1, max_length=200_000)
    external_thread_id: str = Field(default="", max_length=500)
    received_at: str | None = Field(default=None, max_length=64)
    stage_hint: str = Field(
        default="",
        pattern="^(|applied|written_test|assessment|interview_1|interview_2|interview_hr|offer|rejected)$",
    )


class ListApplicationProgressCandidatesInput(_StrictOperationInput):
    status: str = Field(
        default="pending",
        pattern="^(pending|confirmed|rejected|all)$",
    )
    disclosure: str = Field(default="summary", pattern="^(summary|detail)$")
    limit: int = Field(default=100, ge=1, le=500)


class ApplicationProgressCandidateInput(_StrictOperationInput):
    candidate_id: str = Field(min_length=1, max_length=64)


class ReviewApplicationProgressInput(ApplicationProgressCandidateInput):
    action: str = Field(pattern="^(accept|reject)$")
    application_attempt_id: int | None = Field(default=None, gt=0)
    stage: str = Field(
        default="",
        pattern="^(|applied|written_test|assessment|interview_1|interview_2|interview_hr|offer|rejected)$",
    )
    note: str = Field(default="", max_length=1000)
    add_calendar: bool = True
    create_record: bool = False

    @model_validator(mode="after")
    def validate_create_record_action(self) -> "ReviewApplicationProgressInput":
        if self.create_record and self.action != "accept":
            raise ValueError("create_record can only be used with action=accept")
        if self.create_record and self.application_attempt_id is not None:
            raise ValueError(
                "create_record cannot be combined with application_attempt_id"
            )
        return self


class GetApplicationProgressOverviewInput(_StrictOperationInput):
    disclosure: str = Field(default="summary", pattern="^(summary|detail)$")
    job_id: int | None = Field(default=None, gt=0)
    limit: int = Field(default=200, ge=1, le=500)


class GetApplicationWorkspaceInput(_StrictOperationInput):
    pass


class ListApplicationRecordsInput(_StrictOperationInput):
    table_id: int = Field(gt=0)
    keyword: str = Field(default="", max_length=300)


class ListApplicationEventsInput(_StrictOperationInput):
    application_type: str | None = Field(
        default=None,
        pattern="^(application|application_record)$",
    )
    application_id: int | None = Field(default=None, gt=0)
    event_type: str | None = Field(
        default=None,
        pattern="^[a-z][a-z0-9_]{1,79}$",
    )
    limit: int = Field(default=1000, ge=1, le=5000)


class AnalyzeApplicationPatternsInput(_StrictOperationInput):
    pass


class UpdateApplicationRecordInput(_StrictOperationInput):
    record_id: int = Field(gt=0)
    field_key: str = Field(pattern="^(apply_status|follow_up_date|notes)$")
    value: str = Field(max_length=60_000)

    @model_validator(mode="after")
    def validate_value(self):
        allowed_statuses = {"待投递", "已投递", "待处理", "面试中", "已拒绝", "已录用"}
        if self.field_key == "apply_status" and self.value.strip() not in allowed_statuses:
            raise ValueError("apply_status has an unsupported value")
        return self


class ListFollowUpCadenceInput(_StrictOperationInput):
    pass


class RecordFollowUpInput(_StrictOperationInput):
    application_type: str = Field(pattern="^(application|application_record)$")
    application_id: int = Field(gt=0)
    channel: str = Field(pattern="^(email|linkedin|phone|wechat|other)$")
    contact: str = Field(default="", max_length=300)
    notes: str = Field(default="", max_length=2000)
    sent_at: str | None = Field(
        default=None,
        pattern="^\\d{4}-\\d{2}-\\d{2}$",
    )


@dataclass(frozen=True)
class OperationAuthorization:
    operation: str
    run_id: str
    action_id: str
    idempotency_key: str

    @property
    def confirmation_ref(self) -> str:
        return f"agent-run:{self.run_id}:{self.action_id}"


_OPERATION_AUTHORIZATION: ContextVar[OperationAuthorization | None] = ContextVar(
    "offeru_operation_authorization",
    default=None,
)
_PROTECTED_AGENT_SURFACES = {
    "agent",
    "cli",
    "mcp",
    "pi",
    "web_agent",
    "optimize_agent",
}


@contextmanager
def confirmed_operation(
    *,
    operation: str,
    run_id: str,
    action_id: str,
    idempotency_key: str,
):
    """Authorize exactly one persisted Agent Run step for Registry execution."""

    authorization = OperationAuthorization(
        operation=str(operation or "").strip(),
        run_id=str(run_id or "").strip(),
        action_id=str(action_id or "").strip(),
        idempotency_key=str(idempotency_key or "").strip(),
    )
    token = _OPERATION_AUTHORIZATION.set(authorization)
    try:
        yield
    finally:
        _OPERATION_AUTHORIZATION.reset(token)


@dataclass(frozen=True)
class Operation:
    name: str
    fn: OperationFn
    description: str
    parameters: dict[str, str] = field(default_factory=dict)
    group: str = "core"
    side_effects: tuple[str, ...] = ("read",)
    permissions: tuple[str, ...] = ()
    examples: tuple[dict[str, Any], ...] = ()
    audit_redacted_parameters: tuple[str, ...] = ()
    audit_redacted_output_parameters: tuple[str, ...] = ()
    input_model: type[BaseModel] | None = None
    version: str = "2026-05-23"

    @property
    def is_mutation(self) -> bool:
        return any(effect in self.side_effects for effect in ("write", "llm", "external"))

    def schema(self) -> dict[str, Any]:
        input_schema = (
            self.input_model.model_json_schema()
            if self.input_model is not None
            else None
        )
        return {
            "name": self.name,
            "description": self.description,
            "parameters": (
                input_schema.get("properties", {})
                if input_schema is not None
                else self.parameters
            ),
            "input_schema": input_schema,
            "group": self.group,
            "side_effects": list(self.side_effects),
            "supports_dry_run": self.is_mutation,
            "requires_confirmation": self.is_mutation,
            "permissions": list(self.permissions),
            "audit_redacted_parameters": list(self.audit_redacted_parameters),
            "audit_redacted_output_parameters": list(
                self.audit_redacted_output_parameters
            ),
            "examples": list(self.examples),
            "output_contract": {
                "ok": "bool",
                "operation": "str",
                "operation_version": "str|null",
                "inputs": "object",
                "outputs": "object|array|string|number|null",
                "warnings": "list[str]",
                "errors": "list[str]",
                "side_effects": "list[str]",
                "elapsed_ms": "float",
            },
            "operation_version": self.version,
        }


async def _triage_job_via_canonical_update(
    job_id: int,
    status: str,
    pool_id: int | None = None,
) -> dict[str, Any]:
    return await update_job_operation(
        job_id=job_id,
        triage_status=status,
        pool_id=pool_id,
    )


async def _batch_triage_via_canonical_update(
    job_ids: list[int],
    status: str,
    pool_id: int | None = None,
) -> dict[str, Any]:
    return await batch_update_jobs_operation(
        job_ids=job_ids,
        triage_status=status,
        pool_id=pool_id,
    )


async def _prepare_resume_optimization_after_pre_application(
    **kwargs: Any,
) -> dict[str, Any]:
    job_id = kwargs.get("job_id")
    state = await get_pre_application_state(job_id=job_id)
    stage = state.get("stage")
    if stage == "resume_proposal_ready":
        proposal = state.get("resume_proposal") or {}
        proposal_id = proposal.get("proposal_id")
        if proposal_id:
            return await get_resume_optimization(proposal_id=proposal_id)
    if stage != "ready_for_resume_proposal":
        raise ValueError("只有审核通过投或有条件投的岗位才能生成简历提案")
    return await prepare_resume_optimization(**kwargs)


OPERATIONS: dict[str, Operation] = {
    "get_profile": Operation(
        name="get_profile",
        fn=get_profile,
        description="获取用户个人资料概览，包括基本信息、目标岗位、经历统计。",
        group="profile",
        input_model=GetProfileInput,
    ),
    "list_profile_evidence": Operation(
        name="list_profile_evidence",
        fn=list_profile_evidence,
        description="读取带来源信息的结构化职业证据条目。",
        parameters={"section_type": "str?", "limit": "int=100"},
        group="profile",
        input_model=ListProfileEvidenceInput,
    ),
    "add_profile_evidence": Operation(
        name="add_profile_evidence",
        fn=add_profile_evidence,
        description="确认后追加一条来源可验证且确定性去重的分层档案条目；记忆提案应通过 review_memory_proposal 进入此事实门。tier=preference 时必填 preference_confirmation（direct=使用者明确陈述，proposal=收件箱提案确认）。",
        parameters={
            "section_type": "str",
            "title": "str",
            "content_json": "object",
            "source_text": "str",
            "category_label": "str?",
            "source_url": "str?",
            "dedup_key": "str?",
            "tier": "str? (verified_fact|preference|career_hypothesis)",
            "preference_confirmation": "str? (direct|proposal; tier=preference 时必填)",
        },
        group="profile",
        side_effects=("write",),
        input_model=AddProfileEvidenceInput,
    ),
    "list_learning_observations": Operation(
        name="list_learning_observations",
        fn=list_learning_observations,
        description="读取带来源、幂等键和失效状态的学习观察；学习观察本身不是职业事实。",
        parameters={
            "status": "str=active (active|invalidated|all)",
            "observation_type": "str?",
            "limit": "int=100",
        },
        group="memory",
        input_model=ListLearningObservationsInput,
    ),
    "list_memory_inbox": Operation(
        name="list_memory_inbox",
        fn=list_memory_inbox,
        description="读取记忆收件箱提案及其前后差异、理由、影响和来源证据。",
        parameters={"status": "str=pending", "limit": "int=100"},
        group="memory",
        input_model=ListMemoryInboxInput,
    ),
    "create_memory_proposal": Operation(
        name="create_memory_proposal",
        fn=create_memory_proposal,
        description="确认后从一条有效学习观察生成记忆收件箱提案；不会直接改写 Profile。",
        parameters={
            "observation_id": "int",
            "target_tier": "str (verified_fact|preference|career_hypothesis)",
            "section_type": "str",
            "title": "str",
            "after": "object",
            "reason": "str",
            "before": "object?",
            "impact": "list[str]?",
            "supersedes_proposal_id": "int? (被本提案取代的已接受提案)",
        },
        group="memory",
        side_effects=("write",),
        input_model=CreateMemoryProposalInput,
    ),
    "review_memory_proposal": Operation(
        name="review_memory_proposal",
        fn=review_memory_proposal,
        description="确认后接受、拒绝、稍后处理或撤销记忆提案；只有接受才按分层事实门写入 Profile。",
        parameters={
            "proposal_id": "int",
            "action": "str (accept|reject|defer|revoke)",
            "note": "str?",
        },
        group="memory",
        side_effects=("write",),
        input_model=ReviewMemoryProposalInput,
    ),
    "invalidate_memory_source": Operation(
        name="invalidate_memory_source",
        fn=invalidate_memory_source,
        description="确认后撤销一个职业模型来源，并级联失效其观察、提案、证据链接和无其他支持的 Profile 条目（失效条目保留审计外壳）。",
        parameters={"source_id": "int", "reason": "str"},
        group="memory",
        side_effects=("write",),
        input_model=InvalidateMemorySourceInput,
    ),
    "derive_career_model": Operation(
        name="derive_career_model",
        fn=derive_career_model,
        description="从仍有效的档案条目派生当前职业模型视图：按 tier 分组、标注来源有效性，失效条目进入审计列表（ADR-0048）。",
        parameters={},
        group="memory",
        input_model=DeriveCareerModelInput,
    ),
    "list_career_ledger": Operation(
        name="list_career_ledger",
        fn=list_career_ledger,
        description="按条目列出职业模型变更账本：保留变化前后、来源、理由、影响与取代链，并附每条落地条目的当前状态（ADR-0048）。",
        parameters={"status": "str=all", "limit": "int=100"},
        group="memory",
        input_model=ListCareerLedgerInput,
    ),
    "build_job_projection": Operation(
        name="build_job_projection",
        fn=build_job_projection,
        description="面向一个岗位从当前职业模型生成岗位职业投影：选择相关证据并按相关性排序，不修改长期模型（ADR-0048）。",
        parameters={"job_id": "int"},
        group="job",
        input_model=GetJobInput,
    ),
    "consolidate_memory_observations": Operation(
        name="consolidate_memory_observations",
        fn=consolidate_memory_observations,
        description="把上游已结构化的学习候选幂等巩固为记忆收件箱提案；不调用模型且不直接改写 Profile。",
        parameters={"observation_ids": "list[int]?", "limit": "int=100"},
        group="memory",
        side_effects=("write",),
        input_model=ConsolidateMemoryObservationsInput,
    ),
    "get_ai_interview_runtime": Operation(
        name="get_ai_interview_runtime",
        fn=get_ai_interview_runtime,
        description="读取当前面试模型、数据类别同意要求、摄像头隐私边界和禁止推断范围。",
        group="interview",
    ),
    "list_calendar_events": Operation(
        name="list_calendar_events",
        fn=list_calendar_events,
        description="按时间范围或岗位读取面试、截止日期及其他本地日程事件。",
        parameters={"start": "str?", "end": "str?", "related_job_id": "int?", "limit": "int=100"},
        group="interview",
        input_model=ListCalendarEventsInput,
    ),
    "list_interview_questions": Operation(
        name="list_interview_questions",
        fn=list_interview_questions,
        description="按公司、岗位、职位或类别读取已收集的结构化面试题。",
        parameters={"company": "str?", "role": "str?", "job_id": "int?", "category": "str?", "limit": "int=100"},
        group="interview",
        input_model=ListInterviewQuestionsInput,
    ),
    "list_interview_scoring_skills": Operation(
        name="list_interview_scoring_skills",
        fn=list_interview_scoring_skills,
        description="读取版本化声明式内容评分 Skill 摘要；Skill 不执行任意代码。",
        parameters={"status": "str=active", "limit": "int=50"},
        group="interview",
    ),
    "get_interview_scoring_skill": Operation(
        name="get_interview_scoring_skill",
        fn=get_interview_scoring_skill,
        description="读取一个固定版本的内容评分定义、权重、证据要求和禁止输出。",
        parameters={"skill_id": "str", "version": "int?"},
        group="interview",
    ),
    "create_interview_scoring_skill": Operation(
        name="create_interview_scoring_skill",
        fn=create_interview_scoring_skill,
        description="确认后创建新版本声明式内容评分 Skill；只允许 schema 内权重和提示，不执行 Python、JS 或 Shell。",
        parameters={
            "skill_id": "str",
            "name": "str",
            "definition": "object",
            "user_confirmed": "bool (must be true)",
        },
        group="interview",
        side_effects=("write",),
    ),
    "list_ai_interviews": Operation(
        name="list_ai_interviews",
        fn=list_ai_interviews,
        description="渐进读取 AI 面试摘要列表，不展开回答文本和逐条表达行为事件。",
        parameters={"status": "str?", "limit": "int=100"},
        group="interview",
    ),
    "get_ai_interview": Operation(
        name="get_ai_interview",
        fn=get_ai_interview,
        description="读取一场 AI 面试；summary 不展开，full 才返回回答、内容评价和派生表达行为事件。",
        parameters={"interview_id": "int", "detail": "str=full (summary|full)"},
        group="interview",
        audit_redacted_output_parameters=("messages",),
    ),
    "create_ai_interview": Operation(
        name="create_ai_interview",
        fn=create_ai_interview,
        description="确认模型提供方和数据类别后，使用已验证档案事实、JD 与调研证据生成一题一答的 AI 面试。",
        parameters={
            "model_provider": "str",
            "data_consent": "bool",
            "consented_data_categories": "list[str]",
            "user_confirmed": "bool (must be true)",
            "title": "str?",
            "target_company": "str?",
            "target_position": "str?",
            "target_job_id": "int?",
            "resume_id": "int?",
            "profile_id": "int?",
            "interview_type": "str=behavioral",
            "difficulty": "str=medium",
            "question_count": "int=5",
            "scoring_skill_id": "str=evidence-interview-score",
            "scoring_skill_version": "int?",
        },
        group="interview",
        side_effects=("llm", "external", "write"),
        permissions=("model:interview_context",),
    ),
    "submit_ai_interview_answer": Operation(
        name="submit_ai_interview_answer",
        fn=submit_ai_interview_answer,
        description="确认后评价并保存当前题回答；模型只输出逐字证据维度，服务器按固定 Skill 确定性聚合内容分。",
        parameters={
            "interview_id": "int",
            "question_index": "int",
            "content": "str",
            "model_provider": "str",
            "user_confirmed": "bool (must be true)",
        },
        group="interview",
        side_effects=("llm", "external", "write"),
        permissions=("model:interview_transcript",),
        audit_redacted_parameters=("content",),
    ),
    "ingest_interview_behavior_events": Operation(
        name="ingest_interview_behavior_events",
        fn=ingest_interview_behavior_events,
        description="确认后保存浏览器本地视觉模型产生的派生事件；拒绝原始帧、landmarks，并与内容评分保持分离。",
        parameters={
            "interview_id": "int",
            "events": "list[object]",
            "user_confirmed": "bool (must be true)",
        },
        group="interview",
        side_effects=("write",),
        permissions=("camera:derived_events",),
        audit_redacted_parameters=("events",),
    ),
    "restart_ai_interview": Operation(
        name="restart_ai_interview",
        fn=restart_ai_interview,
        description="确认后归档原会话并从同一固定问题和评分版本创建新会话，保留旧会话证据链。",
        parameters={
            "interview_id": "int",
            "user_confirmed": "bool (must be true)",
        },
        group="interview",
        side_effects=("write",),
    ),
    "delete_ai_interview": Operation(
        name="delete_ai_interview",
        fn=delete_ai_interview,
        description="确认后删除面试，并先级联失效由它产生的学习观察和无其他支持的派生记忆。",
        parameters={
            "interview_id": "int",
            "reason": "str",
            "user_confirmed": "bool (must be true)",
        },
        group="interview",
        side_effects=("write",),
    ),
    "register_work_source": Operation(
        name="register_work_source",
        fn=register_work_source,
        description="确认后登记一个本地目录或 Git 仓库为只读工作源；未登记路径不会被扫描。",
        parameters={
            "name": "str",
            "root_path": "str",
            "source_type": "str=directory (directory|git_repository)",
            "runtime_id": "str=codex",
            "include_patterns": "list[str]?",
            "exclude_patterns": "list[str]?",
        },
        group="memory",
        side_effects=("write",),
        audit_redacted_parameters=("root_path",),
    ),
    "list_work_sources": Operation(
        name="list_work_sources",
        fn=list_work_sources,
        description="读取使用者显式登记的工作源、同步指纹和最近同步时间。",
        parameters={"status": "str=active", "limit": "int=100"},
        group="memory",
    ),
    "get_work_source": Operation(
        name="get_work_source",
        fn=get_work_source,
        description="读取一项登记工作源的配置和最近同步状态。",
        parameters={"work_source_id": "int"},
        group="memory",
    ),
    "start_work_source_sync": Operation(
        name="start_work_source_sync",
        fn=start_work_source_sync,
        description="在本次工作内容模型授权后启动只读增量摘要；原始文件不落库，结果只形成观察和待确认提案。",
        parameters={
            "work_source_id": "int",
            "data_consent": "bool (must be true)",
            "runtime_id": "str?",
        },
        group="memory",
        side_effects=("external", "llm", "write"),
        permissions=("work_source_content:model",),
    ),
    "list_work_source_sync_runs": Operation(
        name="list_work_source_sync_runs",
        fn=list_work_source_sync_runs,
        description="读取工作源同步运行及其真实状态、摘要和失败信息。",
        parameters={
            "work_source_id": "int?",
            "status": "str?",
            "limit": "int=50",
        },
        group="memory",
    ),
    "get_work_source_sync_run": Operation(
        name="get_work_source_sync_run",
        fn=get_work_source_sync_run,
        description="读取单次工作源同步的摘要、审计轨迹和错误。",
        parameters={"run_id": "str"},
        group="memory",
    ),
    "resume_work_source_sync": Operation(
        name="resume_work_source_sync",
        fn=resume_work_source_sync,
        description="确认后重放失败的工作源同步；幂等指纹防止重复观察和重复提案。",
        parameters={"run_id": "str"},
        group="memory",
        side_effects=("external", "llm", "write"),
        permissions=("work_source_content:model",),
    ),
    "invalidate_work_source": Operation(
        name="invalidate_work_source",
        fn=invalidate_work_source,
        description="确认后撤销工作源并清除路径、指纹、摘要和派生记忆，保留最小审计外壳。",
        parameters={"work_source_id": "int", "reason": "str"},
        group="memory",
        side_effects=("write",),
    ),
    "import_jd": Operation(
        name="import_jd",
        fn=import_jd,
        description="导入单条 JD 文本为 Job；按 md5(jd_text) 去重，新建 Job triage_status=inbox。",
        parameters={
            "title": "str",
            "company": "str",
            "jd_text": "str",
            "source": "str=agent_import",
            "location": "str?",
            "url": "str?",
            "apply_url": "str?",
            "batch_id": "str?",
        },
        group="jobs",
        side_effects=("write",),
    ),
    "import_job_batch": Operation(
        name="import_job_batch",
        fn=import_job_batch,
        description="批量导入岗位为 Job（浏览器扩展/CLI 统一入口）：逐条按 hash_key 幂等去重，同 batch_id 重放不重复计数；triage_status=inbox。",
        parameters={
            "jobs": "list[object]",
            "source": "str=manual",
            "batch_id": "str?",
            "keywords": "list[str]=[]",
            "location": "str?",
        },
        group="jobs",
        side_effects=("write",),
        input_model=ImportJobBatchInput,
        version="2026-08-10",
    ),
    "validate_fact_gate": Operation(
        name="validate_fact_gate",
        fn=validate_fact_gate,
        description="对生成内容跑事实门校验：返回 unverified_metric / unverified_fact 警告列表。只读。",
        parameters={
            "source_facts": "object",
            "generated": "object",
        },
        group="profile",
        side_effects=("read",),
        input_model=ValidateFactGateInput,
    ),
    "create_application_attempt": Operation(
        name="create_application_attempt",
        fn=create_application_attempt,
        description="确认后创建一条投递尝试记录（ADR-0007：一行一次尝试）。不自动提交站外申请。",
        parameters={
            "job_id": "int",
            "resume_id": "int?",
            "resume_version_id": "int?",
            "cover_letter": "str?",
            "notes": "str?",
        },
        group="applications",
        side_effects=("write",),
        input_model=CreateApplicationAttemptInput,
    ),
    "list_pools": Operation(
        name="list_pools",
        fn=list_pools,
        description="获取岗位池列表。",
        group="jobs",
        input_model=ListPoolsInput,
    ),
    "list_jobs": Operation(
        name="list_jobs",
        fn=list_jobs,
        description="分页浏览岗位列表，支持按分拣状态、池、关键词筛选。",
        parameters={
            "triage_status": "str? (inbox|picked|ignored)",
            "pool_id": "int?",
            "keyword": "str?",
            "page": "int=1",
            "page_size": "int=20",
        },
        group="jobs",
        input_model=ListJobsInput,
    ),
    "list_coding_agents": Operation(
        name="list_coding_agents",
        fn=list_coding_agents,
        description="检测本机 coding-agent CLI 及其隔离运行支持。",
        group="agent_runtime",
    ),
    "list_agent_runs": Operation(
        name="list_agent_runs",
        fn=list_agent_runs_summary,
        description="读取主 Agent Run 摘要、状态、待确认动作数量和可见失败，不展开消息或 Provider 原始事件。",
        parameters={"conversation_id": "str?", "task_id": "str?", "limit": "int=20"},
        group="agent_runtime",
        input_model=ListAgentRunsInput,
    ),
    "list_batch_job_evaluations": Operation(
        name="list_batch_job_evaluations",
        fn=list_batch_job_evaluations,
        description="读取持久化的 coding-agent 批处理运行。",
        parameters={"limit": "int=20"},
        group="agent_runtime",
    ),
    "get_batch_job_evaluation": Operation(
        name="get_batch_job_evaluation",
        fn=get_batch_job_evaluation,
        description="读取一条批处理运行和逐岗位断点。",
        parameters={"batch_id": "str"},
        group="agent_runtime",
    ),
    "start_batch_job_evaluation": Operation(
        name="start_batch_job_evaluation",
        fn=start_batch_job_evaluation,
        description="确认后用隔离的本地 coding-agent 后台并行评估岗位。",
        parameters={"job_ids": "list[int]", "runtime_id": "str=codex", "max_workers": "int=2"},
        group="agent_runtime",
        side_effects=("write", "external"),
    ),
    "resume_batch_job_evaluation": Operation(
        name="resume_batch_job_evaluation",
        fn=resume_batch_job_evaluation,
        description="确认后恢复失败或中断的批处理岗位，已完成项不会重放。",
        parameters={"batch_id": "str"},
        group="agent_runtime",
        side_effects=("write", "external"),
    ),
    "list_job_research_runs": Operation(
        name="list_job_research_runs",
        fn=list_job_research_runs,
        description="读取持久化的单岗位公开网页调研运行及证据数量。",
        parameters={"job_id": "int?", "status": "str?", "limit": "int=20"},
        group="research",
        input_model=ListJobResearchRunsInput,
    ),
    "get_job_research": Operation(
        name="get_job_research",
        fn=get_job_research,
        description="读取一次岗位调研的双档案、逐条结论、证据快照、报告和执行轨迹。",
        parameters={"run_id": "str"},
        group="research",
        input_model=GetJobResearchInput,
    ),
    "review_job_research": Operation(
        name="review_job_research",
        fn=review_job_research,
        description="由使用者接受或拒绝候选调研证据；只有接受后才发布到公司与岗位档案。",
        parameters={"run_id": "str", "action": "accept|reject", "note": "str="},
        group="research",
        side_effects=("write",),
        input_model=ReviewJobResearchInput,
    ),
    "start_job_research": Operation(
        name="start_job_research",
        fn=start_job_research,
        description="确认后由只读临时 Codex worker 实时检索公开网页并建立公司与岗位档案。",
        parameters={"job_id": "int", "runtime_id": "str=codex"},
        group="research",
        side_effects=("write", "external"),
        input_model=StartJobResearchInput,
    ),
    "resume_job_research": Operation(
        name="resume_job_research",
        fn=resume_job_research,
        description="确认后恢复失败或被中断的岗位公开网页调研；已完成运行不会重放。",
        parameters={"run_id": "str"},
        group="research",
        side_effects=("write", "external"),
        input_model=ResumeJobResearchInput,
    ),
    "cancel_job_research": Operation(
        name="cancel_job_research",
        fn=cancel_job_research,
        description="确认后取消运行中或被中断的岗位调研，并终止其任务绑定的外部会话。",
        parameters={"run_id": "str"},
        group="research",
        side_effects=("write", "external"),
        input_model=ResumeJobResearchInput,
    ),
    "list_hosted_executor_sessions": Operation(
        name="list_hosted_executor_sessions",
        fn=list_hosted_executor_sessions,
        description="读取按重任务绑定的外部 Coding Agent 会话、协议、授权范围和恢复游标。",
        parameters={"task_type": "str?", "task_id": "str?", "limit": "int=20"},
        group="agent_runtime",
        input_model=ListHostedExecutorSessionsInput,
    ),
    "get_hosted_executor_session": Operation(
        name="get_hosted_executor_session",
        fn=get_hosted_executor_session,
        description="读取一个外部 Coding Agent 托管会话及其追加式事件审计记录。",
        parameters={"session_id": "str"},
        group="agent_runtime",
        input_model=GetHostedExecutorSessionInput,
    ),
    "get_pre_application_state": Operation(
        name="get_pre_application_state",
        fn=get_pre_application_state,
        description="读取一个岗位在投前决策闭环中的当前状态、可复核建议和退出结果。",
        parameters={"job_id": "int"},
        group="pre_application",
        input_model=GetPreApplicationStateInput,
    ),
    "prepare_pre_application_decision": Operation(
        name="prepare_pre_application_decision",
        fn=prepare_pre_application_decision,
        description="确认后基于真实岗位、已确认职业证据和最新已完成调研生成可复核投前决策。",
        parameters={"job_id": "int", "research_run_id": "str?"},
        group="pre_application",
        side_effects=("write", "external"),
        input_model=PreparePreApplicationDecisionInput,
    ),
    "review_pre_application_decision": Operation(
        name="review_pre_application_decision",
        fn=review_pre_application_decision,
        description="记录使用者最终选择；覆盖 Agent 建议时必须附理由。",
        parameters={
            "decision_id": "str",
            "final_decision": "str (go|conditional_go|no_go|insufficient_evidence)",
            "note": "str=",
        },
        group="pre_application",
        side_effects=("write",),
        input_model=ReviewPreApplicationDecisionInput,
    ),
    "start_authorized_research_session": Operation(
        name="start_authorized_research_session",
        fn=start_authorized_research_session,
        description="确认后启动一个不持久化登录状态的本地可见浏览器，由使用者手动登录指定平台。",
        parameters={
            "job_id": "int",
            "platform": "str (xiaohongshu|maimai|niuke|boss)",
            "initial_url": "str",
            "user_authorized": "bool",
            "base_run_id": "str?",
            "expires_minutes": "int=30",
        },
        group="research",
        side_effects=("external", "write"),
        permissions=("authenticated_browser:manual_login",),
        audit_redacted_parameters=("initial_url",),
        audit_redacted_output_parameters=("initial_url",),
    ),
    "activate_authorized_research_read_only": Operation(
        name="activate_authorized_research_read_only",
        fn=activate_authorized_research_read_only,
        description="使用者确认登录完成后重建为只读页面，拦截写请求、WebSocket、下载与 service worker。",
        parameters={
            "session_id": "str",
            "user_confirmed_login_complete": "bool",
        },
        group="research",
        side_effects=("external", "write"),
        permissions=("authenticated_browser:read",),
    ),
    "capture_authorized_research_page": Operation(
        name="capture_authorized_research_page",
        fn=capture_authorized_research_page,
        description="逐页确认后只保存当前页面中使用者选中的短摘录；不保存页面、截图、Cookie 或 storage state。",
        parameters={
            "session_id": "str",
            "dossier_scope": "str (company|role)",
            "source_class": "str",
            "user_confirmed_capture": "bool",
            "publisher": "str?",
            "published_at": "str?",
            "selected_text": "str?",
        },
        group="research",
        side_effects=("external", "write"),
        permissions=("authenticated_browser:read",),
        audit_redacted_parameters=("selected_text",),
        audit_redacted_output_parameters=("excerpt", "authorization"),
    ),
    "list_authorized_research_sessions": Operation(
        name="list_authorized_research_sessions",
        fn=list_authorized_research_sessions,
        description="读取登录态只读调研会话摘要，不展开证据摘录。",
        parameters={"job_id": "int?", "status": "str?", "limit": "int=20"},
        group="research",
    ),
    "get_authorized_research_session": Operation(
        name="get_authorized_research_session",
        fn=get_authorized_research_session,
        description="读取一个授权调研会话及证据清单；只有显式 include_excerpts 才展开短摘录。",
        parameters={"session_id": "str", "include_excerpts": "bool=false"},
        group="research",
        permissions=("authenticated_browser:read",),
        audit_redacted_output_parameters=("captures",),
    ),
    "complete_authorized_research_session": Operation(
        name="complete_authorized_research_session",
        fn=complete_authorized_research_session,
        description="确认后把选定登录态证据与公开网结果合并；每条 finding 仅含 dossier_scope、finding_type、statement、details、capture_ids、base_source_refs，并统一经过事实门。",
        parameters={
            "session_id": "str",
            "findings": "list[object]",
            "user_confirmed_findings": "bool",
            "gaps": "list[str]?",
        },
        group="research",
        side_effects=("write",),
        permissions=("authenticated_browser:read",),
        audit_redacted_parameters=("findings",),
    ),
    "cancel_authorized_research_session": Operation(
        name="cancel_authorized_research_session",
        fn=cancel_authorized_research_session,
        description="确认后关闭临时浏览器并删除尚未提升为正式调研证据的摘录。",
        parameters={"session_id": "str", "reason": "str"},
        group="research",
        side_effects=("write",),
        permissions=("authenticated_browser:read",),
    ),
    "get_job": Operation(
        name="get_job",
        fn=get_job,
        description="查看单个岗位详情，含完整 JD、投递链接、学历经验要求。",
        parameters={"job_id": "int"},
        group="jobs",
        input_model=GetJobInput,
    ),
    "triage_job": Operation(
        name="triage_job",
        fn=_triage_job_via_canonical_update,
        description="将单个岗位分拣为 inbox/picked/ignored，可分配岗位池。",
        parameters={"job_id": "int", "status": "str", "pool_id": "int?"},
        group="jobs",
        side_effects=("write",),
        input_model=TriageJobInput,
    ),
    "batch_triage": Operation(
        name="batch_triage",
        fn=_batch_triage_via_canonical_update,
        description="批量分拣多个岗位。",
        parameters={"job_ids": "list[int]", "status": "str", "pool_id": "int?"},
        group="jobs",
        side_effects=("write",),
        input_model=BatchTriageInput,
    ),
    "prepare_resume_optimization": Operation(
        name="prepare_resume_optimization",
        fn=_prepare_resume_optimization_after_pre_application,
        description="基于已验证档案、完整 JD 和已完成岗位调研生成可审核简历提案；不创建正式 Resume。",
        parameters={
            "job_id": "int",
            "profile_id": "int? (省略时使用默认 Profile)",
            "reference_resume_id": "int?",
            "research_run_id": "str?",
            "candidate_rows": "list[object]? (仅已逐段确认的 Optimize Session 候选稿)",
            "candidate_original_rows": "list[object]? (与候选稿对应的原文快照)",
            "source_session_id": "str? (会话候选稿必填)",
        },
        group="resume",
        side_effects=("llm", "write"),
        permissions=("profile_evidence", "job_description", "job_research"),
        input_model=PrepareResumeOptimizationInput,
    ),
    "list_resume_optimizations": Operation(
        name="list_resume_optimizations",
        fn=list_resume_optimizations,
        description="扁平读取简历优化提案摘要，可按岗位和状态筛选。",
        parameters={"job_id": "int?", "status": "str?", "limit": "int=20"},
        group="resume",
    ),
    "get_resume_optimization": Operation(
        name="get_resume_optimization",
        fn=get_resume_optimization,
        description="渐进披露一个简历优化提案的原文、候选稿、逐项 diff、事实门与调研证据。",
        parameters={"proposal_id": "str"},
        group="resume",
    ),
    "review_resume_optimization": Operation(
        name="review_resume_optimization",
        fn=review_resume_optimization,
        description="明确接受或拒绝简历提案；仅接受通过事实门的非过期提案才原子创建 Resume 与版本。",
        parameters={"proposal_id": "str", "action": "str (accept|reject)", "note": "str?"},
        group="resume",
        side_effects=("write",),
        permissions=("resume_write", "career_memory"),
    ),
    "inspect_resume_document": Operation(
        name="inspect_resume_document",
        fn=inspect_resume_document,
        description="经使用者确认后读取一个本地 PDF/DOCX 简历，返回原文与逐页解析诊断；不会写入档案或简历。",
        parameters={"file_path": "str"},
        group="resume",
        side_effects=("external",),
        permissions=("local_file:read",),
        audit_redacted_parameters=("file_path",),
        audit_redacted_output_parameters=("text",),
        input_model=InspectResumeDocumentInput,
    ),
    "list_resumes": Operation(
        name="list_resumes",
        fn=list_resumes,
        description="查看所有简历列表，包含 AI 溯源标签。",
        group="resume",
    ),
    "get_resume": Operation(
        name="get_resume",
        fn=get_resume,
        description="查看简历完整内容。",
        parameters={"resume_id": "int"},
        group="resume",
    ),
    "export_resume_pdf": Operation(
        name="export_resume_pdf",
        fn=export_resume_pdf,
        description="确认后渲染并原子保存一份 ATS 可读 PDF。",
        parameters={"resume_id": "int"},
        group="resume",
        side_effects=("write",),
    ),
    "list_applications": Operation(
        name="list_applications",
        fn=list_applications,
        description="查看投递记录列表，可按状态筛选。",
        parameters={"status": "str?", "page": "int=1", "page_size": "int=20"},
        group="applications",
        input_model=ListApplicationsInput,
    ),
    "create_application": Operation(
        name="create_application",
        fn=create_application,
        description="为指定岗位在投递工作区事实源中创建一条待投递记录。",
        parameters={"job_id": "int", "notes": "str?"},
        group="applications",
        side_effects=("write",),
        input_model=CreateApplicationInput,
    ),
    "update_application_status": Operation(
        name="update_application_status",
        fn=update_application_status,
        description="确认后原子更新一条投递记录状态。",
        parameters={"application_id": "int", "status": "str", "notes": "str?"},
        group="applications",
        side_effects=("write",),
        input_model=UpdateApplicationStatusInput,
    ),
    "begin_gmail_oauth": Operation(
        name="begin_gmail_oauth",
        fn=begin_gmail_oauth,
        description="生成带 PKCE 与一次性 state 的 Gmail 只读授权链接；verifier 只进入系统钥匙串。",
        parameters={"redirect_uri": "str"},
        group="email",
        side_effects=("write",),
        permissions=("credential:keychain",),
        audit_redacted_output_parameters=("auth_url",),
    ),
    "complete_gmail_oauth": Operation(
        name="complete_gmail_oauth",
        fn=complete_gmail_oauth,
        description="交换 Gmail OAuth code 并把 token 存入系统钥匙串；数据库只保存不透明引用。",
        parameters={"code": "str", "state": "str"},
        group="email",
        side_effects=("external", "write"),
        permissions=("credential:keychain",),
        audit_redacted_parameters=("code", "state"),
    ),
    "connect_imap_account": Operation(
        name="connect_imap_account",
        fn=connect_imap_account,
        description="测试只读 IMAP 连接并把应用授权码存入系统钥匙串。",
        parameters={
            "user": "str",
            "password": "str (transient; audit-redacted)",
            "provider": "str?",
            "host": "str?",
            "port": "int=993",
        },
        group="email",
        side_effects=("external", "write"),
        permissions=("credential:keychain",),
        audit_redacted_parameters=("password",),
    ),
    "email_connection_status": Operation(
        name="email_connection_status",
        fn=email_connection_status,
        description="读取不含凭据引用和密钥的邮箱连接状态。",
        group="email",
    ),
    "list_email_accounts": Operation(
        name="list_email_accounts",
        fn=list_email_accounts,
        description="读取邮箱账号元数据与增量同步状态；不返回 credential_ref 或原始密钥。",
        parameters={"status": "str=active", "limit": "int=50"},
        group="email",
    ),
    "sync_email_notifications": Operation(
        name="sync_email_notifications",
        fn=sync_email_notifications,
        description="用 Gmail historyId 或 IMAP UID/UIDVALIDITY 增量同步，生成待确认候选进展，不自动改变投递阶段。",
        parameters={"account_id": "str?"},
        group="email",
        side_effects=("external", "write"),
        permissions=("mailbox:read",),
    ),
    "list_email_sync_runs": Operation(
        name="list_email_sync_runs",
        fn=list_email_sync_runs,
        description="读取持久化邮箱增量同步运行、真实状态与恢复轨迹。",
        parameters={"account_id": "str?", "status": "str?", "limit": "int=50"},
        group="email",
    ),
    "get_email_sync_run": Operation(
        name="get_email_sync_run",
        fn=get_email_sync_run,
        description="读取单次邮箱同步的计数、游标模式和错误；不包含邮件正文或凭据。",
        parameters={"run_id": "str"},
        group="email",
    ),
    "revoke_email_account": Operation(
        name="revoke_email_account",
        fn=revoke_email_account,
        description="撤销邮箱账号、删除钥匙串凭据并失效尚未确认的消息信号与候选进展。",
        parameters={"account_id": "str", "reason": "str"},
        group="email",
        side_effects=("external", "write"),
        permissions=("credential:keychain",),
    ),
    "ingest_application_signal": Operation(
        name="ingest_application_signal",
        fn=ingest_application_signal,
        description="把一封邮件或主动转发短信保存为最小证据快照和待确认候选进展；不改变正式投递阶段。",
        parameters={
            "channel": "str (email|sms_forward)",
            "account_ref": "str",
            "external_message_id": "str",
            "sender": "str",
            "subject": "str",
            "body": "str (transient; audit-redacted)",
            "external_thread_id": "str?",
            "received_at": "ISO-8601?",
            "stage_hint": "str?",
        },
        group="applications",
        side_effects=("write",),
        audit_redacted_parameters=("body",),
        input_model=IngestApplicationSignalInput,
    ),
    "list_application_progress_candidates": Operation(
        name="list_application_progress_candidates",
        fn=list_application_progress_candidates,
        description="渐进式读取外部消息形成的候选进展；summary 默认隐藏正文片段和备选关联。",
        parameters={"status": "str=pending", "disclosure": "str=summary", "limit": "int=100"},
        group="applications",
        input_model=ListApplicationProgressCandidatesInput,
    ),
    "get_application_progress_candidate": Operation(
        name="get_application_progress_candidate",
        fn=get_application_progress_candidate,
        description="读取一条候选进展的最小消息证据、关联依据和备选投递尝试。",
        parameters={"candidate_id": "str"},
        group="applications",
        input_model=ApplicationProgressCandidateInput,
    ),
    "review_application_progress": Operation(
        name="review_application_progress",
        fn=review_application_progress,
        description="用户确认或拒绝候选进展；接受未关联候选时可显式一键建档，只有接受才追加投递阶段事件。",
        parameters={
            "candidate_id": "str",
            "action": "str (accept|reject)",
            "application_attempt_id": "int?",
            "stage": "str?",
            "note": "str?",
            "add_calendar": "bool=true",
            "create_record": "bool=false",
        },
        group="applications",
        side_effects=("write",),
        input_model=ReviewApplicationProgressInput,
        version="2026-08-13",
    ),
    "get_application_progress_overview": Operation(
        name="get_application_progress_overview",
        fn=get_application_progress_overview,
        description="从投递尝试和已确认阶段事件派生紧凑进度表；detail 才展开时间线。",
        parameters={"disclosure": "str=summary", "job_id": "int?", "limit": "int=200"},
        group="applications",
        input_model=GetApplicationProgressOverviewInput,
    ),
    "get_application_workspace": Operation(
        name="get_application_workspace",
        fn=get_application_workspace,
        description="读取当前投递工作区、表结构、统计和当前表记录。",
        group="applications",
        input_model=GetApplicationWorkspaceInput,
    ),
    "list_application_records": Operation(
        name="list_application_records",
        fn=list_application_records,
        description="读取指定投递工作区表中的事实记录。",
        parameters={"table_id": "int", "keyword": "str?"},
        group="applications",
        input_model=ListApplicationRecordsInput,
    ),
    "list_application_events": Operation(
        name="list_application_events",
        fn=list_application_events,
        description="读取追加式投递事件时间线，可按记录或事件类型过滤。",
        parameters={"application_type": "str?", "application_id": "int?", "event_type": "str?", "limit": "int=1000"},
        group="applications",
        input_model=ListApplicationEventsInput,
    ),
    "analyze_application_patterns": Operation(
        name="analyze_application_patterns",
        fn=analyze_application_patterns,
        description="基于当前状态和追加式事件计算漏斗、转化、状态迁移与历史覆盖率。",
        group="applications",
        input_model=AnalyzeApplicationPatternsInput,
    ),
    "update_application_record": Operation(
        name="update_application_record",
        fn=update_application_record,
        description="确认后更新投递工作区记录的状态、跟进日期或备注。",
        parameters={"record_id": "int", "field_key": "str", "value": "any"},
        group="applications",
        side_effects=("write",),
        input_model=UpdateApplicationRecordInput,
    ),
    "list_follow_up_cadence": Operation(
        name="list_follow_up_cadence",
        fn=list_follow_up_cadence,
        description="按确定性规则计算到期、紧急、等待与冷却跟进。",
        group="applications",
        input_model=ListFollowUpCadenceInput,
    ),
    "record_follow_up": Operation(
        name="record_follow_up",
        fn=record_follow_up,
        description="只在用户确认实际发送后，追加一条不可变跟进记录。",
        parameters={
            "application_type": "str (application|application_record)",
            "application_id": "int",
            "channel": "str",
            "contact": "str?",
            "notes": "str?",
            "sent_at": "YYYY-MM-DD?",
        },
        group="applications",
        side_effects=("write",),
        input_model=RecordFollowUpInput,
    ),
    "list_career_artifacts": Operation(
        name="list_career_artifacts",
        fn=list_career_artifacts,
        description="读取 file-first 职业材料索引和预览。",
        parameters={
            "artifact_type": "str?",
            "related_job_id": "int?",
            "related_application_id": "int?",
            "related_application_record_id": "int?",
            "limit": "int=20",
        },
        group="artifacts",
    ),
    "get_career_artifact": Operation(
        name="get_career_artifact",
        fn=get_career_artifact,
        description="读取一份完整的 file-first 职业材料。",
        parameters={"artifact_id": "str"},
        group="artifacts",
    ),
    "save_career_artifact": Operation(
        name="save_career_artifact",
        fn=save_career_artifact,
        description="确认后原子保存一份 Markdown 职业材料。",
        parameters={
            "artifact_type": "str",
            "title": "str",
            "content_markdown": "str",
            "related_job_id": "int?",
            "related_application_id": "int?",
            "related_application_record_id": "int?",
            "metadata": "object?",
        },
        group="artifacts",
        side_effects=("write",),
        input_model=SaveCareerArtifactInput,
    ),
    "generate_cover_letter": Operation(
        name="generate_cover_letter",
        fn=generate_cover_letter,
        description="为指定岗位和简历生成求职信草稿。",
        parameters={"job_id": "int", "resume_id": "int"},
        group="applications",
        side_effects=("llm",),
    ),
    "job_stats": Operation(
        name="job_stats",
        fn=job_stats,
        description="获取岗位数据统计。",
        group="analytics",
        input_model=JobStatsInput,
    ),
}


def list_operations() -> list[dict[str, Any]]:
    return [op.schema() for op in sorted(OPERATIONS.values(), key=lambda item: item.name)]


def get_operation_schema(name: str) -> Optional[dict[str, Any]]:
    op = OPERATIONS.get(name)
    return op.schema() if op else None


def build_tools_description() -> str:
    lines: list[str] = []
    for op in sorted(OPERATIONS.values(), key=lambda item: item.name):
        param_str = ", ".join(f"{k}: {v}" for k, v in op.parameters.items()) if op.parameters else "无参数"
        effects = ",".join(op.side_effects)
        lines.append(f"- {op.name}({param_str}) [{effects}]: {op.description}")
    return "\n".join(lines)


WORKFLOW_CATALOG: dict[str, dict[str, Any]] = {
    "daily_review": {
        "name": "daily_review",
        "description": "每天快速查看岗位池、未筛岗位和数据概览，决定当天优先处理什么。",
        "intent_keywords": ["今日", "每天", "review", "dashboard", "概览", "岗位"],
        "steps": [
            {"operation": "job_stats", "args": {}},
            {"operation": "list_pools", "args": {}},
            {"operation": "list_jobs", "args": {"triage_status": "inbox", "page_size": 20}},
        ],
    },
    "batch_triage": {
        "name": "batch_triage",
        "description": "批量筛选岗位：先读上下文和候选岗位，再由 agent 选择 job_ids，最后 dry-run 批量分拣。",
        "intent_keywords": ["批量", "筛选", "分拣", "triage", "忽略", "入池"],
        "steps": [
            {"operation": "get_profile", "args": {}},
            {"operation": "list_jobs", "args": {"triage_status": "inbox", "page_size": 50}},
            {"operation": "batch_update_jobs", "args": {"job_ids": [], "triage_status": "picked"}, "dry_run": True},
        ],
    },
    "tailored_resume": {
        "name": "tailored_resume",
        "description": "针对单个岗位准备可审核简历提案：先核对档案、岗位、已完成调研和历史提案，再 dry-run 生成；正式简历必须另行接受。",
        "intent_keywords": ["简历", "优化", "定制", "resume", "岗位匹配"],
        "steps": [
            {"operation": "get_profile", "args": {}},
            {"operation": "get_job", "args": {"job_id": 0}},
            {"operation": "list_job_research_runs", "args": {"job_id": 0, "status": "completed", "limit": 5}},
            {"operation": "list_resume_optimizations", "args": {"job_id": 0, "limit": 20}},
            {"operation": "prepare_resume_optimization", "args": {"job_id": 0}, "dry_run": True},
        ],
    },
    "application_pipeline": {
        "name": "application_pipeline",
        "description": "从已筛岗位先建立调研与简历提案；接受正式简历后，再单独生成求职信和创建投递待办，永不自动提交站外申请。",
        "intent_keywords": ["投递", "申请", "application", "cover letter", "求职信"],
        "steps": [
            {"operation": "get_job", "args": {"job_id": 0}},
            {"operation": "list_job_research_runs", "args": {"job_id": 0, "status": "completed", "limit": 5}},
            {"operation": "list_resume_optimizations", "args": {"job_id": 0, "limit": 20}},
            {"operation": "prepare_resume_optimization", "args": {"job_id": 0}, "dry_run": True},
        ],
    },
    "workspace_handoff": {
        "name": "workspace_handoff",
        "description": "读取或写入 UI 当前页面上下文，让外部 agent 接管用户正在看的对象。",
        "intent_keywords": ["当前页面", "上下文", "handoff", "selection", "接管"],
        "steps": [
            {"operation": "get_current_view", "args": {"scope": "default"}},
            {"operation": "set_current_view", "args": {"scope": "default", "route": "", "title": "", "updated_by": "external_agent"}, "dry_run": True},
        ],
    },
    "jd_research_deep_dive": {
        "name": "jd_research_deep_dive",
        "description": "对单个岗位做深挖调研：读取岗位，自动选 runtime 启动公开网调研，检查已完成调研与证据缺口，最后刷新 LLM 综合分析报告。",
        "intent_keywords": ["调研", "研究", "深挖", "面经", "简历模式", "research", "jd"],
        "steps": [
            {"operation": "get_job", "args": {"job_id": 0}},
            {"operation": "start_job_research", "args": {"job_id": 0}, "dry_run": True},
            {"operation": "list_job_research_runs", "args": {"job_id": 0, "status": "completed", "limit": 5}},
            {"operation": "refresh_job_research_report", "args": {"job_id": 0}, "dry_run": True},
        ],
    },
    "progress_board_review": {
        "name": "progress_board_review",
        "description": "查看公司→岗位二级进度看板，列出待确认候选，逐条审核接受或拒绝并安排下一步动作。",
        "intent_keywords": ["进度", "看板", "进展", "面试", "offer", "progress", "review"],
        "steps": [
            {"operation": "get_application_progress_board", "args": {}},
            {"operation": "list_application_progress_candidates", "args": {"status": "pending", "limit": 20}},
            {"operation": "review_application_progress", "args": {"candidate_id": "", "action": "accept"}, "dry_run": True},
        ],
    },
}


async def get_agent_playbook(detail: str = "compact") -> dict[str, Any]:
    if detail not in {"compact", "full"}:
        return {"error": "detail must be compact or full"}
    payload: dict[str, Any] = {
        "role": "OfferU external-agent operating contract",
        "principles": [
            "Use python -m app.cli manifest --pretty before controlling the system.",
            "Discover atomic operations with python -m app.cli ops --pretty and inspect parameters with schema.",
            "One CLI invocation performs one atomic operation; compose workflows in the agent, not inside ad-hoc shell scripts.",
            "Read operations execute directly; write, llm, and external operations create a persisted proposal instead of executing.",
            "Only after explicit user confirmation, execute the returned run/action with python -m app.cli confirm.",
            "Never auto-submit job applications, send email, or message external parties; create drafts and pending records only.",
        ],
        "commands": {
            "health": "python -m app.cli doctor --pretty",
            "manifest": "python -m app.cli manifest --pretty",
            "operations": "python -m app.cli ops --pretty",
            "schema": "python -m app.cli schema <operation> --pretty",
            "run": "python -m app.cli run <operation> --arg key=value --pretty",
            "dry_run": "python -m app.cli run <operation> --arg key=value --dry-run --pretty",
            "confirm": "python -m app.cli confirm <run_id> --action <action_id> --pretty",
            "workflow_catalog": "python -m app.cli run workflow_catalog --pretty",
            "workflow_plan": "python -m app.cli run workflow_plan --arg goal=\"批量筛选岗位\" --pretty",
        },
        "workflow_names": sorted(WORKFLOW_CATALOG),
    }
    if detail == "full":
        payload["workflows"] = list(WORKFLOW_CATALOG.values())
        payload["operation_groups"] = sorted({op.group for op in OPERATIONS.values()})
        payload["side_effect_labels"] = sorted({effect for op in OPERATIONS.values() for effect in op.side_effects})
    return payload


async def workflow_catalog() -> dict[str, Any]:
    return {"workflows": list(WORKFLOW_CATALOG.values())}


async def workflow_plan(goal: str, limit: int = 20) -> dict[str, Any]:
    normalized_goal = (goal or "").strip().lower()
    if not normalized_goal:
        return {"error": "goal is required"}
    safe_limit = max(1, min(int(limit or 20), 100))
    workflow = _select_workflow(normalized_goal)
    if not workflow:
        return {"error": "unsupported workflow goal", "supported_workflows": sorted(WORKFLOW_CATALOG)}
    steps = [_materialize_workflow_step(step, safe_limit) for step in workflow["steps"]]
    return {
        "goal": goal,
        "workflow": workflow["name"],
        "description": workflow["description"],
        "requires_agent_judgment": _workflow_requires_agent_judgment(workflow["name"]),
        "steps": steps,
        "commands": [step["command"] for step in steps],
        "confirmation_rule": "A mutation run creates a persisted proposal. After explicit user confirmation, execute the returned run/action once with python -m app.cli confirm.",
    }


def _select_workflow(normalized_goal: str) -> Optional[dict[str, Any]]:
    for workflow in WORKFLOW_CATALOG.values():
        if workflow["name"] == normalized_goal:
            return workflow
    ranked: list[tuple[int, int, dict[str, Any]]] = []
    for index, workflow in enumerate(WORKFLOW_CATALOG.values()):
        matches = sum(1 for keyword in workflow["intent_keywords"] if keyword.lower() in normalized_goal)
        if matches:
            ranked.append((matches, -index, workflow))
    if not ranked:
        return None
    ranked.sort(reverse=True, key=lambda item: (item[0], item[1]))
    return ranked[0][2]


def _materialize_workflow_step(step: dict[str, Any], limit: int) -> dict[str, Any]:
    args = dict(step.get("args", {}))
    if "page_size" in args:
        args["page_size"] = limit
    operation = step["operation"]
    dry_run = bool(step.get("dry_run"))
    command = _operation_command(operation, args, dry_run=dry_run)
    return {"operation": operation, "args": args, "dry_run": dry_run, "command": command}


def _operation_command(operation: str, args: dict[str, Any], *, dry_run: bool) -> str:
    parts = ["python -m app.cli run", operation]
    for key, value in args.items():
        parts.extend(["--arg", f"{key}={json.dumps(value, ensure_ascii=True) if isinstance(value, (dict, list)) else value}"])
    if dry_run:
        parts.append("--dry-run")
    parts.append("--pretty")
    return " ".join(str(part) for part in parts)


def _workflow_requires_agent_judgment(name: str) -> list[str]:
    if name == "batch_triage":
        return ["Select concrete job_ids after reading list_jobs outputs.", "Choose picked or ignored based on profile fit and user intent."]
    if name in {"tailored_resume", "application_pipeline"}:
        return ["Replace job_id=0 and resume_id=0 with real IDs discovered from read operations."]
    if name == "workspace_handoff":
        return ["Fill route, title, selection, filters, and context from the UI state being handed off."]
    return []


async def create_pool_operation(
    name: str,
    scope: str = "picked",
    description: str = "",
    color: str = "#3B82F6",
    sort_order: int = 0,
) -> dict[str, Any]:
    normalized_name = (name or "").strip()
    normalized_scope = (scope or "picked").strip().lower()
    if not normalized_name:
        return {"error": "Pool name is required"}
    if normalized_scope not in {"inbox", "picked", "ignored"}:
        return {"error": "invalid pool scope"}

    async with async_session() as db:
        existing = (
            await db.execute(
                select(Pool).where(
                    func.lower(Pool.name) == normalized_name.lower(),
                    Pool.scope == normalized_scope,
                )
            )
        ).scalar_one_or_none()
        if existing:
            return {"error": "Pool name already exists"}

        pool = Pool(
            name=normalized_name,
            scope=normalized_scope,
            description=(description or "").strip(),
            color=(color or "#3B82F6").strip(),
            sort_order=int(sort_order or 0),
        )
        db.add(pool)
        await db.commit()
        await db.refresh(pool)
        return _serialize_pool(pool, 0)


async def update_pool_operation(
    pool_id: int,
    name: Optional[str] = None,
    description: Optional[str] = None,
    color: Optional[str] = None,
    sort_order: Optional[int] = None,
) -> dict[str, Any]:
    async with async_session() as db:
        pool = (await db.execute(select(Pool).where(Pool.id == pool_id))).scalar_one_or_none()
        if not pool:
            return {"error": "Pool not found"}

        if name is not None:
            normalized_name = name.strip()
            if not normalized_name:
                return {"error": "Pool name is required"}
            conflict = (
                await db.execute(
                    select(Pool).where(
                        func.lower(Pool.name) == normalized_name.lower(),
                        Pool.id != pool_id,
                        Pool.scope == pool.scope,
                    )
                )
            ).scalar_one_or_none()
            if conflict:
                return {"error": "Pool name already exists"}
            pool.name = normalized_name
        if description is not None:
            pool.description = description.strip()
        if color is not None:
            pool.color = color.strip()
        if sort_order is not None:
            pool.sort_order = int(sort_order)

        await db.commit()
        await db.refresh(pool)
        count = (await db.execute(select(func.count(Job.id)).where(Job.pool_id == pool_id))).scalar() or 0
        return _serialize_pool(pool, count)


async def delete_pool_operation(pool_id: int) -> dict[str, Any]:
    async with async_session() as db:
        pool = (await db.execute(select(Pool).where(Pool.id == pool_id))).scalar_one_or_none()
        if not pool:
            return {"error": "Pool not found"}
        jobs = (await db.execute(select(Job).where(Job.pool_id == pool_id))).scalars().all()
        for job in jobs:
            job.pool_id = None
        await db.delete(pool)
        await db.commit()
        return {"deleted": True, "pool_id": pool_id, "moved_to_ungrouped": len(jobs)}


def _to_internal_status(status: str) -> str:
    value = (status or "").strip().lower()
    if value in {"inbox", "unscreened"}:
        return "inbox"
    if value in {"picked", "screened"}:
        return "picked"
    if value == "ignored":
        return "ignored"
    return value


async def update_job_operation(
    job_id: int,
    triage_status: Optional[str] = None,
    pool_id: Optional[int] = None,
    clear_pool: bool = False,
) -> dict[str, Any]:
    if triage_status is None and pool_id is None and not clear_pool:
        return {"error": "no update fields provided"}

    normalized = _to_internal_status(triage_status) if triage_status else None
    if normalized and normalized not in {"inbox", "picked", "ignored"}:
        return {"error": "invalid triage_status"}

    clear_pool = bool(clear_pool or pool_id == 0)
    target_pool_id = None if pool_id == 0 else pool_id
    if target_pool_id is not None and clear_pool:
        return {"error": "pool_id and clear_pool are mutually exclusive"}
    if target_pool_id is not None and normalized and normalized != "picked":
        return {"error": "pool_id can only be used with triage_status=picked"}

    async with async_session() as db:
        job = (await db.execute(select(Job).where(Job.id == job_id))).scalar_one_or_none()
        if not job:
            return {"error": "Job not found"}

        if normalized is not None:
            job.triage_status = normalized
            if normalized != "picked":
                job.pool_id = None

        if target_pool_id is not None:
            pool = (await db.execute(select(Pool).where(Pool.id == target_pool_id))).scalar_one_or_none()
            if not pool:
                return {"error": "Pool not found"}
            if pool.scope != "picked":
                return {"error": "only picked scope pool can be assigned"}
            job.pool_id = target_pool_id
            if normalized is None:
                job.triage_status = "picked"

        if clear_pool:
            job.pool_id = None

        await db.commit()
        await db.refresh(job)
        return _serialize_job_detail(job)


async def batch_update_jobs_operation(
    job_ids: list[int],
    triage_status: Optional[str] = None,
    pool_id: Optional[int] = None,
    clear_pool: bool = False,
) -> dict[str, Any]:
    if not job_ids:
        return {"error": "job_ids is required"}
    if len(job_ids) > 500:
        return {"error": "job_ids exceeds 500"}
    if triage_status is None and pool_id is None and not clear_pool:
        return {"error": "no update fields provided"}

    normalized = _to_internal_status(triage_status) if triage_status else None
    if normalized and normalized not in {"inbox", "picked", "ignored"}:
        return {"error": "invalid triage_status"}
    if pool_id is not None and clear_pool:
        return {"error": "pool_id and clear_pool are mutually exclusive"}
    if pool_id is not None and normalized and normalized != "picked":
        return {"error": "pool_id can only be used with triage_status=picked"}

    async with async_session() as db:
        pool = None
        if pool_id is not None:
            pool = (await db.execute(select(Pool).where(Pool.id == pool_id))).scalar_one_or_none()
            if not pool:
                return {"error": "Pool not found"}
            if pool.scope != "picked":
                return {"error": "only picked scope pool can be assigned"}

        jobs = (await db.execute(select(Job).where(Job.id.in_(job_ids)))).scalars().all()
        found_ids = {job.id for job in jobs}
        missing_ids = sorted(set(job_ids) - found_ids)
        if missing_ids:
            return {"error": f"some job_ids were not found: {missing_ids}", "missing_job_ids": missing_ids}

        for job in jobs:
            if normalized:
                job.triage_status = normalized
                # 与 update_job_operation 对齐：仅离开 picked 时清池；
                # picked 且未指定 pool_id 保留原池归属。
                if normalized != "picked":
                    job.pool_id = None
            if pool_id is not None:
                job.pool_id = pool_id
                if triage_status is None:
                    job.triage_status = "picked"
            if clear_pool:
                job.pool_id = None

        await db.commit()
        return {"updated": len(jobs), "requested": len(job_ids), "pool_name": pool.name if pool else None}


def _serialize_job_detail(job: Job) -> dict[str, Any]:
    return {
        "id": job.id,
        "title": job.title,
        "company": job.company,
        "location": job.location or "",
        "url": job.url or "",
        "apply_url": job.apply_url or "",
        "source": job.source or "",
        "triage_status": job.triage_status or "inbox",
        "pool_id": job.pool_id,
        "batch_id": job.batch_id,
        "salary_text": job.salary_text or "",
        "education": job.education or "",
        "experience": job.experience or "",
        "job_type": job.job_type or "",
        "is_campus": job.is_campus,
        "summary": job.summary or "",
        "keywords": job.keywords or [],
        "created_at": str(job.created_at) if job.created_at else None,
    }


async def list_operation_audit(
    operation: Optional[str] = None,
    surface: Optional[str] = None,
    limit: int = 50,
) -> dict[str, Any]:
    safe_limit = max(1, min(int(limit or 50), 200))
    async with async_session() as db:
        query = select(OperationAuditLog)
        if operation:
            query = query.where(OperationAuditLog.operation == operation)
        if surface:
            query = query.where(OperationAuditLog.surface == surface)
        rows = (await db.execute(query.order_by(OperationAuditLog.created_at.desc()).limit(safe_limit))).scalars().all()
        return {
            "total_returned": len(rows),
            "items": [
                {
                    "id": row.id,
                    "operation": row.operation,
                    "operation_version": row.operation_version,
                    "surface": row.surface,
                    "status": row.status,
                    "confirmation_ref": row.confirmation_ref,
                    "idempotency_key": row.idempotency_key,
                    "ok": row.ok,
                    "dry_run": row.dry_run,
                    "side_effects": row.side_effects,
                    "inputs": row.inputs_json,
                    "warnings": row.warnings_json,
                    "errors": row.errors_json,
                    "elapsed_ms": row.elapsed_ms,
                    "created_at": str(row.created_at),
                }
                for row in rows
            ],
        }


async def get_current_view(scope: str = "default") -> dict[str, Any]:
    async with async_session() as db:
        row = (
            await db.execute(select(AgentWorkspaceState).where(AgentWorkspaceState.scope == scope))
        ).scalar_one_or_none()
        if not row:
            return {
                "scope": scope,
                "route": "",
                "title": "",
                "entity_type": "",
                "entity_id": "",
                "selection": {},
                "filters": {},
                "context": {},
                "version": 0,
                "updated_by": "",
                "updated_at": None,
            }
        return _serialize_workspace_state(row)


async def set_current_view(
    scope: str = "default",
    route: str = "",
    title: str = "",
    entity_type: str = "",
    entity_id: str = "",
    selection: Optional[dict[str, Any]] = None,
    filters: Optional[dict[str, Any]] = None,
    context: Optional[dict[str, Any]] = None,
    updated_by: str = "ui",
) -> dict[str, Any]:
    normalized_scope = (scope or "default").strip() or "default"
    async with async_session() as db:
        row = (
            await db.execute(select(AgentWorkspaceState).where(AgentWorkspaceState.scope == normalized_scope))
        ).scalar_one_or_none()
        if not row:
            row = AgentWorkspaceState(scope=normalized_scope)
            db.add(row)
        row.route = (route or "")[:300]
        row.title = (title or "")[:300]
        row.entity_type = (entity_type or "")[:80]
        row.entity_id = (str(entity_id) if entity_id is not None else "")[:120]
        row.selection_json = selection or {}
        row.filters_json = filters or {}
        row.context_json = context or {}
        row.updated_by = (updated_by or "unknown")[:80]
        row.version = int(row.version or 0) + 1
        await db.commit()
        await db.refresh(row)
        return _serialize_workspace_state(row)


async def clear_current_view(scope: str = "default") -> dict[str, Any]:
    normalized_scope = (scope or "default").strip() or "default"
    async with async_session() as db:
        row = (
            await db.execute(select(AgentWorkspaceState).where(AgentWorkspaceState.scope == normalized_scope))
        ).scalar_one_or_none()
        if not row:
            return {"cleared": False, "scope": normalized_scope}
        await db.delete(row)
        await db.commit()
        return {"cleared": True, "scope": normalized_scope}


def _serialize_workspace_state(row: AgentWorkspaceState) -> dict[str, Any]:
    return {
        "scope": row.scope,
        "route": row.route,
        "title": row.title,
        "entity_type": row.entity_type,
        "entity_id": row.entity_id,
        "selection": row.selection_json or {},
        "filters": row.filters_json or {},
        "context": row.context_json or {},
        "version": row.version,
        "updated_by": row.updated_by,
        "updated_at": str(row.updated_at) if row.updated_at else None,
    }


def _serialize_pool(pool: Pool, job_count: int = 0) -> dict[str, Any]:
    return {
        "id": pool.id,
        "name": pool.name,
        "scope": pool.scope,
        "description": pool.description or "",
        "color": pool.color or "#3B82F6",
        "sort_order": pool.sort_order or 0,
        "job_count": job_count,
        "created_at": str(pool.created_at) if pool.created_at else None,
        "updated_at": str(pool.updated_at) if pool.updated_at else None,
    }


OPERATIONS.update(
    {
        "agent_playbook": Operation(
            name="agent_playbook",
            fn=get_agent_playbook,
            description="输出外部 Agent 操作 OfferU 的专家级控制契约、CLI 规则和安全边界。",
            parameters={"detail": "str=compact (compact|full)"},
            input_model=AgentPlaybookInput,
            group="governance",
        ),
        "workflow_catalog": Operation(
            name="workflow_catalog",
            fn=workflow_catalog,
            description="列出内置可组合工作流模板，供外部 Agent 自主选择和批量编排。",
            input_model=WorkflowCatalogInput,
            group="governance",
        ),
        "workflow_plan": Operation(
            name="workflow_plan",
            fn=workflow_plan,
            description="按自然语言目标选择内置工作流，并返回可执行的原子 CLI 命令序列。",
            parameters={"goal": "str", "limit": "int=20"},
            input_model=WorkflowPlanInput,
            group="governance",
        ),
        "create_pool": Operation(
            name="create_pool",
            fn=create_pool_operation,
            description="创建岗位池。",
            parameters={
                "name": "str",
                "scope": "str=picked (inbox|picked|ignored)",
                "description": "str?",
                "color": "str=#3B82F6",
                "sort_order": "int=0",
            },
            group="jobs",
            side_effects=("write",),
            input_model=CreatePoolInput,
        ),
        "update_pool": Operation(
            name="update_pool",
            fn=update_pool_operation,
            description="更新岗位池名称、描述、颜色或排序。",
            parameters={
                "pool_id": "int",
                "name": "str?",
                "description": "str?",
                "color": "str?",
                "sort_order": "int?",
            },
            group="jobs",
            side_effects=("write",),
            input_model=UpdatePoolInput,
        ),
        "delete_pool": Operation(
            name="delete_pool",
            fn=delete_pool_operation,
            description="删除岗位池，并将池内岗位移回未分组。",
            parameters={"pool_id": "int"},
            group="jobs",
            side_effects=("write",),
            input_model=PoolIdInput,
        ),
        "update_job": Operation(
            name="update_job",
            fn=update_job_operation,
            description="更新单个岗位的分拣状态或岗位池归属。",
            parameters={
                "job_id": "int",
                "triage_status": "str? (inbox|picked|ignored)",
                "pool_id": "int?",
                "clear_pool": "bool=false",
            },
            group="jobs",
            side_effects=("write",),
            input_model=UpdateJobInput,
        ),
        "batch_update_jobs": Operation(
            name="batch_update_jobs",
            fn=batch_update_jobs_operation,
            description="批量更新岗位分拣状态或岗位池归属。",
            parameters={
                "job_ids": "list[int]",
                "triage_status": "str? (inbox|picked|ignored)",
                "pool_id": "int?",
                "clear_pool": "bool=false",
            },
            group="jobs",
            side_effects=("write",),
            input_model=BatchUpdateJobsInput,
        ),
        "list_operation_audit": Operation(
            name="list_operation_audit",
            fn=list_operation_audit,
            description="查看 Operation Registry 统一审计日志。",
            parameters={"operation": "str?", "surface": "str?", "limit": "int=50"},
            input_model=ListOperationAuditInput,
            group="governance",
        ),
        "get_current_view": Operation(
            name="get_current_view",
            fn=get_current_view,
            description="获取 UI 与 Agent 共享的当前工作区上下文。",
            parameters={"scope": "str=default"},
            input_model=CurrentViewInput,
            group="context",
        ),
        "set_current_view": Operation(
            name="set_current_view",
            fn=set_current_view,
            description="写入 UI 与 Agent 共享的当前页面、选中项、过滤器和上下文。",
            parameters={
                "scope": "str=default",
                "route": "str?",
                "title": "str?",
                "entity_type": "str?",
                "entity_id": "str?",
                "selection": "dict?",
                "filters": "dict?",
                "context": "dict?",
                "updated_by": "str=ui",
            },
            input_model=SetCurrentViewInput,
            group="context",
            side_effects=("write",),
        ),
        "clear_current_view": Operation(
            name="clear_current_view",
            fn=clear_current_view,
            description="清空 UI 与 Agent 共享的当前工作区上下文。",
            parameters={"scope": "str=default"},
            input_model=CurrentViewInput,
            group="context",
            side_effects=("write",),
        ),
        "distill_memory": Operation(
            name="distill_memory",
            fn=distill_memory,
            description="确认后用 LLM 提炼未处理的职业观察为记忆候选并巩固为收件箱提案；不直接改写 Profile。",
            parameters={"observation_ids": "list[int]?", "limit": "int=20"},
            group="memory",
            side_effects=("llm", "write"),
        ),
        "promote_session_memory": Operation(
            name="promote_session_memory",
            fn=promote_session_memory,
            description="确认后把外部 Agent 会话记忆(facts/preferences/goals)打包为一条观察并提炼为收件箱提案；单向 session→career。",
            group="memory",
            side_effects=("llm", "write"),
        ),
        "search_memory": Operation(
            name="search_memory",
            fn=search_memory,
            description="按语义检索历史职业观察（向量召回），用于注入 LLM 提炼与 Agent 上下文。",
            parameters={"query": "str", "limit": "int=8"},
            group="memory",
            side_effects=("llm",),
        ),
        "refresh_job_research_report": Operation(
            name="refresh_job_research_report",
            fn=refresh_job_research_report,
            description="确认后对岗位最近一次已完成调研重新生成 LLM 综合分析章节并重渲染报告；不改动已验证事实层。",
            parameters={"job_id": "int"},
            group="research",
            side_effects=("llm", "write"),
        ),
        "get_application_progress_board": Operation(
            name="get_application_progress_board",
            fn=get_application_progress_board,
            description="读取公司→岗位二级分组的求职进度看板，含未关联候选、阶段、下一步动作与面试时间。",
            parameters={"status": "str=active (active|closed|all)", "include_timeline": "bool=false"},
            group="applications",
            version="2026-08-13",
        ),
        "classify_progress_signal": Operation(
            name="classify_progress_signal",
            fn=classify_progress_signal,
            description="确认后对单条待审核的求职进展候选重跑 LLM 分类（回填旧信号或重试失败分类）；基于 subject+snippet。",
            parameters={"candidate_id": "str"},
            group="applications",
            side_effects=("llm", "write"),
        ),
        "draft_interview_scoring_skill": Operation(
            name="draft_interview_scoring_skill",
            fn=draft_interview_scoring_skill,
            description="确认后由 LLM 起草一份评分 Skill 草稿并返回，不落库；用户确认后走 create_interview_scoring_skill。",
            parameters={"goal": "str", "target_role": "str=", "job_id": "int?"},
            group="interview",
            side_effects=("llm",),
        ),
    }
)


async def execute_operation(
    name: str,
    args: Optional[dict[str, Any]] = None,
    *,
    dry_run: bool = False,
    surface: str = "unknown",
    audit: bool = True,
) -> dict[str, Any]:
    op = OPERATIONS.get(name)
    inputs = args or {}
    started = time.perf_counter()
    if not op:
        envelope = _envelope(
            ok=False,
            operation=name,
            inputs=inputs,
            started=started,
            errors=[f"未知操作: {name}"],
        )
        return await _audit_or_expose_failure(
            envelope, dry_run=dry_run, surface=surface, audit=audit, op=op
        )

    raw_args = {k: v for k, v in inputs.items() if v is not None}
    clean_args, validation_error = _validated_args(op, raw_args)
    audit_inputs = _audit_inputs(op, clean_args)
    if validation_error:
        envelope = _envelope(
            ok=False,
            operation=name,
            inputs=_audit_inputs(op, raw_args),
            started=started,
            errors=[validation_error],
            op=op,
        )
        return await _audit_or_expose_failure(
            envelope, dry_run=dry_run, surface=surface, audit=audit, op=op
        )

    if dry_run and op.is_mutation:
        envelope = _envelope(
            ok=True,
            operation=name,
            inputs=audit_inputs,
            started=started,
            outputs={"skipped": True, "reason": "dry_run", "side_effects": list(op.side_effects)},
            warnings=["dry_run 已启用，未执行会写入、调用 LLM 或访问外部系统的操作。"],
            op=op,
        )
        return await _audit_or_expose_failure(
            envelope, dry_run=dry_run, surface=surface, audit=audit, op=op
        )

    authorization = _OPERATION_AUTHORIZATION.get()
    audit_id: int | None = None
    if op.is_mutation and surface in _PROTECTED_AGENT_SURFACES:
        authorization_error = await _validate_authorization(op, authorization)
        if authorization_error:
            envelope = _envelope(
                ok=False,
                operation=name,
                inputs=audit_inputs,
                started=started,
                outputs={
                    "executed": False,
                    "requires_confirmation": True,
                },
                errors=[authorization_error],
                op=op,
            )
            return await _audit_or_expose_failure(
                envelope, dry_run=dry_run, surface=surface, audit=audit, op=op
            )
        assert authorization is not None
        if not audit:
            return _envelope(
                ok=False,
                operation=name,
                inputs=audit_inputs,
                started=started,
                errors=["Agent 副作用操作不能关闭审计。"],
                op=op,
            )
        try:
            audit_id, replay = await _claim_authorized_execution(
                op=op,
                inputs=audit_inputs,
                surface=surface,
                authorization=authorization,
                started=started,
            )
        except OperationAuditError as exc:
            return _audit_failure_envelope(
                _envelope(
                    ok=False,
                    operation=name,
                    inputs=audit_inputs,
                    started=started,
                    op=op,
                ),
                exc,
                side_effect_may_have_completed=False,
            )
        if replay is not None:
            return replay

    try:
        result = await op.fn(**clean_args)
        envelope = _envelope(
            ok=not (isinstance(result, dict) and result.get("error")),
            operation=name,
            inputs=audit_inputs,
            started=started,
            outputs=result,
            errors=[result["error"]] if isinstance(result, dict) and result.get("error") else [],
            op=op,
        )
    except Exception as exc:
        envelope = _envelope(
            ok=False,
            operation=name,
            inputs=audit_inputs,
            started=started,
            errors=[str(exc)],
            op=op,
        )

    if audit_id is not None:
        try:
            await _complete_authorized_audit(audit_id, envelope=envelope, op=op)
        except OperationAuditError as exc:
            return _audit_failure_envelope(
                envelope,
                exc,
                side_effect_may_have_completed=True,
            )
        return envelope

    return await _audit_or_expose_failure(
        envelope, dry_run=dry_run, surface=surface, audit=audit, op=op
    )


def _validated_args(
    op: Operation,
    args: dict[str, Any],
) -> tuple[dict[str, Any], Optional[str]]:
    if op.input_model is not None:
        try:
            value = op.input_model.model_validate(args)
        except ValidationError as exc:
            missing = [
                ".".join(str(part) for part in error.get("loc") or ())
                for error in exc.errors()
                if error.get("type") == "missing"
            ]
            if missing:
                return args, f"缺少必填参数: {', '.join(missing)}"
            extras = [
                ".".join(str(part) for part in error.get("loc") or ())
                for error in exc.errors()
                if error.get("type") == "extra_forbidden"
            ]
            if extras:
                return args, f"未知参数: {', '.join(extras)}"
            details = "; ".join(
                f"{'.'.join(str(part) for part in error.get('loc') or ())}: {error.get('msg')}"
                for error in exc.errors()
            )
            return args, f"参数校验失败: {details}"
        return value.model_dump(exclude_none=True), None

    signature = inspect.signature(op.fn)
    required = [
        name
        for name, param in signature.parameters.items()
        if param.default is inspect.Parameter.empty
        and param.kind in (inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY)
    ]
    missing = [name for name in required if name not in args]
    if missing:
        return args, f"缺少必填参数: {', '.join(missing)}"

    allowed = set(signature.parameters)
    extra = [name for name in args if name not in allowed]
    if extra:
        return args, f"未知参数: {', '.join(extra)}"
    return args, None


async def _validate_authorization(
    op: Operation,
    authorization: OperationAuthorization | None,
) -> Optional[str]:
    if authorization is None:
        return "该副作用操作需要先写入 Agent Run 提案并由用户确认。"
    if authorization.operation != op.name:
        return "确认授权与待执行 Operation 不匹配。"
    if not all(
        (
            authorization.run_id,
            authorization.action_id,
            authorization.idempotency_key,
        )
    ):
        return "确认授权缺少 Agent Run、动作或幂等键。"

    from app.services.agent_run_state import load_agent_run

    run = await load_agent_run(authorization.run_id)
    if run is None:
        return "确认授权对应的持久化 Agent Run 不存在。"
    step = next(
        (
            item
            for item in (run.get("steps") or [])
            if isinstance(item, dict)
            and str(item.get("id") or "") == authorization.action_id
        ),
        None,
    )
    if step is None:
        return "确认授权对应的持久化 Agent Run 动作不存在。"
    if str(step.get("tool") or "") != op.name:
        return "持久化 Agent Run 动作与待执行 Operation 不匹配。"
    if str(step.get("idempotency_key") or "") != authorization.idempotency_key:
        return "持久化 Agent Run 动作的幂等键不匹配。"
    if str(step.get("status") or "") != "executing":
        return "持久化 Agent Run 动作尚未进入已确认执行状态。"
    return None


class OperationAuditError(RuntimeError):
    pass


async def _claim_authorized_execution(
    *,
    op: Operation,
    inputs: dict[str, Any],
    surface: str,
    authorization: OperationAuthorization,
    started: float,
) -> tuple[int | None, dict[str, Any] | None]:
    row = OperationAuditLog(
        operation=op.name,
        operation_version=op.version,
        surface=(surface or "unknown")[:40],
        status="executing",
        confirmation_ref=authorization.confirmation_ref[:160],
        idempotency_key=authorization.idempotency_key[:180],
        ok=False,
        dry_run=False,
        side_effects=list(op.side_effects),
        inputs_json=_json_object(inputs),
        outputs_json={},
        warnings_json=[],
        errors_json=[],
        elapsed_ms=round((time.perf_counter() - started) * 1000, 2),
    )
    try:
        async with async_session() as db:
            db.add(row)
            await db.commit()
            await db.refresh(row)
            return row.id, None
    except IntegrityError:
        pass
    except Exception as exc:
        raise OperationAuditError(f"无法在执行前写入审计记录: {exc}") from exc

    try:
        async with async_session() as db:
            existing = (
                await db.execute(
                    select(OperationAuditLog).where(
                        OperationAuditLog.idempotency_key
                        == authorization.idempotency_key[:180]
                    )
                )
            ).scalar_one_or_none()
    except Exception as exc:
        raise OperationAuditError(f"无法核对幂等执行记录: {exc}") from exc
    if existing is None:
        raise OperationAuditError("幂等键已被占用，但找不到对应审计记录。")
    if (
        existing.operation != op.name
        or existing.confirmation_ref != authorization.confirmation_ref[:160]
        or existing.inputs_json != _json_object(inputs)
    ):
        return None, _envelope(
            ok=False,
            operation=op.name,
            inputs=inputs,
            started=started,
            errors=["幂等键已被另一项 Operation 或不同输入占用。"],
            op=op,
        )
    if existing.status == "completed":
        return None, _envelope(
            ok=bool(existing.ok),
            operation=op.name,
            inputs=inputs,
            started=started,
            outputs=existing.outputs_json,
            warnings=[
                *list(existing.warnings_json or []),
                "相同确认动作已执行；本次返回持久化结果，没有重放副作用。",
            ],
            errors=list(existing.errors_json or []),
            op=op,
        )
    if existing.status == "failed":
        return None, _envelope(
            ok=False,
            operation=op.name,
            inputs=inputs,
            started=started,
            outputs=existing.outputs_json,
            warnings=list(existing.warnings_json or []),
            errors=list(existing.errors_json or []) or ["该确认动作此前执行失败，没有自动重放。"],
            op=op,
        )
    return None, _envelope(
        ok=False,
        operation=op.name,
        inputs=inputs,
        started=started,
        errors=[
            "相同确认动作已有执行中或结果不确定的审计记录；为避免重复副作用，系统没有自动重放。"
        ],
        op=op,
    )


async def _complete_authorized_audit(
    audit_id: int,
    *,
    envelope: dict[str, Any],
    op: Operation,
) -> None:
    try:
        async with async_session() as db:
            await db.execute(
                update(OperationAuditLog)
                .where(OperationAuditLog.id == audit_id)
                .values(
                    status="completed" if envelope.get("ok") else "failed",
                    ok=bool(envelope.get("ok")),
                    outputs_json=_json_object(
                        _audit_outputs(op, envelope.get("outputs"))
                    ),
                    warnings_json=list(envelope.get("warnings") or []),
                    errors_json=list(envelope.get("errors") or []),
                    elapsed_ms=float(envelope.get("elapsed_ms") or 0),
                )
            )
            await db.commit()
    except Exception as exc:
        raise OperationAuditError(f"Operation 已返回，但最终审计记录写入失败: {exc}") from exc


async def _audit_or_expose_failure(
    envelope: dict[str, Any],
    *,
    dry_run: bool,
    surface: str,
    audit: bool,
    op: Optional[Operation],
) -> dict[str, Any]:
    try:
        await _record_audit(
            envelope, dry_run=dry_run, surface=surface, audit=audit, op=op
        )
        return envelope
    except OperationAuditError as exc:
        return _audit_failure_envelope(
            envelope,
            exc,
            side_effect_may_have_completed=bool(op and op.is_mutation and not dry_run),
        )


def _audit_failure_envelope(
    envelope: dict[str, Any],
    error: OperationAuditError,
    *,
    side_effect_may_have_completed: bool,
) -> dict[str, Any]:
    message = str(error)
    if side_effect_may_have_completed:
        message = f"{message}；副作用可能已完成，需要人工核对，系统不会自动重放。"
    return {
        **envelope,
        "ok": False,
        "warnings": [
            *list(envelope.get("warnings") or []),
            "审计完整性失败已显式暴露。",
        ],
        "errors": [*list(envelope.get("errors") or []), message],
    }


def _audit_inputs(op: Operation, inputs: dict[str, Any]) -> dict[str, Any]:
    return _redact_mapping(inputs, set(op.audit_redacted_parameters))


def _audit_outputs(op: Optional[Operation], outputs: Any) -> Any:
    if op is None or not isinstance(outputs, dict):
        return outputs
    return _redact_mapping(outputs, set(op.audit_redacted_output_parameters))


def _redact_mapping(
    values: dict[str, Any],
    redacted: set[str],
) -> dict[str, Any]:
    if not redacted:
        return values
    result = dict(values)
    for key in redacted:
        if key not in result:
            continue
        value = result[key]
        try:
            serialized = json.dumps(
                value,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
        except (TypeError, ValueError):
            serialized = str(value)
        result[key] = {
            "redacted": True,
            "sha256": hashlib.sha256(serialized.encode("utf-8")).hexdigest(),
            "length": len(serialized),
        }
    return result


def _envelope(
    *,
    ok: bool,
    operation: str,
    inputs: dict[str, Any],
    started: float,
    outputs: Any = None,
    warnings: Optional[list[str]] = None,
    errors: Optional[list[str]] = None,
    op: Optional[Operation] = None,
) -> dict[str, Any]:
    return {
        "ok": ok,
        "operation": operation,
        "operation_version": op.version if op else None,
        "inputs": inputs,
        "outputs": outputs,
        "warnings": warnings or [],
        "errors": errors or [],
        "side_effects": list(op.side_effects) if op else [],
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
    }


async def _record_audit(
    envelope: dict[str, Any],
    *,
    dry_run: bool,
    surface: str,
    audit: bool,
    op: Optional[Operation],
) -> None:
    if not audit or envelope.get("operation") == "list_operation_audit":
        return
    try:
        async with async_session() as db:
            row = OperationAuditLog(
                operation=envelope.get("operation") or "unknown",
                operation_version=envelope.get("operation_version") or "",
                surface=(surface or "unknown")[:40],
                status="completed" if envelope.get("ok") else "failed",
                confirmation_ref="",
                idempotency_key=None,
                ok=bool(envelope.get("ok")),
                dry_run=bool(dry_run),
                side_effects=list(envelope.get("side_effects") or []),
                inputs_json=_json_object(envelope.get("inputs")),
                outputs_json=_json_object(
                    _audit_outputs(op, envelope.get("outputs"))
                ),
                warnings_json=list(envelope.get("warnings") or []),
                errors_json=list(envelope.get("errors") or []),
                elapsed_ms=float(envelope.get("elapsed_ms") or 0),
            )
            db.add(row)
            await db.commit()
    except Exception as exc:
        raise OperationAuditError(f"审计记录写入失败: {exc}") from exc


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if value is None:
        return {}
    return {"value": value}
