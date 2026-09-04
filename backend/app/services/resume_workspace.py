"""Resume Workspace orchestration.

The workspace deliberately composes the existing Resume, Proposal and Version
records.  It does not create a second document model: the editable Resume is
the source of truth, proposals are review records, and versions are snapshots.
"""

from __future__ import annotations

import copy
import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.database import async_session
from app.models.models import (
    Application,
    ApplicationAttempt,
    Job,
    Profile,
    Resume,
    ResumeOptimizationProposal,
    ResumeSection,
    ResumeVersion,
)
from app.services.resume_builder import _profile_to_contact_json
from app.services.resume_optimization import _proposal_detail
from app.services.resume_versions import create_version_snapshot


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _positive_id(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{field} 必须是正整数")
    return value


def _text(value: Any, field: str, limit: int) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError(f"{field} 必须是字符串")
    value = value.strip()
    if len(value) > limit:
        raise ValueError(f"{field} 超过最大长度 {limit}")
    return value


def _json_hash(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def workspace_content_hash(resume: Resume) -> str:
    """Hash only editable content, never timestamps or database identifiers."""
    return _json_hash(
        {
            "user_name": resume.user_name,
            "title": resume.title,
            "photo_url": resume.photo_url,
            "summary": resume.summary,
            "contact_json": resume.contact_json or {},
            "template_id": resume.template_id,
            "style_config": resume.style_config or {},
            "language": resume.language,
            "sections": [
                {
                    "section_type": section.section_type,
                    "sort_order": section.sort_order,
                    "title": section.title,
                    "visible": section.visible,
                    "content_json": section.content_json or [],
                    "source_section_ids": section.source_section_ids or [],
                }
                for section in sorted(
                    resume.sections,
                    key=lambda item: (item.sort_order, item.id),
                )
            ],
        }
    )


def _source_ids(value: Any) -> list[int]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, int) and item > 0]


def _section_dict(section: ResumeSection) -> dict[str, Any]:
    return {
        "id": section.id,
        "resume_id": section.resume_id,
        "section_type": section.section_type,
        "sort_order": section.sort_order,
        "title": section.title,
        "visible": section.visible,
        "content_json": section.content_json or [],
        "source_section_ids": section.source_section_ids or [],
    }


def _resume_dict(resume: Resume, jobs: dict[int, Job] | None = None) -> dict[str, Any]:
    source_ids = _source_ids(resume.source_job_ids)
    jobs = jobs or {}
    return {
        "id": resume.id,
        "user_name": resume.user_name,
        "title": resume.title,
        "photo_url": resume.photo_url,
        "summary": resume.summary,
        "contact_json": resume.contact_json or {},
        "template_id": resume.template_id,
        "style_config": resume.style_config or {},
        "is_primary": resume.is_primary,
        "language": resume.language,
        "source_mode": resume.source_mode,
        "source_job_ids": source_ids,
        "source_jobs": [
            {"id": item, "title": jobs[item].title, "company": jobs[item].company}
            for item in source_ids
            if item in jobs
        ],
        "source_profile_snapshot": resume.source_profile_snapshot or {},
        "source_profile_id": resume.source_profile_id,
        "source_resume_id": resume.source_resume_id,
        "target_job_id": resume.target_job_id,
        "application_id": resume.application_id,
        "current_version_id": resume.current_version_id,
        "workspace_revision": resume.workspace_revision or 0,
        "sections": [_section_dict(section) for section in resume.sections],
        "created_at": str(resume.created_at),
        "updated_at": str(resume.updated_at),
    }


def _job_dict(job: Optional[Job]) -> Optional[dict[str, Any]]:
    if job is None:
        return None
    return {
        "id": job.id,
        "title": job.title,
        "company": job.company,
        "location": job.location,
        "url": job.url,
        "apply_url": job.apply_url,
        "summary": job.summary,
        "raw_description": job.raw_description,
        "keywords": job.keywords or [],
    }


def _version_dict(version: ResumeVersion, current_id: Optional[int]) -> dict[str, Any]:
    return {
        "id": version.id,
        "resume_id": version.resume_id,
        "version_number": version.version_number,
        "change_summary": version.change_summary,
        "created_by": version.created_by,
        "created_at": version.created_at.isoformat(),
        "is_current": version.id == current_id,
    }


async def _load_resume(db, resume_id: int) -> Resume:
    resume = (
        await db.execute(
            select(Resume)
            .where(Resume.id == resume_id)
            .options(selectinload(Resume.sections))
        )
    ).scalar_one_or_none()
    if resume is None:
        raise ValueError("Resume not found")
    return resume


async def _source_jobs(db, resume: Resume, job: Optional[Job]) -> dict[int, Job]:
    ids = set(_source_ids(resume.source_job_ids))
    if job:
        ids.add(job.id)
    if not ids:
        return {}
    rows = (await db.execute(select(Job).where(Job.id.in_(ids)))).scalars().all()
    return {item.id: item for item in rows}


async def _workspace_payload(
    db,
    resume: Resume,
    *,
    job: Optional[Job],
    proposal_id: Optional[str] = None,
) -> dict[str, Any]:
    jobs = await _source_jobs(db, resume, job)
    proposal_query = select(ResumeOptimizationProposal).order_by(
        ResumeOptimizationProposal.created_at.desc()
    )
    if proposal_id:
        proposal_query = proposal_query.where(
            ResumeOptimizationProposal.proposal_id == proposal_id
        )
    elif resume.target_job_id:
        proposal_query = proposal_query.where(
            ResumeOptimizationProposal.job_id == resume.target_job_id
        ).limit(8)
    else:
        proposal_query = proposal_query.where(
            ResumeOptimizationProposal.workspace_resume_id == resume.id
        ).limit(8)
    proposals = list((await db.execute(proposal_query)).scalars().all())
    versions = list(
        (
            await db.execute(
                select(ResumeVersion)
                .where(ResumeVersion.resume_id == resume.id)
                .order_by(ResumeVersion.version_number.desc())
            )
        ).scalars().all()
    )
    attempts = list(
        (
            await db.execute(
                select(ApplicationAttempt)
                .where(ApplicationAttempt.job_id == (job.id if job else -1))
                .order_by(ApplicationAttempt.created_at.desc())
            )
        ).scalars().all()
    ) if job else []
    legacy_application = None
    if job:
        legacy_application = (
            await db.execute(
                select(Application)
                .where(Application.job_id == job.id)
                .order_by(Application.updated_at.desc())
            )
        ).scalars().first()
    current_version = next(
        (item for item in versions if item.id == resume.current_version_id),
        versions[0] if versions else None,
    )
    packet = {
        "job_id": job.id if job else resume.target_job_id,
        "resume_id": resume.id,
        "current_version_id": current_version.id if current_version else None,
        "current_version_number": current_version.version_number if current_version else None,
        "status": "ready" if current_version else "draft",
        "application_id": resume.application_id or (legacy_application.id if legacy_application else None),
        "application_attempt_id": next((item.id for item in attempts if item.resume_id == resume.id), None),
        "artifacts": {
            "resume": True,
            "research": bool(proposals),
            "interview_focus": bool(proposals),
        },
    }
    return {
        "resume": _resume_dict(resume, jobs),
        "job": _job_dict(job),
        "workspace": {
            "revision": resume.workspace_revision or 0,
            "content_hash": workspace_content_hash(resume),
            "is_tailored": bool(resume.target_job_id),
        },
        "application_packet": packet,
        "proposals": [
            _proposal_detail(item, job if job and item.job_id == job.id else None)
            for item in proposals
        ],
        "versions": [_version_dict(item, resume.current_version_id) for item in versions],
    }


async def get_resume_workspace(resume_id: int) -> dict[str, Any]:
    clean_id = _positive_id(resume_id, "resume_id")
    async with async_session() as db:
        resume = await _load_resume(db, clean_id)
        job = None
        if resume.target_job_id:
            job = await db.get(Job, resume.target_job_id)
        return await _workspace_payload(db, resume, job=job)


def _row_section_type(section_type: str) -> str:
    return {
        "experience": "workExperiences",
        "project": "projects",
        "skill": "skills",
        "custom": "personalExperiences",
    }.get(section_type, section_type)


def _row_to_section(row: dict[str, Any], index: int) -> ResumeSection:
    return ResumeSection(
        section_type=_row_section_type(str(row.get("section_type") or "custom")),
        sort_order=int(row.get("sort_order", index)),
        title=str(row.get("title") or "未命名模块"),
        visible=bool(row.get("visible", True)),
        content_json=copy.deepcopy(row.get("content_json") or []),
        source_section_ids=_source_ids(row.get("source_section_ids")),
    )


async def ensure_resume_workspace(
    job_id: int,
    proposal_id: Optional[str] = None,
    reference_resume_id: Optional[int] = None,
) -> dict[str, Any]:
    clean_job_id = _positive_id(job_id, "job_id")
    clean_proposal_id = _text(proposal_id, "proposal_id", 80) or None
    clean_reference_id = (
        _positive_id(reference_resume_id, "reference_resume_id")
        if reference_resume_id is not None
        else None
    )
    async with async_session() as db:
        job = await db.get(Job, clean_job_id)
        if job is None:
            raise ValueError(f"岗位 #{clean_job_id} 不存在")

        proposal = None
        if clean_proposal_id:
            proposal = (
                await db.execute(
                    select(ResumeOptimizationProposal).where(
                        ResumeOptimizationProposal.proposal_id == clean_proposal_id
                    )
                )
            ).scalar_one_or_none()
            if proposal is None:
                raise ValueError("指定的简历提案不存在")
            if proposal.job_id != job.id:
                raise ValueError("简历提案不属于当前岗位")

        resume = None
        if proposal and proposal.workspace_resume_id:
            resume = await _load_resume(db, proposal.workspace_resume_id)
        if resume is None:
            resume = (
                await db.execute(
                    select(Resume)
                    .where(Resume.target_job_id == job.id)
                    .where(Resume.source_mode == "job_tailored_workspace")
                    .order_by(Resume.updated_at.desc(), Resume.id.desc())
                    .options(selectinload(Resume.sections))
                )
            ).scalars().first()

        if resume is None and proposal and proposal.accepted_resume_id:
            resume = await _load_resume(db, proposal.accepted_resume_id)
        if resume is None and proposal and proposal.reference_resume_id:
            clean_reference_id = proposal.reference_resume_id

        source_resume = None
        if resume is None and clean_reference_id:
            source_resume = await _load_resume(db, clean_reference_id)

        profile_id = proposal.profile_id if proposal else None
        profile_query = select(Profile)
        if profile_id:
            profile_query = profile_query.where(Profile.id == profile_id)
        else:
            profile_query = profile_query.order_by(Profile.is_default.desc(), Profile.updated_at.desc())
        profile = (await db.execute(profile_query)).scalars().first()
        if profile is None:
            raise ValueError("未找到可用于简历工作区的 Profile")

        if resume is None and source_resume is None:
            source_resume = (
                await db.execute(
                    select(Resume)
                    .where(Resume.source_mode != "job_tailored_workspace")
                    .order_by(
                        Resume.is_primary.desc(),
                        Resume.updated_at.desc(),
                        Resume.id.desc(),
                    )
                    .options(selectinload(Resume.sections))
                )
            ).scalars().first()

        if resume is None:
            presentation = proposal.presentation_json if proposal else {}
            if proposal and proposal.original_rows_json:
                # A proposal is built from verified Profile evidence.  Keep
                # that generated content while linking the workspace back to
                # the user's master resume for provenance and future refresh.
                content_sections = copy.deepcopy(proposal.original_rows_json)
            elif source_resume:
                content_sections = [
                    {
                        "section_type": section.section_type,
                        "sort_order": section.sort_order,
                        "title": section.title,
                        "visible": section.visible,
                        "content_json": copy.deepcopy(section.content_json or []),
                        "source_section_ids": _source_ids(section.source_section_ids),
                    }
                    for section in source_resume.sections
                ]
            else:
                content_sections = []
            resume = Resume(
                user_name=source_resume.user_name if source_resume else (profile.name or "默认候选人"),
                title=f"{job.company} - {job.title} 定制简历",
                summary=source_resume.summary if source_resume else "",
                contact_json=(
                    copy.deepcopy(source_resume.contact_json or {})
                    if source_resume
                    else _profile_to_contact_json(profile)
                ),
                template_id=source_resume.template_id if source_resume else (presentation or {}).get("template_id"),
                style_config=(
                    copy.deepcopy(source_resume.style_config or {})
                    if source_resume
                    else copy.deepcopy((presentation or {}).get("style_config") or {})
                ),
                is_primary=False,
                language=source_resume.language if source_resume else str((presentation or {}).get("language") or "zh"),
                source_mode="job_tailored_workspace",
                source_job_ids=[job.id],
                source_profile_snapshot=copy.deepcopy(
                    source_resume.source_profile_snapshot or {}
                    if source_resume
                    else {
                        "profile_id": profile.id,
                        "workspace_created_at": _now().isoformat(),
                    }
                ),
                source_profile_id=profile.id,
                source_resume_id=source_resume.id if source_resume else None,
                target_job_id=job.id,
            )
            for index, row in enumerate(content_sections):
                if isinstance(row, dict):
                    resume.sections.append(_row_to_section(row, index))
            if not resume.sections:
                resume.sections.extend(
                    [
                        ResumeSection(section_type="education", title="教育经历", sort_order=0),
                        ResumeSection(section_type="workExperiences", title="工作经历", sort_order=1),
                        ResumeSection(section_type="skills", title="技能", sort_order=2),
                    ]
                )
            db.add(resume)
            await db.flush()
            version = await create_version_snapshot(
                db,
                resume,
                change_summary="创建岗位简历工作区",
                created_by="system",
            )
            resume.current_version_id = version.id

        resume.target_job_id = job.id
        resume.source_mode = "job_tailored_workspace"
        if not resume.source_job_ids:
            resume.source_job_ids = [job.id]
        if proposal:
            proposal.workspace_resume_id = resume.id
            if not proposal.item_reviews_json:
                proposal.item_reviews_json = {}
            if not proposal.workspace_snapshot_hash:
                proposal.workspace_snapshot_hash = workspace_content_hash(resume)
        await db.commit()
        resume = await _load_resume(db, resume.id)
        return await _workspace_payload(db, resume, job=job, proposal_id=clean_proposal_id)


def _replace_first_text(value: Any, before: str, after: str) -> tuple[Any, bool]:
    if isinstance(value, str):
        if value == before:
            return after, True
        if before and before in value:
            return value.replace(before, after, 1), True
        return value, False
    if isinstance(value, list):
        result = copy.deepcopy(value)
        for index, item in enumerate(result):
            result[index], changed = _replace_first_text(item, before, after)
            if changed:
                return result, True
        return result, False
    if isinstance(value, dict):
        result = copy.deepcopy(value)
        for key, item in result.items():
            result[key], changed = _replace_first_text(item, before, after)
            if changed:
                return result, True
        return result, False
    return value, False


def _first_text_difference(before: Any, after: Any) -> str:
    """Return the first changed text leaf so Edit-then-Accept stays targeted."""
    if isinstance(before, str) and isinstance(after, str):
        return before if before != after else ""
    if isinstance(before, dict) and isinstance(after, dict):
        keys = list(before.keys()) + [key for key in after.keys() if key not in before]
        for key in keys:
            changed = _first_text_difference(before.get(key), after.get(key))
            if changed:
                return changed
        return ""
    if isinstance(before, list) and isinstance(after, list):
        for before_item, after_item in zip(before, after):
            changed = _first_text_difference(before_item, after_item)
            if changed:
                return changed
        return ""
    return ""


def _find_section(resume: Resume, row: Optional[dict[str, Any]]) -> Optional[ResumeSection]:
    if not isinstance(row, dict):
        return None
    wanted_ids = set(_source_ids(row.get("source_section_ids")))
    if wanted_ids:
        for section in resume.sections:
            if wanted_ids.intersection(_source_ids(section.source_section_ids)):
                return section
    section_type = _row_section_type(str(row.get("section_type") or ""))
    title = str(row.get("title") or "")
    return next(
        (
            section
            for section in resume.sections
            if section.section_type == section_type and section.title == title
        ),
        None,
    )


async def review_resume_proposal_item(
    proposal_id: str,
    resume_id: int,
    change_id: str,
    action: str,
    edited_text: str = "",
) -> dict[str, Any]:
    clean_proposal_id = _text(proposal_id, "proposal_id", 80)
    clean_resume_id = _positive_id(resume_id, "resume_id")
    clean_change_id = _text(change_id, "change_id", 120)
    clean_action = _text(action, "action", 20).lower()
    clean_edited_text = _text(edited_text, "edited_text", 20_000)
    if clean_action not in {"accept", "reject"}:
        raise ValueError("action 只能是 accept 或 reject")
    async with async_session() as db:
        proposal = (
            await db.execute(
                select(ResumeOptimizationProposal).where(
                    ResumeOptimizationProposal.proposal_id == clean_proposal_id
                )
            )
        ).scalar_one_or_none()
        if proposal is None:
            raise ValueError("简历提案不存在")
        if proposal.workspace_resume_id != clean_resume_id:
            raise ValueError("该提案尚未绑定当前 Resume Workspace")
        resume = await _load_resume(db, clean_resume_id)
        job = await db.get(Job, proposal.job_id)
        diff = next(
            (
                item
                for item in (proposal.diff_json or [])
                if isinstance(item, dict) and item.get("change_id") == clean_change_id
            ),
            None,
        )
        if diff is None:
            raise ValueError("提案条目不存在，可能需要重新生成提案")
        reviews = dict(proposal.item_reviews_json or {})
        previous = reviews.get(clean_change_id)
        if isinstance(previous, dict):
            return {
                **await _workspace_payload(db, resume, job=job, proposal_id=proposal.proposal_id),
                "duplicate": True,
            }
        if clean_action == "accept":
            if proposal.status == "blocked" or (proposal.fact_gates_json or {}).get("status") == "blocked":
                raise ValueError("事实门处于 blocked，不能接受该建议")
            expected_hash = proposal.workspace_snapshot_hash
            if expected_hash and workspace_content_hash(resume) != expected_hash:
                proposal.status = "stale"
                proposal.review_note = "用户手动修改后，原提案已过期，请重新生成或重新计算"
                proposal.reviewed_at = _now()
                await db.commit()
                raise ValueError(proposal.review_note)
            before = diff.get("before") if isinstance(diff.get("before"), dict) else None
            after = diff.get("after") if isinstance(diff.get("after"), dict) else None
            target = _find_section(resume, before or after)
            change_type = str(diff.get("change_type") or "modified")
            if change_type == "added" and after:
                target = _row_to_section(after, len(resume.sections))
                target.resume_id = resume.id
                db.add(target)
                await db.flush()
            elif target is None:
                raise ValueError("提案目标段落已变化，请重新生成提案")
            elif change_type == "removed":
                target.visible = False
            elif after:
                target.section_type = _row_section_type(str(after.get("section_type") or target.section_type))
                target.title = str(after.get("title") or target.title)
                target.sort_order = int(after.get("sort_order", target.sort_order))
                target.visible = bool(after.get("visible", True))
                target.content_json = copy.deepcopy(after.get("content_json") or [])
                target.source_section_ids = _source_ids(after.get("source_section_ids")) or target.source_section_ids
                if clean_edited_text:
                    suggested_text = _first_text_difference(
                        after.get("content_json"),
                        before.get("content_json") if before else None,
                    )
                    updated, changed = _replace_first_text(
                        target.content_json,
                        suggested_text,
                        clean_edited_text,
                    )
                    target.content_json = updated
            resume.workspace_revision = int(resume.workspace_revision or 0) + 1
        reviews[clean_change_id] = {
            "action": clean_action,
            "edited_text": clean_edited_text,
            "reviewed_at": _now().isoformat(),
        }
        proposal.item_reviews_json = reviews
        if proposal.status in {"ready", "blocked"}:
            proposal.status = "in_review"
        proposal.workspace_snapshot_hash = workspace_content_hash(resume)
        await db.commit()
        resume = await _load_resume(db, resume.id)
        return {
            **await _workspace_payload(db, resume, job=job, proposal_id=proposal.proposal_id),
            "duplicate": False,
        }
