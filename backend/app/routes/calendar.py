# =============================================
# Calendar 路由 — 日程管理 API
# =============================================
# GET    /api/calendar/events     获取日程事件
# POST   /api/calendar/events     创建日程事件
# POST   /api/calendar/auto-fill  Agent 自动填充日程
# =============================================

from datetime import datetime
from typing import Optional

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
async def create_event(data: EventCreate, db: AsyncSession = Depends(get_db)):
    """手动创建日程事件"""
    event = CalendarEvent(
        title=data.title,
        description=data.description,
        event_type=data.event_type,
        start_time=data.start_time,
        end_time=data.end_time,
        location=data.location,
        related_job_id=data.related_job_id,
        related_notification_id=data.related_notification_id,
    )
    db.add(event)
    await db.commit()
    await db.refresh(event)
    return {"id": event.id, "message": "Event created"}


@router.post("/auto-fill")
async def auto_fill_events(db: AsyncSession = Depends(get_db)):
    """
    自动补建日历事件：扫描所有有 interview_time 但尚未关联 CalendarEvent 的通知。
    作为兜底机制 —— 正常 sync 时已自动创建，此接口处理遗漏。
    """
    from datetime import timedelta
    from app.models.models import InterviewNotification

    # 需要自动创建日历的分类
    auto_categories = {
        "written_test", "assessment",
        "interview_1", "interview_2", "interview_hr",
    }
    category_display = {
        "written_test": "笔试通知", "assessment": "在线测评",
        "interview_1": "初面/技术面", "interview_2": "复面/交叉面",
        "interview_hr": "HR面/终面",
    }

    # 找出有 interview_time 且未关联日历事件的通知
    subq = select(CalendarEvent.related_notification_id).where(
        CalendarEvent.related_notification_id.is_not(None)
    )
    stmt = (
        select(InterviewNotification)
        .where(
            InterviewNotification.interview_time.is_not(None),
            InterviewNotification.id.not_in(subq),
        )
    )
    result = await db.execute(stmt)
    notifications = result.scalars().all()

    created = 0
    for n in notifications:
        category = getattr(n, "category", "unknown")
        if category not in auto_categories:
            continue
        event = CalendarEvent(
            title=f"{category_display.get(category, '面试')} - {n.company}",
            description=f"岗位: {n.position}\n{getattr(n, 'action_required', '')}",
            event_type="interview",
            start_time=n.interview_time,
            end_time=n.interview_time + timedelta(hours=1),
            location=n.location or "",
            related_notification_id=n.id,
        )
        db.add(event)
        created += 1

    await db.commit()
    return {"created": created, "scanned": len(notifications)}
