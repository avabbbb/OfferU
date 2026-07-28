from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.cover_letter import generate_cover_letter
from app.database import get_db
from app.models.models import Application, Batch, Job, Resume
from app.services.application_workspace import (
    apply_template_to_all_tables,
    auto_write_job_to_total,
    create_record,
    create_records_from_jobs,
    create_subtable,
    delete_records_from_table,
    delete_subtable,
    get_workspace_payload,
    list_table_records,
    move_records_to_table,
    rename_table,
    save_template_schema_and_apply,
    update_record_value,
    update_settings,
    update_table_schema,
)

router = APIRouter()


class ApplicationCreate(BaseModel):
    job_id: int
    notes: str = ""


class ApplicationUpdate(BaseModel):
    status: Optional[str] = None
    notes: Optional[str] = None
    cover_letter: Optional[str] = None


class GenerateRequest(BaseModel):
    job_id: int
    resume_id: int


class TableCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)


class TableRenameRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)


class ImportJobsRequest(BaseModel):
    job_ids: list[int] = Field(..., min_length=1, max_length=500)


class ImportLatestExtensionBatchRequest(BaseModel):
    batch_id: Optional[str] = Field(default=None, max_length=64)
    source: str = Field(default="offeru-extension", min_length=1, max_length=64)
    limit: int = Field(default=500, ge=1, le=500)
    skip_existing: bool = True


class RecordCreateRequest(BaseModel):
    table_id: int
    values: dict[str, Any]
    job_ref_id: Optional[int] = None


class RecordPatchRequest(BaseModel):
    field_key: str
    value: Any = None


class MoveRecordsRequest(BaseModel):
    source_table_id: int
    target_table_id: int
    record_ids: list[int] = Field(..., min_length=1, max_length=500)


class DeleteRecordsRequest(BaseModel):
    table_id: int
    record_ids: list[int] = Field(..., min_length=1, max_length=500)
    delete_from_total: bool = False


class TableSchemaUpdateRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    schema_payload: list[dict[str, Any]] = Field(alias="schema")


class TemplateUpdateRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    schema_payload: list[dict[str, Any]] = Field(alias="schema")
    purge_non_template_fields: bool = False


class TemplateApplyRequest(BaseModel):
    purge_non_template_fields: bool = False


class SettingsUpdateRequest(BaseModel):
    auto_row_height: Optional[bool] = None
    auto_column_width: Optional[bool] = None
    delete_subtable_sync_total_default: Optional[bool] = None


class AutoWriteRequest(BaseModel):
    job_id: int


def _bad_request(error: ValueError) -> HTTPException:
    return HTTPException(status_code=400, detail=str(error))


@router.get("/workspace")
async def workspace(db: AsyncSession = Depends(get_db)):
    return await get_workspace_payload(db)


@router.get("/progress-board")
async def progress_board(
    status: str = Query("active", description="active / closed / all"),
    include_timeline: bool = Query(False),
):
    """公司 → 岗位 二级分组的进度看板（渐进式披露第一、二层）。"""
    from app.services.application_progress import get_application_progress_board

    try:
        return await get_application_progress_board(
            status=status,
            include_timeline=include_timeline,
        )
    except ValueError as error:
        raise _bad_request(error)


@router.get("/progress-board/{application_attempt_id}/timeline")
async def progress_board_timeline(application_attempt_id: int):
    """单个投递的完整阶段时间线 + 待确认候选（渐进式披露第三层）。"""
    from app.services.application_progress import get_application_progress_timeline

    try:
        result = await get_application_progress_timeline(application_attempt_id)
    except ValueError as error:
        raise _bad_request(error)
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


@router.get("/tables/{table_id}/records")
async def table_records(
    table_id: int,
    keyword: str = Query("", description="关键词搜索"),
    db: AsyncSession = Depends(get_db),
):
    try:
        return await list_table_records(db, table_id=table_id, keyword=keyword)
    except ValueError as exc:
        raise _bad_request(exc) from exc


@router.post("/tables")
async def create_table(data: TableCreateRequest, db: AsyncSession = Depends(get_db)):
    try:
        return await create_subtable(db, name=data.name)
    except ValueError as exc:
        raise _bad_request(exc) from exc


@router.patch("/tables/{table_id}")
async def rename_table_route(
    table_id: int,
    data: TableRenameRequest,
    db: AsyncSession = Depends(get_db),
):
    try:
        return await rename_table(db, table_id=table_id, name=data.name)
    except ValueError as exc:
        raise _bad_request(exc) from exc


@router.delete("/tables/{table_id}")
async def delete_table_route(table_id: int, db: AsyncSession = Depends(get_db)):
    try:
        return await delete_subtable(db, table_id=table_id)
    except ValueError as exc:
        raise _bad_request(exc) from exc


@router.post("/tables/{table_id}/import-jobs")
async def import_jobs(
    table_id: int,
    data: ImportJobsRequest,
    db: AsyncSession = Depends(get_db),
):
    try:
        return await create_records_from_jobs(db, table_id=table_id, job_ids=data.job_ids)
    except ValueError as exc:
        raise _bad_request(exc) from exc


@router.post("/tables/{table_id}/import-latest-extension-batch")
async def import_latest_extension_batch(
    table_id: int,
    data: ImportLatestExtensionBatchRequest,
    db: AsyncSession = Depends(get_db),
):
    source = (data.source or "offeru-extension").strip()
    batch_id = (data.batch_id or "").strip()
    batch: Batch | None = None

    if batch_id:
        batch = (await db.execute(select(Batch).where(Batch.id == batch_id))).scalar_one_or_none()
    else:
        batch = (
            await db.execute(
                select(Batch)
                .where(Batch.source == source)
                .order_by(desc(Batch.created_at))
            )
        ).scalars().first()
        batch_id = batch.id if batch else ""

    if not batch_id:
        raise HTTPException(status_code=404, detail="no extension sync batch found")

    job_ids = (
        await db.execute(
            select(Job.id)
            .where(Job.batch_id == batch_id)
            .order_by(Job.created_at.desc(), Job.id.desc())
            .limit(data.limit)
        )
    ).scalars().all()
    if not job_ids:
        raise HTTPException(status_code=404, detail="extension sync batch has no jobs")

    try:
        result = await create_records_from_jobs(
            db,
            table_id=table_id,
            job_ids=[int(job_id) for job_id in job_ids],
            skip_existing_in_table=data.skip_existing,
        )
    except ValueError as exc:
        raise _bad_request(exc) from exc

    return {
        "batch_id": batch_id,
        "source": batch.source if batch else source,
        "total_jobs": len(job_ids),
        **result,
    }


@router.post("/records")
async def create_record_route(data: RecordCreateRequest, db: AsyncSession = Depends(get_db)):
    try:
        return await create_record(
            db,
            table_id=data.table_id,
            values=data.values,
            job_ref_id=data.job_ref_id,
        )
    except ValueError as exc:
        raise _bad_request(exc) from exc


@router.patch("/records/{record_id}")
async def patch_record(
    record_id: int,
    data: RecordPatchRequest,
    db: AsyncSession = Depends(get_db),
):
    try:
        return await update_record_value(
            db,
            record_id=record_id,
            field_key=data.field_key,
            value=data.value,
        )
    except ValueError as exc:
        raise _bad_request(exc) from exc


@router.post("/records/move")
async def move_records(data: MoveRecordsRequest, db: AsyncSession = Depends(get_db)):
    try:
        return await move_records_to_table(
            db,
            source_table_id=data.source_table_id,
            target_table_id=data.target_table_id,
            record_ids=data.record_ids,
        )
    except ValueError as exc:
        raise _bad_request(exc) from exc


@router.post("/records/delete")
async def delete_records(data: DeleteRecordsRequest, db: AsyncSession = Depends(get_db)):
    try:
        return await delete_records_from_table(
            db,
            table_id=data.table_id,
            record_ids=data.record_ids,
            delete_from_total=data.delete_from_total,
        )
    except ValueError as exc:
        raise _bad_request(exc) from exc


@router.put("/tables/{table_id}/schema")
async def update_table_schema_route(
    table_id: int,
    data: TableSchemaUpdateRequest,
    db: AsyncSession = Depends(get_db),
):
    try:
        return await update_table_schema(db, table_id=table_id, schema=data.schema_payload)
    except ValueError as exc:
        raise _bad_request(exc) from exc


@router.get("/template")
async def get_template(db: AsyncSession = Depends(get_db)):
    payload = await get_workspace_payload(db)
    return {"schema": payload["template_schema"]}


@router.put("/template")
async def put_template(data: TemplateUpdateRequest, db: AsyncSession = Depends(get_db)):
    result = await save_template_schema_and_apply(
        db,
        schema=data.schema_payload,
        purge_non_template_fields=data.purge_non_template_fields,
    )
    return {
        "schema": result["template_schema"],
        "updated_tables": result["updated_tables"],
        "purged_keys": result["purged_keys"],
    }


@router.post("/template/apply-to-all")
async def apply_template(data: TemplateApplyRequest, db: AsyncSession = Depends(get_db)):
    return await apply_template_to_all_tables(
        db,
        purge_non_template_fields=data.purge_non_template_fields,
    )


@router.get("/settings")
async def get_settings(db: AsyncSession = Depends(get_db)):
    payload = await get_workspace_payload(db)
    return payload["settings"]


@router.put("/settings")
async def put_settings(data: SettingsUpdateRequest, db: AsyncSession = Depends(get_db)):
    return await update_settings(
        db,
        auto_row_height=data.auto_row_height,
        auto_column_width=data.auto_column_width,
        delete_subtable_sync_total_default=data.delete_subtable_sync_total_default,
    )


@router.post("/auto-write")
async def auto_write(data: AutoWriteRequest, db: AsyncSession = Depends(get_db)):
    try:
        return await auto_write_job_to_total(db, job_id=data.job_id)
    except ValueError as exc:
        raise _bad_request(exc) from exc


# ---- 兼容旧接口（不移除） ----


@router.get("/")
async def list_applications(
    status: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    query = select(Application).order_by(desc(Application.created_at))
    if status:
        query = query.where(Application.status == status)

    total_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(total_q)).scalar() or 0

    query = query.offset((page - 1) * page_size).limit(page_size)
    apps = (await db.execute(query)).scalars().all()

    job_ids = list({app.job_id for app in apps if app.job_id})
    jobs_map: dict[int, Job] = {}
    if job_ids:
        job_rows = await db.execute(select(Job).where(Job.id.in_(job_ids)))
        jobs_map = {job.id: job for job in job_rows.scalars().all()}

    items = []
    for app in apps:
        job = jobs_map.get(app.job_id)
        items.append(
            {
                "id": app.id,
                "job_id": app.job_id,
                "job_title": job.title if job else "",
                "job_company": job.company if job else "",
                "status": app.status,
                "cover_letter": app.cover_letter,
                "apply_url": app.apply_url,
                "notes": app.notes,
                "submitted_at": app.submitted_at.isoformat() if app.submitted_at else None,
                "created_at": str(app.created_at),
            }
        )

    return {"total": total, "page": page, "page_size": page_size, "items": items}


@router.post("/")
async def create_application(data: ApplicationCreate, db: AsyncSession = Depends(get_db)):
    job = (await db.execute(select(Job).where(Job.id == data.job_id))).scalar_one_or_none()
    app = Application(
        job_id=data.job_id,
        apply_url=job.apply_url if job else "",
        notes=data.notes,
        status="pending",
    )
    db.add(app)
    await db.commit()
    await db.refresh(app)

    try:
        await auto_write_job_to_total(db, job_id=data.job_id)
    except ValueError:
        pass

    return {"id": app.id, "message": "Application created"}


@router.post("/generate")
async def generate(data: GenerateRequest, db: AsyncSession = Depends(get_db)):
    job = (await db.execute(select(Job).where(Job.id == data.job_id))).scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    resume = (await db.execute(select(Resume).where(Resume.id == data.resume_id))).scalar_one_or_none()
    if not resume:
        raise HTTPException(status_code=404, detail="Resume not found")

    content = resume.content_json or {}
    resume_text = f"姓名: {content.get('name', '')}\n"
    resume_text += f"技能: {content.get('skills', '')}\n"
    for exp in content.get("experience", []):
        resume_text += f"工作经历: {exp.get('company', '')} - {exp.get('position', '')}\n"
        resume_text += f"  描述: {exp.get('description', '')}\n"

    return await generate_cover_letter(
        jd=job.raw_description or job.summary,
        resume=resume_text,
    )


@router.get("/stats")
async def application_stats(db: AsyncSession = Depends(get_db)):
    stats_q = (
        select(Application.status, func.count(Application.id).label("count"))
        .group_by(Application.status)
    )
    rows = (await db.execute(stats_q)).all()
    return {row.status: row.count for row in rows}


@router.put("/{app_id}")
async def update_application(app_id: int, data: ApplicationUpdate, db: AsyncSession = Depends(get_db)):
    app = (await db.execute(select(Application).where(Application.id == app_id))).scalar_one_or_none()
    if not app:
        raise HTTPException(status_code=404, detail="Application not found")

    if data.status is not None:
        app.status = data.status
        if data.status == "submitted":
            app.submitted_at = datetime.utcnow()
    if data.notes is not None:
        app.notes = data.notes
    if data.cover_letter is not None:
        app.cover_letter = data.cover_letter

    await db.commit()
    return {"id": app.id, "message": "Updated"}
