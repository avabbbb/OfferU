from __future__ import annotations

from sqlalchemy import func, select

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
        },
        "sections": [
            {
                "id": section.id,
                "section_type": section.section_type,
                "sort_order": section.sort_order,
                "title": section.title,
                "visible": section.visible,
                "content_json": section.content_json,
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
    db.add(version)
    await db.flush()
    return version
