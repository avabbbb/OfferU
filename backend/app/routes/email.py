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


def _operation_outputs(result: dict) -> dict:
    if not result.get("ok"):
        message = "；".join(str(item) for item in result.get("errors") or [])
        raise HTTPException(status_code=400, detail=message or "操作失败")
    outputs = result.get("outputs")
    if not isinstance(outputs, dict):
        raise HTTPException(status_code=502, detail="操作返回了无效结果")
    return outputs


def _frontend_url() -> str:
    origins = [
        item.strip()
        for item in get_settings().cors_origins.split(",")
        if item.strip()
    ]
    return next(
        (item for item in origins if item.rstrip("/").endswith(":3300")),
        origins[0] if origins else "http://localhost:3300",
    )


def _redirect_uri(request: Request) -> str:
    return get_settings().gmail_redirect_uri or str(
        request.url_for("oauth_callback")
    )


@router.get("/auth-url")
async def get_auth_url(request: Request):
    from app.ops import execute_operation

    result = await execute_operation(
        "begin_gmail_oauth",
        {"redirect_uri": _redirect_uri(request)},
        surface="email_api",
    )
    return _operation_outputs(result)


@router.get("/callback")
async def oauth_callback(
    code: str = Query(...),
    state: str = Query(...),
):
    from app.ops import execute_operation

    result = await execute_operation(
        "complete_gmail_oauth",
        {"code": code, "state": state},
        surface="email_api",
    )
    _operation_outputs(result)
    return RedirectResponse(url=f"{_frontend_url()}/email?auth=success")


@router.post("/imap-connect")
async def imap_connect(data: ImapConnectRequest):
    from app.ops import execute_operation

    result = await execute_operation(
        "connect_imap_account",
        data.model_dump(),
        surface="email_api",
    )
    return _operation_outputs(result)


@router.get("/status")
async def email_status():
    from app.ops import execute_operation

    result = await execute_operation(
        "email_connection_status",
        {},
        surface="email_api",
    )
    return _operation_outputs(result)


@router.get("/accounts")
async def email_accounts(
    status: str = Query("active"),
    limit: int = Query(50, ge=1, le=200),
):
    from app.ops import execute_operation

    result = await execute_operation(
        "list_email_accounts",
        {"status": status, "limit": limit},
        surface="email_api",
    )
    return _operation_outputs(result)


@router.post("/accounts/{account_id}/revoke")
async def revoke_account(account_id: str, data: RevokeEmailAccountRequest):
    from app.ops import execute_operation

    result = await execute_operation(
        "revoke_email_account",
        {"account_id": account_id, "reason": data.reason},
        surface="email_api",
    )
    return _operation_outputs(result)


@router.post("/sync")
async def sync_emails(data: Optional[EmailSyncRequest] = None):
    from app.ops import execute_operation

    result = await execute_operation(
        "sync_email_notifications",
        {"account_id": data.account_id} if data and data.account_id else {},
        surface="email_api",
    )
    return _operation_outputs(result)


@router.get("/sync-runs")
async def email_sync_runs(
    account_id: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=500),
):
    from app.ops import execute_operation

    result = await execute_operation(
        "list_email_sync_runs",
        {"account_id": account_id, "status": status, "limit": limit},
        surface="email_api",
    )
    return _operation_outputs(result)


@router.get("/sync-runs/{run_id}")
async def email_sync_run(run_id: str):
    from app.ops import execute_operation

    result = await execute_operation(
        "get_email_sync_run",
        {"run_id": run_id},
        surface="email_api",
    )
    return _operation_outputs(result)


@router.get("/notifications")
async def list_notifications(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(InterviewNotification).order_by(
            InterviewNotification.created_at.desc()
        )
    )
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
            "parsed_at": str(item.parsed_at),
        }
        for item in result.scalars().all()
    ]


@router.post("/signals")
async def ingest_progress_signal(data: ProgressSignalIngestRequest):
    from app.ops import execute_operation

    result = await execute_operation(
        "ingest_application_signal",
        data.model_dump(),
        surface="email_api",
    )
    return _operation_outputs(result)


@router.get("/progress-candidates")
async def progress_candidates(
    status: str = Query("pending"),
    disclosure: str = Query("summary"),
    limit: int = Query(100, ge=1, le=500),
):
    from app.ops import execute_operation

    result = await execute_operation(
        "list_application_progress_candidates",
        {"status": status, "disclosure": disclosure, "limit": limit},
        surface="email_api",
    )
    return _operation_outputs(result)


@router.get("/progress-candidates/{candidate_id}")
async def progress_candidate_detail(candidate_id: str):
    from app.ops import execute_operation

    result = await execute_operation(
        "get_application_progress_candidate",
        {"candidate_id": candidate_id},
        surface="email_api",
    )
    return _operation_outputs(result)


@router.post("/progress-candidates/{candidate_id}/review")
async def review_progress_candidate(
    candidate_id: str,
    data: ProgressReviewRequest,
):
    from app.ops import execute_operation

    result = await execute_operation(
        "review_application_progress",
        {"candidate_id": candidate_id, **data.model_dump()},
        surface="email_api",
    )
    return _operation_outputs(result)


@router.get("/application-overview")
async def application_progress_overview(
    disclosure: str = Query("summary"),
    job_id: Optional[int] = Query(None),
    limit: int = Query(200, ge=1, le=500),
):
    from app.ops import execute_operation

    result = await execute_operation(
        "get_application_progress_overview",
        {"disclosure": disclosure, "job_id": job_id, "limit": limit},
        surface="email_api",
    )
    return _operation_outputs(result)
