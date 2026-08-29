from __future__ import annotations

import hashlib
import json
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session
from app.models.models import (
    Job,
    JobResearchRun,
    Profile,
    ProfileSection,
    ResearchEvidenceSnapshot,
    ResearchFinding,
    Resume,
    ResumeOptimizationProposal,
)
from app.services.career_memory import record_learning_observation
from app.services.resume_builder import (
    _build_source_profile_snapshot,
    _profile_to_contact_json,
    stage_generated_resume,
)
from app.services.resume_fact_gates import validate_resume_fact_gates
from app.services.resume_versions import create_version_snapshot


PROPOSAL_STATUSES = frozenset({"ready", "blocked", "stale", "accepted", "rejected"})
REVIEW_ACTIONS = frozenset({"accept", "reject"})
_TERMINAL_STATUSES = frozenset({"stale", "accepted", "rejected"})


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _canonical_json(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError) as exc:
        raise ValueError("简历优化数据必须能够序列化为 JSON") from exc


def _json_safe(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=False, default=str))


def _sha256(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _clean_positive_int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{field} 必须是正整数")
    return value


def _clean_text(value: Any, field: str, limit: int) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError(f"{field} 必须是字符串")
    clean = value.strip()
    if len(clean) > limit:
        raise ValueError(f"{field} 超过最大长度 {limit}")
    return clean


def _validated_resume_rows(value: Any, field: str) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not value:
        raise ValueError(f"{field} 必须是非空数组")
    if len(value) > 30:
        raise ValueError(f"{field} 最多包含 30 个 section")

    allowed_keys = {
        "section_type",
        "title",
        "sort_order",
        "visible",
        "content_json",
        "source_section_ids",
    }
    rows: list[dict[str, Any]] = []
    for index, raw_row in enumerate(value):
        if not isinstance(raw_row, dict):
            raise ValueError(f"{field}[{index}] 必须是对象")
        unknown = set(raw_row) - allowed_keys
        if unknown:
            raise ValueError(f"{field}[{index}] 含未知字段: {', '.join(sorted(unknown))}")
        section_type = _clean_text(
            raw_row.get("section_type"),
            f"{field}[{index}].section_type",
            80,
        )
        if not section_type:
            raise ValueError(f"{field}[{index}].section_type 不能为空")
        title = _clean_text(raw_row.get("title"), f"{field}[{index}].title", 200)
        sort_order = raw_row.get("sort_order", index)
        if isinstance(sort_order, bool) or not isinstance(sort_order, int) or sort_order < 0:
            raise ValueError(f"{field}[{index}].sort_order 必须是非负整数")
        visible = raw_row.get("visible", True)
        if not isinstance(visible, bool):
            raise ValueError(f"{field}[{index}].visible 必须是布尔值")
        content = raw_row.get("content_json")
        if not isinstance(content, list):
            raise ValueError(f"{field}[{index}].content_json 必须是数组")
        source_ids = raw_row.get("source_section_ids")
        if not isinstance(source_ids, list) or not source_ids:
            raise ValueError(f"{field}[{index}].source_section_ids 必须是非空数组")
        clean_source_ids: list[int] = []
        for source_id in source_ids:
            clean_id = _clean_positive_int(
                source_id,
                f"{field}[{index}].source_section_ids",
            )
            if clean_id not in clean_source_ids:
                clean_source_ids.append(clean_id)
        _canonical_json(content)
        rows.append({
            "section_type": section_type,
            "title": title,
            "sort_order": sort_order,
            "visible": visible,
            "content_json": _json_safe(content),
            "source_section_ids": clean_source_ids,
        })
    return rows


def _section_snapshot(section: ProfileSection) -> dict[str, Any]:
    return {
        "id": section.id,
        "section_type": section.section_type,
        "title": section.title or "",
        "content_json": section.content_json or {},
        "tier": section.tier,
        "updated_at": str(section.updated_at),
    }


def _profile_snapshot_hash(sections: list[ProfileSection]) -> str:
    return _sha256([
        _section_snapshot(section)
        for section in sorted(sections, key=lambda item: item.id)
    ])


def _research_snapshot_hash(payload: dict[str, Any]) -> str:
    return _sha256({
        "run_id": payload["run_id"],
        "job_id": payload["job_id"],
        "sources": payload["sources"],
        "findings": payload["findings"],
        "gaps": payload["gaps"],
    })


def _row_key(row: dict[str, Any]) -> str:
    return f"{row.get('section_type') or ''}:{row.get('title') or ''}"


def _build_diff(
    before_rows: list[dict[str, Any]],
    after_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    before_map = {_row_key(row): row for row in before_rows if isinstance(row, dict)}
    after_map = {_row_key(row): row for row in after_rows if isinstance(row, dict)}
    ordered_keys = list(before_map)
    ordered_keys.extend(key for key in after_map if key not in before_map)
    changes: list[dict[str, Any]] = []
    for key in ordered_keys:
        before = before_map.get(key)
        after = after_map.get(key)
        if before == after:
            continue
        if before is None:
            change_type = "added"
        elif after is None:
            change_type = "removed"
        elif before.get("content_json") == after.get("content_json"):
            change_type = "reordered"
        else:
            change_type = "modified"
        source_ids = (
            after.get("source_section_ids")
            if isinstance(after, dict)
            else before.get("source_section_ids") if isinstance(before, dict) else []
        )
        fingerprint = _sha256({"key": key, "before": before, "after": after})
        changes.append({
            "change_id": f"change_{fingerprint[:16]}",
            "change_type": change_type,
            "section_key": key,
            "section_type": (
                after.get("section_type")
                if isinstance(after, dict)
                else before.get("section_type") if isinstance(before, dict) else ""
            ),
            "title": (
                after.get("title")
                if isinstance(after, dict)
                else before.get("title") if isinstance(before, dict) else ""
            ),
            "source_section_ids": source_ids or [],
            "before": before,
            "after": after,
        })
    return changes


async def _load_research_context(
    db: AsyncSession,
    *,
    job_id: int,
    research_run_id: Optional[str],
) -> dict[str, Any]:
    query = (
        select(JobResearchRun)
        .where(JobResearchRun.job_id == job_id)
        .where(JobResearchRun.status == "completed")
        .where(JobResearchRun.review_status == "accepted")
    )
    if research_run_id:
        query = query.where(JobResearchRun.run_id == research_run_id)
    query = query.order_by(
        JobResearchRun.completed_at.desc(),
        JobResearchRun.updated_at.desc(),
    ).limit(1)
    run = (await db.execute(query)).scalars().first()
    if run is None:
        if research_run_id:
            raise ValueError("指定的岗位调研不存在、未完成、未通过审核或不属于该岗位")
        raise ValueError("该岗位尚无已完成并通过审核的调研")

    sources = (
        await db.execute(
            select(ResearchEvidenceSnapshot)
            .where(ResearchEvidenceSnapshot.run_id == run.run_id)
            .order_by(ResearchEvidenceSnapshot.id.asc())
        )
    ).scalars().all()
    findings = (
        await db.execute(
            select(ResearchFinding)
            .where(ResearchFinding.run_id == run.run_id)
            .order_by(ResearchFinding.id.asc())
        )
    ).scalars().all()
    if not sources or not findings:
        raise ValueError("岗位调研标记为 completed，但缺少可引用的证据或结论")

    source_rows = [
        {
            "source_ref": item.source_ref,
            "url": item.url,
            "title": item.title or "",
            "publisher": item.publisher or "",
            "source_class": item.source_class,
            "published_at": item.published_at,
            "retrieved_at": str(item.retrieved_at),
            "excerpt": item.excerpt or "",
            "content_hash": item.content_hash,
        }
        for item in sources
    ]
    source_refs = {item["source_ref"] for item in source_rows}
    finding_rows = []
    for item in findings:
        refs = list(item.source_refs_json or [])
        if any(ref not in source_refs for ref in refs):
            raise ValueError(f"岗位调研结论 #{item.id} 引用了不存在的证据")
        finding_rows.append({
            "id": item.id,
            "finding_type": item.finding_type,
            "statement": item.statement,
            "details": item.details_json or {},
            "source_refs": refs,
            "evidence_level": item.evidence_level,
        })

    gaps = [
        str(item).strip()
        for item in ((run.result_json or {}).get("gaps") or [])
        if str(item).strip()
    ]
    research = {
        "run_id": run.run_id,
        "job_id": run.job_id,
        "runtime_id": run.runtime_id,
        "data_mode": "fixture" if run.runtime_id in {"fixture", "replay"} else "live",
        "trace": run.trace_json if isinstance(run.trace_json, dict) else {},
        "sources": source_rows,
        "findings": finding_rows,
        "gaps": gaps,
    }

    def of_type(*types: str) -> list[dict[str, Any]]:
        allowed = set(types)
        return [
            {
                "statement": item["statement"],
                "details": item["details"],
                "source_refs": item["source_refs"],
                "evidence_level": item["evidence_level"],
            }
            for item in finding_rows
            if item["finding_type"] in allowed
        ]

    research["skill_context"] = {
        "role_requirements": of_type("role_requirement"),
        "resume_patterns": of_type("resume_pattern"),
        "interview_questions": of_type("interview_question", "interview_process"),
        "team_culture_signals": of_type("team_culture"),
        "company_context": of_type("company_business", "company_product"),
        "risks": of_type("risk", "unknown"),
        "gaps": gaps,
    }
    research["snapshot_hash"] = _research_snapshot_hash(research)
    return research


async def _generate_candidate(
    *,
    profile: Profile,
    sections: list[ProfileSection],
    jd_text: str,
    research_context: dict[str, Any],
) -> dict[str, Any]:
    from app.routes.optimize import (
        _build_resume_sections,
        _bullet_text,
        _missing_keywords,
        _select_sections_structured,
        _skills_pipeline_rewrite,
    )

    if research_context.get("data_mode") == "fixture":
        selected = list(sections[:12])
        original_rows = _build_resume_sections(sections)
        proposed_rows = _build_resume_sections(selected)
        used_texts = [_bullet_text(section) for section in selected]
        return {
            "selected": selected,
            "original_rows": original_rows,
            "proposed_rows": proposed_rows,
            "rewrite_applied": False,
            "pipeline": {
                "fixture_replay": {
                    "status": "completed",
                    "provider": "replay",
                    "rewrite_applied": False,
                }
            },
            "missing_capabilities": _missing_keywords(jd_text, used_texts),
        }

    ranked = await _select_sections_structured(
        sections,
        jd_text,
        profile_id=profile.id,
        limit=12,
    )
    selected = [item[0] for item in ranked]
    if not selected:
        raise ValueError("没有任何已验证档案证据与该 JD 建立可用映射")

    original_rows = _build_resume_sections(sections)
    source_rows = _build_resume_sections(selected)
    proposed_rows, rewrite_applied, pipeline = await _skills_pipeline_rewrite(
        deepcopy(source_rows),
        jd_text,
        research_context=research_context,
    )
    used_texts = [_bullet_text(section) for section in selected]
    return {
        "selected": selected,
        "original_rows": original_rows,
        "proposed_rows": proposed_rows,
        "rewrite_applied": rewrite_applied,
        "pipeline": pipeline,
        "missing_capabilities": _missing_keywords(jd_text, used_texts),
    }


def _proposal_summary(
    proposal: ResumeOptimizationProposal,
    job: Optional[Job],
) -> dict[str, Any]:
    fact_gates = proposal.fact_gates_json or {}
    return {
        "proposal_id": proposal.proposal_id,
        "status": proposal.status,
        "job_id": proposal.job_id,
        "job_title": job.title if job else "",
        "company": job.company if job else "",
        "profile_id": proposal.profile_id,
        "research_run_id": proposal.research_run_id,
        "reference_resume_id": proposal.reference_resume_id,
        "change_count": len(proposal.diff_json or []),
        "fact_gate_status": fact_gates.get("status", "unknown"),
        "fact_gate_warnings_count": int(fact_gates.get("warnings_count") or 0),
        "accepted_resume_id": proposal.accepted_resume_id,
        "accepted_resume_version_id": proposal.accepted_resume_version_id,
        "review_note": proposal.review_note or "",
        "created_at": str(proposal.created_at),
        "updated_at": str(proposal.updated_at),
        "reviewed_at": str(proposal.reviewed_at) if proposal.reviewed_at else None,
    }


def _proposal_detail(
    proposal: ResumeOptimizationProposal,
    job: Optional[Job],
) -> dict[str, Any]:
    return {
        **_proposal_summary(proposal, job),
        "source_section_ids": proposal.source_section_ids_json or [],
        "source_snapshot_hash": proposal.source_snapshot_hash,
        "research_snapshot_hash": proposal.research_snapshot_hash,
        "original_summary": proposal.original_summary or "",
        "proposed_summary": proposal.proposed_summary or "",
        "original_rows": proposal.original_rows_json or [],
        "proposed_rows": proposal.proposed_rows_json or [],
        "diff": proposal.diff_json or [],
        "strategy": proposal.strategy_json or {},
        "presentation": proposal.presentation_json or {},
        "fact_gates": proposal.fact_gates_json or {},
        "trace": proposal.trace_json or {},
    }


async def prepare_resume_optimization(
    *,
    job_id: int,
    profile_id: Optional[int] = None,
    reference_resume_id: Optional[int] = None,
    research_run_id: Optional[str] = None,
    candidate_rows: Optional[list[dict[str, Any]]] = None,
    candidate_original_rows: Optional[list[dict[str, Any]]] = None,
    source_session_id: Optional[str] = None,
) -> dict[str, Any]:
    clean_job_id = _clean_positive_int(job_id, "job_id")
    clean_profile_id = (
        _clean_positive_int(profile_id, "profile_id")
        if profile_id is not None
        else None
    )
    clean_reference_id = (
        _clean_positive_int(reference_resume_id, "reference_resume_id")
        if reference_resume_id is not None
        else None
    )
    clean_research_run_id = _clean_text(research_run_id, "research_run_id", 64) or None
    clean_source_session_id = _clean_text(source_session_id, "source_session_id", 60) or None
    has_session_candidate = any(
        value is not None
        for value in (candidate_rows, candidate_original_rows, source_session_id)
    )
    if has_session_candidate and (
        candidate_rows is None
        or candidate_original_rows is None
        or clean_source_session_id is None
    ):
        raise ValueError(
            "会话候选稿必须同时提供 candidate_rows、candidate_original_rows 和 source_session_id"
        )

    async with async_session() as db:
        profile_query = select(Profile)
        if clean_profile_id is not None:
            profile_query = profile_query.where(Profile.id == clean_profile_id)
        else:
            profile_query = (
                profile_query
                .where(Profile.is_default == True)
                .order_by(Profile.updated_at.desc(), Profile.id.desc())
                .limit(1)
            )
        profile = (await db.execute(profile_query)).scalars().first()
        if profile is None:
            raise ValueError(
                f"Profile #{clean_profile_id} 不存在"
                if clean_profile_id is not None
                else "未找到默认 Profile"
            )
        job = (
            await db.execute(select(Job).where(Job.id == clean_job_id))
        ).scalar_one_or_none()
        if job is None:
            raise ValueError(f"岗位 #{clean_job_id} 不存在")
        jd_text = (job.raw_description or "").strip()
        if not jd_text:
            raise ValueError(f"岗位 #{clean_job_id} 缺少 JD 文本")

        research = await _load_research_context(
            db,
            job_id=job.id,
            research_run_id=clean_research_run_id,
        )
        sections = list((
            await db.execute(
                select(ProfileSection)
                .where(ProfileSection.profile_id == profile.id)
                .where(ProfileSection.tier == "verified_fact")
                .where(ProfileSection.status == "active")
            )
        ).scalars().all())
        if not sections:
            raise ValueError("Profile 中没有 tier=verified_fact 的可用职业事实")
        from app.services.job_projection import reorder_sections_by_job_relevance

        reorder_sections_by_job_relevance(
            sections,
            job_title=str(job.title or ""),
            jd_text=jd_text,
        )

        reference_resume = None
        if clean_reference_id is not None:
            reference_resume = (
                await db.execute(select(Resume).where(Resume.id == clean_reference_id))
            ).scalar_one_or_none()
            if reference_resume is None:
                raise ValueError("reference_resume_id 对应简历不存在")

        if has_session_candidate:
            proposed_candidate_rows = _validated_resume_rows(
                candidate_rows,
                "candidate_rows",
            )
            original_candidate_rows = _validated_resume_rows(
                candidate_original_rows,
                "candidate_original_rows",
            )
            source_ids = list(dict.fromkeys(
                source_id
                for row in proposed_candidate_rows + original_candidate_rows
                for source_id in row["source_section_ids"]
            ))
            section_by_id = {section.id: section for section in sections}
            missing_source_ids = [
                source_id for source_id in source_ids if source_id not in section_by_id
            ]
            if missing_source_ids:
                raise ValueError(
                    "会话候选稿引用了不属于当前 Profile 的已验证事实: "
                    + ", ".join(str(item) for item in missing_source_ids)
                )
            selected = [section_by_id[source_id] for source_id in source_ids]
            from app.routes.optimize import _bullet_text, _missing_keywords

            candidate = {
                "selected": selected,
                "original_rows": original_candidate_rows,
                "proposed_rows": proposed_candidate_rows,
                "rewrite_applied": original_candidate_rows != proposed_candidate_rows,
                "pipeline": {
                    "reviewed_optimize_session": {
                        "status": "completed",
                        "source_session_id": clean_source_session_id,
                    }
                },
                "missing_capabilities": _missing_keywords(
                    jd_text,
                    [_bullet_text(section) for section in selected],
                ),
            }
        else:
            candidate = await _generate_candidate(
                profile=profile,
                sections=sections,
                jd_text=jd_text,
                research_context={
                    **research["skill_context"],
                    "data_mode": research["data_mode"],
                    "runtime_id": research["runtime_id"],
                },
            )
            candidate["original_rows"] = _validated_resume_rows(
                candidate["original_rows"],
                "generated_original_rows",
            )
            candidate["proposed_rows"] = _validated_resume_rows(
                candidate["proposed_rows"],
                "generated_proposed_rows",
            )
        selected = candidate["selected"]
        proposed_rows = candidate["proposed_rows"]
        fact_gates = validate_resume_fact_gates(
            proposed_rows,
            selected,
            strict_structured_facts=True,
        )
        diff = _build_diff(candidate["original_rows"], proposed_rows)

        contact_json = (
            reference_resume.contact_json
            if reference_resume and isinstance(reference_resume.contact_json, dict)
            else _profile_to_contact_json(profile)
        )
        style_config = (
            reference_resume.style_config
            if reference_resume and isinstance(reference_resume.style_config, dict)
            else {}
        )
        presentation = {
            "contact_json": _json_safe(contact_json or {}),
            "style_config": _json_safe(style_config or {}),
            "template_id": reference_resume.template_id if reference_resume else None,
            "language": (reference_resume.language or "zh") if reference_resume else "zh",
            "content_policy": "reference_resume_style_only",
        }
        pipeline = _json_safe(candidate["pipeline"])
        pipeline_errors = {
            name: value.get("error")
            for name, value in pipeline.items()
            if isinstance(value, dict) and value.get("error")
        }
        if pipeline_errors:
            details = "；".join(
                f"{name}: {message}"
                for name, message in pipeline_errors.items()
            )
            raise RuntimeError(f"简历优化 Skill 未完整执行，未保存降级提案：{details}")
        source_hash = _profile_snapshot_hash(selected)
        proposal = ResumeOptimizationProposal(
            proposal_id=f"resume_opt_{uuid.uuid4().hex[:20]}",
            job_id=job.id,
            profile_id=profile.id,
            research_run_id=research["run_id"],
            reference_resume_id=clean_reference_id,
            status="blocked" if fact_gates["status"] == "blocked" else "ready",
            source_section_ids_json=[section.id for section in selected],
            source_snapshot_hash=source_hash,
            research_snapshot_hash=research["snapshot_hash"],
            original_summary="",
            proposed_summary="",
            original_rows_json=_json_safe(candidate["original_rows"]),
            proposed_rows_json=proposed_rows,
            diff_json=_json_safe(diff),
            strategy_json=_json_safe({
                "job_description_sha256": _sha256(jd_text),
                "research": {
                    key: value
                    for key, value in research.items()
                    if key not in {"skill_context", "snapshot_hash"}
                },
                "selected_source_section_ids": [section.id for section in selected],
                "missing_capabilities": candidate["missing_capabilities"],
                "research_gaps": research["gaps"],
                "scoring_policy": "no_unvalidated_ats_score",
            }),
            presentation_json=presentation,
            fact_gates_json=_json_safe(fact_gates),
            trace_json={
                "source_mode": (
                    "reviewed_optimize_session" if has_session_candidate else "skill_pipeline"
                ),
                "source_session_id": clean_source_session_id,
                "rewrite_applied": bool(candidate["rewrite_applied"]),
                "pipeline": pipeline,
                "pipeline_errors": pipeline_errors,
                "profile_verified_fact_count": len(sections),
                "selected_fact_count": len(selected),
            },
        )
        db.add(proposal)
        await db.commit()
        await db.refresh(proposal)
        return _proposal_detail(proposal, job)


async def list_resume_optimizations(
    *,
    job_id: Optional[int] = None,
    status: Optional[str] = None,
    limit: int = 20,
) -> dict[str, Any]:
    clean_job_id = (
        _clean_positive_int(job_id, "job_id") if job_id is not None else None
    )
    clean_status = _clean_text(status, "status", 24).lower() or None
    if clean_status and clean_status not in PROPOSAL_STATUSES:
        raise ValueError("status 不在允许枚举中")
    safe_limit = max(1, min(int(limit), 200))
    query = select(ResumeOptimizationProposal)
    if clean_job_id is not None:
        query = query.where(ResumeOptimizationProposal.job_id == clean_job_id)
    if clean_status:
        query = query.where(ResumeOptimizationProposal.status == clean_status)
    query = query.order_by(
        ResumeOptimizationProposal.created_at.desc(),
        ResumeOptimizationProposal.proposal_id.desc(),
    ).limit(safe_limit)

    async with async_session() as db:
        proposals = list((await db.execute(query)).scalars().all())
        job_ids = sorted({item.job_id for item in proposals})
        jobs = {}
        if job_ids:
            rows = (
                await db.execute(select(Job).where(Job.id.in_(job_ids)))
            ).scalars().all()
            jobs = {item.id: item for item in rows}
        return {
            "total": len(proposals),
            "items": [
                _proposal_summary(item, jobs.get(item.job_id))
                for item in proposals
            ],
        }


async def get_resume_optimization(*, proposal_id: str) -> dict[str, Any]:
    clean_id = _clean_text(proposal_id, "proposal_id", 64)
    if not clean_id.startswith("resume_opt_"):
        raise ValueError("proposal_id 格式无效")
    async with async_session() as db:
        proposal = (
            await db.execute(
                select(ResumeOptimizationProposal).where(
                    ResumeOptimizationProposal.proposal_id == clean_id
                )
            )
        ).scalar_one_or_none()
        if proposal is None:
            raise ValueError(f"简历优化提案 {clean_id} 不存在")
        job = (
            await db.execute(select(Job).where(Job.id == proposal.job_id))
        ).scalar_one_or_none()
        return _proposal_detail(proposal, job)


async def _mark_stale(
    db: AsyncSession,
    *,
    proposal: ResumeOptimizationProposal,
    job: Optional[Job],
    reason: str,
) -> dict[str, Any]:
    proposal.status = "stale"
    proposal.review_note = reason[:2000]
    proposal.reviewed_at = _now()
    await db.commit()
    await db.refresh(proposal)
    return {
        "error": reason,
        "proposal": _proposal_detail(proposal, job),
    }


async def review_resume_optimization(
    *,
    proposal_id: str,
    action: str,
    note: str = "",
) -> dict[str, Any]:
    clean_id = _clean_text(proposal_id, "proposal_id", 64)
    clean_action = _clean_text(action, "action", 20).lower()
    clean_note = _clean_text(note, "note", 2000)
    if clean_action not in REVIEW_ACTIONS:
        raise ValueError("action 只能是 accept 或 reject")

    async with async_session() as db:
        proposal = (
            await db.execute(
                select(ResumeOptimizationProposal).where(
                    ResumeOptimizationProposal.proposal_id == clean_id
                )
            )
        ).scalar_one_or_none()
        if proposal is None:
            raise ValueError(f"简历优化提案 {clean_id} 不存在")
        job = (
            await db.execute(select(Job).where(Job.id == proposal.job_id))
        ).scalar_one_or_none()
        profile = (
            await db.execute(select(Profile).where(Profile.id == proposal.profile_id))
        ).scalar_one_or_none()
        if job is None or profile is None:
            return await _mark_stale(
                db,
                proposal=proposal,
                job=job,
                reason="岗位或 Profile 已不存在，提案不能继续应用",
            )

        if proposal.status == "accepted" and clean_action == "accept":
            return {
                **_proposal_detail(proposal, job),
                "duplicate": True,
            }
        if proposal.status == "rejected" and clean_action == "reject":
            return {
                **_proposal_detail(proposal, job),
                "duplicate": True,
            }
        if proposal.status in _TERMINAL_STATUSES:
            raise ValueError(f"提案已处于终态 {proposal.status}，不能执行 {clean_action}")

        if clean_action == "reject":
            proposal.status = "rejected"
            proposal.review_note = clean_note
            proposal.reviewed_at = _now()
            observation = await record_learning_observation(
                source_type="resume_optimization",
                source_external_id=proposal.proposal_id,
                source_title=f"简历优化提案 {proposal.proposal_id}",
                source_locator=f"offeru://resume-optimization/{proposal.proposal_id}",
                source_metadata={"schema": "offeru.resume_optimization.v1"},
                observation_type="resume_optimization_rejected",
                content={
                    "proposal_id": proposal.proposal_id,
                    "job_id": proposal.job_id,
                    "research_run_id": proposal.research_run_id,
                    "decision": "rejected",
                    "diff_sha256": _sha256(proposal.diff_json or []),
                    "review_note": clean_note,
                    "career_fact": False,
                },
                idempotency_key=f"{proposal.proposal_id}:reject",
                _db=db,
                _commit=False,
            )
            await db.commit()
            await db.refresh(proposal)
            return {
                **_proposal_detail(proposal, job),
                "learning_observation": observation,
                "duplicate": False,
            }

        if proposal.status == "blocked":
            raise ValueError("事实门处于 blocked，必须重新生成合规提案后才能接受")
        if proposal.status != "ready":
            raise ValueError(f"提案状态 {proposal.status} 不能接受")

        current_jd = (job.raw_description or "").strip()
        expected_jd_hash = str(
            (proposal.strategy_json or {}).get("job_description_sha256") or ""
        )
        if not current_jd or _sha256(current_jd) != expected_jd_hash:
            return await _mark_stale(
                db,
                proposal=proposal,
                job=job,
                reason="提案生成后岗位 JD 已变化或缺失，请重新生成",
            )

        source_ids = list(proposal.source_section_ids_json or [])
        sections = list((
            await db.execute(
                select(ProfileSection)
                .where(ProfileSection.id.in_(source_ids))
                .where(ProfileSection.profile_id == proposal.profile_id)
                .where(ProfileSection.tier == "verified_fact")
                .where(ProfileSection.status == "active")
                .order_by(ProfileSection.id.asc())
            )
        ).scalars().all())
        if len(sections) != len(set(source_ids)):
            return await _mark_stale(
                db,
                proposal=proposal,
                job=job,
                reason="提案引用的已验证档案事实已缺失或降级，请重新生成",
            )
        if _profile_snapshot_hash(sections) != proposal.source_snapshot_hash:
            return await _mark_stale(
                db,
                proposal=proposal,
                job=job,
                reason="提案生成后档案事实已变化，请重新生成以避免使用过期内容",
            )
        try:
            research = await _load_research_context(
                db,
                job_id=proposal.job_id,
                research_run_id=proposal.research_run_id,
            )
        except ValueError as exc:
            return await _mark_stale(
                db,
                proposal=proposal,
                job=job,
                reason=f"岗位调研已不可用：{exc}",
            )
        if research["snapshot_hash"] != proposal.research_snapshot_hash:
            return await _mark_stale(
                db,
                proposal=proposal,
                job=job,
                reason="岗位调研证据快照已变化，请重新生成提案",
            )

        proposed_rows = deepcopy(proposal.proposed_rows_json or [])
        fact_gates = validate_resume_fact_gates(
            proposed_rows,
            sections,
            strict_structured_facts=True,
        )
        if fact_gates["status"] != "passed":
            proposal.status = "blocked"
            proposal.fact_gates_json = _json_safe(fact_gates)
            proposal.review_note = "接受前重新校验未通过"
            proposal.reviewed_at = _now()
            await db.commit()
            raise ValueError("接受前事实门重新校验失败，提案已转为 blocked")

        presentation = proposal.presentation_json or {}
        source_snapshot = _build_source_profile_snapshot(profile, sections)
        source_snapshot.update({
            "source_snapshot_hash": proposal.source_snapshot_hash,
            "research_run_id": proposal.research_run_id,
            "research_snapshot_hash": proposal.research_snapshot_hash,
            "resume_optimization_proposal_id": proposal.proposal_id,
        })
        resume = await stage_generated_resume(
            db=db,
            profile=profile,
            title=f"{job.company} - {job.title} 定制简历",
            summary=proposal.proposed_summary or "",
            source_mode="per_job_reviewed",
            source_job_ids=[job.id],
            contact_json=presentation.get("contact_json") or {},
            style_config=presentation.get("style_config") or {},
            template_id=presentation.get("template_id"),
            source_profile_snapshot=source_snapshot,
            rows=proposed_rows,
            language=str(presentation.get("language") or "zh"),
        )
        version = await create_version_snapshot(
            db,
            resume,
            change_summary=f"接受岗位 #{job.id} 的简历优化提案 {proposal.proposal_id}",
            created_by="resume_optimization",
        )
        snapshot = deepcopy(version.content_snapshot or {})
        snapshot["provenance"] = {
            "proposal_id": proposal.proposal_id,
            "job_id": proposal.job_id,
            "research_run_id": proposal.research_run_id,
            "source_snapshot_hash": proposal.source_snapshot_hash,
            "research_snapshot_hash": proposal.research_snapshot_hash,
            "diff_sha256": _sha256(proposal.diff_json or []),
        }
        source_ids_by_type = {
            _row_key(row): row.get("source_section_ids") or []
            for row in proposed_rows
            if isinstance(row, dict)
        }
        for item in snapshot.get("sections") or []:
            key = f"{item.get('section_type') or ''}:{item.get('title') or ''}"
            item["source_section_ids"] = source_ids_by_type.get(key, [])
        version.content_snapshot = snapshot

        proposal.status = "accepted"
        proposal.accepted_resume_id = resume.id
        proposal.accepted_resume_version_id = version.id
        proposal.review_note = clean_note
        proposal.reviewed_at = _now()
        observation = await record_learning_observation(
            source_type="resume_optimization",
            source_external_id=proposal.proposal_id,
            source_title=f"简历优化提案 {proposal.proposal_id}",
            source_locator=f"offeru://resume-optimization/{proposal.proposal_id}",
            source_metadata={"schema": "offeru.resume_optimization.v1"},
            observation_type="resume_optimization_accepted",
            content={
                "proposal_id": proposal.proposal_id,
                "job_id": proposal.job_id,
                "research_run_id": proposal.research_run_id,
                "decision": "accepted",
                "resume_id": resume.id,
                "resume_version_id": version.id,
                "diff_sha256": _sha256(proposal.diff_json or []),
                "review_note": clean_note,
                "career_fact": False,
            },
            idempotency_key=f"{proposal.proposal_id}:accept",
            _db=db,
            _commit=False,
        )
        await db.commit()
        await db.refresh(proposal)
        return {
            **_proposal_detail(proposal, job),
            "learning_observation": observation,
            "duplicate": False,
        }
