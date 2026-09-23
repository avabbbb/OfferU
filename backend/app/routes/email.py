from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import get_db
from app.models.models import InterviewNotification
from app.services.email_sync import (
    DEFAULT_GMAIL_CALLBACK_URL,
    validate_gmail_redirect_uri,
)
from app.services.security_redaction import safe_error_message


router = APIRouter()

CATEGORY_DISPLAY = {
    "application": "网申确认",
    "written_test": "笔试通知",
    "assessment": "在线测评",
    "interview_1": "初面/技术面",
    "interview_2": "复面/交叉面",
    "interview_hr": "HR面/终面",
    "offer": "录用通知",
    "rejection": "拒信",
    "unknown": "其他",
}


class ImapConnectRequest(BaseModel):
    host: str = ""
    port: int = 993
    user: str
    password: str
    provider: str = ""


class EmailSyncRequest(BaseModel):
    account_id: Optional[str] = None


class RevokeEmailAccountRequest(BaseModel):
    reason: str


class ProgressSignalIngestRequest(BaseModel):
    channel: str = "email"
    account_ref: str
    external_message_id: str
    external_thread_id: str = ""
    sender: str = ""
    received_at: Optional[str] = None
    subject: str = ""
    body: str
    stage_hint: str = ""


class ProgressReviewRequest(BaseModel):
    action: str
    application_attempt_id: Optional[int] = None
    stage: str = ""
    note: str = ""
    add_calendar: bool = True
    create_record: bool = False


async def _execute_operation(name: str, args: Optional[dict] = None) -> dict:
    from app.ops import execute_operation

    result = await execute_operation(name, args or {}, surface="email_api")
    if not result.get("ok"):
        message = "；".join(
            safe_error_message(ValueError(str(item)))
            for item in result.get("errors") or []
        )
        raise HTTPException(status_code=400, detail=message or "操作失败")
    outputs = result.get("outputs")
    if not isinstance(outputs, dict):
        raise HTTPException(status_code=502, detail="操作返回了无效结果")
    return outputs


def _frontend_url() -> str:
    # OAuth callbacks are user-facing local navigation, not a configurable
    # provider endpoint. Keep them on the one supported OfferU web origin.
    return "http://127.0.0.1:7410"


def _redirect_uri(_request: Request) -> str:
    configured = get_settings().gmail_redirect_uri.strip()
    if not configured:
        return DEFAULT_GMAIL_CALLBACK_URL
    return validate_gmail_redirect_uri(configured)


@router.get("/auth-url")
async def get_auth_url(
    request: Request,
):
    try:
        redirect_uri = _redirect_uri(request)
    except ValueError as exc:
        raise HTTPException(status_code=503, detail=safe_error_message(exc)) from exc

    return await _execute_operation(
        "begin_gmail_oauth",
        {
            "redirect_uri": redirect_uri,
        },
    )


@router.get("/callback")
async def oauth_callback(
    code: str = Query(...),
    state: str = Query(...),
):
    await _execute_operation(
        "complete_gmail_oauth",
        {"code": code, "state": state},
    )
    return RedirectResponse(url=f"{_frontend_url()}/?auth=success#/email")


@router.post("/imap-connect")
async def imap_connect(data: ImapConnectRequest):
    return await _execute_operation(
        "connect_imap_account",
        data.model_dump(),
    )


@router.get("/status")
async def email_status():
    return await _execute_operation(
        "email_connection_status",
        {},
    )


@router.get("/accounts")
async def email_accounts(
    status: str = Query("active"),
    limit: int = Query(50, ge=1, le=200),
):
    return await _execute_operation(
        "list_email_accounts",
        {"status": status, "limit": limit},
    )


@router.post("/accounts/{account_id}/revoke")
async def revoke_account(account_id: str, data: RevokeEmailAccountRequest):
    return await _execute_operation(
        "revoke_email_account",
        {"account_id": account_id, "reason": data.reason},
    )


@router.post("/sync")
async def sync_emails(data: Optional[EmailSyncRequest] = None):
    return await _execute_operation(
        "sync_email_notifications",
        {"account_id": data.account_id} if data and data.account_id else {},
    )


@router.get("/sync-runs")
async def email_sync_runs(
    account_id: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=500),
):
    return await _execute_operation(
        "list_email_sync_runs",
        {"account_id": account_id, "status": status, "limit": limit},
    )


@router.get("/sync-runs/{run_id}")
async def email_sync_run(run_id: str):
    return await _execute_operation(
        "get_email_sync_run",
        {"run_id": run_id},
    )


@router.get("/notifications")
async def list_notifications(
    pending: bool = Query(False, description="仅返回未处理且需要操作的信号"),
    db: AsyncSession = Depends(get_db),
):
    query = select(InterviewNotification).order_by(
        InterviewNotification.created_at.desc()
    )
    if pending:
        query = query.where(
            InterviewNotification.action_required != "",
            InterviewNotification.acknowledged_at.is_(None),
        )
    result = await db.execute(query)
    return [
        {
            "id": item.id,
            "email_subject": item.email_subject,
            "email_from": item.email_from,
            "company": item.company,
            "position": item.position,
            "category": getattr(item, "category", "unknown"),
            "category_display": CATEGORY_DISPLAY.get(
                getattr(item, "category", "unknown"),
                "其他",
            ),
            "interview_time": (
                item.interview_time.isoformat() if item.interview_time else None
            ),
            "location": item.location,
            "action_required": getattr(item, "action_required", ""),
            "acknowledged_at": (
                item.acknowledged_at.isoformat()
                if getattr(item, "acknowledged_at", None)
                else None
            ),
            "parsed_at": str(item.parsed_at),
        }
        for item in result.scalars().all()
    ]


@router.post("/notifications/{notification_id}/ack")
async def ack_notification(
    notification_id: int,
    db: AsyncSession = Depends(get_db),
):
    from app.services.email_sync import acknowledge_notification

    item = await acknowledge_notification(notification_id, db)
    if item is None:
        raise HTTPException(status_code=404, detail="通知不存在")
    return {
        "ok": True,
        "id": item.id,
        "acknowledged_at": (
            item.acknowledged_at.isoformat() if item.acknowledged_at else None
        ),
    }


@router.post("/signals")
async def ingest_progress_signal(data: ProgressSignalIngestRequest):
    return await _execute_operation(
        "ingest_application_signal",
        data.model_dump(),
    )


@router.get("/progress-candidates")
async def progress_candidates(
    status: str = Query("pending"),
    disclosure: str = Query("summary"),
    limit: int = Query(100, ge=1, le=500),
):
    return await _execute_operation(
        "list_application_progress_candidates",
        {"status": status, "disclosure": disclosure, "limit": limit},
    )


@router.get("/progress-candidates/{candidate_id}")
async def progress_candidate_detail(candidate_id: str):
    return await _execute_operation(
        "get_application_progress_candidate",
        {"candidate_id": candidate_id},
    )


@router.post("/progress-candidates/{candidate_id}/review")
async def review_progress_candidate(
    candidate_id: str,
    data: ProgressReviewRequest,
):
    return await _execute_operation(
        "review_application_progress",
        {"candidate_id": candidate_id, **data.model_dump()},
    )


@router.get("/application-overview")
async def application_progress_overview(
    disclosure: str = Query("summary"),
    job_id: Optional[int] = Query(None),
    limit: int = Query(200, ge=1, le=500),
):
    return await _execute_operation(
        "get_application_progress_overview",
        {"disclosure": disclosure, "job_id": job_id, "limit": limit},
    )
