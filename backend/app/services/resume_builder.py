# =============================================
# Resume Builder — 简历生成共享服务
# =============================================
# 从 optimize.py 提取的共享函数，避免 optimize_agent.py ↔ optimize.py 循环导入
# =============================================

from __future__ import annotations

from app.models.models import Profile, ProfileSection, Resume, ResumeSection


def _profile_to_contact_json(profile: Profile) -> dict:
    info = profile.base_info_json or {}
    if not isinstance(info, dict):
        info = {}
    contact = {
        "email": info.get("email") or getattr(profile, "email", "") or "",
        "phone": info.get("phone") or getattr(profile, "phone", "") or "",
        "wechat": info.get("wechat") or getattr(profile, "wechat", "") or "",
    }
    return {key: value for key, value in contact.items() if isinstance(value, str) and value.strip()}


def _build_source_profile_snapshot(profile: Profile, selected: list[ProfileSection]) -> dict:
    return {
        "profile_id": profile.id,
        "profile_updated_at": str(profile.updated_at),
        "selected_section_ids": [item.id for item in selected],
        "selected_count": len(selected),
    }


# Brand-new resumes open on the "paper" canvas (what you see is the export).
# Anything derived from an existing resume keeps that resume's look, and an
# existing resume without an explicit template keeps rendering as before.
NEW_RESUME_DEFAULT_TEMPLATE = "paper"


def with_new_resume_template(style_config: dict | None, *, derived_from_existing: bool) -> dict:
    style = dict(style_config or {})
    if derived_from_existing or style.get("template") or style.get("templateType"):
        return style
    style["template"] = NEW_RESUME_DEFAULT_TEMPLATE
    return style


async def stage_generated_resume(
    *,
    db,
    profile: Profile,
    title: str,
    summary: str,
    source_mode: str,
    source_job_ids: list[int],
    contact_json: dict,
    style_config: dict,
    template_id: int | None,
    source_profile_snapshot: dict,
    rows: list[dict],
    language: str = "zh",
    source_resume_id: int | None = None,
    target_job_id: int | None = None,
    application_id: int | None = None,
) -> Resume:
    """Stage a generated resume inside the caller's transaction."""
    resume = Resume(
        user_name=profile.name or "默认候选人",
        title=title,
        summary=summary,
        contact_json=contact_json,
        style_config=with_new_resume_template(
            style_config, derived_from_existing=source_resume_id is not None or template_id is not None
        ),
        template_id=template_id,
        is_primary=False,
        language=language or "zh",
        source_mode=source_mode,
        source_job_ids=source_job_ids,
        source_profile_snapshot=source_profile_snapshot,
        source_profile_id=profile.id,
        source_resume_id=source_resume_id,
        target_job_id=target_job_id,
        application_id=application_id,
    )
    db.add(resume)

    for row in rows:
        resume.sections.append(
            ResumeSection(
                section_type=row["section_type"],
                sort_order=row["sort_order"],
                title=row["title"],
                visible=True,
                content_json=row["content_json"],
                source_section_ids=row.get("source_section_ids"),
            )
        )
    await db.flush()
    return resume
