# =============================================
# Pools 路由 — 岗位池（文件夹）管理 API
# =============================================
# GET    /api/pools/         获取池列表
# POST   /api/pools/         创建池
# PUT    /api/pools/{id}     重命名池
# DELETE /api/pools/{id}     删除池（岗位转为未分组）
# =============================================

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.models import Job, Pool
from app.ops import execute_operation
from app.services.security_redaction import safe_error_message

router = APIRouter()
POOL_SCOPES = {"inbox", "picked", "ignored"}


class PoolCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    scope: str = Field(default="picked", max_length=20)
    description: str = Field(default="", max_length=500)
    color: str = Field(default="#3B82F6", max_length=20)
    sort_order: int = 0


class PoolUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    description: Optional[str] = Field(default=None, max_length=500)
    color: Optional[str] = Field(default=None, max_length=20)
    sort_order: Optional[int] = None


def _serialize_pool(pool: Pool, job_count: int = 0) -> dict:
    return {
        "id": pool.id,
        "name": pool.name,
        "scope": pool.scope,
        "description": pool.description or "",
        "color": pool.color or "#3B82F6",
        "sort_order": pool.sort_order or 0,
        "job_count": job_count,
        "created_at": str(pool.created_at),
        "updated_at": str(pool.updated_at),
    }


@router.get("/")
async def list_pools(
    scope: Optional[str] = Query(default=None, description="inbox / picked / ignored"),
    db: AsyncSession = Depends(get_db),
):
    """获取岗位池列表及每个池的岗位数量"""
    if scope and scope not in POOL_SCOPES:
        raise HTTPException(status_code=400, detail="invalid pool scope")

    counts_subquery = (
        select(
            Job.pool_id.label("pool_id"),
            func.count(Job.id).label("job_count"),
        )
        .where(Job.pool_id.is_not(None))
        .group_by(Job.pool_id)
        .subquery()
    )

    if scope:
        counts_subquery = (
            select(
                Job.pool_id.label("pool_id"),
                func.count(Job.id).label("job_count"),
            )
            .where(Job.pool_id.is_not(None), Job.triage_status == scope)
            .group_by(Job.pool_id)
            .subquery()
        )

    query = (
        select(Pool, func.coalesce(counts_subquery.c.job_count, 0).label("job_count"))
        .outerjoin(counts_subquery, counts_subquery.c.pool_id == Pool.id)
        .order_by(Pool.sort_order.asc(), Pool.created_at.desc())
    )
    if scope:
        query = query.where(Pool.scope == scope)

    result = await db.execute(query)
    rows = result.all()
    return [_serialize_pool(pool, job_count or 0) for pool, job_count in rows]


@router.post("/")
async def create_pool(data: PoolCreateRequest, db: AsyncSession = Depends(get_db)):
    """创建岗位池（名称大小写不敏感）"""
    result = await execute_operation(
        "create_pool",
        data.model_dump(),
        surface="ui",
    )
    return _operation_output_or_error(result)


@router.put("/{pool_id}")
async def update_pool(
    pool_id: int,
    data: PoolUpdateRequest,
    scope: Optional[str] = Query(default=None, description="inbox / picked / ignored"),
    db: AsyncSession = Depends(get_db),
):
    """重命名岗位池"""
    payload = data.model_dump(exclude_unset=True)
    payload["pool_id"] = pool_id
    result = await execute_operation("update_pool", payload, surface="ui")
    return _operation_output_or_error(result)


@router.delete("/{pool_id}")
async def delete_pool(
    pool_id: int,
    scope: Optional[str] = Query(default=None, description="inbox / picked / ignored"),
    db: AsyncSession = Depends(get_db),
):
    """删除岗位池，池内岗位转为未分组（pool_id=null）"""
    result = await execute_operation("delete_pool", {"pool_id": pool_id}, surface="ui")
    return _operation_output_or_error(result)


def _operation_output_or_error(result: dict) -> dict:
    if result.get("ok"):
        return result.get("outputs") or {}
    detail = "; ".join(
        safe_error_message(ValueError(str(item)))
        for item in (result.get("errors") or ["operation failed"])
    )
    status_code = 404 if "not found" in detail.lower() else 400
    if "already exists" in detail.lower():
        status_code = 409
    raise HTTPException(status_code=status_code, detail=detail)
