from __future__ import annotations

import copy
from typing import Any

from sqlalchemy import select

from app.models.models import (
    ApplicationAttempt,
    Interview,
    Job,
    JobResearchRun,
    ResearchEvidenceSnapshot,
    ResearchFinding,
    Resume,
    ResumeOptimizationProposal,
    ResumeVersion,
    RoleBenchmarkDocument,
    RoleBenchmarkRun,
)
from app.services.career_artifacts import career_artifact_store
from app.services.job_research import (
    RESEARCH_RESULT_SCHEMA,
    _run_summary as _research_run_summary,
    _validated_research_result,
)
from app.services.role_intelligence import (
    ROLE_INTERVIEW_FOCUS_PLAN_SCHEMA,
    _run_summary,
    verify_benchmark_artifact,
)
from app.services.resume_versions import snapshot_resume


async def _benchmark_documents(
    db,
    run: RoleBenchmarkRun | None,
) -> list[RoleBenchmarkDocument]:
    if run is None:
        return []
    return list(
        (
            await db.execute(
                select(RoleBenchmarkDocument)
                .where(RoleBenchmarkDocument.run_id == run.run_id)
                .order_by(RoleBenchmarkDocument.id.asc())
            )
        ).scalars().all()
    )


def _valid_benchmark(
    run: RoleBenchmarkRun | None,
    *,
    job: Job | None,
    documents: list[RoleBenchmarkDocument],
) -> tuple[bool, dict[str, Any] | None]:
    if run is None:
        return False, None
    summary = _run_summary(run)
    verification = verify_benchmark_artifact(
        run,
        job=job,
        documents=documents,
    )
    summary["artifact_verification"] = verification
    summary["target_snapshot_matches"] = verification["target_snapshot"]["verified"]
    return verification["ready"], summary


def _research_data_mode(run: JobResearchRun) -> str:
    runtime_id = str(run.runtime_id or "").strip().casefold()
    summary = _research_run_summary(run)
    if "fixture" in runtime_id:
        return "fixture_plugin" if runtime_id.startswith("plugin:") else "fixture"
    return str(summary.get("data_mode") or "unknown")


def _research_artifacts_match(
    run: JobResearchRun,
    evidence_rows: list[ResearchEvidenceSnapshot],
    finding_rows: list[ResearchFinding],
) -> bool:
    result = run.result_json if isinstance(run.result_json, dict) else {}
    findings = result.get("findings")
    if not isinstance(findings, list) or any(not isinstance(item, dict) for item in findings):
        return False

    # Re-run the producer's canonical fact gate over its persisted shape. In
    # particular, unknown findings must remain unreferenced; normalization
    # clears refs on those findings, so a persisted mismatch is unverified.
    canonical_input = {
        "sources": result.get("sources"),
        "findings": [
            {
                key: finding.get(key)
                for key in (
                    "dossier_scope",
                    "finding_type",
                    "statement",
                    "details",
                    "source_refs",
                )
            }
            for finding in findings
        ],
        "gaps": result.get("gaps"),
    }
    try:
        canonical_result = _validated_research_result(canonical_input)
    except (TypeError, ValueError):
        return False
    if canonical_result != result:
        return False

    sources = canonical_result["sources"]
    evidence_by_ref = {row.source_ref: row for row in evidence_rows}
    source_by_ref = {source["source_ref"]: source for source in sources}
    if (
        len(evidence_by_ref) != len(evidence_rows)
        or set(evidence_by_ref) != set(source_by_ref)
        or any(not row.content_hash for row in evidence_rows)
        or any(
            row.url != source_by_ref[ref]["url"]
            or row.title != source_by_ref[ref]["title"]
            or row.publisher != source_by_ref[ref]["publisher"]
            or row.source_class != source_by_ref[ref]["source_class"]
            or row.excerpt != source_by_ref[ref]["excerpt"]
            for ref, row in evidence_by_ref.items()
        )
        or len(canonical_result["findings"]) != len(finding_rows)
    ):
        return False

    # Unknowns remain visible gaps, but only sourced findings can support a
    # research artifact used as Career Truth.
    if not any(item["finding_type"] != "unknown" for item in canonical_result["findings"]):
        return False

    stored_findings = list(finding_rows)
    for finding in canonical_result["findings"]:
        refs = finding.get("source_refs")
        unknown = finding["finding_type"] == "unknown"
        if (
            not isinstance(refs, list)
            or (unknown and refs)
            or (not unknown and not refs)
            or any(ref not in evidence_by_ref for ref in refs)
        ):
            return False
        match_index = next(
            (
                index
                for index, row in enumerate(stored_findings)
                if row.finding_type == finding.get("finding_type")
                and row.statement == finding.get("statement")
                and list(row.source_refs_json or []) == refs
                and row.evidence_level == finding.get("evidence_level")
                and (row.details_json or {}) == finding.get("details")
            ),
            None,
        )
        if match_index is None:
            return False
        stored_findings.pop(match_index)
    return not stored_findings


def _research_ready(
    run: JobResearchRun,
    evidence_rows: list[ResearchEvidenceSnapshot],
    finding_rows: list[ResearchFinding],
) -> bool:
    summary = _research_run_summary(run)
    result = run.result_json if isinstance(run.result_json, dict) else {}
    trace = run.trace_json if isinstance(run.trace_json, dict) else {}
    runtime_id = str(summary.get("runtime_id") or "").strip()
    runtime_version = str(summary.get("runtime_version") or "").strip()
    data_mode = _research_data_mode(run)
    return bool(
        summary.get("status") == "completed"
        and summary.get("review_status") == "accepted"
        and result.get("schema") == RESEARCH_RESULT_SCHEMA
        and trace.get("result_schema") == RESEARCH_RESULT_SCHEMA
        and trace.get("runtime_id") == runtime_id
        and trace.get("runtime_version") == runtime_version
        and runtime_id
        and runtime_version
        and data_mode == "live"
        and summary.get("source_count") == len(evidence_rows) > 0
        and summary.get("finding_count") == len(finding_rows) > 0
        and _research_artifacts_match(run, evidence_rows, finding_rows)
    )


def _snapshot_core(snapshot: Any) -> dict[str, Any]:
    if not isinstance(snapshot, dict):
        return {}
    core = copy.deepcopy(snapshot)
    core.pop("provenance", None)
    return core


def _snapshot_without_presentation(snapshot: Any) -> dict[str, Any]:
    core = _snapshot_core(snapshot)
    resume = core.get("resume")
    if isinstance(resume, dict):
        for field in ("photo_url", "style_config", "template_id"):
            resume.pop(field, None)
        contact = resume.get("contact_json")
        if isinstance(contact, dict):
            for field in ("schoolLogoUrl", "universityLogoUrl", "logoUrl", "school_logo_url"):
                contact.pop(field, None)
    return core


def _has_content(resume: Resume) -> bool:
    def has_text(value: Any) -> bool:
        if isinstance(value, str):
            return bool(value.strip())
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return True
        if isinstance(value, dict):
            return any(has_text(item) for item in value.values())
        if isinstance(value, list):
            return any(has_text(item) for item in value)
        return False

    return bool((resume.summary or "").strip()) or any(
        section.visible and has_text(section.content_json or [])
        for section in resume.sections
    )


async def project_packet_state(
    db,
    *,
    job: Job | None,
    resume: Resume,
    proposals: list[ResumeOptimizationProposal],
    versions: list[ResumeVersion],
    attempts: list[ApplicationAttempt],
    legacy_application_id: int | None,
) -> dict[str, Any]:
    """Project saved packet resources without inferring one artifact from another."""
    current_version = next(
        (
            item
            for item in versions
            if resume.current_version_id is not None
            and item.id == resume.current_version_id
            and item.resume_id == resume.id
        ),
        None,
    )
    adopted_proposals: list[ResumeOptimizationProposal] = []
    pending_proposal_id = None
    if job is not None:
        adopted_proposals = list((
            await db.execute(
                select(ResumeOptimizationProposal)
                .where(ResumeOptimizationProposal.job_id == job.id)
                .where(ResumeOptimizationProposal.status == "accepted")
                .where(ResumeOptimizationProposal.accepted_resume_id == resume.id)
                .order_by(ResumeOptimizationProposal.reviewed_at.desc())
            )
        ).scalars().all())
        pending_proposal_id = (
            await db.execute(
                select(ResumeOptimizationProposal.proposal_id)
                .where(ResumeOptimizationProposal.job_id == job.id)
                .where(ResumeOptimizationProposal.workspace_resume_id == resume.id)
                .where(ResumeOptimizationProposal.status.in_(("ready", "blocked", "in_review")))
                .limit(1)
            )
        ).scalar_one_or_none()
    adopted_proposal = next(
        (
            item
            for item in adopted_proposals
            if current_version is not None
            and item.accepted_resume_version_id == current_version.id
        ),
        None,
    )
    snapshot_matches = bool(
        current_version
        and _snapshot_core(current_version.content_snapshot)
        == _snapshot_core(snapshot_resume(resume))
    )
    adopted_source_version = next(
        (
            version
            for proposal in adopted_proposals
            for version in versions
            if proposal.accepted_resume_version_id == version.id
            and version.resume_id == resume.id
        ),
        None,
    )
    inherited_layout = bool(
        snapshot_matches
        and current_version
        and current_version.created_by == "resume_design"
        and adopted_source_version
        and _snapshot_without_presentation(current_version.content_snapshot)
        == _snapshot_without_presentation(adopted_source_version.content_snapshot)
    )
    user_saved = bool(
        snapshot_matches
        and current_version
        and current_version.created_by in {"user", "manual"}
        and pending_proposal_id is None
    )
    adopted = bool(snapshot_matches and (adopted_proposal is not None or inherited_layout))
    resume_ready = bool(
        snapshot_matches and _has_content(resume) and (adopted or user_saved)
    )
    if adopted:
        adoption_status = "adopted"
        adoption_source = "accepted_proposal" if adopted_proposal else "inherited_layout"
        adoption_source_version_id = (
            adopted_proposal.accepted_resume_version_id
            if adopted_proposal
            else adopted_source_version.id if adopted_source_version else None
        )
    elif user_saved:
        adoption_status = "user_saved"
        adoption_source = "user_authored_version"
        adoption_source_version_id = current_version.id if current_version else None
    elif pending_proposal_id or (current_version and current_version.created_by == "system"):
        adoption_status = "not_adopted"
        adoption_source = None
        adoption_source_version_id = None
    else:
        adoption_status = "unknown"
        adoption_source = None
        adoption_source_version_id = None

    job_id = job.id if job is not None else None
    research_run = None
    referenced_research_run_id = None
    if job_id is not None:
        resume_proposals = [
            item
            for item in proposals
            if item.job_id == job_id
            and (
                item.workspace_resume_id == resume.id
                or item.accepted_resume_id == resume.id
            )
        ]
        referenced_research_run_id = next(
            (item.research_run_id for item in resume_proposals if item.research_run_id),
            None,
        )
        research_query = select(JobResearchRun).where(JobResearchRun.job_id == job_id)
        if referenced_research_run_id:
            research_query = research_query.where(
                JobResearchRun.run_id == referenced_research_run_id
            )
        else:
            research_query = research_query.order_by(
                JobResearchRun.updated_at.desc(), JobResearchRun.created_at.desc()
            )
        research_run = (await db.execute(research_query.limit(1))).scalars().first()

    research_ready = False
    research_summary: dict[str, Any] | None = None
    research_result: dict[str, Any] = {}
    research_data_mode: str | None = None
    if research_run is not None:
        evidence_rows = list((
            await db.execute(
                select(ResearchEvidenceSnapshot)
                .where(ResearchEvidenceSnapshot.run_id == research_run.run_id)
            )
        ).scalars().all())
        finding_rows = list((
            await db.execute(
                select(ResearchFinding)
                .where(ResearchFinding.run_id == research_run.run_id)
            )
        ).scalars().all())
        research_summary = _research_run_summary(research_run)
        research_result = (
            research_run.result_json
            if isinstance(research_run.result_json, dict)
            else {}
        )
        research_data_mode = _research_data_mode(research_run)
        research_ready = _research_ready(research_run, evidence_rows, finding_rows)

    benchmark_attempt = None
    benchmark_run = None
    benchmark_summary = None
    benchmark_ready = False
    benchmark_target_document = None
    benchmark_documents: list[RoleBenchmarkDocument] = []
    benchmark_target_snapshot_matches = False
    if job_id is not None:
        benchmark_attempt = (
            await db.execute(
                select(RoleBenchmarkRun)
                .where(RoleBenchmarkRun.target_job_id == job_id)
                .order_by(RoleBenchmarkRun.created_at.desc(), RoleBenchmarkRun.run_id.desc())
                .limit(1)
            )
        ).scalars().first()
        benchmark_run = benchmark_attempt
        if benchmark_attempt is not None and benchmark_attempt.status != "completed":
            completed = (
                await db.execute(
                    select(RoleBenchmarkRun)
                    .where(RoleBenchmarkRun.target_job_id == job_id)
                    .where(RoleBenchmarkRun.status == "completed")
                    .order_by(
                        RoleBenchmarkRun.created_at.desc(),
                        RoleBenchmarkRun.run_id.desc(),
                    )
                    .limit(1)
                )
            ).scalars().first()
            if completed is not None:
                benchmark_run = completed
        benchmark_documents = await _benchmark_documents(db, benchmark_run)
        target_documents = [
            item for item in benchmark_documents if item.document_kind == "target"
        ]
        benchmark_target_document = (
            target_documents[0] if len(target_documents) == 1 else None
        )
        benchmark_ready, benchmark_summary = _valid_benchmark(
            benchmark_run,
            job=job,
            documents=benchmark_documents,
        )
        benchmark_verification = (
            benchmark_summary.get("artifact_verification")
            if benchmark_summary
            else None
        )
        benchmark_target_snapshot_matches = bool(
            benchmark_verification
            and benchmark_verification.get("target_snapshot", {}).get("verified")
        )
    else:
        benchmark_verification = None

    focus_interview = None
    focus_benchmark = None
    focus_plan: dict[str, Any] = {}
    if job_id is not None:
        focus_interview = (
            await db.execute(
                select(Interview)
                .where(Interview.target_job_id == job_id)
                .where(Interview.resume_id == resume.id)
                .where(Interview.focus_plan_json.is_not(None))
                .order_by(Interview.created_at.desc())
                .limit(1)
            )
        ).scalars().first()
        if focus_interview is not None:
            focus_plan = (
                focus_interview.focus_plan_json
                if isinstance(focus_interview.focus_plan_json, dict)
                else {}
            )
            focus_benchmark_id = str(focus_plan.get("benchmark_run_id") or "")
            if focus_benchmark_id:
                focus_benchmark = (
                    await db.execute(
                        select(RoleBenchmarkRun).where(
                            RoleBenchmarkRun.run_id == focus_benchmark_id,
                            RoleBenchmarkRun.target_job_id == job_id,
                        )
                    )
                ).scalars().first()
    focus_benchmark_documents = await _benchmark_documents(db, focus_benchmark)
    focus_benchmark_ready, _ = _valid_benchmark(
        focus_benchmark,
        job=job,
        documents=focus_benchmark_documents,
    )
    focus_ready = bool(
        focus_interview
        and focus_interview.status in {"active", "completed", "archived"}
        and focus_plan.get("schema") == ROLE_INTERVIEW_FOCUS_PLAN_SCHEMA
        and focus_plan.get("target_job_id") == job_id
        and focus_plan.get("benchmark_run_id")
        and isinstance(focus_plan.get("focuses"), list)
        and focus_plan["focuses"]
        and focus_benchmark_ready
    )

    documents: list[dict[str, Any]] = []
    if job_id is not None:
        stored = career_artifact_store.list(related_job_id=job_id, limit=100)
        for item in stored.get("items") or []:
            metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
            raw_resume_id = metadata.get("resume_id")
            if isinstance(raw_resume_id, bool):
                continue
            try:
                artifact_resume_id = int(raw_resume_id)
            except (TypeError, ValueError):
                continue
            if artifact_resume_id <= 0 or artifact_resume_id != resume.id:
                continue
            raw_version_id = metadata.get("resume_version_id")
            if isinstance(raw_version_id, bool):
                artifact_version_id = None
            else:
                try:
                    artifact_version_id = int(raw_version_id) if raw_version_id is not None else None
                except (TypeError, ValueError):
                    artifact_version_id = None
            if artifact_version_id is not None and artifact_version_id <= 0:
                artifact_version_id = None
            artifact_version = next(
                (
                    version
                    for version in versions
                    if artifact_version_id is not None
                    and version.id == artifact_version_id
                    and version.resume_id == resume.id
                ),
                None,
            )
            documents.append(
                {
                    "id": item.get("id"),
                    "artifact_type": item.get("artifact_type"),
                    "created_at": item.get("created_at"),
                    "resume_id": artifact_resume_id,
                    "resume_version_id": artifact_version_id,
                    "version_matches_resume": (
                        artifact_version is not None if artifact_version_id is not None else None
                    ),
                    "matches_current_version": bool(
                        artifact_version
                        and current_version
                        and artifact_version.id == current_version.id
                    ),
                }
            )

    resume_attempts = [item for item in attempts if item.resume_id == resume.id]
    latest_attempt = resume_attempts[0] if resume_attempts else None
    submitted_attempt = next(
        (
            item
            for item in resume_attempts
            if item.status in {"submitted", "applied"}
        ),
        None,
    )
    submitted_version_id = (
        int(submitted_attempt.resume_version_id)
        if submitted_attempt and submitted_attempt.resume_version_id is not None
        else None
    )
    submitted_version = next(
        (
            item
            for item in versions
            if submitted_version_id is not None
            and item.id == submitted_version_id
            and item.resume_id == resume.id
        ),
        None,
    )
    displayed_submission_attempt = submitted_attempt or latest_attempt
    displayed_submission_version_id = (
        int(displayed_submission_attempt.resume_version_id)
        if displayed_submission_attempt
        and displayed_submission_attempt.resume_version_id is not None
        else None
    )
    displayed_submission_version = next(
        (
            item
            for item in versions
            if displayed_submission_version_id is not None
            and item.id == displayed_submission_version_id
            and item.resume_id == resume.id
        ),
        None,
    )
    return {
        "status": "ready" if resume_ready else "draft",
        "status_scope": "resume_for_send",
        "job_id": job_id if job_id is not None else resume.target_job_id,
        "resume_id": resume.id,
        "current_version_id": current_version.id if current_version else None,
        "current_version_number": current_version.version_number if current_version else None,
        "application_id": resume.application_id or legacy_application_id,
        "application_attempt_id": latest_attempt.id if latest_attempt else None,
        "artifacts": {
            "resume": True,
            "research": research_run is not None,
            "benchmark": benchmark_run is not None,
            "interview_focus": focus_interview is not None,
        },
        "artifact_state": {
            "resume": {
                "exists": True,
                "ready": resume_ready,
                "adopted": adopted,
                "adoption_status": adoption_status,
                "adoption_source": adoption_source,
                "adoption_source_version_id": adoption_source_version_id,
                "current_version_matches_resume": snapshot_matches,
                "current_version_id": current_version.id if current_version else None,
                "current_version_number": (
                    current_version.version_number if current_version else None
                ),
            },
            "research": {
                "exists": research_run is not None,
                "ready": research_ready,
                "verification_status": (
                    "verified" if research_ready else "unverified" if research_run else "unavailable"
                ),
                "linked_to_resume": bool(
                    research_run
                    and referenced_research_run_id
                    and research_run.run_id == referenced_research_run_id
                ),
                "adopted": bool(
                    research_run and research_run.review_status == "accepted"
                ),
                "proposal_run_id": referenced_research_run_id,
                "run_id": research_run.run_id if research_run else None,
                "status": research_run.status if research_run else "unavailable",
                "review_status": research_run.review_status if research_run else None,
                "schema_version": research_result.get("schema") or None,
                "runtime_id": research_summary.get("runtime_id") if research_summary else None,
                "runtime_version": research_summary.get("runtime_version") if research_summary else None,
                "data_mode": research_data_mode,
                "target_job_id": research_run.job_id if research_run else None,
                "target_job_matches": bool(research_run and research_run.job_id == job_id),
            },
            "benchmark": {
                "exists": benchmark_attempt is not None,
                "ready": benchmark_ready,
                "verification_status": (
                    benchmark_verification.get("status")
                    if benchmark_verification
                    else "unavailable"
                ),
                "artifact_verification": benchmark_verification,
                "run_id": benchmark_run.run_id if benchmark_run else None,
                "status": benchmark_run.status if benchmark_run else "not_built",
                "latest_attempt_run_id": (
                    benchmark_attempt.run_id
                    if benchmark_attempt and benchmark_attempt.run_id != (benchmark_run.run_id if benchmark_run else None)
                    else None
                ),
                "latest_attempt_status": (
                    benchmark_attempt.status if benchmark_attempt else None
                ),
                "schema_version": benchmark_run.schema_version if benchmark_run else None,
                "result_schema": (
                    (benchmark_run.result_json or {}).get("schema")
                    if benchmark_run and isinstance(benchmark_run.result_json, dict)
                    else None
                ),
                "algorithm_version": benchmark_run.algorithm_version if benchmark_run else None,
                "taxonomy_version": (
                    (benchmark_run.result_json or {}).get("taxonomy_version")
                    if benchmark_run and isinstance(benchmark_run.result_json, dict)
                    else None
                ),
                "runtime_id": benchmark_summary.get("runtime_id") if benchmark_summary else None,
                "runtime_version": benchmark_summary.get("runtime_version") if benchmark_summary else None,
                "data_mode": benchmark_summary.get("data_mode") if benchmark_summary else None,
                "target_snapshot": {
                    "exists": (
                        benchmark_verification.get("target_snapshot", {}).get("exists", False)
                        if benchmark_verification
                        else False
                    ),
                    "verified": benchmark_target_snapshot_matches,
                    "job_id": benchmark_target_document.job_id if benchmark_target_document else None,
                    "source_ref": benchmark_target_document.source_ref if benchmark_target_document else None,
                    "description_hash": (
                        benchmark_target_document.description_hash
                        if benchmark_target_document
                        else None
                    ),
                },
                "valid_sample_count": (
                    benchmark_summary.get("valid_sample_count")
                    if benchmark_summary
                    else None
                ),
                "minimum_sample_count": (
                    benchmark_summary.get("minimum_sample_count")
                    if benchmark_summary
                    else None
                ),
            },
            "interview_focus": {
                "exists": focus_interview is not None,
                "ready": focus_ready,
                "interview_id": focus_interview.id if focus_interview else None,
                "resume_id": focus_interview.resume_id if focus_interview else None,
                "status": focus_interview.status if focus_interview else "not_built",
                "focus_schema": focus_plan.get("schema") or None,
                "benchmark_run_id": focus_plan.get("benchmark_run_id") or None,
            },
            "documents": {
                "exists": bool(documents),
                "count": len(documents),
                "items": documents,
            },
        },
        "external_submission": {
            "scope": "recorded_only",
            "receipt_verified": False,
            "recorded": latest_attempt is not None,
            "completed": submitted_version is not None,
            "attempt_id": displayed_submission_attempt.id if displayed_submission_attempt else None,
            "job_id": displayed_submission_attempt.job_id if displayed_submission_attempt else None,
            "resume_id": displayed_submission_attempt.resume_id if displayed_submission_attempt else None,
            "status": displayed_submission_attempt.status if displayed_submission_attempt else None,
            "resume_version_id": displayed_submission_version_id,
            "matches_current_version": bool(
                displayed_submission_version
                and current_version
                and displayed_submission_version.id == current_version.id
            ),
            "latest_attempt": (
                {
                    "attempt_id": latest_attempt.id,
                    "job_id": latest_attempt.job_id,
                    "resume_id": latest_attempt.resume_id,
                    "status": latest_attempt.status,
                    "resume_version_id": latest_attempt.resume_version_id,
                    "matches_current_version": bool(
                        latest_attempt.resume_version_id is not None
                        and current_version
                        and latest_attempt.resume_version_id == current_version.id
                    ),
                }
                if latest_attempt
                else None
            ),
        },
    }
