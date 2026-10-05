"""Read-only proof for the existing ``ensure_resume_workspace`` operation.

The adapter verifies a Registry result against the canonical database rows and
the current task's committed ORM witness. It never creates or edits business
records and does not imply that any proposal content was accepted.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import select

from app.models.models import Job, Profile, Resume, ResumeOptimizationProposal, ResumeSection, ResumeVersion
from app.services import proposal_plan_sources as sources
from app.services import resume_workspace as workspace
from app.services.resume_versions import snapshot_resume
from app.services.proposal_plan_builder import PlanValidationError, canonical_digest

_OPERATION = "ensure_resume_workspace"
_ADAPTER = "proposal-plan.ensure-resume-workspace.v1"


def _source_evidence(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    nested = value.get("source_evidence")
    return nested if isinstance(nested, dict) else value


def _safe_source_evidence(evidence: dict[str, Any], *, verified: bool) -> dict[str, Any]:
    def summarize(items: Any, *, bound: bool) -> list[dict[str, Any]]:
        if not isinstance(items, list):
            return []
        result: list[dict[str, Any]] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            after = item.get("after") if isinstance(item.get("after"), dict) else {}
            row_id = after.get("id")
            result.append(
                {
                    **(
                        {"source": item.get("source"), "collection": item.get("collection")}
                        if bound
                        else {"model": item.get("model")}
                    ),
                    "action": item.get("action"),
                    "row_id": row_id,
                    "after_digest": canonical_digest(after) if after else "",
                }
            )
        return result

    return {
        "before_versions": dict(evidence.get("before_versions") or {}),
        "after_versions": dict(evidence.get("after_versions") or {}),
        "effects": summarize(evidence.get("effects"), bound=True),
        "unbound_effects": summarize(evidence.get("unbound_effects"), bound=False),
        "bulk_dml": bool(evidence.get("bulk_dml")),
        "verified": verified,
        "complete": verified,
        "adapter": _ADAPTER,
    }


def _section_projection(value: dict[str, Any]) -> dict[str, Any]:
    return {
        "section_type": value.get("section_type"),
        "sort_order": int(value.get("sort_order") or 0),
        "title": str(value.get("title") or ""),
        "visible": bool(value.get("visible", True)),
        "content_json": value.get("content_json") or [],
        "source_section_ids": value.get("source_section_ids") or [],
    }


def _sorted_sections(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    projected = [_section_projection(row) for row in rows]
    return [item for _, item in sorted(enumerate(projected), key=lambda pair: (pair[1]["sort_order"], pair[0]))]


def _row_matches(actual: dict[str, Any], observed: Any, *, first_resume_insert: bool = False) -> bool:
    if not isinstance(observed, dict):
        return False
    expected = dict(actual)
    if first_resume_insert and observed.get("current_version_id") is None:
        expected["current_version_id"] = None
    return observed == expected


def _verify_unbound_effects(
    evidence: dict[str, Any],
    *,
    resume_row: dict[str, Any],
    section_rows: dict[int, dict[str, Any]],
    version_row: dict[str, Any],
    mode: str,
    before_workspace_id: int | None,
) -> bool:
    effects = evidence.get("unbound_effects")
    if not isinstance(effects, list) or evidence.get("bulk_dml") is True:
        return False
    resume_adds = 0
    resume_updates = 0
    section_ids: list[int] = []
    version_count = 0

    for item in effects:
        if not isinstance(item, dict):
            return False
        model = item.get("model")
        action = item.get("action")
        after = item.get("after")
        if not isinstance(after, dict):
            return False
        if model == "Resume":
            if after.get("id") != resume_row.get("id") or action not in {"add", "update"}:
                return False
            if not _row_matches(resume_row, after, first_resume_insert=action == "add"):
                return False
            resume_adds += action == "add"
            resume_updates += action == "update"
        elif model == "ResumeSection":
            if action != "add" or not isinstance(after, dict):
                return False
            identity = after.get("id")
            if (
                isinstance(identity, bool)
                or not isinstance(identity, int)
                or identity not in section_rows
                or after.get("resume_id") != resume_row.get("id")
                or after != section_rows[identity]
            ):
                return False
            section_ids.append(identity)
        elif model == "ResumeVersion":
            if (
                action != "add"
                or not isinstance(after, dict)
                or after.get("id") != version_row.get("id")
                or after.get("resume_id") != resume_row.get("id")
                or after != version_row
            ):
                return False
            version_count += 1
        else:
            return False

    if mode == "created":
        return (
            before_workspace_id is None
            and resume_adds == 1
            and resume_updates == 1
            and len(section_ids) == len(set(section_ids))
            and set(section_ids) == set(section_rows)
            and version_count == 1
        )

    # Reuse is allowed only when this attempt did not write unsealed workspace
    # rows. A concurrent creator may have won after review; its canonical rows
    # still need to match every reviewed association and section below.
    return not effects and (before_workspace_id is None or resume_row.get("id") == before_workspace_id)


def _verify_bound_effects(
    evidence: dict[str, Any],
    *,
    proposal_id: str | None,
    proposal_row: dict[str, Any] | None,
    resume_row: dict[str, Any],
) -> bool:
    effects = evidence.get("effects")
    if not isinstance(effects, list):
        return False
    seen_proposal_update = False
    for item in effects:
        if not isinstance(item, dict):
            return False
        resume_ref = f"resume:{resume_row['id']}"
        if item.get("source") == resume_ref and item.get("collection") is None and item.get("action") == "update" and item.get("after") == resume_row:
            if evidence["before_versions"].get(resume_ref) != evidence["after_versions"].get(resume_ref):
                return False
            continue
        # The only expected source-bound write is ensure_resume_workspace's
        # proposal -> workspace reference. It never accepts proposal content.
        if (
            not proposal_id
            or proposal_row is None
            or item.get("source") != f"proposal:{proposal_id}"
            or item.get("collection") is not None
            or item.get("action") != "update"
            or item.get("after") != proposal_row
            or seen_proposal_update
        ):
            return False
        seen_proposal_update = True
    return True


def _failure(reason: str, evidence: dict[str, Any] | None = None) -> dict[str, Any]:
    safe = _safe_source_evidence(evidence, verified=False) if evidence is not None else {
        "before_versions": {},
        "after_versions": {},
        "effects": [],
        "unbound_effects": [],
        "bulk_dml": False,
        "verified": False,
        "complete": False,
        "adapter": _ADAPTER,
    }
    return {"verified": False, "effect_state": "unknown", "reason": reason, "source_evidence": safe}


async def verify_workspace_effect(
    node: dict[str, Any],
    result: dict[str, Any],
    source_evidence: dict[str, Any],
    *,
    expected_versions: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Prove only that the reviewed Job has a canonical Resume Workspace.

    ``expected_versions`` is the current, verified group-prefix overlay from
    the executor. When omitted, the node's sealed source hashes apply. The
    overlay may advance hash values but cannot change the reviewed source set.
    """
    evidence = _source_evidence(source_evidence)
    if not isinstance(node, dict) or node.get("operation") != _OPERATION or evidence is None:
        return _failure("Workspace node or source witness is missing", evidence)
    if (
        not isinstance(result, dict)
        or result.get("ok") is not True
        or result.get("operation") != _OPERATION
        or result.get("operation_version") != node.get("operation_version")
    ):
        return _failure("Registry did not report the reviewed workspace operation", evidence)
    if evidence.get("verified") is not True or evidence.get("bulk_dml") is True:
        return _failure("The Registry source observer did not verify the workspace transaction", evidence)

    args = node.get("args") if isinstance(node.get("args"), dict) else {}
    display = node.get("display") if isinstance(node.get("display"), dict) else {}
    before = display.get("before") if isinstance(display.get("before"), dict) else {}
    after = display.get("after") if isinstance(display.get("after"), dict) else {}
    try:
        job_id = int(args["job_id"])
        profile_id = int(before["profile_id"])
        reference_resume_id = before.get("reference_resume_id")
        existing_workspace_id = before.get("workspace_resume_id")
        if reference_resume_id is not None:
            reference_resume_id = int(reference_resume_id)
        if existing_workspace_id is not None:
            existing_workspace_id = int(existing_workspace_id)
    except (KeyError, TypeError, ValueError):
        return _failure("Reviewed workspace source associations are incomplete", evidence)

    sealed_versions = node.get("source_versions")
    before_versions = evidence.get("before_versions")
    after_versions = evidence.get("after_versions")
    current_expected = expected_versions if expected_versions is not None else sealed_versions
    if (
        not isinstance(sealed_versions, dict)
        or not isinstance(current_expected, dict)
        or not isinstance(before_versions, dict)
        or not isinstance(after_versions, dict)
        or set(current_expected) != set(sealed_versions)
        or set(before_versions) != set(sealed_versions)
        or before_versions != current_expected
        or set(after_versions) != set(before_versions)
    ):
        return _failure("Workspace source evidence is outside the sealed source scope", evidence)

    if (
        before.get("job_id") != job_id
        or before.get("profile_id") != profile_id
        or after.get("job_id") != job_id
        or after.get("profile_id") != profile_id
        or after.get("reference_resume_id") != reference_resume_id
        or after.get("workspace_resume_id") != existing_workspace_id
    ):
        return _failure("Workspace after-preview differs from its reviewed source associations", evidence)
    if args.get("reference_resume_id") is not None:
        try:
            if int(args["reference_resume_id"]) != reference_resume_id:
                return _failure("The selected master Resume differs from the reviewed arguments", evidence)
        except (TypeError, ValueError):
            return _failure("The selected master Resume argument is invalid", evidence)

    required_refs = {f"job:{job_id}", f"profile:{profile_id}"}
    if reference_resume_id is not None:
        required_refs.add(f"resume:{reference_resume_id}")
    if existing_workspace_id is not None:
        required_refs.add(f"resume:{existing_workspace_id}")
    proposal_id = str(args.get("proposal_id") or "").strip() or None
    if proposal_id:
        required_refs.add(f"proposal:{proposal_id}")
    if not required_refs.issubset(sealed_versions):
        return _failure("Workspace Job/Profile/master/proposal source was not sealed before review", evidence)
    if reference_resume_id is not None and existing_workspace_id == reference_resume_id:
        return _failure("The reviewed source Resume cannot also be the tailored Workspace", evidence)

    outputs = result.get("outputs") if isinstance(result.get("outputs"), dict) else {}
    output_resume = outputs.get("resume") if isinstance(outputs.get("resume"), dict) else {}
    output_job = outputs.get("job") if isinstance(outputs.get("job"), dict) else {}
    try:
        resume_id = int(output_resume["id"])
    except (KeyError, TypeError, ValueError):
        return _failure("Registry result has no canonical Resume identity", evidence)
    if output_job.get("id") != job_id or output_resume.get("target_job_id") != job_id:
        return _failure("Registry result is not bound to the reviewed Job", evidence)
    if existing_workspace_id is not None and resume_id != existing_workspace_id:
        return _failure("Registry did not reuse the reviewed Workspace", evidence)

    unbound = evidence.get("unbound_effects")
    created_here = isinstance(unbound, list) and any(
        isinstance(item, dict)
        and item.get("model") == "Resume"
        and item.get("action") == "add"
        and isinstance(item.get("after"), dict)
        and item["after"].get("id") == resume_id
        for item in unbound
    )
    mode = "created" if created_here else "reused"

    try:
        async with workspace.async_session() as db:
            job = await db.get(Job, job_id)
            profile = await db.get(Profile, profile_id)
            resume = await workspace._load_resume(db, resume_id)
            if job is None or profile is None:
                return _failure("Canonical Job or Profile no longer exists", evidence)
            if (
                resume.target_job_id != job_id
                or resume.source_profile_id != profile_id
                or resume.source_resume_id != reference_resume_id
                or resume.source_mode != "job_tailored_workspace"
                or resume.is_primary
                or job.id != before.get("job_id")
                or profile.id != before.get("profile_id")
                or job.id not in (resume.source_job_ids or [])
            ):
                return _failure("Persisted Resume associations differ from the reviewed Workspace", evidence)

            preview_sections = after.get("sections")
            if not isinstance(preview_sections, list):
                return _failure("The sealed Workspace preview does not include its sections", evidence)
            expected_sections = [
                _section_projection(workspace._section_dict(workspace._row_to_section(row, index)))
                for index, row in enumerate(preview_sections)
                if isinstance(row, dict)
            ]
            actual_sections = [workspace._section_dict(section) for section in resume.sections]
            if len(expected_sections) != len(preview_sections):
                return _failure("The sealed Workspace preview contains an invalid section", evidence)
            if _sorted_sections(expected_sections) != _sorted_sections(actual_sections):
                return _failure("Persisted Resume sections differ from the approved Workspace preview", evidence)

            version_id = resume.current_version_id
            if isinstance(version_id, bool) or not isinstance(version_id, int) or version_id <= 0:
                return _failure("Workspace has no committed current ResumeVersion", evidence)
            version = await db.get(ResumeVersion, version_id)
            if (
                version is None
                or version.resume_id != resume.id
                or version.content_snapshot != snapshot_resume(resume)
            ):
                return _failure("Current ResumeVersion is missing or differs from canonical content", evidence)

            proposal = await db.get(ResumeOptimizationProposal, proposal_id) if proposal_id else None
            if proposal_id and (
                proposal is None
                or proposal.job_id != job_id
                or proposal.profile_id != profile_id
                or proposal.workspace_resume_id != resume.id
            ):
                return _failure("Proposal is not bound to the verified Workspace", evidence)

            expected_payload = await workspace._workspace_payload(
                db, resume, job=job, proposal_id=proposal_id
            )
            if any(
                key not in outputs or canonical_digest(outputs[key]) != canonical_digest(value)
                for key, value in expected_payload.items()
            ):
                return _failure("Registry payload differs from canonical workspace database readback", evidence)

            workspace_rows = (
                await db.execute(
                    select(Resume.id)
                    .where(Resume.target_job_id == job_id)
                    .where(Resume.source_mode == "job_tailored_workspace")
                )
            ).scalars().all()
            if len(workspace_rows) != 1 or workspace_rows[0] != resume.id:
                return _failure("Job does not have exactly one canonical tailored Workspace", evidence)

            before_proposal_hash = f"proposal:{proposal_id}" if proposal_id else None
            for reference, expected_hash in after_versions.items():
                kind, separator, identity = str(reference).partition(":")
                if not separator or not identity:
                    return _failure("Workspace source reference is malformed", evidence)
                material = await sources._source(db, kind, identity)
                if canonical_digest(material) != expected_hash:
                    return _failure(f"Workspace source {reference} differs from its observed after-image", evidence)
                if reference != before_proposal_hash and expected_hash != before_versions[reference]:
                    return _failure(f"Workspace source {reference} changed outside its approved scope", evidence)

            actual_resume_row = sources._row(resume)
            actual_section_rows = {
                section.id: sources._row(section) for section in resume.sections
            }
            actual_version_row = sources._row(version)
            if not _verify_unbound_effects(
                evidence,
                resume_row=actual_resume_row,
                section_rows=actual_section_rows,
                version_row=actual_version_row,
                mode=mode,
                before_workspace_id=existing_workspace_id,
            ):
                return _failure("Committed workspace writes do not match canonical Resume/section/version rows", evidence)

            proposal_row = sources._row(proposal) if proposal is not None else None
            if not _verify_bound_effects(
                evidence, proposal_id=proposal_id, proposal_row=proposal_row, resume_row=actual_resume_row
            ):
                return _failure("Source-bound workspace effects exceed the proposal link", evidence)

            proof = {
                "verified": True,
                "kind": "resume_workspace",
                "mode": mode,
                "workspace_id": resume.id,
                "job_id": job_id,
                "profile_id": profile_id,
                "source_resume_id": reference_resume_id,
                "proposal_id": proposal_id,
                "content_hash": workspace.workspace_content_hash(resume),
                "workspace_revision": int(resume.workspace_revision or 0),
                "current_version_id": version.id,
                "sections_hash": canonical_digest(actual_sections),
            }
    except (PlanValidationError, KeyError, TypeError, ValueError) as exc:
        return _failure(f"Workspace readback was incomplete: {type(exc).__name__}", evidence)
    except Exception as exc:
        raise

    safe_evidence = _safe_source_evidence(evidence, verified=True)
    safe_evidence["workspace_effect"] = proof
    return {**proof, "effect_state": "committed", "source_evidence": safe_evidence}
