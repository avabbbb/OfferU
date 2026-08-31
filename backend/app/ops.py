from __future__ import annotations

import hashlib
import inspect
import json
import time
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Awaitable, Callable, Optional

from pydantic import BaseModel, ConfigDict, Field, PositiveInt, ValidationError, model_validator
from sqlalchemy.exc import IntegrityError
from sqlalchemy import func, select, update

from app.database import async_session
from app.services.security_redaction import (
    redact_sensitive_value,
    safe_error_message,
)
from app.services.job_ingest import JobIngestItem, import_job_batch
from app.services.scraper_operations import finalize_scraper_batch, start_scraper_batch
from app.services.harness_operations import (
    delete_harness_conversation,
    distill_harness_conversation,
    import_harness_memory,
    promote_harness_memory,
    save_harness_conversation,
)
from app.services.optimize_agent_operations import (
    chat_optimize_agent_session,
    delete_optimize_agent_session,
    start_optimize_agent_session,
    stream_optimize_agent_session,
)
from app.services.agent_operations import (
    activate_authorized_research_read_only,
    add_profile_evidence,
    analyze_application_patterns,
    begin_gmail_oauth,
    complete_gmail_oauth,
    complete_authorized_research_session,
    connect_imap_account,
    cancel_job_research,
    create_fixture_job_research,
    cancel_career_task,
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
    get_application_progress_timeline,
    get_application_progress_overview,
    get_ai_interview,
    get_ai_interview_runtime,
    get_authorized_research_session,
    get_career_artifact,
    get_job,
    get_job_research,
    get_hosted_executor_session,
    get_career_task,
    get_career_task_result,
    get_agent_provider_health,
    install_capability_plugin,
    invoke_plugin_capability,
    get_role_benchmark,
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
    reject_agent_run,
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
    list_career_task_events,
    list_career_tasks,
    list_agent_provider_health,
    list_automation_events,
    list_automation_inbox,
    list_automation_rules,
    list_capability_plugins,
    list_plugin_capabilities,
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
    list_role_delta_signals,
    list_resume_optimizations,
    list_resumes,
    prepare_pre_application_decision,
    prepare_role_interview_focus,
    prepare_resume_optimization,
    promote_session_memory,
    register_work_source,
    refresh_job_research_report,
    refresh_role_benchmark,
    ingest_application_signal,
    ingest_interview_behavior_events,
    record_automation_event,
    record_follow_up,
    revoke_email_account,
    restart_ai_interview,
    review_memory_proposal,
    review_job_research,
    review_pre_application_decision,
    review_resume_optimization,
    review_application_progress,
    resolve_automation_inbox_item,
    save_career_artifact,
    search_memory,
    start_batch_job_evaluation,
    start_authorized_research_session,
    resume_batch_job_evaluation,
    resume_job_research,
    resume_work_source_sync,
    resume_career_task,
    retry_career_task,
    start_work_source_sync,
    start_job_research,
    start_career_task,
    delegate_career_task,
    build_role_benchmark,
    sync_email_notifications,
    submit_ai_interview_answer,
    update_application_record,
    update_application_status,
    uninstall_capability_plugin,
    email_connection_status,
    delete_ai_interview,
)
from app.services.legacy_operations import (
    apply_application_template_to_all,
    apply_resume_template,
    auto_fill_calendar_events,
    auto_write_application_job,
    collect_interview_experience,
    create_application_table,
    create_application_table_record,
    create_calendar_event,
    create_legacy_application,
    create_resume_template,
    delete_application_records,
    delete_application_table,
    delete_resume_template,
    duplicate_resume_template,
    extract_interview_questions,
    generate_html_resume,
    generate_legacy_cover_letter,
    generate_legacy_interview_answer,
    import_jobs_to_application_table,
    import_latest_extension_batch_to_application_table,
    move_application_records,
    rename_application_table,
    update_application_settings,
    update_application_table_record,
    update_application_table_schema,
    update_legacy_application,
    update_resume_template,
    update_application_template,
)
from app.services.profile_operations import (
    confirm_profile_bullet,
    create_profile_section,
    create_target_role,
    delete_profile_section,
    delete_target_role,
    generate_profile_narrative,
    get_legacy_profile,
    list_target_roles,
    list_profile_chat_sessions,
    get_profile_chat_session,
    start_smart_fill_run,
    complete_smart_fill_run,
    save_profile_chat_turn,
    save_profile_resume_import,
    save_smart_fill_cache,
    save_smart_fill_run_logs,
    update_profile,
    update_profile_section,
)
from app.services.profile_agent_operations import (
    apply_profile_agent_patch,
    continue_profile_agent_session,
    get_profile_agent_session,
    start_profile_agent_session,
)
from app.services.resume_route_operations import (
    access_resume_share_record,
    apply_resume_suggestions_batch,
    apply_resume_suggestion,
    apply_resume_template_to_record,
    batch_optimize_resume_records,
    create_resume_record,
    create_resume_section,
    create_resume_share_record,
    create_resume_version_record,
    delete_resume_record,
    delete_resume_section,
    delete_resume_share_record,
    reorder_resume_sections,
    resolve_resume_logo,
    restore_resume_version_record,
    save_resume_draft_record,
    toggle_resume_share_record,
    update_resume_record,
    update_resume_section,
    upload_resume_logo,
    upload_resume_photo,
)
from app.services.resume_workspace import (
    ensure_resume_workspace,
    get_resume_workspace,
    review_resume_proposal_item,
)
from app.services.data_export import export_user_data
from app.services.diagnostics import export_diagnostic_bundle
from app.services.demo_data import reset_demo_data
from app.services.data_safety import (
    cancel_data_restore,
    check_database_integrity,
    create_data_backup,
    get_data_safety_status,
    list_data_backups,
    stage_data_restore,
)
from app.models.models import AgentWorkspaceState, Job, OperationAuditLog, Pool


OperationFn = Callable[..., Awaitable[Any]]


class _StrictOperationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DataRestoreInput(_StrictOperationInput):
    backup_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    user_confirmed: bool = False


class DataSafetyConfirmationInput(_StrictOperationInput):
    user_confirmed: bool = False


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


class FixtureJobResearchInput(_StrictOperationInput):
    job_id: int = Field(gt=0)


class RoleBenchmarkRunInput(_StrictOperationInput):
    job_id: int = Field(gt=0)
    runtime_id: str = Field(
        default="codex",
        pattern="^(codex|claude|gemini|omp|pi|opencode|fixture|replay|boss-fixture|plugin:[A-Za-z0-9_.-]+)$",
    )
    role_family: str = Field(default="", max_length=120)
    specialization: str = Field(default="", max_length=160)
    seniority: str = Field(default="", max_length=60)
    region: str = Field(default="", max_length=300)
    industry: str = Field(default="", max_length=200)


class CareerTaskStartInput(_StrictOperationInput):
    task_type: str = Field(
        pattern="^(agent_turn|run_artifact|role_intelligence|plugin_capability)$"
    )
    source: str = Field(default="ui", min_length=1, max_length=80)
    target_type: str = Field(default="", max_length=80)
    target_id: str = Field(default="", max_length=160)
    runtime_provider: str = Field(
        default="replay",
        pattern="^(codex|codex-app-server|claude|fixture|replay|mock|boss-fixture|plugin:[A-Za-z0-9_.-]+)$",
    )
    input: dict[str, Any] = Field(default_factory=dict)
    output_contract: dict[str, Any] = Field(default_factory=dict)
    run_id: str = Field(default="", max_length=160)
    idempotency_key: str = Field(default="", max_length=180)
    max_attempts: int = Field(default=3, ge=1, le=10)


class CareerTaskIdInput(_StrictOperationInput):
    task_id: str = Field(min_length=1, max_length=80)


class ListCareerTasksInput(_StrictOperationInput):
    status: str | None = Field(default=None, pattern="^(queued|running|waiting_for_approval|completed|failed|blocked|cancelled)$")
    task_type: str | None = Field(default=None, min_length=1, max_length=100)
    target_type: str | None = Field(default=None, min_length=1, max_length=80)
    target_id: str | None = Field(default=None, min_length=1, max_length=160)
    limit: int = Field(default=50, ge=1, le=200)


class CareerTaskEventsInput(CareerTaskIdInput):
    after: int = Field(default=0, ge=0)
    limit: int = Field(default=100, ge=1, le=500)


class ProviderHealthInput(_StrictOperationInput):
    provider_id: str = Field(min_length=1, max_length=80)


class DelegateCareerTaskInput(_StrictOperationInput):
    run_id: str = Field(min_length=1, max_length=160)
    job_id: int = Field(gt=0)
    runtime_id: str = Field(
        default="codex",
        pattern="^(codex|claude|gemini|omp|pi|opencode|fixture|replay|mock)$",
    )
    prompt: str = Field(min_length=1, max_length=12000)
    timeout_seconds: int = Field(default=240, ge=1, le=3600)
    web_search_mode: str = Field(default="disabled", pattern="^(disabled|live)$")


class PluginNameInput(_StrictOperationInput):
    plugin: str = Field(pattern="^[A-Za-z0-9_.-]{1,80}$")


class InvokePluginCapabilityInput(_StrictOperationInput):
    plugin: str = Field(pattern="^[A-Za-z0-9_.-]{1,80}$")
    capability: str = Field(min_length=1, max_length=160)
    arguments: dict[str, Any] = Field(default_factory=dict)
    timeout_seconds: int = Field(default=60, ge=1, le=300)


class RecordAutomationEventInput(_StrictOperationInput):
    event_type: str = Field(
        pattern=(
            "^(JOB_SAVED|JOB_UPDATED|APPLICATION_CREATED|APPLICATION_SUBMITTED|"
            "APPLICATION_STAGE_CANDIDATE|EMAIL_RECEIVED|INTERVIEW_INVITATION_DETECTED|"
            "REJECTION_DETECTED|OFFER_DETECTED|CAREER_FILE_CHANGED|"
            "CAREER_FACT_CANDIDATE_CREATED|RESUME_UPDATED|INTERVIEW_COMPLETED|"
            "INTERVIEW_DEBRIEF_CREATED|ROLE_BENCHMARK_STALE|DAILY_REVIEW|WEEKLY_REVIEW)$"
        )
    )
    source: str = Field(default="system", min_length=1, max_length=80)
    target_type: str = Field(default="", max_length=80)
    target_id: str = Field(default="", max_length=160)
    payload: dict[str, Any] = Field(default_factory=dict)
    dedupe_key: str = Field(default="", max_length=180)


class ListAutomationEventsInput(_StrictOperationInput):
    event_type: str | None = Field(default=None, max_length=80)
    status: str | None = Field(
        default=None,
        pattern="^(queued|dispatched|completed|failed|blocked|skipped)$",
    )
    limit: int = Field(default=100, ge=1, le=500)


class ListAutomationInboxInput(_StrictOperationInput):
    status: str = Field(default="pending", pattern="^(pending|resolved|dismissed|all)$")
    category: str | None = Field(
        default=None,
        pattern="^(needs_approval|needs_review|fyi|completed|failed)$",
    )
    limit: int = Field(default=100, ge=1, le=500)


class ListAutomationRulesInput(_StrictOperationInput):
    enabled: bool | None = None


class ResolveAutomationInboxItemInput(_StrictOperationInput):
    item_id: str = Field(min_length=1, max_length=100)
    action: str = Field(pattern="^(resolve|dismiss|reopen)$")


class GetRoleBenchmarkInput(_StrictOperationInput):
    run_id: str | None = Field(default=None, min_length=1, max_length=64)
    job_id: int | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def require_run_or_job(self) -> "GetRoleBenchmarkInput":
        if not self.run_id and self.job_id is None:
            raise ValueError("run_id 或 job_id 至少填写一个")
        return self


class ListRoleDeltaSignalsInput(GetRoleBenchmarkInput):
    direction: str | None = Field(
        default=None,
        pattern="^(common|distinctive|highly_distinctive|missing_common)$",
    )
    limit: int = Field(default=100, ge=1, le=200)


class PrepareRoleInterviewFocusInput(_StrictOperationInput):
    job_id: int = Field(gt=0)
    run_id: str | None = Field(default=None, min_length=1, max_length=64)
    profile_id: int | None = Field(default=None, gt=0)
    focus_count: int = Field(default=5, ge=3, le=5)
    question_count: int = Field(default=5, ge=5, le=8)


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


class AgentRunIdInput(_StrictOperationInput):
    run_id: str = Field(min_length=1, max_length=120)


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


class BatchDeleteJobsInput(_StrictOperationInput):
    job_ids: list[PositiveInt] = Field(min_length=1, max_length=500)


class ApplicationTableNameInput(_StrictOperationInput):
    name: str = Field(min_length=1, max_length=120)


class ApplicationTableIdNameInput(_StrictOperationInput):
    table_id: int = Field(gt=0)
    name: str = Field(min_length=1, max_length=120)


class ApplicationTableIdInput(_StrictOperationInput):
    table_id: int = Field(gt=0)


class ImportApplicationJobsInput(_StrictOperationInput):
    table_id: int = Field(gt=0)
    job_ids: list[PositiveInt] = Field(min_length=1, max_length=500)
    skip_existing_in_table: bool = False


class ImportLatestExtensionBatchInput(_StrictOperationInput):
    table_id: int = Field(gt=0)
    batch_id: str = Field(default="", max_length=64)
    source: str = Field(default="offeru-extension", min_length=1, max_length=64)
    limit: int = Field(default=500, ge=1, le=500)
    skip_existing: bool = True


class ApplicationRecordCreateInput(_StrictOperationInput):
    table_id: int = Field(gt=0)
    values: dict[str, Any] = Field(min_length=1)
    job_ref_id: int | None = Field(default=None, gt=0)


class ApplicationRecordUpdateInput(_StrictOperationInput):
    record_id: int = Field(gt=0)
    field_key: str = Field(min_length=1, max_length=120)
    value: Any = None


class MoveApplicationRecordsInput(_StrictOperationInput):
    source_table_id: int = Field(gt=0)
    target_table_id: int = Field(gt=0)
    record_ids: list[PositiveInt] = Field(min_length=1, max_length=500)


class DeleteApplicationRecordsInput(_StrictOperationInput):
    table_id: int = Field(gt=0)
    record_ids: list[PositiveInt] = Field(min_length=1, max_length=500)
    delete_from_total: bool = False


class ApplicationTableSchemaInput(_StrictOperationInput):
    table_id: int = Field(gt=0)
    schema: list[dict[str, Any]] = Field(min_length=1, max_length=200)


class ApplicationTemplateInput(_StrictOperationInput):
    schema: list[dict[str, Any]] = Field(min_length=1, max_length=200)
    purge_non_template_fields: bool = False


class ApplicationTemplateApplyAllInput(_StrictOperationInput):
    purge_non_template_fields: bool = False


class ApplicationSettingsInput(_StrictOperationInput):
    auto_row_height: bool | None = None
    auto_column_width: bool | None = None
    delete_subtable_sync_total_default: bool | None = None


class LegacyApplicationCreateInput(_StrictOperationInput):
    job_id: int = Field(gt=0)
    notes: str = Field(default="", max_length=60000)


class LegacyApplicationUpdateInput(_StrictOperationInput):
    application_id: int = Field(gt=0)
    status: str | None = Field(default=None, max_length=80)
    notes: str | None = Field(default=None, max_length=60000)
    cover_letter: str | None = Field(default=None, max_length=60000)


class CalendarEventCreateInput(_StrictOperationInput):
    title: str = Field(min_length=1, max_length=500)
    description: str = Field(default="", max_length=10000)
    event_type: str = Field(default="interview", max_length=80)
    start_time: datetime
    end_time: datetime | None = None
    location: str = Field(default="", max_length=1000)
    related_job_id: int | None = Field(default=None, gt=0)
    related_notification_id: int | None = Field(default=None, gt=0)


class CollectInterviewExperienceInput(_StrictOperationInput):
    company: str = Field(min_length=1, max_length=300)
    role: str = Field(min_length=1, max_length=300)
    raw_text: str = Field(min_length=10, max_length=200000)
    source_url: str | None = Field(default=None, max_length=2048)
    source_platform: str = Field(default="manual", min_length=1, max_length=80)
    job_id: int | None = Field(default=None, gt=0)


class ExtractInterviewQuestionsInput(_StrictOperationInput):
    experience_id: int = Field(gt=0)


class GenerateLegacyInterviewAnswerInput(_StrictOperationInput):
    question_id: int = Field(gt=0)


class ResumeTemplateCreateInput(_StrictOperationInput):
    name: str = Field(min_length=1, max_length=300)
    thumbnail_url: str = Field(default="", max_length=2048)
    css_variables: dict[str, Any] = Field(default_factory=dict)
    html_layout: str = Field(default="", max_length=200000)
    is_builtin: bool = False


class ResumeTemplateUpdateInput(_StrictOperationInput):
    template_id: int = Field(gt=0)
    name: str | None = Field(default=None, min_length=1, max_length=300)
    thumbnail_url: str | None = Field(default=None, max_length=2048)
    css_variables: dict[str, Any] | None = None
    html_layout: str | None = Field(default=None, max_length=200000)


class ResumeTemplateIdInput(_StrictOperationInput):
    template_id: int = Field(gt=0)


class ResumeTemplateApplyInput(_StrictOperationInput):
    template_id: int = Field(gt=0)
    resume_id: int = Field(gt=0)


class ResumeTemplateDuplicateInput(_StrictOperationInput):
    template_id: int = Field(gt=0)
    new_name: str = Field(min_length=1, max_length=300)


class LegacyCoverLetterInput(_StrictOperationInput):
    job_id: int = Field(gt=0)
    resume_id: int = Field(gt=0)


class GenerateHtmlResumeInput(_StrictOperationInput):
    profile_id: int = Field(gt=0)
    template_id: int = Field(gt=0)
    design_overrides: dict[str, Any] = Field(default_factory=dict)
    job_ids: list[PositiveInt] = Field(default_factory=list, max_length=500)


class JobStatsInput(_StrictOperationInput):
    pass


class GetProfileInput(_StrictOperationInput):
    pass


class ProfileUpdateInput(_StrictOperationInput):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    headline: str | None = Field(default=None, max_length=300)
    exit_story: str | None = None
    cross_cutting_advantage: str | None = None
    base_info_json: dict[str, Any] | None = None


class TargetRoleCreateInput(_StrictOperationInput):
    role_name: str = Field(min_length=1, max_length=120)
    role_level: str = Field(default="", max_length=60)
    fit: str = Field(default="primary", pattern="^(primary|secondary|adjacent)$")


class TargetRoleIdInput(_StrictOperationInput):
    role_id: int = Field(gt=0)


class ProfileSectionCreateInput(_StrictOperationInput):
    section_type: str = Field(min_length=1, max_length=60)
    category_label: str | None = Field(default=None, max_length=80)
    title: str = Field(default="", max_length=220)
    sort_order: int = 0
    content_json: dict[str, Any] = Field(default_factory=dict)
    source: str = Field(default="manual", max_length=30)
    confidence: float = Field(default=1.0, ge=0, le=1)
    tier: str | None = Field(
        default=None,
        pattern="^(verified_fact|preference|career_hypothesis)$",
    )


class ProfileSectionUpdateInput(_StrictOperationInput):
    section_id: int = Field(gt=0)
    section_type: str | None = Field(default=None, min_length=1, max_length=60)
    category_label: str | None = Field(default=None, max_length=80)
    title: str | None = Field(default=None, max_length=220)
    sort_order: int | None = None
    content_json: dict[str, Any] | None = None
    source: str | None = Field(default=None, max_length=30)
    confidence: float | None = Field(default=None, ge=0, le=1)


class ProfileSectionIdInput(_StrictOperationInput):
    section_id: int = Field(gt=0)


class ProfileChatTurnInput(_StrictOperationInput):
    topic: str = Field(pattern="^(education|experience|project|activity|skill|general)$")
    user_message: str = Field(min_length=1, max_length=10000)
    assistant_message: str = Field(min_length=1, max_length=30000)
    candidates: list[dict[str, Any]] = Field(max_length=3)
    topic_complete: bool = False
    session_id: int | None = Field(default=None, gt=0)


class ConfirmProfileBulletInput(_StrictOperationInput):
    session_id: int = Field(gt=0)
    bullet_index: int = Field(ge=0, le=20)
    edits: dict[str, Any] | None = None


class ProfileResumeImportInput(_StrictOperationInput):
    filename: str = Field(min_length=1, max_length=255)
    parse_mode: str = Field(pattern="^(ai|mechanical)$")
    parsed_text: str = Field(min_length=1, max_length=1_000_000)
    parse_diagnostics: dict[str, Any] = Field(default_factory=dict)
    base_info: dict[str, Any] = Field(default_factory=dict)
    candidates: list[dict[str, Any]] = Field(max_length=100)
    agent_messages_json: list[dict[str, Any]] = Field(max_length=100)
    memory_summary: dict[str, Any] = Field(default_factory=dict)


class SmartFillCacheSetInput(_StrictOperationInput):
    cache_key: str = Field(min_length=4, max_length=128)
    adapter_id: str = Field(default="unknown", max_length=50)
    model_signature: str = Field(default="", max_length=128)
    ttl_seconds: int = Field(default=300, ge=30, le=7200)
    mappings: list[dict[str, Any]] = Field(default_factory=list)
    channel: str = Field(default="backend", max_length=30)
    fallback_used: bool = False
    run_id: str | None = Field(default=None, max_length=64)


class SmartFillRunLogsInput(_StrictOperationInput):
    run_id: str = Field(min_length=6, max_length=64)
    logs: list[dict[str, Any]] = Field(default_factory=list, max_length=500)


class ProfileChatSessionsInput(_StrictOperationInput):
    limit: int = Field(default=20, ge=1, le=100)


class HarnessConversationSaveInput(_StrictOperationInput):
    conversation_id: str | None = Field(default=None, max_length=120)
    messages: list[dict[str, str]] = Field(max_length=120)


class HarnessConversationIdInput(_StrictOperationInput):
    conversation_id: str = Field(min_length=1, max_length=120)


class HarnessMemoryImportInput(_StrictOperationInput):
    content: dict[str, Any] | str


class OptimizeAgentStartInput(_StrictOperationInput):
    job_ids: list[int] = Field(min_length=1, max_length=200)
    mode: str = Field(default="per_job", pattern="^(per_job|combined)$")
    profile_id: int | None = Field(default=None, gt=0)
    reference_resume_id: int | None = Field(default=None, gt=0)


class OptimizeAgentChatInput(_StrictOperationInput):
    session_id: str = Field(min_length=1, max_length=120)
    message: str = Field(min_length=1, max_length=20_000)
    action: str = Field(default="reply", pattern="^(reply|confirm|reject|adjust)$")
    feedback: str = Field(default="", max_length=20_000)


class OptimizeAgentSessionIdInput(_StrictOperationInput):
    session_id: str = Field(min_length=1, max_length=120)


class ProfileChatSessionIdInput(_StrictOperationInput):
    session_id: int = Field(gt=0)


class SmartFillRunStartInput(_StrictOperationInput):
    run_id: str = Field(min_length=6, max_length=64)


class SmartFillRunCompleteInput(_StrictOperationInput):
    run_id: str = Field(min_length=6, max_length=64)
    status: str = Field(pattern="^(success|failed|cancelled)$")
    summary: dict[str, Any] = Field(default_factory=dict)


class ProfileAgentStartInput(_StrictOperationInput):
    state: dict[str, Any] = Field(default_factory=dict)
    patch: dict[str, Any] = Field(min_length=1)
    messages_json: list[dict[str, Any]] = Field(max_length=100)


class ProfileAgentMessageInput(_StrictOperationInput):
    session_id: int = Field(gt=0)
    message: str = Field(min_length=1, max_length=8000)


class ProfileAgentApplyInput(_StrictOperationInput):
    session_id: int = Field(gt=0)
    patch: dict[str, Any] | None = None


class ResumeCreateRecordInput(_StrictOperationInput):
    user_name: str = Field(default="", max_length=200)
    title: str = Field(default="未命名简历", max_length=300)
    summary: str = Field(default="", max_length=50_000)
    contact_json: dict[str, Any] = Field(default_factory=dict)
    template_id: int | None = Field(default=None, gt=0)
    style_config: dict[str, Any] = Field(default_factory=dict)
    language: str = Field(default="zh", max_length=10)
    source_mode: str = Field(default="manual", max_length=30)
    source_job_ids: list[int] = Field(default_factory=list, max_length=100)
    source_profile_snapshot: dict[str, Any] = Field(default_factory=dict)
    source_resume_id: int | None = Field(default=None, gt=0)
    target_job_id: int | None = Field(default=None, gt=0)
    application_id: int | None = Field(default=None, gt=0)


class ResumeApplyTemplateInput(_StrictOperationInput):
    template_id: int = Field(gt=0)
    resume_id: int = Field(gt=0)


class ResumeUpdateRecordInput(_StrictOperationInput):
    resume_id: int = Field(gt=0)
    update_data: dict[str, Any] = Field(default_factory=dict)


class ResumeIdInput(_StrictOperationInput):
    resume_id: int = Field(gt=0)


class ResumeSectionReorderInput(_StrictOperationInput):
    resume_id: int = Field(gt=0)
    items: list[dict[str, int]] = Field(max_length=500)


class ResumeSectionCreateInput(_StrictOperationInput):
    resume_id: int = Field(gt=0)
    section_type: str = Field(min_length=1, max_length=50)
    title: str = Field(default="", max_length=200)
    sort_order: int = Field(default=0, ge=0)
    visible: bool = True
    content_json: list[Any] = Field(default_factory=list)


class ResumeSectionUpdateInput(_StrictOperationInput):
    resume_id: int = Field(gt=0)
    section_id: int = Field(gt=0)
    update_data: dict[str, Any] = Field(default_factory=dict)


class ResumeSectionIdInput(_StrictOperationInput):
    resume_id: int = Field(gt=0)
    section_id: int = Field(gt=0)


class ResumeUploadInput(_StrictOperationInput):
    resume_id: int = Field(gt=0)
    content_b64: str = Field(min_length=1, max_length=8_000_000)
    content_type: str = Field(pattern="^image/(jpeg|png|webp)$")


class ResumeLogoResolveInput(_StrictOperationInput):
    resume_id: int = Field(gt=0)
    school_name: str = Field(min_length=1, max_length=120)


class ResumeSuggestionInput(_StrictOperationInput):
    resume_id: int = Field(gt=0)
    suggestion: dict[str, Any] = Field(min_length=1)


class ResumeSuggestionBatchInput(_StrictOperationInput):
    resume_id: int = Field(gt=0)
    payload: dict[str, Any] = Field(min_length=1)


class ResumeBatchOptimizeInput(_StrictOperationInput):
    resume_id: int = Field(gt=0)
    job_ids: list[int] = Field(min_length=1, max_length=20)
    auto_apply: bool = False


class ResumeVersionCreateInput(_StrictOperationInput):
    resume_id: int = Field(gt=0)
    change_summary: str = Field(default="", max_length=500)
    created_by: str = Field(default="user", max_length=100)


class ResumeVersionRestoreInput(_StrictOperationInput):
    resume_id: int = Field(gt=0)
    version_id: int = Field(gt=0)


class ResumeWorkspaceInput(_StrictOperationInput):
    resume_id: int = Field(gt=0)


class ResumeWorkspaceEnsureInput(_StrictOperationInput):
    job_id: int = Field(gt=0)
    proposal_id: str | None = Field(default=None, min_length=1, max_length=80)
    reference_resume_id: int | None = Field(default=None, gt=0)


class ResumeProposalItemReviewInput(_StrictOperationInput):
    proposal_id: str = Field(min_length=1, max_length=80)
    resume_id: int = Field(gt=0)
    change_id: str = Field(min_length=1, max_length=120)
    action: str = Field(pattern="^(accept|reject)$")
    edited_text: str = Field(default="", max_length=20_000)


class ResumeShareCreateInput(_StrictOperationInput):
    resume_id: int = Field(gt=0)
    password: str | None = Field(default=None, max_length=200)
    expires_days: int | None = Field(default=None, ge=1, le=3650)


class ResumeShareIdInput(_StrictOperationInput):
    share_id: int = Field(gt=0)


class ResumeShareAccessInput(_StrictOperationInput):
    share_token: str = Field(min_length=1, max_length=128)
    password: str | None = Field(default=None, max_length=200)


class SaveResumeDraftInput(_StrictOperationInput):
    resume_id: int = Field(gt=0)
    profile_id: int = Field(gt=0)
    jd_text: str = Field(min_length=1, max_length=100_000)
    summary: str = Field(default="", max_length=50_000)
    sections: list[dict[str, Any]] = Field(min_length=1, max_length=50)
    fact_gates: dict[str, Any] = Field(default_factory=dict)


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
    pool_id: int | None = Field(default=None, gt=0)


class StartScraperBatchInput(_StrictOperationInput):
    batch_id: str = Field(min_length=1, max_length=64)
    source: str = Field(min_length=1, max_length=50)
    keywords: list[str] = Field(default_factory=list, max_length=50)
    location: str = Field(default="", max_length=100)
    max_results: int = Field(default=50, ge=1, le=500)
    pool_name: str = Field(min_length=1, max_length=100)


class FinalizeScraperBatchInput(_StrictOperationInput):
    batch_id: str = Field(min_length=1, max_length=64)
    total_fetched: int = Field(default=0, ge=0, le=100_000)
    job_count: int = Field(default=0, ge=0, le=100_000)
    status: str = Field(default="completed", pattern="^(completed|failed)$")


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


class GetApplicationProgressTimelineInput(_StrictOperationInput):
    application_attempt_id: int = Field(gt=0)


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
    "bridge",
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
    research_run_id = str(kwargs.get("research_run_id") or "").strip()
    if stage != "ready_for_resume_proposal" and research_run_id:
        fixture_research = await get_job_research(run_id=research_run_id)
        trace = fixture_research.get("trace")
        if (
            fixture_research.get("data_mode") == "fixture"
            and isinstance(trace, dict)
            and trace.get("synthetic") is True
            and trace.get("pre_reviewed") is True
        ):
            return await prepare_resume_optimization(**kwargs)
    if stage != "ready_for_resume_proposal":
        raise ValueError("只有审核通过投或有条件投的岗位才能生成简历提案")
    return await prepare_resume_optimization(**kwargs)


OPERATIONS: dict[str, Operation] = {
    "get_data_safety_status": Operation(
        name="get_data_safety_status",
        fn=get_data_safety_status,
        description="读取本地数据库、受管备份数量与待重启恢复状态；不返回本机绝对路径。",
        group="governance",
        input_model=_StrictOperationInput,
        version="2026-08-30",
    ),
    "check_database_integrity": Operation(
        name="check_database_integrity",
        fn=check_database_integrity,
        description="运行 SQLite integrity_check 与 foreign_key_check，不修改业务数据。",
        group="governance",
        input_model=_StrictOperationInput,
        version="2026-08-30",
    ),
    "list_data_backups": Operation(
        name="list_data_backups",
        fn=list_data_backups,
        description="列出通过 manifest 与归档结构校验的本地受管备份。",
        group="governance",
        input_model=_StrictOperationInput,
        version="2026-08-30",
    ),
    "create_data_backup": Operation(
        name="create_data_backup",
        fn=create_data_backup,
        description="确认后使用 SQLite Online Backup API 创建一致性快照，并保存受管资产 manifest 与哈希。",
        group="governance",
        side_effects=("write",),
        input_model=_StrictOperationInput,
        version="2026-08-30",
    ),
    "stage_data_restore": Operation(
        name="stage_data_restore",
        fn=stage_data_restore,
        description="确认后校验并暂存指定备份；当前进程不替换数据库，下次启动前执行恢复。",
        group="governance",
        side_effects=("write",),
        input_model=DataRestoreInput,
        version="2026-08-30",
    ),
    "cancel_data_restore": Operation(
        name="cancel_data_restore",
        fn=cancel_data_restore,
        description="确认后取消待重启恢复任务；已创建的备份归档保持不变。",
        group="governance",
        side_effects=("write",),
        input_model=DataSafetyConfirmationInput,
        version="2026-08-30",
    ),
    "export_user_data": Operation(
        name="export_user_data",
        fn=export_user_data,
        description="导出本地核心职业数据；自动排除 Provider 凭据、连接凭据和浏览器会话状态。",
        group="governance",
        audit_redacted_output_parameters=("data",),
        version="2026-08-29",
    ),
    "export_diagnostic_bundle": Operation(
        name="export_diagnostic_bundle",
        fn=export_diagnostic_bundle,
        description="导出本地脱敏诊断包；只包含运行元数据、错误关联 ID 和安全摘要，不包含 Profile、岗位、简历或凭据。",
        group="governance",
        audit_redacted_output_parameters=("recent_errors",),
        version="2026-08-31",
    ),
    "reset_demo_data": Operation(
        name="reset_demo_data",
        fn=reset_demo_data,
        description="确认后只清理 reserved offeru-demo/offeru-demo-v1 合成数据，不接收任意 ID，也不删除真实用户数据。",
        group="governance",
        side_effects=("write",),
        input_model=DataSafetyConfirmationInput,
        version="2026-08-31",
    ),
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
            "role_benchmark_run_id": "str?",
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
        description="批量导入岗位为 Job（浏览器扩展/CLI/采集器统一入口）：逐条按 hash_key 幂等去重，同 batch_id 重放不重复计数；triage_status=inbox。",
        parameters={
            "jobs": "list[object]",
            "source": "str=manual",
            "batch_id": "str?",
            "keywords": "list[str]=[]",
            "location": "str?",
            "pool_id": "int?",
        },
        group="jobs",
        side_effects=("write",),
        input_model=ImportJobBatchInput,
        version="2026-08-10",
    ),
    "start_scraper_batch": Operation(
        name="start_scraper_batch",
        fn=start_scraper_batch,
        description="创建采集任务的岗位池与持久化批次。后台采集器不得直接写入 ORM。",
        group="jobs",
        side_effects=("external", "write"),
        input_model=StartScraperBatchInput,
        version="2026-08-28",
    ),
    "finalize_scraper_batch": Operation(
        name="finalize_scraper_batch",
        fn=finalize_scraper_batch,
        description="记录采集批次最终状态与 Runtime 统计数量。",
        group="jobs",
        side_effects=("write",),
        input_model=FinalizeScraperBatchInput,
        version="2026-08-28",
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
    "create_fixture_job_research": Operation(
        name="create_fixture_job_research",
        fn=create_fixture_job_research,
        description="仅为 replay 内测链路创建明确标记的合成岗位调研；不访问网络、不代表真实市场事实。",
        parameters={"job_id": "int"},
        group="research",
        side_effects=("write",),
        input_model=FixtureJobResearchInput,
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
    "build_role_benchmark": Operation(
        name="build_role_benchmark",
        fn=build_role_benchmark,
        description="确认后使用受限 deep executor 收集同类 JD，并由 Runtime 持久化去重后的岗位基准与确定性 Delta；fixture/replay 仅用于本地验收。",
        parameters={
            "job_id": "int",
            "runtime_id": "str=codex",
            "role_family": "str?",
            "specialization": "str?",
            "seniority": "str?",
            "region": "str?",
            "industry": "str?",
        },
        group="research",
        side_effects=("external", "llm", "write"),
        input_model=RoleBenchmarkRunInput,
        version="2026-08-26",
    ),
    "refresh_role_benchmark": Operation(
        name="refresh_role_benchmark",
        fn=refresh_role_benchmark,
        description="确认后重新收集并计算目标岗位的同类岗位基准；历史运行保持不变。",
        parameters={
            "job_id": "int",
            "runtime_id": "str=codex",
            "role_family": "str?",
            "specialization": "str?",
            "seniority": "str?",
            "region": "str?",
            "industry": "str?",
        },
        group="research",
        side_effects=("external", "llm", "write"),
        input_model=RoleBenchmarkRunInput,
        version="2026-08-26",
    ),
    "get_role_benchmark": Operation(
        name="get_role_benchmark",
        fn=get_role_benchmark,
        description="读取岗位基准运行、去重/cohort 样本、统一能力观察和 Delta 证据。",
        parameters={"run_id": "str?", "job_id": "int?"},
        group="research",
        input_model=GetRoleBenchmarkInput,
        version="2026-08-26",
    ),
    "list_role_delta_signals": Operation(
        name="list_role_delta_signals",
        fn=list_role_delta_signals,
        description="读取由 Python Runtime 计算的岗位 Delta，可按方向筛选；不接受 LLM 生成的频率。",
        parameters={
            "run_id": "str?",
            "job_id": "int?",
            "direction": "str? (common|distinctive|highly_distinctive|missing_common)",
            "limit": "int=100",
        },
        group="research",
        input_model=ListRoleDeltaSignalsInput,
        version="2026-08-26",
    ),
    "prepare_role_interview_focus": Operation(
        name="prepare_role_interview_focus",
        fn=prepare_role_interview_focus,
        description="读取已完成的岗位 Delta 与 active verified career evidence，确定性生成专项面试 Focus Plan；不修改 Profile。",
        parameters={
            "job_id": "int",
            "run_id": "str?",
            "profile_id": "int?",
            "focus_count": "int=5 (3-5)",
            "question_count": "int=5 (5-8)",
        },
        group="interview",
        input_model=PrepareRoleInterviewFocusInput,
        version="2026-08-27",
    ),
    "start_career_task": Operation(
        name="start_career_task",
        fn=start_career_task,
        description="创建可恢复的 CareerTask 执行信封；任务结果是候选/提案，不直接成为 Career Truth。",
        group="agent_runtime",
        side_effects=("write",),
        input_model=CareerTaskStartInput,
        version="2026-08-27",
    ),
    "get_career_task": Operation(
        name="get_career_task",
        fn=get_career_task,
        description="读取一个 CareerTask 的状态、进度、恢复信息和显式错误。",
        group="agent_runtime",
        input_model=CareerTaskIdInput,
        version="2026-08-27",
    ),
    "list_career_tasks": Operation(
        name="list_career_tasks",
        fn=list_career_tasks,
        description="读取 CareerTask 列表，支持状态、类型和目标筛选。",
        group="agent_runtime",
        input_model=ListCareerTasksInput,
        version="2026-08-27",
    ),
    "list_career_task_events": Operation(
        name="list_career_task_events",
        fn=list_career_task_events,
        description="读取 CareerTask 的追加式生命周期事件。",
        group="agent_runtime",
        input_model=CareerTaskEventsInput,
        version="2026-08-27",
    ),
    "get_career_task_result": Operation(
        name="get_career_task_result",
        fn=get_career_task_result,
        description="读取 CareerTask 的最终候选结果或显式失败原因。",
        group="agent_runtime",
        input_model=CareerTaskIdInput,
        version="2026-08-27",
    ),
    "cancel_career_task": Operation(
        name="cancel_career_task",
        fn=cancel_career_task,
        description="取消一个尚未完成的 CareerTask；已完成任务不可重放。",
        group="agent_runtime",
        side_effects=("write",),
        input_model=CareerTaskIdInput,
        version="2026-08-27",
    ),
    "retry_career_task": Operation(
        name="retry_career_task",
        fn=retry_career_task,
        description="在 retry policy 允许时重新排队失败的 CareerTask。",
        group="agent_runtime",
        side_effects=("write",),
        input_model=CareerTaskIdInput,
        version="2026-08-27",
    ),
    "resume_career_task": Operation(
        name="resume_career_task",
        fn=resume_career_task,
        description="从持久化 checkpoint 恢复可重试的 CareerTask。",
        group="agent_runtime",
        side_effects=("write",),
        input_model=CareerTaskIdInput,
        version="2026-08-27",
    ),
    "delegate_career_task": Operation(
        name="delegate_career_task",
        fn=delegate_career_task,
        description="把受限 workspace 深度任务放入 CareerTask；工作区、Job 上下文和外部执行仍由控制面约束。",
        group="agent_runtime",
        side_effects=("external", "llm", "write"),
        permissions=("workspace:bound", "executor:task-scoped"),
        input_model=DelegateCareerTaskInput,
        version="2026-08-27",
    ),
    "get_agent_provider_health": Operation(
        name="get_agent_provider_health",
        fn=get_agent_provider_health,
        description="读取一个 Agent Runtime provider 的脱敏可用性、认证与阻塞状态。",
        group="agent_runtime",
        input_model=ProviderHealthInput,
        version="2026-08-27",
    ),
    "list_agent_provider_health": Operation(
        name="list_agent_provider_health",
        fn=list_agent_provider_health,
        description="读取所有已记录的 Agent Runtime provider 健康快照。",
        group="agent_runtime",
        version="2026-08-27",
    ),
    "list_capability_plugins": Operation(
        name="list_capability_plugins",
        fn=list_capability_plugins,
        description="发现本地 OfferU Capability Plugin 及其安装状态；不执行插件。",
        group="plugins",
        version="2026-08-27",
    ),
    "list_plugin_capabilities": Operation(
        name="list_plugin_capabilities",
        fn=list_plugin_capabilities,
        description="读取已安装插件声明的 capability、side effect 和输出契约。",
        group="plugins",
        version="2026-08-27",
    ),
    "install_capability_plugin": Operation(
        name="install_capability_plugin",
        fn=install_capability_plugin,
        description="确认后启用一个本地 Capability Plugin；只改变能力发现状态，不删除或改写插件文件。",
        group="plugins",
        side_effects=("write",),
        input_model=PluginNameInput,
        version="2026-08-27",
    ),
    "uninstall_capability_plugin": Operation(
        name="uninstall_capability_plugin",
        fn=uninstall_capability_plugin,
        description="确认后禁用一个本地 Capability Plugin；保留文件，能力从 Agent 目录消失。",
        group="plugins",
        side_effects=("write",),
        input_model=PluginNameInput,
        version="2026-08-27",
    ),
    "invoke_plugin_capability": Operation(
        name="invoke_plugin_capability",
        fn=invoke_plugin_capability,
        description="调用已安装插件的读取型 CLI capability；stdout 必须是一个 JSON object，结果仍是候选数据。",
        group="plugins",
        side_effects=("external_read",),
        permissions=("plugin:declared", "network:manifest-scoped"),
        input_model=InvokePluginCapabilityInput,
        version="2026-08-27",
    ),
    "record_automation_event": Operation(
        name="record_automation_event",
        fn=record_automation_event,
        description="记录一个可幂等重放的 AutomationEvent，并按显式 Rule 创建 CareerTask；结果不会绕过控制面成为 Career Truth。",
        group="automation",
        side_effects=("write",),
        input_model=RecordAutomationEventInput,
        version="2026-08-27",
    ),
    "list_automation_events": Operation(
        name="list_automation_events",
        fn=list_automation_events,
        description="读取 AutomationEvent 信号及其分发状态。",
        group="automation",
        input_model=ListAutomationEventsInput,
        version="2026-08-27",
    ),
    "list_automation_inbox": Operation(
        name="list_automation_inbox",
        fn=list_automation_inbox,
        description="读取 OfferU Automation Inbox 中需要审批、复核、知会或失败处理的项目。",
        group="automation",
        input_model=ListAutomationInboxInput,
        version="2026-08-27",
    ),
    "list_automation_rules": Operation(
        name="list_automation_rules",
        fn=list_automation_rules,
        description="读取事件到任务的显式 Automation Rule；不存在无限 Agent Loop。",
        group="automation",
        input_model=ListAutomationRulesInput,
        version="2026-08-27",
    ),
    "resolve_automation_inbox_item": Operation(
        name="resolve_automation_inbox_item",
        fn=resolve_automation_inbox_item,
        description="确认后关闭、忽略或重新打开一个 Automation Inbox 项；不会把候选直接写入 Career Profile。",
        group="automation",
        side_effects=("write",),
        input_model=ResolveAutomationInboxItemInput,
        version="2026-08-27",
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
    "get_resume_workspace": Operation(
        name="get_resume_workspace",
        fn=get_resume_workspace,
        description="读取岗位简历工作区：编辑内容、目标岗位、Proposal 队列、版本和 Application Packet 引用。",
        parameters={"resume_id": "int"},
        group="resume",
        input_model=ResumeWorkspaceInput,
    ),
    "ensure_resume_workspace": Operation(
        name="ensure_resume_workspace",
        fn=ensure_resume_workspace,
        description="为目标岗位幂等建立或复用 Tailored Resume Workspace；保留原简历，不直接接受 AI Proposal。",
        parameters={"job_id": "int", "proposal_id": "str?", "reference_resume_id": "int?"},
        group="resume",
        side_effects=("write",),
        permissions=("resume_write", "job_description"),
        input_model=ResumeWorkspaceEnsureInput,
    ),
    "review_resume_proposal_item": Operation(
        name="review_resume_proposal_item",
        fn=review_resume_proposal_item,
        description="在 Resume Workspace 中逐条接受或拒绝 AI Proposal；检测手工修改造成的 stale，不能覆盖最新内容。",
        parameters={
            "proposal_id": "str",
            "resume_id": "int",
            "change_id": "str",
            "action": "str (accept|reject)",
            "edited_text": "str?",
        },
        group="resume",
        side_effects=("write",),
        permissions=("resume_write",),
        input_model=ResumeProposalItemReviewInput,
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


OPERATIONS.update(
    {
        "create_application_table": Operation(
            name="create_application_table",
            fn=create_application_table,
            description="创建投递工作区子表。",
            group="applications",
            side_effects=("write",),
            input_model=ApplicationTableNameInput,
        ),
        "rename_application_table": Operation(
            name="rename_application_table",
            fn=rename_application_table,
            description="重命名投递工作区子表。",
            group="applications",
            side_effects=("write",),
            input_model=ApplicationTableIdNameInput,
        ),
        "delete_application_table": Operation(
            name="delete_application_table",
            fn=delete_application_table,
            description="删除投递工作区子表。",
            group="applications",
            side_effects=("write",),
            input_model=ApplicationTableIdInput,
        ),
        "import_jobs_to_application_table": Operation(
            name="import_jobs_to_application_table",
            fn=import_jobs_to_application_table,
            description="把指定岗位导入投递工作区表。",
            group="applications",
            side_effects=("write",),
            input_model=ImportApplicationJobsInput,
        ),
        "import_latest_extension_batch_to_application_table": Operation(
            name="import_latest_extension_batch_to_application_table",
            fn=import_latest_extension_batch_to_application_table,
            description="把最近一次浏览器扩展采集批次导入投递工作区表。",
            group="applications",
            side_effects=("write",),
            input_model=ImportLatestExtensionBatchInput,
        ),
        "create_application_table_record": Operation(
            name="create_application_table_record",
            fn=create_application_table_record,
            description="在投递工作区表中创建一条记录。",
            group="applications",
            side_effects=("write",),
            input_model=ApplicationRecordCreateInput,
        ),
        "update_application_table_record": Operation(
            name="update_application_table_record",
            fn=update_application_table_record,
            description="更新投递工作区记录字段。",
            group="applications",
            side_effects=("write",),
            input_model=ApplicationRecordUpdateInput,
        ),
        "move_application_records": Operation(
            name="move_application_records",
            fn=move_application_records,
            description="在投递工作区表之间移动记录。",
            group="applications",
            side_effects=("write",),
            input_model=MoveApplicationRecordsInput,
        ),
        "delete_application_records": Operation(
            name="delete_application_records",
            fn=delete_application_records,
            description="删除或从投递工作区表移除记录。",
            group="applications",
            side_effects=("write",),
            input_model=DeleteApplicationRecordsInput,
        ),
        "update_application_table_schema": Operation(
            name="update_application_table_schema",
            fn=update_application_table_schema,
            description="更新投递工作区表结构。",
            group="applications",
            side_effects=("write",),
            input_model=ApplicationTableSchemaInput,
        ),
        "update_application_template": Operation(
            name="update_application_template",
            fn=update_application_template,
            description="更新投递工作区模板并同步表结构。",
            group="applications",
            side_effects=("write",),
            input_model=ApplicationTemplateInput,
        ),
        "apply_application_template_to_all": Operation(
            name="apply_application_template_to_all",
            fn=apply_application_template_to_all,
            description="将投递工作区模板应用到所有表。",
            group="applications",
            side_effects=("write",),
            input_model=ApplicationTemplateApplyAllInput,
        ),
        "update_application_settings": Operation(
            name="update_application_settings",
            fn=update_application_settings,
            description="更新投递工作区设置。",
            group="applications",
            side_effects=("write",),
            input_model=ApplicationSettingsInput,
        ),
        "auto_write_application_job": Operation(
            name="auto_write_application_job",
            fn=auto_write_application_job,
            description="将岗位写入投递工作区总表。",
            group="applications",
            side_effects=("write",),
            input_model=GetJobInput,
        ),
        "create_legacy_application": Operation(
            name="create_legacy_application",
            fn=create_legacy_application,
            description="兼容旧投递接口创建投递记录。",
            group="applications",
            side_effects=("write",),
            input_model=LegacyApplicationCreateInput,
        ),
        "update_legacy_application": Operation(
            name="update_legacy_application",
            fn=update_legacy_application,
            description="兼容旧投递接口更新投递记录。",
            group="applications",
            side_effects=("write",),
            input_model=LegacyApplicationUpdateInput,
        ),
        "create_calendar_event": Operation(
            name="create_calendar_event",
            fn=create_calendar_event,
            description="创建本地日历事件。",
            group="calendar",
            side_effects=("write",),
            input_model=CalendarEventCreateInput,
        ),
        "auto_fill_calendar_events": Operation(
            name="auto_fill_calendar_events",
            fn=auto_fill_calendar_events,
            description="根据面试通知补建缺失的本地日历事件。",
            group="calendar",
            side_effects=("write",),
            input_model=WorkflowCatalogInput,
        ),
        "collect_interview_experience": Operation(
            name="collect_interview_experience",
            fn=collect_interview_experience,
            description="保存一条面经原文。",
            group="interview",
            side_effects=("write",),
            input_model=CollectInterviewExperienceInput,
        ),
        "extract_interview_questions": Operation(
            name="extract_interview_questions",
            fn=extract_interview_questions,
            description="从面经原文提炼结构化面试问题并保存。",
            group="interview",
            side_effects=("llm", "write"),
            input_model=ExtractInterviewQuestionsInput,
        ),
        "generate_legacy_interview_answer": Operation(
            name="generate_legacy_interview_answer",
            fn=generate_legacy_interview_answer,
            description="根据职业档案为题库问题生成回答思路并保存。",
            group="interview",
            side_effects=("llm", "write"),
            input_model=GenerateLegacyInterviewAnswerInput,
        ),
        "generate_legacy_cover_letter": Operation(
            name="generate_legacy_cover_letter",
            fn=generate_legacy_cover_letter,
            description="兼容旧投递接口生成求职信草稿。",
            group="applications",
            side_effects=("llm",),
            input_model=LegacyCoverLetterInput,
        ),
        "create_resume_template": Operation(
            name="create_resume_template",
            fn=create_resume_template,
            description="创建自定义简历模板。",
            group="resume",
            side_effects=("write",),
            input_model=ResumeTemplateCreateInput,
        ),
        "update_resume_template": Operation(
            name="update_resume_template",
            fn=update_resume_template,
            description="更新自定义简历模板。",
            group="resume",
            side_effects=("write",),
            input_model=ResumeTemplateUpdateInput,
        ),
        "delete_resume_template": Operation(
            name="delete_resume_template",
            fn=delete_resume_template,
            description="删除自定义简历模板。",
            group="resume",
            side_effects=("write",),
            input_model=ResumeTemplateIdInput,
        ),
        "apply_resume_template": Operation(
            name="apply_resume_template",
            fn=apply_resume_template,
            description="将简历模板应用到指定简历。",
            group="resume",
            side_effects=("write",),
            input_model=ResumeTemplateApplyInput,
        ),
        "duplicate_resume_template": Operation(
            name="duplicate_resume_template",
            fn=duplicate_resume_template,
            description="复制一份简历模板。",
            group="resume",
            side_effects=("write",),
            input_model=ResumeTemplateDuplicateInput,
        ),
        "generate_html_resume": Operation(
            name="generate_html_resume",
            fn=generate_html_resume,
            description="根据档案和 HTML 模板生成并保存 HTML 简历。",
            group="resume",
            side_effects=("llm", "write"),
            input_model=GenerateHtmlResumeInput,
        ),
        "get_legacy_profile": Operation(
            name="get_legacy_profile",
            fn=get_legacy_profile,
            description="读取并规范化兼容 Profile 接口使用的完整档案。",
            group="profile",
            side_effects=("write",),
            input_model=GetProfileInput,
        ),
        "list_profile_target_roles": Operation(
            name="list_profile_target_roles",
            fn=list_target_roles,
            description="读取兼容 Profile 接口使用的目标岗位方向。",
            group="profile",
            side_effects=("write",),
            input_model=GetProfileInput,
        ),
        "list_profile_chat_sessions": Operation(
            name="list_profile_chat_sessions",
            fn=list_profile_chat_sessions,
            description="读取 Profile 对话会话列表。",
            group="profile",
            side_effects=("write",),
            input_model=ProfileChatSessionsInput,
        ),
        "get_profile_chat_session": Operation(
            name="get_profile_chat_session",
            fn=get_profile_chat_session,
            description="读取 Profile 对话会话及最近候选。",
            group="profile",
            side_effects=("write",),
            input_model=ProfileChatSessionIdInput,
        ),
        "update_profile": Operation(
            name="update_profile",
            fn=update_profile,
            description="更新 Profile 基础信息并同步职业档案条目。",
            group="profile",
            side_effects=("write",),
            input_model=ProfileUpdateInput,
        ),
        "create_target_role": Operation(
            name="create_target_role",
            fn=create_target_role,
            description="创建一个目标岗位方向。",
            group="profile",
            side_effects=("write",),
            input_model=TargetRoleCreateInput,
        ),
        "delete_target_role": Operation(
            name="delete_target_role",
            fn=delete_target_role,
            description="删除当前档案下的目标岗位方向。",
            group="profile",
            side_effects=("write",),
            input_model=TargetRoleIdInput,
        ),
        "create_profile_section": Operation(
            name="create_profile_section",
            fn=create_profile_section,
            description="创建一条经过规范化的 Profile 档案条目。",
            group="profile",
            side_effects=("write",),
            input_model=ProfileSectionCreateInput,
        ),
        "update_profile_section": Operation(
            name="update_profile_section",
            fn=update_profile_section,
            description="更新一条 Profile 档案条目。",
            group="profile",
            side_effects=("write",),
            input_model=ProfileSectionUpdateInput,
        ),
        "delete_profile_section": Operation(
            name="delete_profile_section",
            fn=delete_profile_section,
            description="删除一条 Profile 档案条目。",
            group="profile",
            side_effects=("write",),
            input_model=ProfileSectionIdInput,
        ),
        "save_profile_chat_turn": Operation(
            name="save_profile_chat_turn",
            fn=save_profile_chat_turn,
            description="保存 Profile 对话及其候选条目；候选需经确认才进入档案事实。",
            group="profile",
            side_effects=("llm", "write"),
            input_model=ProfileChatTurnInput,
        ),
        "confirm_profile_bullet": Operation(
            name="confirm_profile_bullet",
            fn=confirm_profile_bullet,
            description="确认一条 Profile 对话候选并写入档案条目。",
            group="profile",
            side_effects=("write",),
            input_model=ConfirmProfileBulletInput,
        ),
        "save_profile_resume_import": Operation(
            name="save_profile_resume_import",
            fn=save_profile_resume_import,
            description="保存简历导入产生的候选会话与证据，不直接确认候选事实。",
            group="profile",
            side_effects=("write",),
            input_model=ProfileResumeImportInput,
        ),
        "generate_profile_narrative": Operation(
            name="generate_profile_narrative",
            fn=generate_profile_narrative,
            description="根据已保存档案条目生成并保存叙事字段。",
            group="profile",
            side_effects=("llm", "write"),
            input_model=GetProfileInput,
        ),
        "save_smart_fill_cache": Operation(
            name="save_smart_fill_cache",
            fn=save_smart_fill_cache,
            description="保存 SmartFill 映射缓存。",
            group="profile",
            side_effects=("write",),
            input_model=SmartFillCacheSetInput,
        ),
        "save_smart_fill_run_logs": Operation(
            name="save_smart_fill_run_logs",
            fn=save_smart_fill_run_logs,
            description="追加 SmartFill 运行诊断日志。",
            group="profile",
            side_effects=("write",),
            input_model=SmartFillRunLogsInput,
        ),
        "start_smart_fill_run": Operation(
            name="start_smart_fill_run",
            fn=start_smart_fill_run,
            description="创建 SmartFill 运行记录。",
            group="profile",
            side_effects=("write",),
            input_model=SmartFillRunStartInput,
        ),
        "complete_smart_fill_run": Operation(
            name="complete_smart_fill_run",
            fn=complete_smart_fill_run,
            description="记录 SmartFill 运行的成功或失败状态。",
            group="profile",
            side_effects=("write",),
            input_model=SmartFillRunCompleteInput,
        ),
        "start_profile_agent_session": Operation(
            name="start_profile_agent_session",
            fn=start_profile_agent_session,
            description="创建 Profile Builder Agent 的可审计会话。",
            group="profile",
            side_effects=("write",),
            input_model=ProfileAgentStartInput,
        ),
        "get_profile_agent_session": Operation(
            name="get_profile_agent_session",
            fn=get_profile_agent_session,
            description="读取 Profile Builder Agent 会话及其待确认候选。",
            group="profile",
            input_model=ProfileChatSessionIdInput,
        ),
        "continue_profile_agent_session": Operation(
            name="continue_profile_agent_session",
            fn=continue_profile_agent_session,
            description="追加 Profile Builder Agent 用户消息并保存下一轮候选。",
            group="profile",
            side_effects=("llm", "write"),
            input_model=ProfileAgentMessageInput,
        ),
        "apply_profile_agent_patch": Operation(
            name="apply_profile_agent_patch",
            fn=apply_profile_agent_patch,
            description="将用户确认的 Profile Builder Agent 候选补丁写入职业档案。",
            group="profile",
            side_effects=("write",),
            input_model=ProfileAgentApplyInput,
        ),
    }
)


OPERATIONS["reject_agent_run"] = Operation(
    name="reject_agent_run",
    fn=reject_agent_run,
    description="记录用户拒绝 Agent Run 提案，确保后续不会执行。",
    group="agent_runtime",
    side_effects=("write",),
    input_model=AgentRunIdInput,
    version="2026-08-28",
)


OPERATIONS.update(
    {
        "start_optimize_agent_session": Operation(
            name="start_optimize_agent_session",
            fn=start_optimize_agent_session,
            description="启动兼容的对话式简历优化会话并持久化会话快照。",
            group="resume",
            side_effects=("llm", "write"),
            input_model=OptimizeAgentStartInput,
            version="2026-08-28",
        ),
        "chat_optimize_agent_session": Operation(
            name="chat_optimize_agent_session",
            fn=chat_optimize_agent_session,
            description="推进对话式简历优化会话并保存状态。",
            group="resume",
            side_effects=("llm", "write"),
            input_model=OptimizeAgentChatInput,
            version="2026-08-28",
        ),
        "stream_optimize_agent_session": Operation(
            name="stream_optimize_agent_session",
            fn=stream_optimize_agent_session,
            description="执行兼容的对话式简历优化会话并返回可复用 SSE 事件。",
            group="resume",
            side_effects=("llm", "write"),
            input_model=OptimizeAgentChatInput,
            audit_redacted_output_parameters=("events",),
            version="2026-08-28",
        ),
        "delete_optimize_agent_session": Operation(
            name="delete_optimize_agent_session",
            fn=delete_optimize_agent_session,
            description="删除对话式简历优化会话。",
            group="resume",
            side_effects=("write",),
            input_model=OptimizeAgentSessionIdInput,
            version="2026-08-28",
        ),
    }
)


OPERATIONS.update(
    {
        "create_resume_record": Operation(
            name="create_resume_record",
            fn=create_resume_record,
            description="创建一份带默认段落的简历记录。",
            group="resume",
            side_effects=("write",),
            input_model=ResumeCreateRecordInput,
        ),
        "apply_resume_record_template": Operation(
            name="apply_resume_record_template",
            fn=apply_resume_template_to_record,
            description="将模板样式应用到指定简历。",
            group="resume",
            side_effects=("write",),
            input_model=ResumeApplyTemplateInput,
        ),
        "update_resume_record": Operation(
            name="update_resume_record",
            fn=update_resume_record,
            description="更新简历元信息并按 id 同步段落。",
            group="resume",
            side_effects=("write",),
            input_model=ResumeUpdateRecordInput,
        ),
        "delete_resume_record": Operation(
            name="delete_resume_record",
            fn=delete_resume_record,
            description="删除简历及其段落。",
            group="resume",
            side_effects=("write",),
            input_model=ResumeIdInput,
        ),
        "reorder_resume_sections": Operation(
            name="reorder_resume_sections",
            fn=reorder_resume_sections,
            description="批量更新简历段落顺序。",
            group="resume",
            side_effects=("write",),
            input_model=ResumeSectionReorderInput,
        ),
        "create_resume_section": Operation(
            name="create_resume_section",
            fn=create_resume_section,
            description="向简历添加段落。",
            group="resume",
            side_effects=("write",),
            input_model=ResumeSectionCreateInput,
        ),
        "update_resume_section": Operation(
            name="update_resume_section",
            fn=update_resume_section,
            description="更新简历段落。",
            group="resume",
            side_effects=("write",),
            input_model=ResumeSectionUpdateInput,
        ),
        "delete_resume_section": Operation(
            name="delete_resume_section",
            fn=delete_resume_section,
            description="删除简历段落。",
            group="resume",
            side_effects=("write",),
            input_model=ResumeSectionIdInput,
        ),
        "upload_resume_photo": Operation(
            name="upload_resume_photo",
            fn=upload_resume_photo,
            description="保存简历头像并更新简历引用。",
            group="resume",
            side_effects=("external", "write"),
            permissions=("local_file:write",),
            audit_redacted_parameters=("content_b64",),
            input_model=ResumeUploadInput,
        ),
        "upload_resume_logo": Operation(
            name="upload_resume_logo",
            fn=upload_resume_logo,
            description="保存学校标识并更新简历联系方式。",
            group="resume",
            side_effects=("external", "write"),
            permissions=("local_file:write",),
            audit_redacted_parameters=("content_b64",),
            input_model=ResumeUploadInput,
        ),
        "resolve_resume_logo": Operation(
            name="resolve_resume_logo",
            fn=resolve_resume_logo,
            description="从公开来源解析学校标识并更新简历联系方式。",
            group="resume",
            side_effects=("external", "write"),
            permissions=("network:public_read",),
            input_model=ResumeLogoResolveInput,
        ),
        "apply_resume_suggestion": Operation(
            name="apply_resume_suggestion",
            fn=apply_resume_suggestion,
            description="经事实门与版本备份后应用一条简历建议。",
            group="resume",
            side_effects=("write",),
            permissions=("resume_write",),
            input_model=ResumeSuggestionInput,
        ),
        "apply_resume_suggestions_batch": Operation(
            name="apply_resume_suggestions_batch",
            fn=apply_resume_suggestions_batch,
            description="经事实门与版本备份后原子应用一批简历建议。",
            group="resume",
            side_effects=("write",),
            permissions=("resume_write",),
            input_model=ResumeSuggestionBatchInput,
        ),
        "batch_optimize_resume_records": Operation(
            name="batch_optimize_resume_records",
            fn=batch_optimize_resume_records,
            description="按岗位批量创建岗位化简历候选稿。",
            group="resume",
            side_effects=("llm", "write"),
            permissions=("resume_write", "job_description"),
            input_model=ResumeBatchOptimizeInput,
        ),
        "create_resume_version_record": Operation(
            name="create_resume_version_record",
            fn=create_resume_version_record,
            description="保存简历版本快照。",
            group="resume",
            side_effects=("write",),
            input_model=ResumeVersionCreateInput,
        ),
        "restore_resume_version_record": Operation(
            name="restore_resume_version_record",
            fn=restore_resume_version_record,
            description="创建回滚前备份并恢复指定简历版本。",
            group="resume",
            side_effects=("write",),
            permissions=("resume_write",),
            input_model=ResumeVersionRestoreInput,
        ),
        "create_resume_share_record": Operation(
            name="create_resume_share_record",
            fn=create_resume_share_record,
            description="创建带可选密码和过期时间的简历分享链接。",
            group="resume",
            side_effects=("write",),
            input_model=ResumeShareCreateInput,
        ),
        "delete_resume_share_record": Operation(
            name="delete_resume_share_record",
            fn=delete_resume_share_record,
            description="删除简历分享链接。",
            group="resume",
            side_effects=("write",),
            input_model=ResumeShareIdInput,
        ),
        "toggle_resume_share_record": Operation(
            name="toggle_resume_share_record",
            fn=toggle_resume_share_record,
            description="启用或禁用简历分享链接。",
            group="resume",
            side_effects=("write",),
            input_model=ResumeShareIdInput,
        ),
        "access_resume_share_record": Operation(
            name="access_resume_share_record",
            fn=access_resume_share_record,
            description="验证分享链接并记录一次访问。",
            group="resume",
            side_effects=("write",),
            input_model=ResumeShareAccessInput,
        ),
        "save_resume_draft_record": Operation(
            name="save_resume_draft_record",
            fn=save_resume_draft_record,
            description="保存待审核的 AI 简历草稿，不直接覆盖正式简历。",
            group="resume",
            side_effects=("write",),
            permissions=("resume_write",),
            audit_redacted_parameters=("jd_text", "sections"),
            input_model=SaveResumeDraftInput,
        ),
    }
)


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


async def delete_jobs_batch_operation(job_ids: list[int]) -> dict[str, Any]:
    if not job_ids:
        return {"error": "job_ids is required"}
    if len(job_ids) > 500:
        return {"error": "job_ids exceeds 500"}

    async with async_session() as db:
        jobs = (await db.execute(select(Job).where(Job.id.in_(job_ids)))).scalars().all()
        found_ids = {job.id for job in jobs}
        missing_ids = sorted(set(job_ids) - found_ids)
        if missing_ids:
            return {"error": f"some job_ids were not found: {missing_ids}", "missing_job_ids": missing_ids}

        non_ignored = [job.id for job in jobs if job.triage_status != "ignored"]
        if non_ignored:
            return {
                "error": f"only ignored jobs can be deleted permanently: {non_ignored}",
                "protected_job_ids": non_ignored,
            }

        for job in jobs:
            await db.delete(job)

        await db.commit()
        return {"deleted": len(jobs), "requested": len(job_ids)}


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
                    "inputs": redact_sensitive_value(row.inputs_json or {}),
                    "warnings": redact_sensitive_value(row.warnings_json or []),
                    "errors": redact_sensitive_value(row.errors_json or []),
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
        "delete_jobs_batch": Operation(
            name="delete_jobs_batch",
            fn=delete_jobs_batch_operation,
            description="永久删除批量岗位；仅允许删除已标记为 ignored 的岗位。",
            parameters={"job_ids": "list[int]"},
            group="jobs",
            side_effects=("write",),
            input_model=BatchDeleteJobsInput,
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
        "get_application_progress_timeline": Operation(
            name="get_application_progress_timeline",
            fn=get_application_progress_timeline,
            description="读取单条投递的追加式阶段时间线、邮件证据与待确认候选。",
            parameters={"application_attempt_id": "int"},
            group="applications",
            input_model=GetApplicationProgressTimelineInput,
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
            errors=[
                safe_error_message(RuntimeError(str(result["error"])))
            ]
            if isinstance(result, dict) and result.get("error")
            else [],
            op=op,
        )
    except Exception as exc:
        envelope = _envelope(
            ok=False,
            operation=name,
            inputs=audit_inputs,
            started=started,
            errors=[safe_error_message(exc)],
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
    safe_inputs = redact_sensitive_value(inputs)
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
        inputs_json=_json_object(safe_inputs),
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
        or existing.inputs_json != _json_object(safe_inputs)
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
                    warnings_json=redact_sensitive_value(
                        envelope.get("warnings") or []
                    ),
                    errors_json=redact_sensitive_value(
                        envelope.get("errors") or []
                    ),
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
    message = safe_error_message(error, fallback="审计记录失败")
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
    return redact_sensitive_value(
        _redact_mapping(inputs, set(op.audit_redacted_parameters))
    )


def _audit_outputs(op: Optional[Operation], outputs: Any) -> Any:
    if op is not None and isinstance(outputs, dict):
        outputs = _redact_mapping(
            outputs, set(op.audit_redacted_output_parameters)
        )
    return redact_sensitive_value(outputs)


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
                inputs_json=_json_object(
                    redact_sensitive_value(envelope.get("inputs"))
                ),
                outputs_json=_json_object(
                    _audit_outputs(op, envelope.get("outputs"))
                ),
                warnings_json=redact_sensitive_value(
                    envelope.get("warnings") or []
                ),
                errors_json=redact_sensitive_value(
                    envelope.get("errors") or []
                ),
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


OPERATIONS.update(
    {
        "save_harness_conversation": Operation(
            name="save_harness_conversation",
            fn=save_harness_conversation,
            description="保存本地 Harness 会话消息，不直接修改 Career Truth。",
            group="agent_runtime",
            side_effects=("write",),
            input_model=HarnessConversationSaveInput,
            version="2026-08-28",
        ),
        "delete_harness_conversation": Operation(
            name="delete_harness_conversation",
            fn=delete_harness_conversation,
            description="删除本地 Harness 会话记录。",
            group="agent_runtime",
            side_effects=("write",),
            input_model=HarnessConversationIdInput,
            version="2026-08-28",
        ),
        "distill_harness_conversation": Operation(
            name="distill_harness_conversation",
            fn=distill_harness_conversation,
            description="把 Harness 会话中的可验证用户摘录送入现有学习观察管线。",
            group="agent_runtime",
            side_effects=("llm", "write"),
            input_model=HarnessConversationIdInput,
            version="2026-08-28",
        ),
        "promote_harness_memory": Operation(
            name="promote_harness_memory",
            fn=promote_harness_memory,
            description="把 Harness 会话记忆快照送入现有职业记忆候选管线。",
            group="agent_runtime",
            side_effects=("llm", "write"),
            input_model=_StrictOperationInput,
            version="2026-08-28",
        ),
        "import_harness_memory": Operation(
            name="import_harness_memory",
            fn=import_harness_memory,
            description="导入并保存本地 Harness 记忆快照。",
            group="agent_runtime",
            side_effects=("write",),
            input_model=HarnessMemoryImportInput,
            version="2026-08-28",
        ),
    }
)
