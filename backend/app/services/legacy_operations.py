"""Operation implementations for legacy HTTP mutation consumers.

The legacy routes remain as compatibility surfaces, but they must not own a
database session mutation.  These functions keep the old response semantics
behind the same Operation Registry used by the Agent, CLI, and MCP surfaces.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
from typing import Any, Optional

from jinja2 import Template
from sqlalchemy import desc, select
from sqlalchemy.orm import selectinload

from app.database import async_session
from app.models.html_resume import HtmlResume, HtmlResumeTemplate
from app.models.models import (
    Application,
    Batch,
    CalendarEvent,
    InterviewExperience,
    InterviewNotification,
    InterviewQuestion,
    Job,
    Profile,
    Resume,
    ResumeSection,
    ResumeTemplate,
)
from app.services.application_workspace import (
    apply_template_to_all_tables,
    auto_write_job_to_total,
    create_record,
    create_records_from_jobs,
    create_subtable,
    delete_records_from_table,
    delete_subtable,
    move_records_to_table,
    rename_table,
    save_template_schema_and_apply,
    update_record_value,
    update_settings,
    update_table_schema,
)


_LEGACY_APPLICATION_CREATE_LOCKS: dict[int, asyncio.Lock] = {}


async def create_application_table(name: str) -> dict[str, Any]:
    async with async_session() as db:
        return await create_subtable(db, name=name)


async def rename_application_table(table_id: int, name: str) -> dict[str, Any]:
    async with async_session() as db:
        return await rename_table(db, table_id=table_id, name=name)


async def delete_application_table(table_id: int) -> dict[str, Any]:
    async with async_session() as db:
        return await delete_subtable(db, table_id=table_id)


async def import_jobs_to_application_table(
    table_id: int,
    job_ids: list[int],
    skip_existing_in_table: bool = False,
) -> dict[str, Any]:
    async with async_session() as db:
        return await create_records_from_jobs(
            db,
            table_id=table_id,
            job_ids=job_ids,
            skip_existing_in_table=skip_existing_in_table,
        )


async def import_latest_extension_batch_to_application_table(
    table_id: int,
    batch_id: str = "",
    source: str = "offeru-extension",
    limit: int = 500,
    skip_existing: bool = True,
) -> dict[str, Any]:
    clean_source = (source or "offeru-extension").strip()
    clean_batch_id = (batch_id or "").strip()
    async with async_session() as db:
        batch: Batch | None
        if clean_batch_id:
            batch = (
                await db.execute(select(Batch).where(Batch.id == clean_batch_id))
            ).scalar_one_or_none()
        else:
            batch = (
                await db.execute(
                    select(Batch)
                    .where(Batch.source == clean_source)
                    .order_by(desc(Batch.created_at))
                )
            ).scalars().first()
            clean_batch_id = batch.id if batch else ""

        if not clean_batch_id:
            raise ValueError("no extension sync batch found")

        job_ids = (
            await db.execute(
                select(Job.id)
                .where(Job.batch_id == clean_batch_id)
                .order_by(Job.created_at.desc(), Job.id.desc())
                .limit(limit)
            )
        ).scalars().all()
        if not job_ids:
            raise ValueError("extension sync batch has no jobs")

        result = await create_records_from_jobs(
            db,
            table_id=table_id,
            job_ids=[int(job_id) for job_id in job_ids],
            skip_existing_in_table=skip_existing,
        )
        return {
            "batch_id": clean_batch_id,
            "source": batch.source if batch else clean_source,
            "total_jobs": len(job_ids),
            **result,
        }


async def create_application_table_record(
    table_id: int,
    values: dict[str, Any],
    job_ref_id: Optional[int] = None,
) -> dict[str, Any]:
    async with async_session() as db:
        return await create_record(
            db,
            table_id=table_id,
            values=values,
            job_ref_id=job_ref_id,
        )


async def update_application_table_record(
    record_id: int,
    field_key: str,
    value: Any,
) -> dict[str, Any]:
    async with async_session() as db:
        return await update_record_value(
            db,
            record_id=record_id,
            field_key=field_key,
            value=value,
        )


async def move_application_records(
    source_table_id: int,
    target_table_id: int,
    record_ids: list[int],
) -> dict[str, Any]:
    async with async_session() as db:
        return await move_records_to_table(
            db,
            source_table_id=source_table_id,
            target_table_id=target_table_id,
            record_ids=record_ids,
        )


async def delete_application_records(
    table_id: int,
    record_ids: list[int],
    delete_from_total: bool = False,
) -> dict[str, Any]:
    async with async_session() as db:
        return await delete_records_from_table(
            db,
            table_id=table_id,
            record_ids=record_ids,
            delete_from_total=delete_from_total,
        )


async def update_application_table_schema(
    table_id: int,
    schema: list[dict[str, Any]],
) -> dict[str, Any]:
    async with async_session() as db:
        return await update_table_schema(db, table_id=table_id, schema=schema)


async def update_application_template(
    schema: list[dict[str, Any]],
    purge_non_template_fields: bool = False,
) -> dict[str, Any]:
    async with async_session() as db:
        result = await save_template_schema_and_apply(
            db,
            schema=schema,
            purge_non_template_fields=purge_non_template_fields,
        )
        return {
            "schema": result["template_schema"],
            "updated_tables": result["updated_tables"],
            "purged_keys": result["purged_keys"],
        }


async def apply_application_template_to_all(
    purge_non_template_fields: bool = False,
) -> dict[str, Any]:
    async with async_session() as db:
        return await apply_template_to_all_tables(
            db,
            purge_non_template_fields=purge_non_template_fields,
        )


async def update_application_settings(
    auto_row_height: Optional[bool] = None,
    auto_column_width: Optional[bool] = None,
    delete_subtable_sync_total_default: Optional[bool] = None,
) -> dict[str, Any]:
    async with async_session() as db:
        return await update_settings(
            db,
            auto_row_height=auto_row_height,
            auto_column_width=auto_column_width,
            delete_subtable_sync_total_default=delete_subtable_sync_total_default,
        )


async def auto_write_application_job(job_id: int) -> dict[str, Any]:
    async with async_session() as db:
        return await auto_write_job_to_total(db, job_id=job_id)


async def create_legacy_application(job_id: int, notes: str = "") -> dict[str, Any]:
    lock = _LEGACY_APPLICATION_CREATE_LOCKS.setdefault(int(job_id), asyncio.Lock())
    async with lock:
        async with async_session() as db:
            job = (await db.execute(select(Job).where(Job.id == job_id))).scalar_one_or_none()
            existing = (
                await db.execute(
                    select(Application)
                    .where(Application.job_id == job_id)
                    .order_by(Application.id.asc())
                )
            ).scalars().first()
            if existing is not None:
                return {
                    "id": existing.id,
                    "message": "Application already exists",
                    "duplicate": True,
                }

            application = Application(
                job_id=job_id,
                apply_url=job.apply_url if job else "",
                notes=notes,
                status="pending",
            )
            db.add(application)
            await db.commit()
            await db.refresh(application)

            try:
                await auto_write_job_to_total(db, job_id=job_id)
            except ValueError:
                pass

            return {"id": application.id, "message": "Application created", "duplicate": False}


async def update_legacy_application(
    application_id: int,
    status: Optional[str] = None,
    notes: Optional[str] = None,
    cover_letter: Optional[str] = None,
) -> dict[str, Any]:
    async with async_session() as db:
        application = (
            await db.execute(select(Application).where(Application.id == application_id))
        ).scalar_one_or_none()
        if not application:
            raise ValueError("Application not found")

        changed = False
        if status is not None:
            if application.status != status:
                application.status = status
                changed = True
            if status == "submitted" and application.submitted_at is None:
                application.submitted_at = datetime.utcnow()
                changed = True
        if notes is not None:
            if application.notes != notes:
                application.notes = notes
                changed = True
        if cover_letter is not None:
            if application.cover_letter != cover_letter:
                application.cover_letter = cover_letter
                changed = True

        if changed:
            await db.commit()
        return {
            "id": application.id,
            "message": "Updated" if changed else "Already up to date",
            "duplicate": not changed,
        }


async def create_calendar_event(
    title: str,
    description: str,
    event_type: str,
    start_time: datetime,
    end_time: Optional[datetime] = None,
    location: str = "",
    related_job_id: Optional[int] = None,
    related_notification_id: Optional[int] = None,
) -> dict[str, Any]:
    async with async_session() as db:
        event = CalendarEvent(
            title=title,
            description=description,
            event_type=event_type,
            start_time=start_time,
            end_time=end_time,
            location=location,
            related_job_id=related_job_id,
            related_notification_id=related_notification_id,
        )
        db.add(event)
        await db.commit()
        await db.refresh(event)
        return {"id": event.id, "message": "Event created"}


async def auto_fill_calendar_events() -> dict[str, Any]:
    auto_categories = {
        "written_test",
        "assessment",
        "interview_1",
        "interview_2",
        "interview_hr",
    }
    category_display = {
        "written_test": "笔试通知",
        "assessment": "在线测评",
        "interview_1": "初面/技术面",
        "interview_2": "复面/交叉面",
        "interview_hr": "HR面/终面",
    }
    async with async_session() as db:
        subq = select(CalendarEvent.related_notification_id).where(
            CalendarEvent.related_notification_id.is_not(None)
        )
        stmt = select(InterviewNotification).where(
            InterviewNotification.interview_time.is_not(None),
            InterviewNotification.id.not_in(subq),
        )
        notifications = (await db.execute(stmt)).scalars().all()

        created = 0
        for notification in notifications:
            category = getattr(notification, "category", "unknown")
            if category not in auto_categories:
                continue
            event = CalendarEvent(
                title=f"{category_display.get(category, '面试')} - {notification.company}",
                description=(
                    f"岗位: {notification.position}\n"
                    f"{getattr(notification, 'action_required', '')}"
                ),
                event_type="interview",
                start_time=notification.interview_time,
                end_time=notification.interview_time + timedelta(hours=1),
                location=notification.location or "",
                related_notification_id=notification.id,
            )
            db.add(event)
            created += 1

        await db.commit()
        return {"created": created, "scanned": len(notifications)}


async def collect_interview_experience(
    company: str,
    role: str,
    raw_text: str,
    source_url: Optional[str] = None,
    source_platform: str = "manual",
    job_id: Optional[int] = None,
) -> dict[str, Any]:
    async with async_session() as db:
        experience = InterviewExperience(
            company=company.strip(),
            role=role.strip(),
            raw_text=raw_text,
            source_url=source_url,
            source_platform=source_platform,
            job_id=job_id,
        )
        db.add(experience)
        await db.commit()
        await db.refresh(experience)
        return {
            "id": experience.id,
            "company": experience.company,
            "role": experience.role,
            "source_platform": experience.source_platform,
            "collected_at": (
                experience.collected_at.isoformat()
                if experience.collected_at
                else None
            ),
        }


async def extract_interview_questions(experience_id: int) -> dict[str, Any]:
    from app.agents.interview_prep import extract_questions

    async with async_session() as db:
        experience = await db.get(InterviewExperience, experience_id)
        if not experience:
            raise ValueError("面经记录不存在")

        result = await extract_questions(
            company=experience.company,
            role=experience.role,
            raw_text=experience.raw_text,
        )
        if not result:
            raise RuntimeError("LLM 提炼失败，请稍后重试")

        questions: list[InterviewQuestion] = []
        for item in result.get("questions", []):
            question = InterviewQuestion(
                experience_id=experience.id,
                question_text=item.get("question_text", ""),
                round_type=item.get("round_type", "department"),
                category=item.get("category", "behavioral"),
                difficulty=item.get("difficulty", 3),
                job_id=experience.job_id,
            )
            db.add(question)
            questions.append(question)

        if result.get("rounds"):
            import json

            experience.interview_rounds = json.dumps(
                result["rounds"], ensure_ascii=False
            )

        await db.commit()
        for question in questions:
            await db.refresh(question)

        return {
            "experience_id": experience.id,
            "rounds": result.get("rounds", []),
            "questions_count": len(questions),
            "questions": [
                {
                    "id": question.id,
                    "question_text": question.question_text,
                    "round_type": question.round_type,
                    "category": question.category,
                    "difficulty": question.difficulty,
                }
                for question in questions
            ],
        }


async def generate_legacy_interview_answer(question_id: int) -> dict[str, Any]:
    from app.agents.interview_prep import generate_answer_hint

    async with async_session() as db:
        question = await db.get(InterviewQuestion, question_id)
        if not question:
            raise ValueError("题目不存在")

        profile = (await db.execute(select(Profile).limit(1))).scalar_one_or_none()
        if not profile:
            raise ValueError("请先创建个人档案")

        sections = (
            await db.execute(
                select(ProfileSection)
                .where(ProfileSection.profile_id == profile.id)
                .where(ProfileSection.status == "active")
            )
        ).scalars().all()
        bullet_lines: list[str] = []
        for section in sections:
            content = section.content_json or {}
            text = content.get("bullet") or content.get("description") or section.title or ""
            if isinstance(text, str):
                text = text.strip()
            if text:
                bullet_lines.append(f"- [{section.section_type}] {text}")

        bullets = "\n".join(bullet_lines)
        if not bullets:
            raise ValueError("Profile 内容为空，请先填写个人经历")

        answer = await generate_answer_hint(
            question=question.question_text,
            category=question.category,
            difficulty=question.difficulty,
            profile_bullets=bullets,
        )
        if not answer:
            raise RuntimeError("LLM 生成失败，请稍后重试")

        question.suggested_answer = answer
        await db.commit()
        return {
            "question_id": question.id,
            "question_text": question.question_text,
            "suggested_answer": answer,
        }


async def generate_legacy_cover_letter(job_id: int, resume_id: int) -> dict[str, Any]:
    from app.agents.cover_letter import generate_cover_letter

    async with async_session() as db:
        job = (await db.execute(select(Job).where(Job.id == job_id))).scalar_one_or_none()
        if not job:
            raise ValueError("Job not found")
        resume = (
            await db.execute(select(Resume).where(Resume.id == resume_id))
        ).scalar_one_or_none()
        if not resume:
            raise ValueError("Resume not found")

        content = resume.content_json or {}
        resume_text = f"姓名: {content.get('name', '')}\n"
        resume_text += f"技能: {content.get('skills', '')}\n"
        for experience in content.get("experience", []):
            resume_text += (
                f"工作经历: {experience.get('company', '')} - "
                f"{experience.get('position', '')}\n"
                f"  描述: {experience.get('description', '')}\n"
            )
        return await generate_cover_letter(
            jd=job.raw_description or job.summary,
            resume=resume_text,
        )


async def create_resume_template(
    name: str,
    thumbnail_url: str = "",
    css_variables: Optional[dict[str, Any]] = None,
    html_layout: str = "",
    is_builtin: bool = False,
) -> dict[str, Any]:
    async with async_session() as db:
        template = ResumeTemplate(
            name=name,
            thumbnail_url=thumbnail_url,
            css_variables=css_variables or {},
            html_layout=html_layout,
            is_builtin=is_builtin,
        )
        db.add(template)
        await db.commit()
        await db.refresh(template)
        return _serialize_resume_template(template)


async def update_resume_template(
    template_id: int,
    name: Optional[str] = None,
    thumbnail_url: Optional[str] = None,
    css_variables: Optional[dict[str, Any]] = None,
    html_layout: Optional[str] = None,
) -> dict[str, Any]:
    async with async_session() as db:
        template = await db.get(ResumeTemplate, template_id)
        if not template:
            raise ValueError("模板不存在")
        if template.is_builtin:
            raise PermissionError("不能修改内置模板")
        if name is not None:
            template.name = name
        if thumbnail_url is not None:
            template.thumbnail_url = thumbnail_url
        if css_variables is not None:
            template.css_variables = css_variables
        if html_layout is not None:
            template.html_layout = html_layout
        await db.commit()
        await db.refresh(template)
        return _serialize_resume_template(template)


async def delete_resume_template(template_id: int) -> dict[str, Any]:
    async with async_session() as db:
        template = await db.get(ResumeTemplate, template_id)
        if not template:
            raise ValueError("模板不存在")
        if template.is_builtin:
            raise PermissionError("不能删除内置模板")
        await db.delete(template)
        await db.commit()
        return {"success": True, "message": "模板已删除"}


async def apply_resume_template(template_id: int, resume_id: int) -> dict[str, Any]:
    async with async_session() as db:
        template = await db.get(ResumeTemplate, template_id)
        if not template:
            raise ValueError("模板不存在")
        resume = await db.get(Resume, resume_id)
        if not resume:
            raise ValueError("简历不存在")
        resume.template_id = template_id
        resume.style_config = {}
        await db.commit()
        return {
            "success": True,
            "message": f"已将模板 '{template.name}' 应用到简历",
            "template_id": template_id,
        }


async def duplicate_resume_template(template_id: int, new_name: str) -> dict[str, Any]:
    async with async_session() as db:
        template = await db.get(ResumeTemplate, template_id)
        if not template:
            raise ValueError("模板不存在")
        new_template = ResumeTemplate(
            name=new_name,
            thumbnail_url=template.thumbnail_url,
            css_variables=dict(template.css_variables or {}),
            html_layout=template.html_layout,
            is_builtin=False,
        )
        db.add(new_template)
        await db.commit()
        await db.refresh(new_template)
        return _serialize_resume_template(new_template)


def _serialize_resume_template(template: ResumeTemplate) -> dict[str, Any]:
    return {
        "id": template.id,
        "name": template.name,
        "thumbnail_url": template.thumbnail_url,
        "css_variables": template.css_variables,
        "is_builtin": template.is_builtin,
        "created_at": template.created_at.isoformat(),
    }


async def generate_html_resume(
    profile_id: int,
    template_id: int,
    design_overrides: Optional[dict[str, Any]] = None,
    job_ids: Optional[list[int]] = None,
) -> dict[str, Any]:
    async with async_session() as db:
        profile = (
            await db.execute(
                select(Profile)
                .options(
                    selectinload(Profile.sections),
                    selectinload(Profile.target_roles),
                )
                .where(Profile.id == profile_id)
            )
        ).scalar_one_or_none()
        if not profile:
            raise ValueError("Profile not found")
        template = await db.get(HtmlResumeTemplate, template_id)
        if not template:
            raise ValueError("Template not found")

        base_info = profile.base_info_json if isinstance(profile.base_info_json, dict) else {}
        profile_data = {
            "name": profile.name,
            "email": profile.email,
            "phone": profile.phone,
            "location": base_info.get("current_city", ""),
            "summary": base_info.get("personal_summary")
            or base_info.get("summary")
            or profile.headline
            or "",
            "sections": [
                {
                    "section_type": section.section_type,
                    "title": section.title,
                    "content_json": section.content_json
                    if isinstance(section.content_json, dict)
                    else {},
                    "sort_order": section.sort_order,
                }
                for section in profile.sections
            ],
            "target_roles": [role.role_name for role in profile.target_roles],
        }
        overrides = design_overrides or {}
        html_content = Template(template.html_template).render(
            profile=profile_data,
            design_tokens={**(template.design_tokens or {}), **overrides},
        )
        html_resume = HtmlResume(
            profile_id=profile_id,
            template_id=template_id,
            title=f"{profile.name} - {template.display_name}",
            html_content=html_content,
            design_overrides=overrides,
            job_ids=job_ids or [],
        )
        db.add(html_resume)
        await db.commit()
        await db.refresh(html_resume)
        return {"id": html_resume.id, "html": html_content}
