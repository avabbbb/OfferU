# =============================================
# Calendar 路由 — 日程管理 API
# =============================================
# GET    /api/calendar/events     获取日程事件
# POST   /api/calendar/events     创建日程事件
# POST   /api/calendar/auto-fill  Agent 自动填充日程
# =============================================

from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel

from app.database import get_db
from app.models.models import CalendarEvent

router = APIRouter()


class EventCreate(BaseModel):
    title: str
    description: str = ""
    event_type: str = "interview"
    start_time: datetime
    end_time: Optional[datetime] = None
    location: str = ""
    related_job_id: Optional[int] = None
    related_notification_id: Optional[int] = None


async def _execute_operation(name: str, args: dict[str, Any]) -> Any:
    from app.ops import execute_operation

    result = await execute_operation(name, args, surface="calendar_api")
    if not result.get("ok"):
        message = "；".join(str(item) for item in result.get("errors") or [])
        status = 404 if "不存在" in message or "not found" in message.lower() else 400
        raise HTTPException(status_code=status, detail=message or "操作失败")
    return result.get("outputs")


@router.get("/events")
async def list_events(
    start: Optional[str] = None,
    end: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """获取日程事件列表，可按时间范围筛选"""
    query = select(CalendarEvent).order_by(CalendarEvent.start_time)

    if start:
        try:
            start_dt = datetime.fromisoformat(start)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"invalid start datetime: {start}")
        query = query.where(CalendarEvent.start_time >= start_dt)
    if end:
        try:
            end_dt = datetime.fromisoformat(end)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"invalid end datetime: {end}")
        query = query.where(CalendarEvent.start_time <= end_dt)

    result = await db.execute(query)
    events = result.scalars().all()
    return [
        {
            "id": e.id,
            "title": e.title,
            "description": e.description,
            "event_type": e.event_type,
            "start_time": e.start_time.isoformat(),
            "end_time": e.end_time.isoformat() if e.end_time else None,
            "location": e.location,
            "related_job_id": e.related_job_id,
            "related_notification_id": e.related_notification_id,
        }
        for e in events
    ]


@router.post("/events")
async def create_event(data: EventCreate):
    """手动创建日程事件"""
    return await _execute_operation("create_calendar_event", data.model_dump())


@router.post("/auto-fill")
async def auto_fill_events():
    """
    自动补建日历事件：扫描所有有 interview_time 但尚未关联 CalendarEvent 的通知。
    作为兜底机制 —— 正常 sync 时已自动创建，此接口处理遗漏。
    """
    return await _execute_operation("auto_fill_calendar_events", {})
