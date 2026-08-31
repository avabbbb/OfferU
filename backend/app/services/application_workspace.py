from __future__ import annotations

import copy
import re
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import and_, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import (
    ApplicationRecord,
    ApplicationTable,
    ApplicationTableRecord,
    ApplicationTemplate,
    ApplicationWorkspaceSettings,
    Job,
)
from app.services.security_redaction import safe_error_message

FIELD_TYPES = {
    "text",
    "long_text",
    "single_select",
    "multi_select",
    "date",
    "datetime",
    "number",
    "boolean",
    "link",
}

INTERNAL_TEST_BATCH_PREFIXES = ("test-", "test_", "ui-ext-", "mock-")
INTERNAL_TEST_COMPANY_PREFIX = "OfferU "
INTERNAL_TEST_URL_MARKERS = (
    "example.com/jobs/test-",
    "example.com/apply/test-",
)


def _public_application_record_filter():
    batch_filters = [
        or_(Job.batch_id.is_(None), ~Job.batch_id.ilike(f"{prefix}%"))
        for prefix in INTERNAL_TEST_BATCH_PREFIXES
    ]
    url_filters = [
        or_(ApplicationRecord.job_link.is_(None), ~ApplicationRecord.job_link.ilike(f"%{marker}%"))
        for marker in INTERNAL_TEST_URL_MARKERS
    ] + [
        or_(Job.url.is_(None), ~Job.url.ilike(f"%{marker}%"))
        for marker in INTERNAL_TEST_URL_MARKERS
    ] + [
        or_(Job.apply_url.is_(None), ~Job.apply_url.ilike(f"%{marker}%"))
        for marker in INTERNAL_TEST_URL_MARKERS
    ]
    return and_(
        *batch_filters,
        or_(ApplicationRecord.company_name.is_(None), ~ApplicationRecord.company_name.ilike(f"{INTERNAL_TEST_COMPANY_PREFIX}%")),
        or_(Job.company.is_(None), ~Job.company.ilike(f"{INTERNAL_TEST_COMPANY_PREFIX}%")),
        *url_filters,
    )

FIXED_FIELD_SPECS: list[dict[str, Any]] = [
    {
        "field_key": "company_name",
        "label": "公司名称",
        "type": "text",
        "job_attrs": ("company",),
        "required": True,
    },
    {
        "field_key": "job_title",
        "label": "岗位名称",
        "type": "text",
        "job_attrs": ("title",),
        "required": True,
    },
    {
        "field_key": "location",
        "label": "地点",
        "type": "text",
        "job_attrs": ("location",),
        "required": True,
    },
    {
        "field_key": "job_link",
        "label": "岗位链接",
        "type": "link",
        "job_attrs": ("apply_url", "url"),
        "required": True,
    },
    {
        "field_key": "source",
        "label": "来源",
        "type": "text",
        "job_attrs": ("source",),
        "required": False,
    },
    {
        "field_key": "salary_text",
        "label": "薪酬",
        "type": "text",
        "job_attrs": ("salary_text",),
        "required": False,
    },
    {
        "field_key": "updated_at",
        "label": "更新时间",
        "type": "datetime",
        "job_attrs": tuple(),
        "required": False,
    },
]

FIXED_FIELD_KEYS = {item["field_key"] for item in FIXED_FIELD_SPECS}


def _default_custom_template_fields() -> list[dict[str, Any]]:
    return [
        {
            "field_key": "apply_status",
            "label": "投递状态",
            "type": "single_select",
            "fixed": False,
            "visible": True,
            "width": 160,
            "options": ["待投递", "已投递", "待处理", "面试中", "已拒绝", "已录用"],
        },
        {
            "field_key": "follow_up_date",
            "label": "跟进日期",
            "type": "date",
            "fixed": False,
            "visible": True,
            "width": 160,
            "options": [],
        },
        {
            "field_key": "notes",
            "label": "备注",
            "type": "long_text",
            "fixed": False,
            "visible": True,
            "width": 260,
            "options": [],
        },
    ]


def _custom_field_defaults_by_key() -> dict[str, dict[str, Any]]:
    return {item["field_key"]: item for item in _default_custom_template_fields()}


def _default_template_schema() -> list[dict[str, Any]]:
    fields: list[dict[str, Any]] = []
    for index, spec in enumerate(FIXED_FIELD_SPECS):
        fields.append(
            {
                "field_key": spec["field_key"],
                "label": spec["label"],
                "type": spec["type"],
                "fixed": True,
                "visible": True,
                "width": 180 if spec["field_key"] != "job_link" else 260,
                "options": [],
                "order": index,
            }
        )
    for custom in _default_custom_template_fields():
        custom_copy = copy.deepcopy(custom)
        custom_copy["order"] = len(fields)
        fields.append(custom_copy)
    return fields


def _safe_field_key(raw: str) -> str:
    value = (raw or "").strip().lower()
    value = re.sub(r"\s+", "_", value)
    value = re.sub(r"[^\w_]+", "", value)
    if not value:
        value = "custom_field"
    return value


def _normalize_schema(schema: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    source = schema or []
    fixed_map: dict[str, dict[str, Any]] = {}
    custom_fields: list[dict[str, Any]] = []
    seen_custom: set[str] = set()
    default_custom = _custom_field_defaults_by_key()

    for field in source:
        if not isinstance(field, dict):
            continue
        raw_key = str(field.get("field_key") or "").strip()
        if not raw_key:
            continue
        if raw_key in FIXED_FIELD_KEYS:
            fixed_map[raw_key] = field
            continue
        field_key = _safe_field_key(raw_key)
        if field_key in FIXED_FIELD_KEYS or field_key in seen_custom:
            continue
        seen_custom.add(field_key)
        canonical = default_custom.get(field_key)
        field_type = str((canonical or field).get("type") or "text")
        if field_type not in FIELD_TYPES:
            field_type = "text"
        options = (canonical or field).get("options")
        if not isinstance(options, list):
            options = []
        custom_fields.append(
            {
                "field_key": field_key,
                "label": str((canonical or field).get("label") or raw_key or "自定义字段"),
                "type": field_type,
                "fixed": False,
                "visible": bool(field.get("visible", True)),
                "width": int(field.get("width") or (canonical or {}).get("width") or 180),
                "options": [str(item) for item in options if str(item).strip()],
                "order": int(field.get("order") or 0),
            }
        )

    fixed_fields: list[dict[str, Any]] = []
    for index, spec in enumerate(FIXED_FIELD_SPECS):
        existing = fixed_map.get(spec["field_key"], {})
        fixed_fields.append(
            {
                "field_key": spec["field_key"],
                "label": spec["label"],
                "type": spec["type"],
                "fixed": True,
                "visible": bool(existing.get("visible", True)),
                "width": int(existing.get("width") or (260 if spec["field_key"] == "job_link" else 180)),
                "options": [],
                "order": index,
            }
        )

    custom_fields.sort(key=lambda item: item.get("order", 0))
    normalized: list[dict[str, Any]] = []
    normalized.extend(fixed_fields)
    for default_field in _default_custom_template_fields():
        if default_field["field_key"] in seen_custom:
            continue
        custom_fields.append(copy.deepcopy(default_field))
    for item in custom_fields:
        item["order"] = len(normalized)
        normalized.append(item)
    return normalized


def _coerce_datetime(value: Any) -> Optional[datetime]:
    """把输入转为 naive UTC datetime；空串/非法值返回 None（表示未设置），
    而不是静默写成当前时间——否则清空日期字段会变成「现在」，数据失真。"""
    def _as_naive_utc(dt: datetime) -> datetime:
        if dt.tzinfo is None:
            return dt
        return dt.astimezone(timezone.utc).replace(tzinfo=None)

    if value is None:
        return None
    if isinstance(value, datetime):
        return _as_naive_utc(value)
    text = str(value).strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return _as_naive_utc(parsed)
    except ValueError:
        return None


def _record_signature(record: ApplicationRecord) -> tuple[str, str, str, str]:
    return (
        (record.company_name or "").strip(),
        (record.job_title or "").strip(),
        (record.location or "").strip(),
        (record.job_link or "").strip(),
    )


def _signature_key(values: tuple[str, str, str, str]) -> str:
    return "|".join(values)


def _record_to_values(record: ApplicationRecord) -> dict[str, Any]:
    values = {
        "company_name": record.company_name or "",
        "job_title": record.job_title or "",
        "location": record.location or "",
        "job_link": record.job_link or "",
        "source": record.source or "",
        "salary_text": record.salary_text or "",
        "updated_at": record.updated_at_value.isoformat() if record.updated_at_value else "",
    }
    custom_values = record.custom_values or {}
    if isinstance(custom_values, dict):
        values.update(custom_values)
    return values


def _serialize_table(table: ApplicationTable, record_count: int = 0) -> dict[str, Any]:
    return {
        "id": table.id,
        "name": table.name,
        "is_total": table.is_total,
        "record_count": record_count,
        "schema": _normalize_schema(table.schema_json),
        "created_at": str(table.created_at),
        "updated_at": str(table.updated_at),
    }


def _serialize_settings(settings: ApplicationWorkspaceSettings) -> dict[str, Any]:
    return {
        "auto_row_height": settings.auto_row_height,
        "auto_column_width": settings.auto_column_width,
        "delete_subtable_sync_total_default": settings.delete_subtable_sync_total_default,
        "updated_at": str(settings.updated_at),
    }


async def _get_settings(db: AsyncSession) -> ApplicationWorkspaceSettings:
    settings = (
        await db.execute(select(ApplicationWorkspaceSettings).order_by(ApplicationWorkspaceSettings.id.asc()))
    ).scalars().first()
    if settings:
        return settings
    settings = ApplicationWorkspaceSettings()
    db.add(settings)
    await db.flush()
    return settings


async def _get_template(db: AsyncSession) -> ApplicationTemplate:
    template = (await db.execute(select(ApplicationTemplate).order_by(ApplicationTemplate.id.asc()))).scalars().first()
    if template:
        template.schema_json = _normalize_schema(template.schema_json)
        return template
    template = ApplicationTemplate(schema_json=_default_template_schema())
    db.add(template)
    await db.flush()
    return template


async def _get_total_table(db: AsyncSession) -> ApplicationTable:
    table = (await db.execute(select(ApplicationTable).where(ApplicationTable.is_total.is_(True)))).scalars().first()
    if table:
        return table
    template = await _get_template(db)
    table = ApplicationTable(
        name="总表",
        is_total=True,
        schema_json=copy.deepcopy(template.schema_json),
    )
    db.add(table)
    await db.flush()
    return table


async def ensure_workspace_bootstrap(db: AsyncSession) -> None:
    await _get_settings(db)
    template = await _get_template(db)
    total_table = await _get_total_table(db)
    total_table.schema_json = _normalize_schema(total_table.schema_json or template.schema_json)

    subtable_count = (
        await db.execute(
            select(func.count(ApplicationTable.id)).where(ApplicationTable.is_total.is_(False))
        )
    ).scalar_one()
    if subtable_count == 0:
        db.add(
            ApplicationTable(
                name="新建表",
                is_total=False,
                schema_json=copy.deepcopy(template.schema_json),
            )
        )
    await db.commit()


async def recompute_duplicate_flags(db: AsyncSession) -> None:
    records = (await db.execute(select(ApplicationRecord))).scalars().all()
    grouped: dict[tuple[str, str, str, str], list[ApplicationRecord]] = {}
    for record in records:
        grouped.setdefault(_record_signature(record), []).append(record)

    for signature, items in grouped.items():
        duplicate = len(items) > 1
        group_key = _signature_key(signature) if duplicate else ""
        for item in items:
            item.is_duplicate = duplicate
            item.duplicate_group = group_key


async def get_workspace_payload(db: AsyncSession) -> dict[str, Any]:
    await ensure_workspace_bootstrap(db)
    settings = await _get_settings(db)
    template = await _get_template(db)

    tables = (
        await db.execute(
            select(ApplicationTable).order_by(ApplicationTable.is_total.desc(), ApplicationTable.created_at.asc())
        )
    ).scalars().all()
    count_rows = (
        await db.execute(
            select(
                ApplicationTableRecord.table_id,
                func.count(ApplicationTableRecord.record_id).label("count"),
            )
            .join(ApplicationRecord, ApplicationRecord.id == ApplicationTableRecord.record_id)
            .outerjoin(Job, Job.id == ApplicationRecord.job_ref_id)
            .where(_public_application_record_filter())
            .group_by(ApplicationTableRecord.table_id)
        )
    ).all()
    count_map = {int(row.table_id): int(row.count) for row in count_rows}

    current_table = next((table for table in tables if not table.is_total), tables[0])
    total_records = (
        await db.execute(
            select(func.count(ApplicationRecord.id))
            .outerjoin(Job, Job.id == ApplicationRecord.job_ref_id)
            .where(_public_application_record_filter())
        )
    ).scalar_one()
    duplicate_records = (
        await db.execute(
            select(func.count(ApplicationRecord.id))
            .outerjoin(Job, Job.id == ApplicationRecord.job_ref_id)
            .where(_public_application_record_filter(), ApplicationRecord.is_duplicate.is_(True))
        )
    ).scalar_one()

    return {
        "tables": [_serialize_table(table, count_map.get(table.id, 0)) for table in tables],
        "current_table_id": current_table.id,
        "settings": _serialize_settings(settings),
        "template_schema": _normalize_schema(template.schema_json),
        "stats": {
            "total_records": int(total_records or 0),
            "duplicate_records": int(duplicate_records or 0),
        },
    }


async def get_table_or_raise(db: AsyncSession, table_id: int) -> ApplicationTable:
    await ensure_workspace_bootstrap(db)
    table = (
        await db.execute(select(ApplicationTable).where(ApplicationTable.id == table_id))
    ).scalars().first()
    if not table:
        raise ValueError("目标表不存在")
    return table


async def list_table_records(
    db: AsyncSession,
    table_id: int,
    keyword: str = "",
) -> dict[str, Any]:
    table = await get_table_or_raise(db, table_id)
    pattern = f"%{keyword.strip()}%" if keyword.strip() else ""

    stmt = (
        select(ApplicationRecord)
        .join(
            ApplicationTableRecord,
            ApplicationTableRecord.record_id == ApplicationRecord.id,
        )
        .outerjoin(Job, Job.id == ApplicationRecord.job_ref_id)
        .where(ApplicationTableRecord.table_id == table.id, _public_application_record_filter())
        .order_by(ApplicationRecord.updated_at.desc(), ApplicationRecord.id.desc())
    )
    if pattern:
        stmt = stmt.where(
            or_(
                ApplicationRecord.company_name.ilike(pattern),
                ApplicationRecord.job_title.ilike(pattern),
                ApplicationRecord.location.ilike(pattern),
                ApplicationRecord.job_link.ilike(pattern),
                ApplicationRecord.source.ilike(pattern),
                ApplicationRecord.salary_text.ilike(pattern),
            )
        )

    records = (await db.execute(stmt)).scalars().all()
    items = []
    for record in records:
        items.append(
            {
                "id": record.id,
                "values": _record_to_values(record),
                "is_duplicate": record.is_duplicate,
                "duplicate_group": record.duplicate_group,
                "created_at": str(record.created_at),
                "updated_at": str(record.updated_at),
            }
        )

    return {
        "table": _serialize_table(table, len(items)),
        "records": items,
    }


async def create_subtable(db: AsyncSession, name: str) -> dict[str, Any]:
    await ensure_workspace_bootstrap(db)
    template = await _get_template(db)
    clean_name = (name or "").strip() or "未命名表"
    table = ApplicationTable(
        name=clean_name,
        is_total=False,
        schema_json=copy.deepcopy(_normalize_schema(template.schema_json)),
    )
    db.add(table)
    await db.commit()
    await db.refresh(table)
    return _serialize_table(table, 0)


async def rename_table(db: AsyncSession, table_id: int, name: str) -> dict[str, Any]:
    table = await get_table_or_raise(db, table_id)
    if table.is_total:
        raise ValueError("总表不可重命名")
    clean_name = (name or "").strip()
    if not clean_name:
        raise ValueError("表名不能为空")
    table.name = clean_name
    await db.commit()
    await db.refresh(table)
    count = (
        await db.execute(
            select(func.count(ApplicationTableRecord.id)).where(ApplicationTableRecord.table_id == table.id)
        )
    ).scalar_one()
    return _serialize_table(table, int(count or 0))


async def delete_subtable(db: AsyncSession, table_id: int) -> dict[str, Any]:
    table = await get_table_or_raise(db, table_id)
    if table.is_total:
        raise ValueError("总表不可删除")

    await db.delete(table)
    await db.flush()

    remaining_subtables = (
        await db.execute(select(ApplicationTable).where(ApplicationTable.is_total.is_(False)))
    ).scalars().all()
    created_default = False
    if not remaining_subtables:
        template = await _get_template(db)
        db.add(
            ApplicationTable(
                name="新建表",
                is_total=False,
                schema_json=copy.deepcopy(_normalize_schema(template.schema_json)),
            )
        )
        created_default = True
    await db.commit()
    return {"deleted_table_id": table_id, "created_default_subtable": created_default}


def _job_value(job: Job, attrs: tuple[str, ...]) -> str:
    for attr in attrs:
        value = getattr(job, attr, "")
        if value:
            return str(value)
    return ""


def _build_fixed_values_from_job(job: Job) -> dict[str, Any]:
    values: dict[str, Any] = {}
    for spec in FIXED_FIELD_SPECS:
        field_key = spec["field_key"]
        if field_key == "updated_at":
            values[field_key] = datetime.utcnow().isoformat()
            continue
        values[field_key] = _job_value(job, spec["job_attrs"])
    values["apply_status"] = "待投递"
    return values


def _extract_record_payload(values: dict[str, Any]) -> tuple[dict[str, str], dict[str, Any]]:
    fixed = {
        "company_name": str(values.get("company_name") or "").strip(),
        "job_title": str(values.get("job_title") or "").strip(),
        "location": str(values.get("location") or "").strip(),
        "job_link": str(values.get("job_link") or "").strip(),
        "source": str(values.get("source") or "").strip(),
        "salary_text": str(values.get("salary_text") or "").strip(),
    }
    custom: dict[str, Any] = {}
    for key, value in values.items():
        if key in FIXED_FIELD_KEYS:
            continue
        custom[_safe_field_key(key)] = value
    return fixed, custom


async def _ensure_link(db: AsyncSession, table_id: int, record_id: int) -> None:
    exists = (
        await db.execute(
            select(ApplicationTableRecord.id).where(
                ApplicationTableRecord.table_id == table_id,
                ApplicationTableRecord.record_id == record_id,
            )
        )
    ).scalar_one_or_none()
    if exists is None:
        db.add(ApplicationTableRecord(table_id=table_id, record_id=record_id))


async def _create_record_no_commit(
    db: AsyncSession,
    *,
    target_table: ApplicationTable,
    total_table: ApplicationTable,
    values: dict[str, Any],
    job_ref_id: int | None,
) -> ApplicationRecord:
    fixed, custom = _extract_record_payload(values)
    record = ApplicationRecord(
        job_ref_id=job_ref_id,
        company_name=fixed["company_name"],
        job_title=fixed["job_title"],
        location=fixed["location"],
        job_link=fixed["job_link"],
        source=fixed["source"],
        salary_text=fixed["salary_text"],
        updated_at_value=_coerce_datetime(values.get("updated_at")),
        custom_values=custom,
    )
    db.add(record)
    await db.flush()
    await _ensure_link(db, target_table.id, record.id)
    if not target_table.is_total:
        await _ensure_link(db, total_table.id, record.id)
    return record


async def create_record(
    db: AsyncSession,
    *,
    table_id: int,
    values: dict[str, Any],
    job_ref_id: int | None = None,
) -> dict[str, Any]:
    target_table = await get_table_or_raise(db, table_id)
    total_table = await _get_total_table(db)
    record = await _create_record_no_commit(
        db,
        target_table=target_table,
        total_table=total_table,
        values=values,
        job_ref_id=job_ref_id,
    )
    await recompute_duplicate_flags(db)
    await db.commit()
    await db.refresh(record)
    event_warning = None
    try:
        from app.services.application_events import application_event_store

        current_values = _record_to_values(record)
        application_event_store.record(
            application_type="application_record",
            application_id=record.id,
            event_type="created",
            source="application_workspace",
            field_key="status",
            value=current_values.get("apply_status") or "待投递",
            metadata={"job_id": record.job_ref_id, "table_id": table_id},
        )
    except Exception as exc:
        event_warning = safe_error_message(exc)
    return {
        "id": record.id,
        "values": _record_to_values(record),
        "is_duplicate": record.is_duplicate,
        "duplicate_group": record.duplicate_group,
        "event_warning": event_warning,
    }


async def create_records_from_jobs(
    db: AsyncSession,
    *,
    table_id: int,
    job_ids: list[int],
    skip_existing_in_table: bool = False,
) -> dict[str, Any]:
    if not job_ids:
        raise ValueError("job_ids 不能为空")

    target_table = await get_table_or_raise(db, table_id)
    total_table = await _get_total_table(db)

    jobs = (
        await db.execute(select(Job).where(Job.id.in_(job_ids)))
    ).scalars().all()
    job_map = {job.id: job for job in jobs}
    missing = [job_id for job_id in job_ids if job_id not in job_map]
    if missing:
        raise ValueError(f"以下岗位不存在: {missing}")

    existing_job_ids: set[int] = set()
    if skip_existing_in_table:
        existing_rows = (
            await db.execute(
                select(ApplicationRecord.job_ref_id)
                .join(
                    ApplicationTableRecord,
                    ApplicationTableRecord.record_id == ApplicationRecord.id,
                )
                .where(
                    ApplicationTableRecord.table_id == target_table.id,
                    ApplicationRecord.job_ref_id.in_(job_ids),
                )
            )
        ).scalars().all()
        existing_job_ids = {int(job_id) for job_id in existing_rows if job_id is not None}

    created_records: list[ApplicationRecord] = []
    skipped_existing_job_ids: list[int] = []
    for job_id in job_ids:
        if job_id in existing_job_ids:
            skipped_existing_job_ids.append(job_id)
            continue

        job = job_map[job_id]
        values = _build_fixed_values_from_job(job)
        record = await _create_record_no_commit(
            db,
            target_table=target_table,
            total_table=total_table,
            values=values,
            job_ref_id=job.id,
        )
        created_records.append(record)

    await recompute_duplicate_flags(db)
    await db.commit()
    for record in created_records:
        await db.refresh(record)

    event_warnings: list[str] = []
    try:
        from app.services.application_events import application_event_store
    except Exception as exc:
        event_warnings.append(safe_error_message(exc))
    else:
        for record in created_records:
            try:
                values = _record_to_values(record)
                application_event_store.record(
                    application_type="application_record",
                    application_id=record.id,
                    event_type="created",
                    source="application_workspace",
                    field_key="status",
                    value=values.get("apply_status") or "待投递",
                    metadata={"job_id": record.job_ref_id, "table_id": table_id},
                )
            except Exception as exc:
                event_warnings.append(safe_error_message(exc))

    duplicate_count = sum(1 for record in created_records if record.is_duplicate)
    return {
        "created": len(created_records),
        "skipped_existing": len(skipped_existing_job_ids),
        "skipped_existing_job_ids": skipped_existing_job_ids,
        "duplicate_created": duplicate_count,
        "event_warnings": event_warnings,
        "items": [
            {
                "id": record.id,
                "is_duplicate": record.is_duplicate,
                "duplicate_group": record.duplicate_group,
            }
            for record in created_records
        ],
    }


async def auto_write_job_to_total(
    db: AsyncSession,
    *,
    job_id: int,
) -> dict[str, Any]:
    await ensure_workspace_bootstrap(db)
    job = (await db.execute(select(Job).where(Job.id == job_id))).scalars().first()
    if not job:
        raise ValueError("岗位不存在")
    total_table = await _get_total_table(db)
    result = await create_records_from_jobs(db, table_id=total_table.id, job_ids=[job_id])
    return {"total_table_id": total_table.id, **result}


async def update_record_value(
    db: AsyncSession,
    *,
    record_id: int,
    field_key: str,
    value: Any,
    source: str = "application_workspace",
) -> dict[str, Any]:
    await ensure_workspace_bootstrap(db)
    record = (
        await db.execute(select(ApplicationRecord).where(ApplicationRecord.id == record_id))
    ).scalars().first()
    if not record:
        raise ValueError("记录不存在")

    key = _safe_field_key(field_key)
    if key in FIXED_FIELD_KEYS:
        previous_value = getattr(record, key, None)
    else:
        previous_value = (record.custom_values or {}).get(key)
    if key in FIXED_FIELD_KEYS:
        if key == "company_name":
            record.company_name = str(value or "")
        elif key == "job_title":
            record.job_title = str(value or "")
        elif key == "location":
            record.location = str(value or "")
        elif key == "job_link":
            record.job_link = str(value or "")
        elif key == "source":
            record.source = str(value or "")
        elif key == "salary_text":
            record.salary_text = str(value or "")
        elif key == "updated_at":
            record.updated_at_value = _coerce_datetime(value)
    else:
        custom_values = dict(record.custom_values or {})
        custom_values[key] = value
        record.custom_values = custom_values
        record.updated_at_value = datetime.utcnow()

    if key in FIXED_FIELD_KEYS and key != "updated_at":
        record.updated_at_value = datetime.utcnow()

    if key in {"company_name", "job_title", "location", "job_link"}:
        await recompute_duplicate_flags(db)
    await db.commit()
    await db.refresh(record)
    event_warning = None
    if previous_value != value:
        try:
            from app.services.application_events import application_event_store

            application_event_store.record(
                application_type="application_record",
                application_id=record.id,
                event_type="status_changed" if key == "apply_status" else "field_updated",
                source=source,
                field_key="status" if key == "apply_status" else key,
                previous_value=previous_value,
                value=value,
                metadata={"job_id": record.job_ref_id},
            )
        except Exception as exc:
            event_warning = safe_error_message(exc)
    return {
        "id": record.id,
        "values": _record_to_values(record),
        "is_duplicate": record.is_duplicate,
        "duplicate_group": record.duplicate_group,
        "event_warning": event_warning,
    }


async def move_records_to_table(
    db: AsyncSession,
    *,
    source_table_id: int,
    target_table_id: int,
    record_ids: list[int],
) -> dict[str, Any]:
    if not record_ids:
        raise ValueError("record_ids 不能为空")
    if source_table_id == target_table_id:
        raise ValueError("源表和目标表不能相同")

    source_table = await get_table_or_raise(db, source_table_id)
    target_table = await get_table_or_raise(db, target_table_id)
    total_table = await _get_total_table(db)

    source_links = (
        await db.execute(
            select(ApplicationTableRecord).where(
                ApplicationTableRecord.table_id == source_table.id,
                ApplicationTableRecord.record_id.in_(record_ids),
            )
        )
    ).scalars().all()
    source_link_map = {link.record_id: link for link in source_links}

    target_record_ids = set(
        (
            await db.execute(
                select(ApplicationTableRecord.record_id).where(ApplicationTableRecord.table_id == target_table.id)
            )
        ).scalars().all()
    )
    target_records = (
        await db.execute(
            select(ApplicationRecord).where(ApplicationRecord.id.in_(list(target_record_ids)))
        )
    ).scalars().all() if target_record_ids else []
    target_signature_map = {_record_signature(item): item.id for item in target_records}

    moving_records = (
        await db.execute(select(ApplicationRecord).where(ApplicationRecord.id.in_(record_ids)))
    ).scalars().all()
    moving_map = {record.id: record for record in moving_records}

    moved = 0
    already_exists: list[int] = []
    missing_from_source: list[int] = []

    for record_id in record_ids:
        source_link = source_link_map.get(record_id)
        record = moving_map.get(record_id)
        if source_link is None or record is None:
            missing_from_source.append(record_id)
            continue

        signature = _record_signature(record)
        existing_target_id = target_signature_map.get(signature)
        if existing_target_id is not None and existing_target_id != record_id:
            already_exists.append(record_id)
            continue

        if not target_table.is_total:
            await _ensure_link(db, target_table.id, record_id)
            await _ensure_link(db, total_table.id, record_id)
            target_signature_map[signature] = record_id

        if source_table.is_total:
            # 从总表不允许“移走”到子表：只做加入目标
            moved += 1
            continue

        await db.delete(source_link)
        if target_table.is_total:
            moved += 1
            continue
        moved += 1

    await db.commit()
    return {
        "moved": moved,
        "already_exists": already_exists,
        "missing_from_source": missing_from_source,
    }


async def delete_records_from_table(
    db: AsyncSession,
    *,
    table_id: int,
    record_ids: list[int],
    delete_from_total: bool,
) -> dict[str, Any]:
    if not record_ids:
        raise ValueError("record_ids 不能为空")

    table = await get_table_or_raise(db, table_id)
    deleted_global = 0
    removed_from_current = 0

    if table.is_total or delete_from_total:
        records = (
            await db.execute(
                select(ApplicationRecord).where(ApplicationRecord.id.in_(record_ids))
            )
        ).scalars().all()
        for record in records:
            await db.delete(record)
            deleted_global += 1
        await recompute_duplicate_flags(db)
    else:
        result = await db.execute(
            delete(ApplicationTableRecord).where(
                ApplicationTableRecord.table_id == table.id,
                ApplicationTableRecord.record_id.in_(record_ids),
            )
        )
        removed_from_current = int(result.rowcount or 0)

    await db.commit()
    return {
        "deleted_global": deleted_global,
        "removed_from_current": removed_from_current,
    }


async def update_table_schema(
    db: AsyncSession,
    *,
    table_id: int,
    schema: list[dict[str, Any]],
) -> dict[str, Any]:
    table = await get_table_or_raise(db, table_id)
    table.schema_json = _normalize_schema(schema)
    await db.commit()
    await db.refresh(table)
    count = (
        await db.execute(
            select(func.count(ApplicationTableRecord.id)).where(ApplicationTableRecord.table_id == table.id)
        )
    ).scalar_one()
    return _serialize_table(table, int(count or 0))


async def update_settings(
    db: AsyncSession,
    *,
    auto_row_height: bool | None = None,
    auto_column_width: bool | None = None,
    delete_subtable_sync_total_default: bool | None = None,
) -> dict[str, Any]:
    await ensure_workspace_bootstrap(db)
    settings = await _get_settings(db)
    if auto_row_height is not None:
        settings.auto_row_height = auto_row_height
    if auto_column_width is not None:
        settings.auto_column_width = auto_column_width
    if delete_subtable_sync_total_default is not None:
        settings.delete_subtable_sync_total_default = delete_subtable_sync_total_default
    await db.commit()
    await db.refresh(settings)
    return _serialize_settings(settings)


async def update_template_schema(
    db: AsyncSession,
    *,
    schema: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    await ensure_workspace_bootstrap(db)
    template = await _get_template(db)
    template.schema_json = _normalize_schema(schema)
    await db.commit()
    await db.refresh(template)
    return _normalize_schema(template.schema_json)


async def apply_template_to_all_tables(
    db: AsyncSession,
    *,
    purge_non_template_fields: bool = False,
) -> dict[str, Any]:
    await ensure_workspace_bootstrap(db)
    template = await _get_template(db)
    template_schema = _normalize_schema(template.schema_json)
    template_keys = {field["field_key"] for field in template_schema}

    tables = (await db.execute(select(ApplicationTable))).scalars().all()
    purge_keys: set[str] = set()
    updated_count = 0

    for table in tables:
        current_schema = _normalize_schema(table.schema_json)
        current_custom = [
            field
            for field in current_schema
            if field["field_key"] not in FIXED_FIELD_KEYS
        ]
        extra_custom = [field for field in current_custom if field["field_key"] not in template_keys]
        if purge_non_template_fields:
            purge_keys.update(field["field_key"] for field in extra_custom)
            table.schema_json = copy.deepcopy(template_schema)
        else:
            kept_hidden = []
            for field in extra_custom:
                field_copy = copy.deepcopy(field)
                field_copy["visible"] = False
                kept_hidden.append(field_copy)
            merged = copy.deepcopy(template_schema) + kept_hidden
            table.schema_json = _normalize_schema(merged)
        updated_count += 1

    if purge_non_template_fields and purge_keys:
        records = (await db.execute(select(ApplicationRecord))).scalars().all()
        for record in records:
            custom_values = dict(record.custom_values or {})
            changed = False
            for key in purge_keys:
                if key in custom_values:
                    custom_values.pop(key, None)
                    changed = True
            if changed:
                record.custom_values = custom_values

    await db.commit()
    return {
        "updated_tables": updated_count,
        "purged_keys": sorted(purge_keys),
        "template_schema": template_schema,
    }


async def save_template_schema_and_apply(
    db: AsyncSession,
    *,
    schema: list[dict[str, Any]],
    purge_non_template_fields: bool = False,
) -> dict[str, Any]:
    await ensure_workspace_bootstrap(db)
    template = await _get_template(db)
    template_schema = _normalize_schema(schema)
    template.schema_json = copy.deepcopy(template_schema)
    template_keys = {field["field_key"] for field in template_schema}

    tables = (await db.execute(select(ApplicationTable))).scalars().all()
    purge_keys: set[str] = set()
    updated_count = 0

    for table in tables:
        current_schema = _normalize_schema(table.schema_json)
        current_custom = [
            field
            for field in current_schema
            if field["field_key"] not in FIXED_FIELD_KEYS
        ]
        extra_custom = [field for field in current_custom if field["field_key"] not in template_keys]
        if purge_non_template_fields:
            purge_keys.update(field["field_key"] for field in extra_custom)
            table.schema_json = copy.deepcopy(template_schema)
        else:
            kept_hidden = []
            for field in extra_custom:
                field_copy = copy.deepcopy(field)
                field_copy["visible"] = False
                kept_hidden.append(field_copy)
            merged = copy.deepcopy(template_schema) + kept_hidden
            table.schema_json = _normalize_schema(merged)
        updated_count += 1

    if purge_non_template_fields and purge_keys:
        records = (await db.execute(select(ApplicationRecord))).scalars().all()
        for record in records:
            custom_values = dict(record.custom_values or {})
            changed = False
            for key in purge_keys:
                if key in custom_values:
                    custom_values.pop(key, None)
                    changed = True
            if changed:
                record.custom_values = custom_values

    await db.commit()
    return {
        "updated_tables": updated_count,
        "purged_keys": sorted(purge_keys),
        "template_schema": template_schema,
    }
