from __future__ import annotations

import hashlib
import json
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import async_session
from app.models.models import (
    CareerTask,
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


PROPOSAL_STATUSES = frozenset({"ready", "blocked", "in_review", "stale", "accepted", "rejected"})
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
    from app.services.resume_optimize_support import (
        _build_resume_sections,
        _bullet_text,
        _missing_keywords,
        _rank_profile_sections,
        _select_sections_structured,
        _skills_pipeline_rewrite,
    )

    if research_context.get("data_mode") == "fixture":
        ranked = _rank_profile_sections(sections, jd_text, limit=12)
        selected = [section for section, _ in ranked] or list(sections[:12])
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
                    # Fixture/replay never rewrites by design — this is an
                    # expected no-op, not a provider failure.
                    "rewrite_status": "skipped",
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
        # Surface rewrite integrity to the proposal UI.  Degraded means the
        # JD-tailored AI rewrite failed and original wording was preserved —
        # it must not be presented as a successful tailored rewrite.
        "rewrite_status": pipeline.get("rewrite_status") or ("applied" if rewrite_applied else "degraded"),
        "pipeline": pipeline,
        "missing_capabilities": _missing_keywords(jd_text, used_texts),
    }


def _proposal_summary(
    proposal: ResumeOptimizationProposal,
    job: Optional[Job],
) -> dict[str, Any]:
    fact_gates = proposal.fact_gates_json or {}
    trace = proposal.trace_json or {}
    # Top-level rewrite integrity: applied / degraded / skipped.  Lets the UI
    # flag "original wording preserved" without digging into trace internals.
    rewrite_status = trace.get("rewrite_status") or trace.get("pipeline", {}).get("rewrite_status")
    return {
        "source_mode": trace.get("source_mode") or "",
        "task_id": trace.get("task_id") or "",
        "replaces_proposal_id": trace.get("replaces_proposal_id") or "",
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
        "workspace_resume_id": proposal.workspace_resume_id,
        "workspace_snapshot_hash": proposal.workspace_snapshot_hash or "",
        "item_reviews": proposal.item_reviews_json or {},
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
        "workspace_resume_id": proposal.workspace_resume_id,
        "workspace_snapshot_hash": proposal.workspace_snapshot_hash or "",
        "item_reviews": proposal.item_reviews_json or {},
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
                .order_by(ProfileSection.sort_order.asc(), ProfileSection.id.asc())
            )
        ).scalars().all())
        if not sections:
            raise ValueError("Profile 中没有 tier=verified_fact 的可用职业事实")
        baseline_sections = list(sections)
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
            from app.services.resume_optimize_support import _bullet_text, _missing_keywords

            candidate = {
                "selected": selected,
                "original_rows": original_candidate_rows,
                "proposed_rows": proposed_candidate_rows,
                "rewrite_applied": original_candidate_rows != proposed_candidate_rows,
                "pipeline": {
                    "reviewed_optimize_session": {
                        "status": "completed",
                        "source_session_id": clean_source_session_id,
                        # A human-reviewed session candidate is applied as-is;
                        # no AI rewrite ran here, so mark it applied rather
                        # than degrading a path that never attempted rewrite.
                        "rewrite_status": "applied",
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
            from app.services.resume_optimize_support import _build_resume_sections

            # `sections` is intentionally ordered for job relevance above so
            # the generated candidate can use that order.  The Before side of
            # a proposal must remain the user's current Profile order; using
            # the ranked list here would hide legitimate reorder-only diffs.
            candidate["original_rows"] = _build_resume_sections(baseline_sections)
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
            deepcopy(proposed_rows),
            selected,
            strict_structured_facts=True,
        )
        for row in proposed_rows:
            for item in row.get("content_json") or []:
                if isinstance(item, dict):
                    item.pop("_gate_warnings", None)
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
                "rewrite_status": candidate.get("rewrite_status") or candidate["pipeline"].get("rewrite_status") or ("applied" if candidate["rewrite_applied"] else "degraded"),
                "pipeline_errors": pipeline_errors,
                "profile_verified_fact_count": len(sections),
                "selected_fact_count": len(selected),
            },
        )
        db.add(proposal)
        # Only one live candidate per job: a newly generated proposal
        # supersedes earlier un-reviewed ones so a stale draft can never be
        # accepted after fresher evidence was generated.
        superseded = (
            await db.execute(
                select(ResumeOptimizationProposal).where(
                    ResumeOptimizationProposal.job_id == job.id,
                    ResumeOptimizationProposal.status.in_(("ready", "blocked")),
                    ResumeOptimizationProposal.proposal_id != proposal.proposal_id,
                )
            )
        ).scalars().all()
        for older in superseded:
            older.status = "stale"
            older.review_note = (
                f"已被新提案 {proposal.proposal_id} 取代，请审核最新提案"
            )
            older.reviewed_at = _now()
        await db.commit()
        await db.refresh(proposal)
        return _proposal_detail(proposal, job)


# ---------------------------------------------------------------------------
# Career Director L1 preparation: JD-only verified-Profile proposals.
#
# The director path never runs job research and never touches Career Truth.
# A proposal is built from the model-produced `resume_preparation` payload of
# a real CareerTask, checked against the current source fingerprint so stale
# in-flight output is rejected, gated per row against verified Profile facts,
# and persisted as a normal reviewable ResumeOptimizationProposal.
# ---------------------------------------------------------------------------

DIRECTOR_SOURCE_MODE = "career_director"
_DIRECTOR_CONTEXT_SCHEMA = "offeru.resume_preparation_context.v1"
_DIRECTOR_PREPARATION_SCHEMA = "offeru.resume_preparation.v1"
_MAX_PREPARATION_SECTIONS = 40
_MAX_PREPARATION_CONTENT_CHARS = 20_000
_BLOCKING_GATE_ISSUES = frozenset({
    "invalid_row",
    "missing_provenance",
    "invalid_provenance",
    "unverified_metric",
    "unverified_fact",
    "unverified_placeholder",
    "unverified_org",
    "echo_source",
})
_REVIEWABLE_STATUSES = frozenset({"ready", "blocked", "in_review"})
_DIRECTOR_TASK_STATUSES = frozenset({"running", "completed"})


def _clean_id_list(value: Any, field: str) -> Optional[list[int]]:
    if value is None:
        return None
    if not isinstance(value, list):
        raise ValueError(f"{field} 必须是数组")
    if len(value) > 30:
        raise ValueError(f"{field} 最多包含 30 个 ID")
    cleaned: list[int] = []
    for item in value:
        item_id = _clean_positive_int(item, field)
        if item_id not in cleaned:
            cleaned.append(item_id)
    return cleaned


def _jd_excerpt_ok(jd_text: str, requirement: str) -> bool:
    """Requirement must be an exact JD excerpt (whitespace-insensitive)."""
    jd_compact = " ".join(str(jd_text or "").split()).casefold()
    req_compact = " ".join(str(requirement or "").split()).casefold()
    return bool(req_compact) and req_compact in jd_compact


def _clean_director_rationale(value: Any, jd_text: str, known_ids: set[int]) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 60:
        raise ValueError("preparation.rationale 必须是不超过 60 条的数组")
    cleaned: list[dict[str, Any]] = []
    for index, raw in enumerate(value):
        field = f"preparation.rationale[{index}]"
        if not isinstance(raw, dict):
            raise ValueError(f"{field} 必须是对象")
        requirement = _clean_text(raw.get("requirement"), f"{field}.requirement", 1000)
        why = _clean_text(raw.get("why"), f"{field}.why", 1000)
        if not requirement:
            raise ValueError(f"{field}.requirement 不能为空")
        if not _jd_excerpt_ok(jd_text, requirement):
            raise ValueError(f"{field}.requirement 不是岗位 JD 的原文摘录")
        source_ids = _clean_id_list(raw.get("source_section_ids"), f"{field}.source_section_ids") or []
        invalid = [item for item in source_ids if item not in known_ids]
        if invalid:
            raise ValueError(f"{field}.source_section_ids 引用了不存在的已验证档案: {invalid}")
        cleaned.append({
            "source_section_ids": source_ids,
            "requirement": requirement,
            "why": why,
        })
    return cleaned


def _clean_director_questions(value: Any, jd_text: str, known_ids: set[int]) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 3:
        raise ValueError("preparation.questions 必须是 0-3 条的数组")
    cleaned: list[dict[str, Any]] = []
    for index, raw in enumerate(value):
        field = f"preparation.questions[{index}]"
        if not isinstance(raw, dict):
            raise ValueError(f"{field} 必须是对象")
        question = _clean_text(raw.get("question"), f"{field}.question", 1000)
        why_needed = _clean_text(raw.get("why_needed"), f"{field}.why_needed", 1000)
        requirement = _clean_text(raw.get("requirement"), f"{field}.requirement", 1000)
        if not question or not why_needed:
            raise ValueError(f"{field}.question/why_needed 不能为空")
        if not requirement or not _jd_excerpt_ok(jd_text, requirement):
            raise ValueError(f"{field}.requirement 必须是岗位 JD 的原文摘录")
        source_ids = _clean_id_list(raw.get("source_section_ids"), f"{field}.source_section_ids") or []
        invalid = [item for item in source_ids if item not in known_ids]
        if invalid:
            raise ValueError(f"{field}.source_section_ids 引用了不存在的已验证档案: {invalid}")
        cleaned.append({
            "question": question,
            "why_needed": why_needed,
            "source_section_ids": source_ids,
            "requirement": requirement,
        })
    return cleaned


def _clean_director_gaps(value: Any) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 30:
        raise ValueError("preparation.gaps 必须是不超过 30 条的数组")
    cleaned: list[dict[str, Any]] = []
    for index, raw in enumerate(value):
        field = f"preparation.gaps[{index}]"
        if not isinstance(raw, dict):
            raise ValueError(f"{field} 必须是对象")
        requirement = _clean_text(raw.get("requirement"), f"{field}.requirement", 1000)
        status = _clean_text(raw.get("status"), f"{field}.status", 24).lower()
        explanation = _clean_text(raw.get("explanation"), f"{field}.explanation", 1000)
        if not requirement:
            raise ValueError(f"{field}.requirement 不能为空")
        if status not in {"unknown", "missing"}:
            raise ValueError(f"{field}.status 只能是 unknown 或 missing")
        cleaned.append({
            "requirement": requirement,
            "status": status,
            "explanation": explanation,
        })
    return cleaned


def _director_source_fingerprint(
    *,
    job_id: int,
    jd_text: str,
    profile_id: int,
    sections: list[ProfileSection],
    replaces_proposal_id: Optional[str],
    affected_source_section_ids: Optional[list[int]],
) -> str:
    return _sha256({
        "schema": _DIRECTOR_CONTEXT_SCHEMA,
        "job_id": job_id,
        "jd_text": jd_text,
        "profile_id": profile_id,
        "sections": [
            _section_snapshot(section)
            for section in sorted(sections, key=lambda item: item.id)
        ],
        "replaces_proposal_id": replaces_proposal_id or "",
        "affected_source_section_ids": sorted(affected_source_section_ids or []),
    })


async def _load_director_base(
    db: AsyncSession,
    *,
    job_id: int,
    replaces_proposal_id: Optional[str],
) -> dict[str, Any]:
    """Load job/JD, verified Profile sections and the replaced proposal."""
    job = (
        await db.execute(select(Job).where(Job.id == job_id))
    ).scalar_one_or_none()
    if job is None:
        raise ValueError(f"岗位 #{job_id} 不存在")
    jd_text = (job.raw_description or "").strip()
    if not jd_text:
        raise ValueError(f"岗位 #{job_id} 缺少 JD 文本")

    replaced = None
    if replaces_proposal_id:
        replaced = (
            await db.execute(
                select(ResumeOptimizationProposal).where(
                    ResumeOptimizationProposal.proposal_id == replaces_proposal_id
                )
            )
        ).scalar_one_or_none()
        if replaced is None:
            raise ValueError(f"被替代的简历提案 {replaces_proposal_id} 不存在")
        if replaced.job_id != job.id:
            raise ValueError("被替代的简历提案不属于当前岗位")
        if replaced.status in _TERMINAL_STATUSES:
            raise ValueError(
                f"被替代的简历提案已处于终态 {replaced.status}，不能在其上重新准备"
            )

    if replaced is not None:
        profile = (
            await db.execute(
                select(Profile).where(Profile.id == replaced.profile_id)
            )
        ).scalar_one_or_none()
    else:
        profile = (
            await db.execute(
                select(Profile)
                .where(Profile.is_default == True)
                .order_by(Profile.updated_at.desc(), Profile.id.desc())
                .limit(1)
            )
        ).scalars().first()
    if profile is None:
        raise ValueError("未找到可用于准备的已验证 Profile")

    sections = list((
        await db.execute(
            select(ProfileSection)
            .where(ProfileSection.profile_id == profile.id)
            .where(ProfileSection.tier == "verified_fact")
            .where(ProfileSection.status == "active")
            .order_by(ProfileSection.sort_order.asc(), ProfileSection.id.asc())
        )
    ).scalars().all())
    if not sections:
        raise ValueError("Profile 中没有 tier=verified_fact 的可用职业事实")
    return {
        "job": job,
        "jd_text": jd_text,
        "profile": profile,
        "sections": sections,
        "replaced": replaced,
    }


async def get_resume_preparation_context(
    job_id: int,
    replaces_proposal_id: Optional[str] = None,
    affected_source_section_ids: Optional[list[int]] = None,
) -> dict[str, Any]:
    """Read-only context a real Career Director uses to author resume_preparation.

    Returns the full verified evidence rows (not summaries), the canonical
    baseline resume rows, the replaced proposal's rows/diff/review state for
    localized reprepare, and a source_fingerprint that
    ``persist_director_resume_proposal`` re-verifies to reject in-flight
    source changes.
    """
    clean_job_id = _clean_positive_int(job_id, "job_id")
    clean_replaces = _clean_text(replaces_proposal_id, "replaces_proposal_id", 80) or None
    affected = _clean_id_list(affected_source_section_ids, "affected_source_section_ids")
    if affected is not None and clean_replaces is None:
        raise ValueError("affected_source_section_ids 只能配合 replaces_proposal_id 使用")

    async with async_session() as db:
        base = await _load_director_base(
            db,
            job_id=clean_job_id,
            replaces_proposal_id=clean_replaces,
        )
        job = base["job"]
        jd_text = base["jd_text"]
        profile = base["profile"]
        sections = base["sections"]
        replaced = base["replaced"]

        known_ids = {section.id for section in sections}
        invalid_affected = [
            item for item in (affected or []) if item not in known_ids
        ]
        from app.services.job_projection import reorder_sections_by_job_relevance
        from app.services.resume_optimize_support import _build_resume_sections

        ranked = list(sections)
        reorder_sections_by_job_relevance(
            ranked,
            job_title=str(job.title or ""),
            jd_text=jd_text,
        )
        context_sections = [
            {
                "id": section.id,
                "section_type": section.section_type,
                "title": section.title or "",
                "content_json": _json_safe(section.content_json or {}),
                "updated_at": str(section.updated_at),
            }
            for section in ranked[:_MAX_PREPARATION_SECTIONS]
        ]
        existing_proposal = None
        if replaced is not None:
            replaced_trace = replaced.trace_json or {}
            existing_proposal = {
                "proposal_id": replaced.proposal_id,
                "status": replaced.status,
                "original_rows": _json_safe(replaced.original_rows_json or []),
                "proposed_rows": _json_safe(replaced.proposed_rows_json or []),
                "diff": _json_safe(replaced.diff_json or []),
                "item_reviews": _json_safe(replaced.item_reviews_json or {}),
                "workspace_resume_id": replaced.workspace_resume_id,
                "reprepare_sequence": int(replaced_trace.get("reprepare_sequence") or 0),
                "source_fingerprint": str(replaced_trace.get("source_fingerprint") or ""),
            }
        fingerprint = _director_source_fingerprint(
            job_id=job.id,
            jd_text=jd_text,
            profile_id=profile.id,
            sections=sections,
            replaces_proposal_id=clean_replaces,
            affected_source_section_ids=affected,
        )
        return {
            "schema": _DIRECTOR_CONTEXT_SCHEMA,
            "job": {
                "id": job.id,
                "title": job.title or "",
                "company": job.company or "",
                "location": job.location or "",
                "jd_text": jd_text,
                "jd_sha256": _sha256(jd_text),
            },
            "profile_id": profile.id,
            "verified_sections": context_sections,
            "sections_truncated": len(sections) > _MAX_PREPARATION_SECTIONS,
            "baseline_rows": _json_safe(_build_resume_sections(sections)),
            "replaces_proposal_id": clean_replaces,
            "affected_source_section_ids": affected or [],
            "invalid_affected_source_section_ids": invalid_affected,
            "existing_proposal": existing_proposal,
            "profile_snapshot_hash": _profile_snapshot_hash(sections),
            "source_fingerprint": fingerprint,
        }


def _director_proposal_id(task_id: str) -> str:
    """Deterministic id per real task: replays re-read, never duplicate."""
    return f"resume_opt_{hashlib.sha256(task_id.encode('utf-8')).hexdigest()[:20]}"


def _row_in_scope(row: dict[str, Any], affected_ids: set[int]) -> bool:
    ids = row.get("source_section_ids")
    if not isinstance(ids, list):
        return False
    return any(
        isinstance(item, int) and not isinstance(item, bool) and item in affected_ids
        for item in ids
    )


async def persist_director_resume_proposal(
    job_id: int,
    task_id: str,
    preparation: dict[str, Any],
    replaces_proposal_id: Optional[str] = None,
) -> dict[str, Any]:
    """Persist a real Career Director's resume_preparation as an L2-reviewable proposal.

    Fails closed when: the task is not a real running/completed automation
    career_director scoped to this job, the echoed source_fingerprint no
    longer matches the current JD+Profile snapshot, or any referenced
    source_section_ids / JD excerpt is invalid.  Rows whose content fails the
    fact gate are excluded without blocking the rows that are supported;
    Career Truth is never written here.
    """
    clean_job_id = _clean_positive_int(job_id, "job_id")
    clean_task_id = _clean_text(task_id, "task_id", 80)
    if not clean_task_id:
        raise ValueError("task_id 不能为空")
    clean_replaces = _clean_text(replaces_proposal_id, "replaces_proposal_id", 80) or None
    if not isinstance(preparation, dict):
        raise ValueError("preparation 必须是对象")

    async with async_session() as db:
        task = await db.get(CareerTask, clean_task_id)
        if task is None:
            raise ValueError(f"CareerTask {clean_task_id} 不存在")
        if task.task_type != "career_director" or task.source != "automation":
            raise ValueError("task_id 必须指向由 AutomationEvent 启动的 career_director 任务")
        if task.status not in _DIRECTOR_TASK_STATUSES:
            raise ValueError(
                f"CareerTask {clean_task_id} 状态为 {task.status}，不能生成简历提案"
            )
        task_input = task.input_json if isinstance(task.input_json, dict) else {}
        input_job_id = task_input.get("job_id")
        if (
            not isinstance(input_job_id, int)
            or isinstance(input_job_id, bool)
            or input_job_id != clean_job_id
        ):
            raise ValueError("CareerTask 输入未绑定当前岗位")
        input_replaces = _clean_text(
            task_input.get("replaces_proposal_id"), "replaces_proposal_id", 80
        ) or None
        if clean_replaces and clean_replaces != input_replaces:
            raise ValueError("replaces_proposal_id 与任务输入不一致")
        effective_replaces = input_replaces or clean_replaces
        affected = _clean_id_list(
            task_input.get("affected_source_section_ids"),
            "affected_source_section_ids",
        )
        if affected is not None and effective_replaces is None:
            raise ValueError("affected_source_section_ids 只能配合 replaces_proposal_id 使用")

        # Idempotent per real task: a replayed/duplicated call returns the
        # already persisted proposal instead of writing a second one.
        proposal_id = _director_proposal_id(clean_task_id)
        existing = (
            await db.execute(
                select(ResumeOptimizationProposal).where(
                    ResumeOptimizationProposal.proposal_id == proposal_id
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            existing_trace = existing.trace_json or {}
            if existing_trace.get("task_id") != clean_task_id:
                raise ValueError("提案 ID 冲突：已有提案并非来自该任务")
            job = (
                await db.execute(select(Job).where(Job.id == existing.job_id))
            ).scalar_one_or_none()
            return {**_proposal_detail(existing, job), "duplicate": True}

        base = await _load_director_base(
            db,
            job_id=clean_job_id,
            replaces_proposal_id=effective_replaces,
        )
        job = base["job"]
        jd_text = base["jd_text"]
        profile = base["profile"]
        sections = base["sections"]
        replaced = base["replaced"]

        input_profile_id = task_input.get("profile_id")
        if (
            input_profile_id is not None
            and isinstance(input_profile_id, int)
            and not isinstance(input_profile_id, bool)
            and input_profile_id != profile.id
        ):
            raise ValueError("CareerTask 输入的 profile_id 与当前已验证 Profile 不一致")

        fingerprint = _director_source_fingerprint(
            job_id=job.id,
            jd_text=jd_text,
            profile_id=profile.id,
            sections=sections,
            replaces_proposal_id=effective_replaces,
            affected_source_section_ids=affected,
        )
        echoed = _clean_text(
            preparation.get("source_fingerprint"), "preparation.source_fingerprint", 128
        )
        if not echoed or echoed != fingerprint:
            raise ValueError(
                "preparation.source_fingerprint 与当前岗位/档案快照不一致，"
                "请重新调用 get_resume_preparation_context 后再准备"
            )
        echoed_job = preparation.get("job_id")
        if echoed_job is not None and echoed_job != clean_job_id:
            raise ValueError("preparation.job_id 与任务岗位不一致")
        echoed_replaces = _clean_text(
            preparation.get("replaces_proposal_id"), "preparation.replaces_proposal_id", 80
        ) or None
        if echoed_replaces and echoed_replaces != effective_replaces:
            raise ValueError("preparation.replaces_proposal_id 与任务输入不一致")

        model_rows = _validated_resume_rows(preparation.get("rows"), "preparation.rows")
        for index, row in enumerate(model_rows):
            if len(_canonical_json(row["content_json"])) > _MAX_PREPARATION_CONTENT_CHARS:
                raise ValueError(f"preparation.rows[{index}].content_json 超出大小上限")
        section_by_id = {section.id: section for section in sections}
        known_ids = set(section_by_id)
        referenced = list(dict.fromkeys(
            source_id
            for row in model_rows
            for source_id in row["source_section_ids"]
        ))
        missing = [item for item in referenced if item not in known_ids]
        if missing:
            raise ValueError(
                "preparation.rows 引用了不存在的已验证档案: "
                + ", ".join(str(item) for item in missing)
            )

        rationale = _clean_director_rationale(
            preparation.get("rationale"), jd_text, known_ids
        )
        questions = _clean_director_questions(
            preparation.get("questions"), jd_text, known_ids
        )
        gaps = _clean_director_gaps(preparation.get("gaps"))

        # Per-row fact gate: unsupported model claims are excluded, but rows
        # backed by verified evidence survive instead of blocking everything.
        supported_rows: list[dict[str, Any]] = []
        excluded_rows: list[dict[str, Any]] = []
        carry_warnings: list[dict[str, Any]] = []
        for index, row in enumerate(model_rows):
            row_sources = [section_by_id[source_id] for source_id in row["source_section_ids"]]
            gate = validate_resume_fact_gates(
                [deepcopy(row)],
                row_sources,
                strict_structured_facts=True,
            )
            blocking = [
                warning
                for warning in gate["warnings"]
                if warning.get("issue") in _BLOCKING_GATE_ISSUES
            ]
            if blocking:
                excluded_rows.append({
                    "row_index": index,
                    "section_key": _row_key(row),
                    "title": row.get("title") or "",
                    "issues": blocking,
                })
                continue
            for item in row["content_json"]:
                if isinstance(item, dict):
                    item.pop("_gate_warnings", None)
            carry_warnings.extend(gate["warnings"])
            supported_rows.append(row)
        if not supported_rows:
            raise ValueError(
                "模型提案的所有段落均无法回溯到已验证档案事实，未保存提案"
            )

        affected_set = set(affected or [])
        out_of_scope_keys: list[str] = []
        if replaced is not None and affected is not None:
            # Localized reprepare: only rows citing affected evidence may
            # change; unrelated proposed rows and their reviews carry over.
            previous_rows = [
                row for row in (replaced.proposed_rows_json or [])
                if isinstance(row, dict)
            ]
            affected_keys = {
                _row_key(row) for row in previous_rows if _row_in_scope(row, affected_set)
            }
            kept_model_rows: list[dict[str, Any]] = []
            for row in supported_rows:
                if _row_in_scope(row, affected_set) or _row_key(row) in affected_keys:
                    kept_model_rows.append(row)
                else:
                    out_of_scope_keys.append(_row_key(row))
            merged = [
                row for row in previous_rows if not _row_in_scope(row, affected_set)
            ] + kept_model_rows
            proposed_rows = _validated_resume_rows(merged, "merged_rows")
            proposed_rows = sorted(proposed_rows, key=lambda row: row["sort_order"])
        else:
            proposed_rows = supported_rows

        selected = [
            section_by_id[source_id]
            for source_id in dict.fromkeys(
                source_id
                for row in proposed_rows
                for source_id in row["source_section_ids"]
            )
        ]
        fact_gates = validate_resume_fact_gates(
            deepcopy(proposed_rows),
            selected,
            strict_structured_facts=True,
        )
        from app.services.resume_optimize_support import (
            _build_resume_sections,
            _bullet_text,
            _missing_keywords,
        )

        # Baseline must be the user's current Profile order so the diff and
        # per-item review targets stay honest.
        original_rows = _build_resume_sections(sections)
        diff = _build_diff(original_rows, proposed_rows)

        carried_reviews: dict[str, Any] = {}
        if replaced is not None:
            new_change_ids = {item["change_id"] for item in diff}
            for key, value in (replaced.item_reviews_json or {}).items():
                base_key = key[:-13] if key.endswith(":pending_edit") else key
                if base_key in new_change_ids:
                    carried_reviews[key] = value

        if replaced is not None and isinstance(replaced.presentation_json, dict):
            presentation = _json_safe(replaced.presentation_json)
        else:
            presentation = {
                "contact_json": _json_safe(_profile_to_contact_json(profile)),
                "style_config": {},
                "template_id": None,
                "language": "zh",
                "content_policy": "verified_profile_only",
            }

        reprepare_sequence = (
            int((replaced.trace_json or {}).get("reprepare_sequence") or 0) + 1
            if replaced is not None
            else 0
        )
        evidence_refs = [
            f"profile_section:{source_id}"
            for source_id in sorted({s.id for s in selected})
        ]
        proposal = ResumeOptimizationProposal(
            proposal_id=proposal_id,
            job_id=job.id,
            profile_id=profile.id,
            research_run_id=None,
            reference_resume_id=(
                replaced.reference_resume_id if replaced is not None else None
            ),
            status=(
                "in_review"
                if carried_reviews
                else "blocked" if fact_gates["status"] == "blocked" else "ready"
            ),
            source_section_ids_json=[section.id for section in selected],
            source_snapshot_hash=_profile_snapshot_hash(selected),
            research_snapshot_hash=_sha256({"source_mode": DIRECTOR_SOURCE_MODE, "jd_sha256": _sha256(jd_text)}),
            original_summary="",
            proposed_summary="",
            original_rows_json=_json_safe(original_rows),
            proposed_rows_json=_json_safe(proposed_rows),
            diff_json=_json_safe(diff),
            strategy_json=_json_safe({
                "job_description_sha256": _sha256(jd_text),
                "source_mode": DIRECTOR_SOURCE_MODE,
                "task_id": clean_task_id,
                "schema": _DIRECTOR_PREPARATION_SCHEMA,
                "replaces_proposal_id": effective_replaces,
                "reprepare_sequence": reprepare_sequence,
                "affected_source_section_ids": sorted(affected_set),
                "selected_source_section_ids": [section.id for section in selected],
                "rationale": rationale,
                "questions": questions,
                "gaps": gaps,
                "excluded_rows": excluded_rows,
                "out_of_scope_row_keys": out_of_scope_keys,
                "missing_capabilities": _missing_keywords(
                    jd_text, [_bullet_text(section) for section in selected]
                ),
                "scoring_policy": "no_unvalidated_ats_score",
            }),
            presentation_json=presentation,
            fact_gates_json=_json_safe(fact_gates),
            trace_json=_json_safe({
                "source_mode": DIRECTOR_SOURCE_MODE,
                "task_id": clean_task_id,
                "replaces_proposal_id": effective_replaces,
                "reprepare_sequence": reprepare_sequence,
                "affected_source_section_ids": sorted(affected_set),
                "source_fingerprint": fingerprint,
                "jd_sha256": _sha256(jd_text),
                "profile_snapshot_hash": _profile_snapshot_hash(sections),
                "evidence_refs": evidence_refs,
                "selection_origin": "career_director_model",
                "rewrite_applied": bool(diff),
                "rewrite_status": "applied" if diff else "skipped",
                "pipeline": {
                    "career_director": {
                        "status": "completed",
                        "task_id": clean_task_id,
                        "rewrite_status": "applied" if diff else "skipped",
                    }
                },
                "questions": questions,
                "excluded_rows": excluded_rows,
                "out_of_scope_row_keys": out_of_scope_keys,
                "carried_review_change_ids": sorted(carried_reviews),
                "profile_verified_fact_count": len(sections),
                "selected_fact_count": len(selected),
            }),
            item_reviews_json=carried_reviews,
        )
        # Carry the workspace binding so per-item review continues against the
        # same editable resume; the hash is recomputed from current content so
        # manual edits made during generation stay protected by the stale check.
        if replaced is not None and replaced.workspace_resume_id:
            resume = (
                await db.execute(
                    select(Resume)
                    .where(Resume.id == replaced.workspace_resume_id)
                    .options(selectinload(Resume.sections))
                )
            ).scalar_one_or_none()
            if resume is not None:
                from app.services.resume_workspace import workspace_content_hash

                proposal.workspace_resume_id = resume.id
                proposal.workspace_snapshot_hash = workspace_content_hash(resume)

        db.add(proposal)
        supersede_statuses = ("ready", "blocked", "in_review")
        superseded = (
            await db.execute(
                select(ResumeOptimizationProposal).where(
                    ResumeOptimizationProposal.job_id == job.id,
                    ResumeOptimizationProposal.status.in_(supersede_statuses),
                    ResumeOptimizationProposal.proposal_id != proposal.proposal_id,
                )
            )
        ).scalars().all()
        for older in superseded:
            older.status = "stale"
            older.review_note = (
                f"已被新提案 {proposal.proposal_id} 取代，请审核最新提案"
            )
            older.reviewed_at = _now()
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            winner = (
                await db.execute(
                    select(ResumeOptimizationProposal).where(
                        ResumeOptimizationProposal.proposal_id == proposal_id
                    )
                )
            ).scalar_one_or_none()
            if winner is None:
                raise
            job_row = (
                await db.execute(select(Job).where(Job.id == winner.job_id))
            ).scalar_one_or_none()
            return {**_proposal_detail(winner, job_row), "duplicate": True}
        await db.refresh(proposal)
        return {**_proposal_detail(proposal, job), "duplicate": False}


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
        # The editable workspace is part of the proposal's freshness envelope:
        # if the user changed the bound resume after the proposal last synced,
        # accepting whole would silently overwrite those edits.
        if proposal.workspace_resume_id and proposal.workspace_snapshot_hash:
            workspace_resume = (
                await db.execute(
                    select(Resume)
                    .where(Resume.id == proposal.workspace_resume_id)
                    .options(selectinload(Resume.sections))
                )
            ).scalar_one_or_none()
            if workspace_resume is None:
                return await _mark_stale(
                    db,
                    proposal=proposal,
                    job=job,
                    reason="提案绑定的简历工作区已删除，请重新生成",
                )
            from app.services.resume_workspace import workspace_content_hash

            if workspace_content_hash(workspace_resume) != proposal.workspace_snapshot_hash:
                return await _mark_stale(
                    db,
                    proposal=proposal,
                    job=job,
                    reason="提案绑定的工作区已被手动修改，请重新生成或逐条审核",
                )

        if proposal.research_run_id:
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
        # career_director proposals carry no research run; JD + verified
        # Profile freshness above is their complete staleness envelope.
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
        trace = proposal.trace_json or {}
        is_director = trace.get("source_mode") == DIRECTOR_SOURCE_MODE
        source_snapshot = _build_source_profile_snapshot(profile, sections)
        source_snapshot.update({
            "source_snapshot_hash": proposal.source_snapshot_hash,
            "research_run_id": proposal.research_run_id,
            "research_snapshot_hash": proposal.research_snapshot_hash,
            "resume_optimization_proposal_id": proposal.proposal_id,
            "source_mode": trace.get("source_mode") or "skill_pipeline",
            "task_id": trace.get("task_id") or "",
        })
        resume = await stage_generated_resume(
            db=db,
            profile=profile,
            title=f"{job.company} - {job.title} 定制简历",
            summary=proposal.proposed_summary or "",
            source_mode=DIRECTOR_SOURCE_MODE if is_director else "per_job_reviewed",
            source_job_ids=[job.id],
            contact_json=presentation.get("contact_json") or {},
            style_config=presentation.get("style_config") or {},
            template_id=presentation.get("template_id"),
            source_profile_snapshot=source_snapshot,
            rows=proposed_rows,
            language=str(presentation.get("language") or "zh"),
            source_resume_id=proposal.reference_resume_id,
            target_job_id=job.id,
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
        if is_director:
            snapshot["provenance"]["task_id"] = trace.get("task_id") or ""
            snapshot["provenance"]["source_fingerprint"] = trace.get("source_fingerprint") or ""
            snapshot["provenance"]["source_mode"] = DIRECTOR_SOURCE_MODE
        source_ids_by_type = {
            _row_key(row): row.get("source_section_ids") or []
            for row in proposed_rows
            if isinstance(row, dict)
        }
        for item in snapshot.get("sections") or []:
            key = f"{item.get('section_type') or ''}:{item.get('title') or ''}"
            item["source_section_ids"] = source_ids_by_type.get(key, [])
        version.content_snapshot = snapshot
        resume.current_version_id = version.id

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
