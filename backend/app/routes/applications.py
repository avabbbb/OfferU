from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.cover_letter import generate_cover_letter
from app.database import get_db
from app.models.models import Application, Job
from app.services.application_workspace import (
    list_table_records,
    get_workspace_payload,
)
from app.services.security_redaction import safe_error_message

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
    return HTTPException(status_code=400, detail=safe_error_message(error))


async def _execute_operation(name: str, args: dict[str, Any]) -> Any:
    from app.ops import execute_operation

    result = await execute_operation(name, args, surface="applications_api")
    if not result.get("ok"):
        message = "；".join(
            safe_error_message(ValueError(str(item)))
            for item in result.get("errors") or []
        )
        lowered = message.lower()
        status = 404 if "不存在" in message or "not found" in lowered else 400
        raise HTTPException(status_code=status, detail=message or "操作失败")
    return result.get("outputs")


@router.get("/workspace")
async def workspace(db: AsyncSession = Depends(get_db)):
    return await get_workspace_payload(db)


@router.get("/progress-board")
async def progress_board(
    status: str = Query("active", description="active / closed / all"),
    include_timeline: bool = Query(False),
):
    """公司 → 岗位 二级分组的进度看板（渐进式披露第一、二层）。"""
    try:
        return await _execute_operation(
            "get_application_progress_board",
            {"status": status, "include_timeline": include_timeline},
        )
    except ValueError as error:
        raise _bad_request(error)


@router.get("/progress-board/{application_attempt_id}/timeline")
async def progress_board_timeline(application_attempt_id: int):
    """单个投递的完整阶段时间线 + 待确认候选（渐进式披露第三层）。"""
    try:
        return await _execute_operation(
            "get_application_progress_timeline",
            {"application_attempt_id": application_attempt_id},
        )
    except ValueError as error:
        raise _bad_request(error)


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
async def create_table(data: TableCreateRequest):
    try:
        return await _execute_operation("create_application_table", data.model_dump())
    except ValueError as exc:
        raise _bad_request(exc) from exc


@router.patch("/tables/{table_id}")
async def rename_table_route(
    table_id: int,
    data: TableRenameRequest,
):
    try:
        return await _execute_operation(
            "rename_application_table", {"table_id": table_id, **data.model_dump()}
        )
    except ValueError as exc:
        raise _bad_request(exc) from exc


@router.delete("/tables/{table_id}")
async def delete_table_route(table_id: int):
    try:
        return await _execute_operation("delete_application_table", {"table_id": table_id})
    except ValueError as exc:
        raise _bad_request(exc) from exc


@router.post("/tables/{table_id}/import-jobs")
async def import_jobs(
    table_id: int,
    data: ImportJobsRequest,
):
    try:
        return await _execute_operation(
            "import_jobs_to_application_table",
            {"table_id": table_id, "job_ids": data.job_ids},
        )
    except ValueError as exc:
        raise _bad_request(exc) from exc


@router.post("/tables/{table_id}/import-latest-extension-batch")
async def import_latest_extension_batch(
    table_id: int,
    data: ImportLatestExtensionBatchRequest,
):
    try:
        return await _execute_operation(
            "import_latest_extension_batch_to_application_table",
            {"table_id": table_id, **data.model_dump()},
        )
    except ValueError as exc:
        raise _bad_request(exc) from exc

@router.post("/records")
async def create_record_route(data: RecordCreateRequest):
    try:
        return await _execute_operation(
            "create_application_table_record", data.model_dump()
        )
    except ValueError as exc:
        raise _bad_request(exc) from exc


@router.patch("/records/{record_id}")
async def patch_record(
    record_id: int,
    data: RecordPatchRequest,
):
    try:
        return await _execute_operation(
            "update_application_table_record",
            {"record_id": record_id, **data.model_dump()},
        )
    except ValueError as exc:
        raise _bad_request(exc) from exc


@router.post("/records/move")
async def move_records(data: MoveRecordsRequest):
    try:
        return await _execute_operation(
            "move_application_records", data.model_dump()
        )
    except ValueError as exc:
        raise _bad_request(exc) from exc


@router.post("/records/delete")
async def delete_records(data: DeleteRecordsRequest):
    try:
        return await _execute_operation(
            "delete_application_records", data.model_dump()
        )
    except ValueError as exc:
        raise _bad_request(exc) from exc


@router.put("/tables/{table_id}/schema")
async def update_table_schema_route(
    table_id: int,
    data: TableSchemaUpdateRequest,
):
    try:
        return await _execute_operation(
            "update_application_table_schema",
            {"table_id": table_id, "schema": data.schema_payload},
        )
    except ValueError as exc:
        raise _bad_request(exc) from exc


@router.get("/template")
async def get_template(db: AsyncSession = Depends(get_db)):
    payload = await get_workspace_payload(db)
    return {"schema": payload["template_schema"]}


@router.put("/template")
async def put_template(data: TemplateUpdateRequest):
    result = await _execute_operation(
        "update_application_template",
        {"schema": data.schema_payload, "purge_non_template_fields": data.purge_non_template_fields},
    )
    return result


@router.post("/template/apply-to-all")
async def apply_template(data: TemplateApplyRequest):
    return await _execute_operation(
        "apply_application_template_to_all", data.model_dump()
    )


@router.get("/settings")
async def get_settings(db: AsyncSession = Depends(get_db)):
    payload = await get_workspace_payload(db)
    return payload["settings"]


@router.put("/settings")
async def put_settings(data: SettingsUpdateRequest):
    return await _execute_operation(
        "update_application_settings", data.model_dump(exclude_none=True)
    )


@router.post("/auto-write")
async def auto_write(data: AutoWriteRequest):
    try:
        return await _execute_operation("auto_write_application_job", data.model_dump())
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
async def create_application(data: ApplicationCreate):
    return await _execute_operation("create_legacy_application", data.model_dump())


@router.post("/generate")
async def generate(data: GenerateRequest):
    return await _execute_operation("generate_legacy_cover_letter", data.model_dump())


@router.get("/stats")
async def application_stats(db: AsyncSession = Depends(get_db)):
    stats_q = (
        select(Application.status, func.count(Application.id).label("count"))
        .group_by(Application.status)
    )
    rows = (await db.execute(stats_q)).all()
    return {row.status: row.count for row in rows}


@router.put("/{app_id}")
async def update_application(app_id: int, data: ApplicationUpdate):
    return await _execute_operation(
        "update_legacy_application",
        {"application_id": app_id, **data.model_dump(exclude_none=True)},
    )
