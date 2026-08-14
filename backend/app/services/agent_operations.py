from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import hashlib
from pathlib import Path
import re
from typing import Optional

from sqlalchemy import func, select, desc

from app.database import async_session
from app.models.models import (
    Application,
    ApplicationRecord,
    ApplicationTableRecord,
    ApplicationAttempt,
    CalendarEvent,
    InterviewExperience,
    InterviewQuestion,
    Job,
    Pool,
    Profile,
    ProfileSection,
    ProfileTargetRole,
    Resume,
    ResumeSection,
)


def _public_job_filter():
    return Job.triage_status != "ignored"


async def get_profile() -> dict:
    async with async_session() as db:
        profile = (
            await db.execute(
                select(Profile).where(Profile.is_default == True)
            )
        ).scalar_one_or_none()
        if not profile:
            return {"error": "No default profile found"}
        base_info = profile.base_info_json if isinstance(profile.base_info_json, dict) else {}
        roles = (
            await db.execute(
                select(ProfileTargetRole)
                .where(ProfileTargetRole.profile_id == profile.id)
                .order_by(ProfileTargetRole.created_at.asc())
            )
        ).scalars().all()
        return {
            "id": profile.id,
            "name": profile.name or "",
            "email": profile.email or "",
            "phone": profile.phone or "",
            "location": base_info.get("current_city", "") or "",
            "target_roles": [role.role_name for role in roles],
            "target_locations": base_info.get("target_locations", []) or [],
            "summary": base_info.get("personal_summary") or base_info.get("summary") or profile.headline or "",
        }


def _optional_datetime(value: Optional[str], field: str) -> Optional[datetime]:
    clean = str(value or "").strip()
    if not clean:
        return None
    try:
        parsed = datetime.fromisoformat(clean.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{field} 必须为 ISO 8601 时间") from exc
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


async def list_calendar_events(
    start: Optional[str] = None,
    end: Optional[str] = None,
    related_job_id: Optional[int] = None,
    limit: int = 100,
) -> dict:
    safe_limit = max(1, min(int(limit or 100), 500))
    start_at = _optional_datetime(start, "start")
    end_at = _optional_datetime(end, "end")
    if start_at and end_at and start_at > end_at:
        raise ValueError("start 不能晚于 end")
    async with async_session() as db:
        query = select(CalendarEvent)
        if start_at:
            query = query.where(CalendarEvent.start_time >= start_at)
        if end_at:
            query = query.where(CalendarEvent.start_time <= end_at)
        if related_job_id is not None:
            query = query.where(CalendarEvent.related_job_id == int(related_job_id))
        rows = (
            await db.execute(query.order_by(CalendarEvent.start_time.asc()).limit(safe_limit))
        ).scalars().all()
        return {
            "total": len(rows),
            "items": [
                {
                    "id": row.id,
                    "title": row.title,
                    "description": row.description or "",
                    "event_type": row.event_type,
                    "start_time": row.start_time.isoformat(),
                    "end_time": row.end_time.isoformat() if row.end_time else None,
                    "location": row.location or "",
                    "related_job_id": row.related_job_id,
                    "related_notification_id": row.related_notification_id,
                }
                for row in rows
            ],
        }


async def list_interview_questions(
    company: Optional[str] = None,
    role: Optional[str] = None,
    job_id: Optional[int] = None,
    category: Optional[str] = None,
    limit: int = 100,
) -> dict:
    safe_limit = max(1, min(int(limit or 100), 500))
    async with async_session() as db:
        query = select(InterviewQuestion)
        if company:
            query = query.where(
                InterviewQuestion.experience.has(
                    InterviewExperience.company.contains(str(company).strip())
                )
            )
        if role:
            query = query.where(
                InterviewQuestion.experience.has(
                    InterviewExperience.role.contains(str(role).strip())
                )
            )
        if job_id is not None:
            query = query.where(InterviewQuestion.job_id == int(job_id))
        if category:
            query = query.where(InterviewQuestion.category == str(category).strip())
        rows = (
            await db.execute(
                query.order_by(
                    InterviewQuestion.frequency.desc(),
                    InterviewQuestion.id.desc(),
                ).limit(safe_limit)
            )
        ).scalars().all()
        return {
            "total": len(rows),
            "items": [
                {
                    "id": row.id,
                    "experience_id": row.experience_id,
                    "question_text": row.question_text,
                    "round_type": row.round_type,
                    "category": row.category,
                    "difficulty": row.difficulty,
                    "frequency": row.frequency,
                    "suggested_answer": row.suggested_answer,
                    "job_id": row.job_id,
                    "created_at": row.created_at.isoformat() if row.created_at else None,
                }
                for row in rows
            ],
        }


async def list_agent_runs_summary(
    conversation_id: Optional[str] = None,
    task_id: Optional[str] = None,
    limit: int = 20,
) -> dict:
    from app.services.agent_run_state import list_agent_runs

    runs = await list_agent_runs(
        conversation_id=conversation_id,
        task_id=task_id,
        limit=limit,
    )
    return {
        "total": len(runs),
        "items": [
            {
                "id": run["id"],
                "task_id": run["task_id"],
                "conversation_id": run["conversation_id"],
                "goal": run["goal"],
                "mode": run["mode"],
                "skill_id": run["skill_id"],
                "skill_version": run["skill_version"],
                "status": run["status"],
                "pending_action_count": sum(
                    1
                    for step in run.get("steps") or []
                    if step.get("status") in {"waiting_confirmation", "executing"}
                ),
                "failure_reason": run.get("failure_reason") or "",
                "event_sequence": run.get("event_sequence") or 0,
                "created_at": run.get("created_at"),
                "updated_at": run.get("updated_at"),
            }
            for run in runs
        ],
    }


async def list_profile_evidence(
    section_type: Optional[str] = None,
    limit: int = 100,
) -> dict:
    safe_limit = max(1, min(int(limit), 500))
    async with async_session() as db:
        profile = (
            await db.execute(select(Profile).where(Profile.is_default == True))
        ).scalar_one_or_none()
        if not profile:
            return {"error": "No default profile found"}
        query = select(ProfileSection).where(ProfileSection.profile_id == profile.id)
        query = query.where(ProfileSection.status == "active")
        if section_type:
            query = query.where(ProfileSection.section_type == str(section_type).strip())
        sections = (
            await db.execute(
                query.order_by(ProfileSection.sort_order.asc(), ProfileSection.created_at.asc()).limit(safe_limit)
            )
        ).scalars().all()
        return {
            "profile_id": profile.id,
            "total": len(sections),
            "items": [
                {
                    "id": section.id,
                    "section_type": section.section_type,
                    "title": section.title or "",
                    "sort_order": section.sort_order,
                    "content_json": section.content_json or {},
                    "source": section.source,
                    "confidence": section.confidence,
                    "tier": section.tier,
                    "created_at": str(section.created_at),
                    "updated_at": str(section.updated_at),
                }
                for section in sections
            ],
        }


async def validate_fact_gate(source_facts: object, generated: object) -> dict:
    """Run resume fact-gate validation as a read-only Operation."""
    from app.services.resume_fact_gates import validate_generated_content

    if source_facts is None:
        raise ValueError("source_facts 不能为空")
    if generated is None:
        raise ValueError("generated 不能为空")
    return validate_generated_content(source_facts, generated)


async def create_application_attempt(
    job_id: int,
    resume_id: Optional[int] = None,
    resume_version_id: Optional[int] = None,
    cover_letter: str = "",
    notes: str = "",
) -> dict:
    """Create a single ApplicationAttempt row (ADR-0007: one row per attempt)."""
    try:
        job_id_int = int(job_id)
    except (TypeError, ValueError):
        raise ValueError("job_id 必须为整数")
    if job_id_int <= 0:
        raise ValueError("job_id 必须为正整数")
    rv_id: Optional[int] = None
    if resume_id is not None:
        try:
            rv_id = int(resume_id)
        except (TypeError, ValueError):
            raise ValueError("resume_id 必须为整数或 null")
    rver_id: Optional[int] = None
    if resume_version_id is not None:
        try:
            rver_id = int(resume_version_id)
        except (TypeError, ValueError):
            raise ValueError("resume_version_id 必须为整数或 null")
    clean_cover = str(cover_letter or "")[:60000]
    clean_notes = str(notes or "")[:60000]

    async with async_session() as db:
        job = (
            await db.execute(select(Job).where(Job.id == job_id_int))
        ).scalar_one_or_none()
        if not job:
            raise ValueError(f"job #{job_id_int} 不存在")
        if rv_id is not None:
            resume = (
                await db.execute(select(Resume).where(Resume.id == rv_id))
            ).scalar_one_or_none()
            if not resume:
                raise ValueError(f"resume #{rv_id} 不存在")
        attempt = ApplicationAttempt(
            job_id=job_id_int,
            resume_id=rv_id,
            resume_version_id=rver_id,
            cover_letter=clean_cover,
            status="prepared",
            notes=clean_notes,
        )
        db.add(attempt)
        await db.commit()
        await db.refresh(attempt)
        return {
            "id": attempt.id,
            "job_id": attempt.job_id,
            "resume_id": attempt.resume_id,
            "resume_version_id": attempt.resume_version_id,
            "status": attempt.status,
            "cover_letter_length": len(attempt.cover_letter or ""),
            "notes_length": len(attempt.notes or ""),
            "created_at": str(attempt.created_at),
        }


async def list_learning_observations(
    status: str = "active",
    observation_type: Optional[str] = None,
    limit: int = 100,
) -> dict:
    from app.services.career_memory import list_learning_observations as _list

    return await _list(
        status=status,
        observation_type=observation_type,
        limit=limit,
    )


async def list_memory_inbox(
    status: str = "pending",
    limit: int = 100,
) -> dict:
    from app.services.career_memory import list_memory_inbox as _list

    return await _list(status=status, limit=limit)


async def create_memory_proposal(
    observation_id: int,
    target_tier: str,
    section_type: str,
    title: str,
    after: dict,
    reason: str,
    before: Optional[dict] = None,
    impact: Optional[list[str]] = None,
    supersedes_proposal_id: Optional[int] = None,
) -> dict:
    from app.services.career_memory import create_memory_proposal as _create

    return await _create(
        observation_id=observation_id,
        target_tier=target_tier,
        section_type=section_type,
        title=title,
        after=after,
        reason=reason,
        before=before,
        impact=impact,
        supersedes_proposal_id=supersedes_proposal_id,
    )


async def derive_career_model() -> dict:
    from app.services.career_memory import derive_career_model as _derive

    return await _derive()


async def build_job_projection(job_id: int) -> dict:
    from app.services.job_projection import build_job_projection as _build

    return await _build(job_id=job_id)


async def list_career_ledger(
    status: str = "all",
    limit: int = 100,
) -> dict:
    from app.services.career_memory import list_career_ledger as _list

    return await _list(status=status, limit=limit)


async def review_memory_proposal(
    proposal_id: int,
    action: str,
    note: str = "",
) -> dict:
    from app.services.career_memory import review_memory_proposal as _review

    return await _review(
        proposal_id=proposal_id,
        action=action,
        note=note,
    )


async def invalidate_memory_source(
    source_id: int,
    reason: str,
) -> dict:
    from app.services.career_memory import invalidate_memory_source as _invalidate

    return await _invalidate(source_id=source_id, reason=reason)


async def get_ai_interview_runtime() -> dict:
    from app.services.ai_interviews import get_ai_interview_runtime as _get

    return _get()


async def list_interview_scoring_skills(
    status: str = "active",
    limit: int = 50,
) -> dict:
    from app.services.interview_scoring import list_interview_scoring_skills as _list

    return await _list(status=status, limit=limit)


async def get_interview_scoring_skill(
    skill_id: str,
    version: Optional[int] = None,
) -> dict:
    from app.services.interview_scoring import get_interview_scoring_skill as _get

    return await _get(skill_id=skill_id, version=version)


async def create_interview_scoring_skill(
    skill_id: str,
    name: str,
    definition: dict,
    user_confirmed: bool,
) -> dict:
    if user_confirmed is not True:
        raise ValueError("创建评分 Skill 前必须由使用者明确确认")
    from app.services.interview_scoring import create_interview_scoring_skill as _create

    return await _create(skill_id=skill_id, name=name, definition=definition)


async def list_ai_interviews(
    status: Optional[str] = None,
    limit: int = 100,
) -> dict:
    from app.services.ai_interviews import list_ai_interviews as _list

    return await _list(status=status, limit=limit)


async def get_ai_interview(
    interview_id: int,
    detail: str = "full",
) -> dict:
    from app.services.ai_interviews import get_ai_interview as _get

    return await _get(interview_id=interview_id, detail=detail)


async def create_ai_interview(
    model_provider: str,
    data_consent: bool,
    consented_data_categories: list[str],
    user_confirmed: bool,
    title: str = "未命名面试",
    target_company: str = "",
    target_position: str = "",
    target_job_id: Optional[int] = None,
    resume_id: Optional[int] = None,
    profile_id: Optional[int] = None,
    interview_type: str = "behavioral",
    difficulty: str = "medium",
    question_count: int = 5,
    scoring_skill_id: str = "evidence-interview-score",
    scoring_skill_version: Optional[int] = None,
) -> dict:
    from app.services.ai_interviews import create_ai_interview as _create

    return await _create(
        title=title,
        target_company=target_company,
        target_position=target_position,
        target_job_id=target_job_id,
        resume_id=resume_id,
        profile_id=profile_id,
        interview_type=interview_type,
        difficulty=difficulty,
        question_count=question_count,
        scoring_skill_id=scoring_skill_id,
        scoring_skill_version=scoring_skill_version,
        model_provider=model_provider,
        data_consent=data_consent,
        consented_data_categories=consented_data_categories,
        user_confirmed=user_confirmed,
    )


async def submit_ai_interview_answer(
    interview_id: int,
    question_index: int,
    content: str,
    model_provider: str,
    user_confirmed: bool,
) -> dict:
    from app.services.ai_interviews import submit_ai_interview_answer as _submit

    return await _submit(
        interview_id=interview_id,
        question_index=question_index,
        content=content,
        model_provider=model_provider,
        user_confirmed=user_confirmed,
    )


async def ingest_interview_behavior_events(
    interview_id: int,
    events: list[dict],
    user_confirmed: bool,
) -> dict:
    from app.services.ai_interviews import (
        ingest_interview_behavior_events as _ingest,
    )

    return await _ingest(
        interview_id=interview_id,
        events=events,
        user_confirmed=user_confirmed,
    )


async def delete_ai_interview(
    interview_id: int,
    reason: str,
    user_confirmed: bool,
) -> dict:
    from app.services.ai_interviews import delete_ai_interview as _delete

    return await _delete(
        interview_id=interview_id,
        reason=reason,
        user_confirmed=user_confirmed,
    )


async def restart_ai_interview(
    interview_id: int,
    user_confirmed: bool,
) -> dict:
    from app.services.ai_interviews import restart_ai_interview as _restart

    return await _restart(
        interview_id=interview_id,
        user_confirmed=user_confirmed,
    )


async def register_work_source(
    name: str,
    root_path: str,
    source_type: str = "directory",
    runtime_id: str = "codex",
    include_patterns: Optional[list[str]] = None,
    exclude_patterns: Optional[list[str]] = None,
) -> dict:
    from app.services.work_sources import register_work_source as _register

    return await _register(
        name=name,
        root_path=root_path,
        source_type=source_type,
        runtime_id=runtime_id,
        include_patterns=include_patterns,
        exclude_patterns=exclude_patterns,
    )


async def list_work_sources(status: str = "active", limit: int = 100) -> dict:
    from app.services.work_sources import list_work_sources as _list

    return await _list(status=status, limit=limit)


async def get_work_source(work_source_id: int) -> dict:
    from app.services.work_sources import get_work_source as _get

    return await _get(work_source_id=work_source_id)


async def start_work_source_sync(
    work_source_id: int,
    data_consent: bool,
    runtime_id: Optional[str] = None,
) -> dict:
    from app.services.work_sources import start_work_source_sync as _start

    return await _start(
        work_source_id=work_source_id,
        data_consent=data_consent,
        runtime_id=runtime_id,
    )


async def list_work_source_sync_runs(
    work_source_id: Optional[int] = None,
    status: Optional[str] = None,
    limit: int = 50,
) -> dict:
    from app.services.work_sources import list_work_source_sync_runs as _list

    return await _list(
        work_source_id=work_source_id,
        status=status,
        limit=limit,
    )


async def get_work_source_sync_run(run_id: str) -> dict:
    from app.services.work_sources import get_work_source_sync_run as _get

    return await _get(run_id=run_id)


async def resume_work_source_sync(run_id: str) -> dict:
    from app.services.work_sources import resume_work_source_sync as _resume

    return await _resume(run_id=run_id)


async def consolidate_memory_observations(
    observation_ids: Optional[list[int]] = None,
    limit: int = 100,
) -> dict:
    from app.services.memory_consolidation import (
        consolidate_memory_observations as _consolidate,
    )

    return await _consolidate(observation_ids=observation_ids, limit=limit)


async def distill_memory(
    observation_ids: Optional[list[int]] = None,
    limit: int = 20,
) -> dict:
    from app.services.memory_distiller import distill_observations as _distill

    return await _distill(observation_ids=observation_ids, limit=limit)


async def promote_session_memory() -> dict:
    from app.services.memory_distiller import promote_session_memory as _promote

    return await _promote()


async def search_memory(query: str, limit: int = 8) -> dict:
    from app.services.semantic_search import get_semantic_search

    hits = await get_semantic_search().search_observations(query=query, limit=limit)
    return {"count": len(hits), "hits": hits}


async def refresh_job_research_report(job_id: int) -> dict:
    from app.services.job_research import refresh_job_research_report as _refresh

    return await _refresh(job_id=job_id)


async def get_application_progress_board(
    status: str = "active",
    include_timeline: bool = False,
) -> dict:
    from app.services.application_progress import get_application_progress_board as _board

    return await _board(status=status, include_timeline=include_timeline)


async def classify_progress_signal(candidate_id: str) -> dict:
    from app.services.application_progress import classify_progress_signal as _classify

    return await _classify(candidate_id=candidate_id)


async def draft_interview_scoring_skill(
    goal: str,
    target_role: str = "",
    job_id: Optional[int] = None,
) -> dict:
    from app.services.interview_scoring import draft_scoring_skill as _draft

    return await _draft(goal=goal, target_role=target_role, job_id=job_id)


async def invalidate_work_source(work_source_id: int, reason: str) -> dict:
    from app.services.work_sources import invalidate_work_source as _invalidate

    return await _invalidate(work_source_id=work_source_id, reason=reason)


async def begin_gmail_oauth(redirect_uri: str) -> dict:
    from app.services.email_sync import begin_gmail_oauth as _begin

    return await _begin(redirect_uri=redirect_uri)


async def complete_gmail_oauth(code: str, state: str) -> dict:
    from app.services.email_sync import complete_gmail_oauth as _complete

    return await _complete(code=code, state=state)


async def connect_imap_account(
    user: str,
    password: str,
    provider: str = "",
    host: str = "",
    port: int = 993,
) -> dict:
    from app.services.email_sync import connect_imap_account as _connect

    return await _connect(
        user=user,
        password=password,
        provider=provider,
        host=host,
        port=port,
    )


async def email_connection_status() -> dict:
    from app.services.email_sync import email_connection_status as _status

    return await _status()


async def list_email_accounts(status: str = "active", limit: int = 50) -> dict:
    from app.services.email_sync import list_email_accounts as _list

    return await _list(status=status, limit=limit)


async def sync_email_notifications(account_id: Optional[str] = None) -> dict:
    from app.services.email_sync import sync_email_notifications as _sync

    return await _sync(account_id=account_id)


async def list_email_sync_runs(
    account_id: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 50,
) -> dict:
    from app.services.email_sync import list_email_sync_runs as _list

    return await _list(account_id=account_id, status=status, limit=limit)


async def get_email_sync_run(run_id: str) -> dict:
    from app.services.email_sync import get_email_sync_run as _get

    return await _get(run_id=run_id)


async def revoke_email_account(account_id: str, reason: str) -> dict:
    from app.services.email_sync import revoke_email_account as _revoke

    return await _revoke(account_id=account_id, reason=reason)


async def list_job_research_runs(
    job_id: Optional[int] = None,
    status: Optional[str] = None,
    limit: int = 20,
) -> dict:
    from app.services.job_research import list_job_research_runs as _list

    return await _list(job_id=job_id, status=status, limit=limit)


async def get_job_research(run_id: str) -> dict:
    from app.services.job_research import get_job_research as _get

    return await _get(run_id=run_id)


async def review_job_research(
    run_id: str,
    action: str,
    note: str = "",
) -> dict:
    from app.services.job_research import review_job_research as _review

    return await _review(run_id=run_id, action=action, note=note)


async def start_job_research(
    job_id: int,
    runtime_id: str = "codex",
) -> dict:
    from app.services.job_research import start_job_research as _start

    return await _start(job_id=job_id, runtime_id=runtime_id)


async def resume_job_research(run_id: str) -> dict:
    from app.services.job_research import resume_job_research as _resume

    return await _resume(run_id=run_id)


async def cancel_job_research(run_id: str) -> dict:
    from app.services.job_research import cancel_job_research as _cancel

    return await _cancel(run_id=run_id)


async def list_hosted_executor_sessions(
    task_type: Optional[str] = None,
    task_id: Optional[str] = None,
    limit: int = 20,
) -> dict:
    from app.services.coding_agent_runtime import list_hosted_executor_sessions as _list

    return await _list(task_type=task_type, task_id=task_id, limit=limit)


async def get_hosted_executor_session(session_id: str) -> dict:
    from app.services.coding_agent_runtime import get_hosted_executor_session as _get

    return await _get(session_id=session_id)


async def get_pre_application_state(job_id: int) -> dict:
    from app.services.pre_application_decisions import get_pre_application_state as _get

    return await _get(job_id=job_id)


async def prepare_pre_application_decision(
    job_id: int,
    research_run_id: Optional[str] = None,
) -> dict:
    from app.services.pre_application_decisions import (
        prepare_pre_application_decision as _prepare,
    )

    return await _prepare(job_id=job_id, research_run_id=research_run_id)


async def review_pre_application_decision(
    decision_id: str,
    final_decision: str,
    note: str = "",
) -> dict:
    from app.services.pre_application_decisions import (
        review_pre_application_decision as _review,
    )

    return await _review(
        decision_id=decision_id,
        final_decision=final_decision,
        note=note,
    )


async def start_authorized_research_session(
    job_id: int,
    platform: str,
    initial_url: str,
    user_authorized: bool,
    base_run_id: Optional[str] = None,
    expires_minutes: int = 30,
) -> dict:
    from app.services.authorized_research import (
        start_authorized_research_session as _start,
    )

    return await _start(
        job_id=job_id,
        platform=platform,
        initial_url=initial_url,
        user_authorized=user_authorized,
        base_run_id=base_run_id,
        expires_minutes=expires_minutes,
    )


async def activate_authorized_research_read_only(
    session_id: str,
    user_confirmed_login_complete: bool,
) -> dict:
    from app.services.authorized_research import (
        activate_authorized_research_read_only as _activate,
    )

    return await _activate(
        session_id=session_id,
        user_confirmed_login_complete=user_confirmed_login_complete,
    )


async def capture_authorized_research_page(
    session_id: str,
    dossier_scope: str,
    source_class: str,
    user_confirmed_capture: bool,
    publisher: str = "",
    published_at: Optional[str] = None,
    selected_text: str = "",
) -> dict:
    from app.services.authorized_research import (
        capture_authorized_research_page as _capture,
    )

    return await _capture(
        session_id=session_id,
        dossier_scope=dossier_scope,
        source_class=source_class,
        user_confirmed_capture=user_confirmed_capture,
        publisher=publisher,
        published_at=published_at,
        selected_text=selected_text,
    )


async def list_authorized_research_sessions(
    job_id: Optional[int] = None,
    status: Optional[str] = None,
    limit: int = 20,
) -> dict:
    from app.services.authorized_research import (
        list_authorized_research_sessions as _list,
    )

    return await _list(job_id=job_id, status=status, limit=limit)


async def get_authorized_research_session(
    session_id: str,
    include_excerpts: bool = False,
) -> dict:
    from app.services.authorized_research import (
        get_authorized_research_session as _get,
    )

    return await _get(
        session_id=session_id,
        include_excerpts=include_excerpts,
    )


async def complete_authorized_research_session(
    session_id: str,
    findings: list[dict],
    user_confirmed_findings: bool,
    gaps: Optional[list[str]] = None,
) -> dict:
    from app.services.authorized_research import (
        complete_authorized_research_session as _complete,
    )

    return await _complete(
        session_id=session_id,
        findings=findings,
        user_confirmed_findings=user_confirmed_findings,
        gaps=gaps,
    )


async def cancel_authorized_research_session(
    session_id: str,
    reason: str,
) -> dict:
    from app.services.authorized_research import (
        cancel_authorized_research_session as _cancel,
    )

    return await _cancel(session_id=session_id, reason=reason)


async def import_jd(
    title: str,
    company: str,
    jd_text: str,
    source: str = "agent_import",
    location: str = "",
    url: str = "",
    apply_url: str = "",
    batch_id: Optional[str] = None,
) -> dict:
    """Import a single JD as a Job; deduplicates by md5(jd_text)."""
    from app.services.campus_detector import detect_campus

    clean_title = str(title or "").strip()
    clean_company = str(company or "").strip()
    clean_jd = str(jd_text or "").strip()
    if not 1 <= len(clean_title) <= 500:
        raise ValueError("title 长度必须为 1-500 个字符")
    if not 1 <= len(clean_company) <= 300:
        raise ValueError("company 长度必须为 1-300 个字符")
    if not 1 <= len(clean_jd) <= 50_000:
        raise ValueError("jd_text 长度必须为 1-50000 个字符")

    hash_key = hashlib.md5(clean_jd.encode("utf-8")).hexdigest()
    resolved_batch = (batch_id or "").strip() or f"agent-jd-{datetime.utcnow().strftime('%Y%m%d%H%M%S')}"

    async with async_session() as db:
        existing = (
            await db.execute(select(Job).where(Job.hash_key == hash_key))
        ).scalar_one_or_none()
        if existing:
            return {
                "id": existing.id,
                "duplicate": True,
                "hash_key": hash_key,
                "message": "JD with identical text already imported; no write performed",
            }
        job = Job(
            title=clean_title,
            company=clean_company,
            location=str(location or "").strip(),
            url=str(url or "").strip(),
            apply_url=str(apply_url or "").strip(),
            source=(str(source or "").strip() or "agent_import"),
            raw_description=clean_jd,
            posted_at=None,
            batch_id=resolved_batch,
            triage_status="inbox",
            hash_key=hash_key,
            is_campus=detect_campus(
                title=clean_title,
                source=(source or ""),
                experience="",
                job_type="",
                raw_description=clean_jd,
            ),
        )
        db.add(job)
        await db.commit()
        await db.refresh(job)
        return {
            "id": job.id,
            "title": job.title,
            "company": job.company,
            "source": job.source,
            "batch_id": job.batch_id,
            "hash_key": job.hash_key,
            "is_campus": job.is_campus,
            "raw_description_length": len(job.raw_description or ""),
            "duplicate": False,
        }


async def add_profile_evidence(
    section_type: str,
    title: str,
    content_json: dict,
    source_text: str,
    category_label: Optional[str] = None,
    source_url: Optional[str] = None,
    dedup_key: Optional[str] = None,
    tier: Optional[str] = None,
    preference_confirmation: Optional[str] = None,
    user_confirmed: bool = False,
) -> dict:
    """Append one confirmed, source-grounded profile entry with deterministic dedup."""
    from app.services.profile_schema import canonicalize_profile_section_payload, normalize_profile_tier
    from app.services.resume_fact_gates import validate_generated_content

    clean_title = str(title or "").strip()
    clean_source = str(source_text or "").strip()
    if not 1 <= len(clean_title) <= 220:
        raise ValueError("档案条目标题长度必须为 1-220 个字符")
    if not isinstance(content_json, dict) or not content_json:
        raise ValueError("content_json 必须包含来源中可验证的结构化事实")
    if not 1 <= len(clean_source) <= 20_000:
        raise ValueError("source_text 长度必须为 1-20000 个字符")

    resolved_tier = normalize_profile_tier(tier)
    # ADR-0048 偏好门：行为信号或 Agent 推断不能直写 preference；
    # 只有使用者明确陈述（direct）或收件箱提案确认（proposal）允许落地偏好。
    if resolved_tier == "preference" and preference_confirmation not in {"direct", "proposal"}:
        raise ValueError(
            "preference 条目必须来自使用者明确陈述（preference_confirmation=direct）"
            "或记忆收件箱提案确认（preference_confirmation=proposal）；行为信号或 Agent 推断请先走收件箱提案"
        )
    resolved_type, resolved_label, _, canonical = canonicalize_profile_section_payload(
        section_type=str(section_type or "").strip(),
        category_label=category_label,
        title=clean_title,
        raw_content_json=content_json,
        tier=resolved_tier,
    )
    fact_gate = validate_generated_content(clean_source, canonical)
    if fact_gate["status"] != "passed":
        # 自回声来源（来源=声明本身）：只有使用者明确确认（收件箱 accept / 手动确认）
        # 才放行；未确认的直写（如主 Agent 把用户陈述回声当来源）一律拒绝。
        echo_blocked = any(
            item.get("issue") == "echo_source" for item in fact_gate.get("warnings") or []
        )
        if echo_blocked:
            if not user_confirmed:
                return {
                    "error": "来源只是声明自身的回声，缺少独立可验证出处；请提供真实来源材料，或经记忆收件箱由使用者确认",
                    "fact_gate": fact_gate,
                }
            # 使用者明确确认的回声来源（如记忆收件箱 accept）放行
        else:
            return {
                "error": "档案条目包含来源中无法验证的事实，未写入",
                "fact_gate": fact_gate,
            }

    raw_dedup = dedup_key or f"{resolved_type}:{clean_title}:{source_url or ''}"
    normalized_dedup = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", raw_dedup.casefold())
    canonical["_agent_provenance"] = {
        "dedup_key": normalized_dedup,
        "source_text": clean_source,
        "source_url": str(source_url or "").strip(),
        "confirmed": True,
    }

    async with async_session() as db:
        profile = (
            await db.execute(select(Profile).where(Profile.is_default == True))
        ).scalar_one_or_none()
        if not profile:
            profile = Profile(name="默认档案", is_default=True)
            db.add(profile)
            await db.flush()
        existing_sections = (
            await db.execute(
                select(ProfileSection)
                .where(ProfileSection.profile_id == profile.id)
                .where(ProfileSection.status == "active")
            )
        ).scalars().all()
        for existing in existing_sections:
            payload = existing.content_json if isinstance(existing.content_json, dict) else {}
            provenance = payload.get("_agent_provenance") if isinstance(payload.get("_agent_provenance"), dict) else {}
            if normalized_dedup and provenance.get("dedup_key") == normalized_dedup:
                return {
                    "id": existing.id,
                    "duplicate": True,
                    "message": "Profile evidence already exists; no write performed",
                }
        max_sort = (
            await db.execute(
                select(func.max(ProfileSection.sort_order)).where(ProfileSection.profile_id == profile.id)
            )
        ).scalar()
        section = ProfileSection(
            profile_id=profile.id,
            section_type=resolved_type,
            title=clean_title or resolved_label,
            sort_order=int(max_sort or 0) + 1,
            content_json=canonical,
            source="agent_confirmed",
            confidence=1.0,
            tier=resolved_tier,
        )
        db.add(section)
        await db.commit()
        await db.refresh(section)
        return {
            "id": section.id,
            "profile_id": profile.id,
            "section_type": section.section_type,
            "title": section.title,
            "content_json": section.content_json,
            "source": section.source,
            "confidence": section.confidence,
            "tier": section.tier,
            "duplicate": False,
            "fact_gate": fact_gate,
        }


async def list_pools() -> list[dict]:
    async with async_session() as db:
        rows = (
            await db.execute(
                select(Pool).order_by(Pool.sort_order.asc(), Pool.created_at.desc())
            )
        ).scalars().all()

        pool_ids = [p.id for p in rows]
        counts = {}
        if pool_ids:
            crows = (
                await db.execute(
                    select(Job.pool_id, func.count(Job.id))
                    .where(Job.pool_id.in_(pool_ids))
                    .group_by(Job.pool_id)
                )
            ).all()
            counts = {pid: cnt for pid, cnt in crows}

        return [
            {
                "id": p.id,
                "name": p.name,
                "scope": p.scope,
                "description": p.description or "",
                "color": p.color or "#3B82F6",
                "sort_order": p.sort_order or 0,
                "job_count": counts.get(p.id, 0),
                "created_at": str(p.created_at),
                "updated_at": str(p.updated_at),
            }
            for p in rows
        ]


async def list_jobs(
    triage_status: Optional[str] = None,
    pool_id: Optional[int] = None,
    keyword: Optional[str] = None,
    page: int = 1,
    page_size: int = 20,
) -> dict:
    async with async_session() as db:
        query = select(Job).where(_public_job_filter())
        if triage_status:
            query = query.where(Job.triage_status == triage_status)
        if pool_id is not None:
            query = query.where(Job.pool_id == pool_id)
        if keyword:
            pattern = f"%{keyword}%"
            query = query.where((Job.title.ilike(pattern)) | (Job.company.ilike(pattern)))

        total_q = select(func.count()).select_from(query.subquery())
        total = (await db.execute(total_q)).scalar() or 0

        query = query.order_by(desc(Job.created_at))
        query = query.offset((page - 1) * page_size).limit(page_size)
        jobs = (await db.execute(query)).scalars().all()

        return {
            "total": total,
            "page": page,
            "page_size": page_size,
            "items": [
                {
                    "id": j.id,
                    "title": j.title,
                    "company": j.company,
                    "location": j.location or "",
                    "url": j.url or "",
                    "apply_url": j.apply_url or "",
                    "source": j.source or "",
                    "triage_status": j.triage_status or "inbox",
                    "pool_id": j.pool_id,
                    "salary_text": j.salary_text or "",
                    "education": j.education or "",
                    "experience": j.experience or "",
                    "job_type": j.job_type or "",
                    "is_campus": j.is_campus,
                    "summary": j.summary or "",
                    "keywords": j.keywords or [],
                    "created_at": str(j.created_at),
                }
                for j in jobs
            ],
        }


async def get_job(job_id: int) -> dict:
    async with async_session() as db:
        job = (
            await db.execute(select(Job).where(Job.id == job_id, _public_job_filter()))
        ).scalar_one_or_none()
        if not job:
            return {"error": f"Job #{job_id} not found"}
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
            "salary_text": job.salary_text or "",
            "education": job.education or "",
            "experience": job.experience or "",
            "job_type": job.job_type or "",
            "is_campus": job.is_campus,
            "summary": job.summary or "",
            "raw_description": job.raw_description or "",
            "keywords": job.keywords or [],
            "created_at": str(job.created_at),
        }


async def triage_job(job_id: int, status: str, pool_id: Optional[int] = None) -> dict:
    async with async_session() as db:
        job = (
            await db.execute(select(Job).where(Job.id == job_id, _public_job_filter()))
        ).scalar_one_or_none()
        if not job:
            return {"error": f"Job #{job_id} not found"}
        job.triage_status = status
        if pool_id is not None:
            job.pool_id = pool_id
        else:
            job.pool_id = None
        await db.commit()
        return {"id": job.id, "triage_status": job.triage_status, "pool_id": job.pool_id, "updated": True}


async def batch_triage(job_ids: list[int], status: str, pool_id: Optional[int] = None) -> dict:
    async with async_session() as db:
        from sqlalchemy import update as sql_update
        stmt = sql_update(Job).where(Job.id.in_(job_ids)).values(triage_status=status, pool_id=pool_id)
        result = await db.execute(stmt)
        await db.commit()
        return {"updated": result.rowcount or 0, "requested": len(job_ids)}


async def list_coding_agents() -> dict:
    from app.services.coding_agent_runtime import list_local_executors

    return await list_local_executors()


async def list_batch_job_evaluations(limit: int = 20) -> dict:
    from app.services.batch_job_evaluations import batch_evaluation_store

    return batch_evaluation_store.list(limit=limit)


async def get_batch_job_evaluation(batch_id: str) -> dict:
    from app.services.batch_job_evaluations import batch_evaluation_store

    batch = batch_evaluation_store.get(batch_id)
    return batch or {"error": f"Batch evaluation {batch_id} not found"}


async def start_batch_job_evaluation(
    job_ids: list[int],
    runtime_id: str = "codex",
    max_workers: int = 2,
) -> dict:
    from app.services.batch_job_evaluations import start_batch_job_evaluation as _start

    return await _start(job_ids=job_ids, runtime_id=runtime_id, max_workers=max_workers)


async def resume_batch_job_evaluation(batch_id: str) -> dict:
    from app.services.batch_job_evaluations import resume_batch_job_evaluation as _resume

    return await _resume(batch_id)


async def prepare_resume_optimization(
    job_id: int,
    profile_id: Optional[int] = None,
    reference_resume_id: Optional[int] = None,
    research_run_id: Optional[str] = None,
    candidate_rows: Optional[list[dict]] = None,
    candidate_original_rows: Optional[list[dict]] = None,
    source_session_id: Optional[str] = None,
) -> dict:
    """Prepare an auditable proposal; the formal resume remains unchanged."""
    from app.services.resume_optimization import prepare_resume_optimization as _prepare

    return await _prepare(
        job_id=job_id,
        profile_id=profile_id,
        reference_resume_id=reference_resume_id,
        research_run_id=research_run_id,
        candidate_rows=candidate_rows,
        candidate_original_rows=candidate_original_rows,
        source_session_id=source_session_id,
    )


async def list_resume_optimizations(
    job_id: Optional[int] = None,
    status: Optional[str] = None,
    limit: int = 20,
) -> dict:
    from app.services.resume_optimization import list_resume_optimizations as _list

    return await _list(job_id=job_id, status=status, limit=limit)


async def get_resume_optimization(proposal_id: str) -> dict:
    from app.services.resume_optimization import get_resume_optimization as _get

    return await _get(proposal_id=proposal_id)


async def review_resume_optimization(
    proposal_id: str,
    action: str,
    note: str = "",
) -> dict:
    """Accept or reject a proposal after explicit user review."""
    from app.services.resume_optimization import review_resume_optimization as _review

    return await _review(proposal_id=proposal_id, action=action, note=note)


async def list_resumes() -> list[dict]:
    async with async_session() as db:
        rows = (
            await db.execute(select(Resume).order_by(Resume.updated_at.desc()))
        ).scalars().all()
        return [
            {
                "id": r.id,
                "user_name": r.user_name or "",
                "title": r.title or "",
                "created_at": str(r.created_at),
                "updated_at": str(r.updated_at),
            }
            for r in rows
        ]


async def inspect_resume_document(file_path: str) -> dict:
    """Read one confirmed local PDF/DOCX and return candidates' source text only."""
    requested_path = Path(str(file_path or "").strip()).expanduser()
    try:
        path = requested_path.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise ValueError("简历文件不存在或不可读取") from exc
    if not path.is_file():
        raise ValueError("简历路径必须指向一个文件")
    if path.suffix.lower() not in {".pdf", ".docx"}:
        raise ValueError("仅支持 .pdf 和 .docx 简历文件")
    size = path.stat().st_size
    if size <= 0:
        raise ValueError("简历文件为空")
    if size > 10 * 1024 * 1024:
        raise ValueError("简历文件不能超过 10MB")

    from app.services.resume_parser import parse_resume_document

    file_bytes = await asyncio.to_thread(path.read_bytes)
    parsed = await parse_resume_document(path.name, file_bytes)
    if parsed is None or not parsed.text.strip():
        diagnostics = parsed.public_dict() if parsed else {}
        ocr = diagnostics.get("ocr") if isinstance(diagnostics, dict) else {}
        hint = ocr.get("install_hint") if isinstance(ocr, dict) else None
        raise ValueError(str(hint or "未能从简历文件中提取文本"))
    return {
        "filename": path.name,
        "text": parsed.text,
        "length": len(parsed.text),
        "parse_diagnostics": parsed.public_dict(),
    }


async def get_resume(resume_id: int) -> dict:
    async with async_session() as db:
        resume = (
            await db.execute(select(Resume).where(Resume.id == resume_id))
        ).scalar_one_or_none()
        if not resume:
            return {"error": f"Resume #{resume_id} not found"}
        sections = (
            await db.execute(
                select(ResumeSection)
                .where(ResumeSection.resume_id == resume_id)
                .order_by(ResumeSection.sort_order.asc())
            )
        ).scalars().all()
        return {
            "id": resume.id,
            "user_name": resume.user_name or "",
            "title": resume.title or "",
            "summary": resume.summary or "",
            "contact_json": resume.contact_json or {},
            "sections": [
                {
                    "id": section.id,
                    "section_type": section.section_type,
                    "title": section.title,
                    "sort_order": section.sort_order,
                    "visible": section.visible,
                    "content_json": section.content_json or [],
                }
                for section in sections
            ],
            "created_at": str(resume.created_at),
            "updated_at": str(resume.updated_at),
        }


async def export_resume_pdf(resume_id: int) -> dict:
    """Render and atomically persist an ATS-readable PDF on explicit confirmation."""
    import anyio

    from app.routes.resume import (
        _get_resume_or_404,
        _render_resume_html_for_export,
        _render_resume_pdf_bytes,
        _render_resume_pdf_with_playwright,
    )
    from app.services.agent_files import atomic_write_bytes

    async with async_session() as db:
        resume = await _get_resume_or_404(int(resume_id), db, load_sections=True)
        try:
            pdf_bytes = await _render_resume_pdf_with_playwright(int(resume_id), resume)
            renderer = "playwright"
        except Exception:
            html = await _render_resume_html_for_export(resume, db)
            pdf_bytes = await anyio.to_thread.run_sync(_render_resume_pdf_bytes, html)
            renderer = "python_fallback"

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    export_dir = Path(__file__).resolve().parents[2] / "data" / "exports"
    path = export_dir / f"resume_{int(resume_id)}_{timestamp}.pdf"
    atomic_write_bytes(path, pdf_bytes)
    return {
        "resume_id": int(resume_id),
        "path": str(path),
        "filename": path.name,
        "media_type": "application/pdf",
        "bytes": len(pdf_bytes),
        "sha256": hashlib.sha256(pdf_bytes).hexdigest(),
        "renderer": renderer,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


_APPLICATION_STATUS_TO_WORKSPACE = {
    "pending": "待投递",
    "submitted": "已投递",
    "responded": "待处理",
    "interview": "面试中",
    "rejected": "已拒绝",
    "offer": "已录用",
}


def _application_record_status(value: object) -> str:
    clean = str(value or "").strip().lower()
    aliases = {
        "": "pending",
        "待投递": "pending",
        "draft": "pending",
        "已投递": "submitted",
        "applied": "submitted",
        "待处理": "responded",
        "已回复": "responded",
        "need_action": "responded",
        "面试": "interview",
        "面试中": "interview",
        "interviewing": "interview",
        "已拒绝": "rejected",
        "已录用": "offer",
        "accepted": "offer",
    }
    return aliases.get(clean, clean)


def _serialize_application_record(record: ApplicationRecord) -> dict:
    custom = record.custom_values if isinstance(record.custom_values, dict) else {}
    return {
        "id": record.id,
        "application_type": "application_record",
        "job_id": record.job_ref_id,
        "status": _application_record_status(custom.get("apply_status")),
        "cover_letter": str(custom.get("cover_letter") or ""),
        "apply_url": record.job_link or "",
        "notes": str(custom.get("notes") or ""),
        "submitted_at": custom.get("applied_at") or custom.get("application_date"),
        "created_at": str(record.created_at),
    }


async def list_applications(
    status: Optional[str] = None,
    page: int = 1,
    page_size: int = 20,
) -> dict:
    async with async_session() as db:
        records = (
            await db.execute(
                select(ApplicationRecord).order_by(desc(ApplicationRecord.created_at))
            )
        ).scalars().all()
        filtered = [
            record
            for record in records
            if not status
            or _application_record_status(
                (record.custom_values or {}).get("apply_status")
                if isinstance(record.custom_values, dict)
                else None
            )
            == status
        ]
        total = len(filtered)
        start = (page - 1) * page_size
        apps = filtered[start : start + page_size]

        return {
            "total": total,
            "page": page,
            "page_size": page_size,
            "items": [_serialize_application_record(a) for a in apps],
        }


async def create_application(job_id: int, notes: Optional[str] = None) -> dict:
    """Create the Agent application in the workspace tracker, the canonical UI source."""
    from app.services.application_workspace import create_records_from_jobs, get_workspace_payload

    async with async_session() as db:
        job = (await db.execute(select(Job).where(Job.id == job_id))).scalar_one_or_none()
        if not job:
            return {"error": f"Job #{job_id} not found"}
        workspace = await get_workspace_payload(db)
        table_id = int(workspace.get("current_table_id") or 0)
        if not table_id:
            return {"error": "Application workspace has no active table"}
        created = await create_records_from_jobs(
            db,
            table_id=table_id,
            job_ids=[job_id],
            skip_existing_in_table=True,
        )
        item = next(iter(created.get("items") or []), None)
        if item:
            record_id = int(item["id"])
        else:
            record_id = int(
                (
                    await db.execute(
                        select(ApplicationRecord.id)
                        .join(
                            ApplicationTableRecord,
                            ApplicationTableRecord.record_id == ApplicationRecord.id,
                        )
                        .where(ApplicationRecord.job_ref_id == job_id)
                        .where(ApplicationTableRecord.table_id == table_id)
                        .order_by(ApplicationRecord.updated_at.desc())
                    )
                ).scalars().first()
                or 0
            )
        if not record_id:
            return {"error": "Application workspace record was not created"}
        record = (
            await db.execute(select(ApplicationRecord).where(ApplicationRecord.id == record_id))
        ).scalar_one()
        custom_values = dict(record.custom_values or {})
        custom_values["apply_status"] = custom_values.get("apply_status") or "待投递"
        if notes is not None:
            custom_values["notes"] = str(notes).strip()
        record.custom_values = custom_values
        record.updated_at_value = datetime.utcnow()
        await db.commit()
        return {
            "id": record.id,
            "application_type": "application_record",
            "table_id": table_id,
            "status": _application_record_status(custom_values["apply_status"]),
            "workspace_status": custom_values["apply_status"],
            "created": bool(item),
            "message": "Application workspace record ready",
        }


async def update_application_status(
    application_id: int,
    status: str,
    notes: Optional[str] = None,
) -> dict:
    clean_status = str(status or "").strip().lower()
    allowed = {"pending", "submitted", "responded", "interview", "rejected", "offer"}
    if clean_status not in allowed:
        raise ValueError(f"不支持的投递状态: {clean_status}")
    async with async_session() as db:
        record = (
            await db.execute(
                select(ApplicationRecord).where(ApplicationRecord.id == application_id)
            )
        ).scalar_one_or_none()
        if not record:
            return {"error": f"Application #{application_id} not found"}
        custom_values = dict(record.custom_values or {})
        previous_workspace_status = custom_values.get("apply_status") or "待投递"
        previous_status = _application_record_status(previous_workspace_status)
        custom_values["apply_status"] = _APPLICATION_STATUS_TO_WORKSPACE[clean_status]
        if clean_status == "submitted" and not (
            custom_values.get("applied_at") or custom_values.get("application_date")
        ):
            custom_values["applied_at"] = datetime.utcnow().isoformat()
        if notes is not None:
            custom_values["notes"] = str(notes).strip()
        record.custom_values = custom_values
        record.updated_at_value = datetime.utcnow()
        await db.commit()
        await db.refresh(record)
        event_warning = None
        if previous_status != clean_status:
            try:
                from app.services.application_events import application_event_store

                application_event_store.record(
                    application_type="application_record",
                    application_id=record.id,
                    event_type="status_changed",
                    source="agent",
                    field_key="status",
                    previous_value=previous_workspace_status,
                    value=custom_values["apply_status"],
                    metadata={"job_id": record.job_ref_id},
                )
            except Exception as exc:
                event_warning = str(exc)[:500]
        return {
            "id": record.id,
            "application_type": "application_record",
            "previous_status": previous_status,
            "status": clean_status,
            "workspace_status": custom_values["apply_status"],
            "notes": str(custom_values.get("notes") or ""),
            "submitted_at": custom_values.get("applied_at")
            or custom_values.get("application_date"),
            "updated": True,
            "event_warning": event_warning,
        }


async def ingest_application_signal(
    channel: str,
    account_ref: str,
    external_message_id: str,
    sender: str,
    subject: str,
    body: str,
    external_thread_id: str = "",
    received_at: Optional[str] = None,
    stage_hint: str = "",
) -> dict:
    from app.services.application_progress import ingest_application_signal as _ingest

    return await _ingest(
        channel=channel,
        account_ref=account_ref,
        external_message_id=external_message_id,
        sender=sender,
        subject=subject,
        body=body,
        external_thread_id=external_thread_id,
        received_at=received_at,
        stage_hint=stage_hint,
    )


async def list_application_progress_candidates(
    status: str = "pending",
    disclosure: str = "summary",
    limit: int = 100,
) -> dict:
    from app.services.application_progress import (
        list_application_progress_candidates as _list,
    )

    return await _list(status=status, disclosure=disclosure, limit=limit)


async def get_application_progress_candidate(candidate_id: str) -> dict:
    from app.services.application_progress import get_application_progress_candidate as _get

    return await _get(candidate_id=candidate_id)


async def review_application_progress(
    candidate_id: str,
    action: str,
    application_attempt_id: Optional[int] = None,
    stage: str = "",
    note: str = "",
    add_calendar: bool = True,
    create_record: bool = False,
) -> dict:
    from app.services.application_progress import review_application_progress as _review

    return await _review(
        candidate_id=candidate_id,
        action=action,
        application_attempt_id=application_attempt_id,
        stage=stage,
        note=note,
        add_calendar=add_calendar,
        create_record=create_record,
    )


async def get_application_progress_overview(
    disclosure: str = "summary",
    job_id: Optional[int] = None,
    limit: int = 200,
) -> dict:
    from app.services.application_progress import get_application_progress_overview as _get

    return await _get(disclosure=disclosure, job_id=job_id, limit=limit)


async def get_application_workspace() -> dict:
    from app.services.application_workspace import get_workspace_payload, list_table_records

    async with async_session() as db:
        payload = await get_workspace_payload(db)
        current_table_id = int(payload.get("current_table_id") or 0)
        if current_table_id:
            payload["current_records"] = await list_table_records(db, current_table_id)
        return payload


async def list_application_records(table_id: int, keyword: str = "") -> dict:
    from app.services.application_workspace import list_table_records

    async with async_session() as db:
        return await list_table_records(db, int(table_id), keyword=keyword)


async def update_application_record(record_id: int, field_key: str, value: object) -> dict:
    from app.services.application_workspace import update_record_value

    clean_key = str(field_key or "").strip()
    if clean_key not in {"apply_status", "follow_up_date", "notes"}:
        raise ValueError("Agent 只能更新 apply_status、follow_up_date 或 notes")
    if clean_key == "apply_status":
        allowed_statuses = {"待投递", "已投递", "待处理", "面试中", "已拒绝", "已录用"}
        if str(value or "").strip() not in allowed_statuses:
            raise ValueError("投递表状态必须是待投递、已投递、待处理、面试中、已拒绝或已录用")
    if clean_key == "follow_up_date" and value:
        try:
            datetime.fromisoformat(str(value).strip()[:10])
        except ValueError as exc:
            raise ValueError("follow_up_date 必须是 YYYY-MM-DD") from exc
    async with async_session() as db:
        return await update_record_value(
            db,
            record_id=int(record_id),
            field_key=clean_key,
            value=value,
            source="agent",
        )


async def list_application_events(
    application_type: Optional[str] = None,
    application_id: Optional[int] = None,
    event_type: Optional[str] = None,
    limit: int = 1000,
) -> dict:
    from app.services.application_events import application_event_store

    items = application_event_store.list(
        application_type=application_type,
        application_id=application_id,
        event_type=event_type,
        limit=limit,
    )
    return {"total": len(items), "items": items}


async def analyze_application_patterns() -> dict:
    from app.services.application_events import application_event_store, build_application_pattern_analysis

    async with async_session() as db:
        records = (await db.execute(select(ApplicationRecord))).scalars().all()
        applications: list[dict] = []
        represented_job_ids: set[int] = set()
        for record in records:
            custom = record.custom_values if isinstance(record.custom_values, dict) else {}
            if record.job_ref_id is not None:
                represented_job_ids.add(record.job_ref_id)
            applications.append({
                "application_type": "application_record",
                "application_id": record.id,
                "job_id": record.job_ref_id,
                "company": record.company_name or "",
                "role": record.job_title or "",
                "status": custom.get("apply_status") or "待投递",
                "created_at": str(record.created_at),
            })
        legacy_rows = (await db.execute(select(Application))).scalars().all()
        for application in legacy_rows:
            if application.job_id in represented_job_ids:
                continue
            applications.append({
                "application_type": "application",
                "application_id": application.id,
                "job_id": application.job_id,
                "status": application.status,
                "created_at": str(application.created_at),
            })

    return build_application_pattern_analysis(applications, application_event_store.list(limit=5000))


async def list_career_artifacts(
    artifact_type: Optional[str] = None,
    related_job_id: Optional[int] = None,
    related_application_id: Optional[int] = None,
    related_application_record_id: Optional[int] = None,
    limit: int = 20,
) -> dict:
    from app.services.career_artifacts import career_artifact_store

    return career_artifact_store.list(
        artifact_type=artifact_type,
        related_job_id=related_job_id,
        related_application_id=related_application_id,
        related_application_record_id=related_application_record_id,
        limit=limit,
    )


async def get_career_artifact(artifact_id: str) -> dict:
    from app.services.career_artifacts import career_artifact_store

    artifact = career_artifact_store.get(artifact_id)
    return artifact or {"error": f"Career artifact {artifact_id} not found"}


async def save_career_artifact(
    artifact_type: str,
    title: str,
    content_markdown: str,
    related_job_id: Optional[int] = None,
    related_application_id: Optional[int] = None,
    related_application_record_id: Optional[int] = None,
    metadata: Optional[dict] = None,
) -> dict:
    from app.services.career_artifacts import career_artifact_store

    async with async_session() as db:
        references = (
            (Job, related_job_id, "Job"),
            (Application, related_application_id, "Application"),
            (ApplicationRecord, related_application_record_id, "ApplicationRecord"),
        )
        for model, reference_id, label in references:
            if reference_id is None:
                continue
            exists = (await db.execute(select(model.id).where(model.id == reference_id))).scalar_one_or_none()
            if exists is None:
                return {"error": f"{label} #{reference_id} not found"}

    return career_artifact_store.save(
        artifact_type=artifact_type,
        title=title,
        content_markdown=content_markdown,
        related_job_id=related_job_id,
        related_application_id=related_application_id,
        related_application_record_id=related_application_record_id,
        metadata=metadata,
    )


async def list_follow_up_cadence() -> dict:
    from app.services.application_followups import build_follow_up_dashboard, follow_up_store

    async with async_session() as db:
        workspace_records = (await db.execute(select(ApplicationRecord))).scalars().all()
        applications: list[dict] = []
        represented_job_ids: set[int] = set()
        for record in workspace_records:
            custom = record.custom_values if isinstance(record.custom_values, dict) else {}
            if record.job_ref_id is not None:
                represented_job_ids.add(record.job_ref_id)
            applications.append(
                {
                    "application_type": "application_record",
                    "application_id": record.id,
                    "job_id": record.job_ref_id,
                    "company": record.company_name or "",
                    "role": record.job_title or "",
                    "status": custom.get("apply_status") or "待投递",
                    "follow_up_date": custom.get("follow_up_date"),
                    "applied_at": custom.get("applied_at") or custom.get("application_date"),
                    "notes": custom.get("notes") or "",
                    "created_at": str(record.created_at),
                }
            )

        legacy_rows = (
            await db.execute(
                select(Application, Job)
                .join(Job, Job.id == Application.job_id)
                .order_by(Application.created_at.desc())
            )
        ).all()
        for application, job in legacy_rows:
            if application.job_id in represented_job_ids:
                continue
            applications.append(
                {
                    "application_type": "application",
                    "application_id": application.id,
                    "job_id": application.job_id,
                    "company": job.company or "",
                    "role": job.title or "",
                    "status": application.status,
                    "follow_up_date": None,
                    "applied_at": str(application.submitted_at) if application.submitted_at else None,
                    "notes": application.notes or "",
                    "created_at": str(application.created_at),
                }
            )

    return build_follow_up_dashboard(applications, follow_up_store.list())


async def record_follow_up(
    application_type: str,
    application_id: int,
    channel: str,
    contact: str = "",
    notes: str = "",
    sent_at: Optional[str] = None,
) -> dict:
    from app.services.application_followups import follow_up_store

    model = {"application": Application, "application_record": ApplicationRecord}.get(application_type)
    if model is None:
        raise ValueError("application_type 必须是 application 或 application_record")
    async with async_session() as db:
        exists = (
            await db.execute(select(model.id).where(model.id == int(application_id)))
        ).scalar_one_or_none()
        if exists is None:
            return {"error": f"{application_type} #{application_id} not found"}
    event = follow_up_store.record(
        application_type=application_type,
        application_id=int(application_id),
        channel=channel,
        contact=contact,
        notes=notes,
        sent_at=sent_at,
    )
    try:
        from app.services.application_events import application_event_store

        application_event_store.record(
            application_type=application_type,
            application_id=int(application_id),
            event_type="follow_up_sent",
            source="agent_confirmed",
            value=event.get("sent_at"),
            metadata={"channel": event.get("channel"), "follow_up_event_id": event.get("id")},
        )
        event["event_warning"] = None
    except Exception as exc:
        event["event_warning"] = str(exc)[:500]
    return event


async def generate_cover_letter(job_id: int, resume_id: int) -> dict:
    from app.agents.cover_letter import generate_cover_letter as _gen_cover_letter
    async with async_session() as db:
        job = (await db.execute(select(Job).where(Job.id == job_id))).scalar_one_or_none()
        if not job:
            return {"error": f"Job #{job_id} not found"}
        resume = (await db.execute(select(Resume).where(Resume.id == resume_id))).scalar_one_or_none()
        if not resume:
            return {"error": f"Resume #{resume_id} not found"}
        sections = (
            await db.execute(
                select(ResumeSection)
                .where(ResumeSection.resume_id == resume_id)
                .order_by(ResumeSection.sort_order.asc())
            )
        ).scalars().all()
        resume_text = f"姓名: {resume.user_name or ''}\n简介: {resume.summary or ''}\n"
        for section in sections:
            resume_text += f"\n[{section.title or section.section_type}]\n"
            resume_text += str(section.content_json or [])
        return await _gen_cover_letter(jd=job.raw_description or job.summary, resume=resume_text)


async def job_stats() -> dict:
    async with async_session() as db:
        since = datetime.utcnow() - timedelta(days=7)
        stats_q = select(
            func.count(Job.id).label("total"),
        ).where(_public_job_filter(), Job.created_at >= since)
        row = (await db.execute(stats_q)).one()
        source_q = (
            select(Job.source, func.count(Job.id).label("count"))
            .where(_public_job_filter(), Job.created_at >= since)
            .group_by(Job.source)
        )
        sources = (await db.execute(source_q)).all()
        return {
            "period": "week",
            "total_jobs": row.total,
            "source_distribution": {s.source: s.count for s in sources},
        }
