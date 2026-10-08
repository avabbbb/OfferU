from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.models.models import Resume, ResumeVersion


def snapshot_resume(resume: Resume) -> dict:
    return {
        "resume": {
            "id": resume.id,
            "user_name": resume.user_name,
            "title": resume.title,
            "photo_url": resume.photo_url,
            "summary": resume.summary,
            "contact_json": resume.contact_json,
            "template_id": resume.template_id,
            "style_config": resume.style_config,
            "is_primary": resume.is_primary,
            "language": resume.language,
            "source_mode": resume.source_mode,
            "source_job_ids": resume.source_job_ids,
            "source_profile_snapshot": resume.source_profile_snapshot,
            "source_profile_id": resume.source_profile_id,
            "source_resume_id": resume.source_resume_id,
            "target_job_id": resume.target_job_id,
            "application_id": resume.application_id,
        },
        "sections": [
            {
                "id": section.id,
                "section_type": section.section_type,
                "sort_order": section.sort_order,
                "title": section.title,
                "visible": section.visible,
                "content_json": section.content_json,
                "source_section_ids": section.source_section_ids,
            }
            for section in resume.sections
        ],
    }


async def create_version_snapshot(
    db,
    resume: Resume,
    *,
    change_summary: str,
    created_by: str,
) -> ResumeVersion:
    # Race-safe version numbering: compute max(version_number)+1, then insert
    # inside a SAVEPOINT so an IntegrityError (duplicate version_number) only
    # rolls back the version insert — not the caller's pending work such as a
    # freshly created resume that has only been flushed, not committed.
    last_exc: IntegrityError | None = None
    for _attempt in range(3):
        highest = (
            await db.execute(select(func.max(ResumeVersion.version_number)).where(ResumeVersion.resume_id == resume.id))
        ).scalar_one_or_none() or 0
        version_number = int(highest) + 1
        version = ResumeVersion(
            resume_id=resume.id,
            version_number=version_number,
            content_snapshot=snapshot_resume(resume),
            change_summary=(change_summary.strip() or f"版本 {version_number}")[:500],
            created_by=(created_by.strip() or "system")[:100],
        )
        try:
            async with db.begin_nested():
                db.add(version)
            # begin_nested flushed successfully and released the savepoint.
            return version
        except IntegrityError as exc:
            last_exc = exc
            continue
    raise RuntimeError("resume_version race: failed after 3 attempts") from last_exc


_OPEN_WORKSPACE_PROPOSAL_STATES = ("ready", "in_review")


def proposal_fully_reviewed(proposal) -> bool:
    """Every diff row of a workspace-bound proposal has a recorded review.

    A proposal without diff rows has nothing left to review.
    """
    change_ids = {
        str(item.get("change_id"))
        for item in (proposal.diff_json or [])
        if isinstance(item, dict) and item.get("change_id")
    }
    reviews = proposal.item_reviews_json or {}
    return all(
        isinstance(reviews.get(change_id), dict) for change_id in change_ids
    )


def mark_workspace_proposal_accepted(proposal, *, resume: Resume, version: ResumeVersion) -> bool:
    """Finalize a fully reviewed workspace proposal onto ``version``.

    Shared by the explicit "save version" path and the per-item review path,
    so both record the same terminal state. Idempotent: an already-finalized
    (or stale/blocked/rejected) proposal is left untouched.
    """
    from datetime import datetime, timezone

    if proposal.status not in _OPEN_WORKSPACE_PROPOSAL_STATES or not proposal_fully_reviewed(proposal):
        return False
    proposal.status = "accepted"
    proposal.accepted_resume_id = resume.id
    proposal.accepted_resume_version_id = version.id
    proposal.reviewed_at = datetime.now(timezone.utc).replace(tzinfo=None)
    return True
