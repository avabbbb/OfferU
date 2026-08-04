from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field


router = APIRouter()


class AuthorizedResearchStartRequest(BaseModel):
    job_id: int
    platform: str
    initial_url: str
    user_authorized: bool
    base_run_id: Optional[str] = None
    expires_minutes: int = Field(30, ge=5, le=120)


class AuthorizedResearchActivateRequest(BaseModel):
    user_confirmed_login_complete: bool


class AuthorizedResearchCaptureRequest(BaseModel):
    dossier_scope: str
    source_class: str
    user_confirmed_capture: bool
    publisher: str = ""
    published_at: Optional[str] = None
    selected_text: str = ""


class AuthorizedResearchCompleteRequest(BaseModel):
    findings: list[dict[str, Any]]
    user_confirmed_findings: bool
    gaps: list[str] = Field(default_factory=list)


class AuthorizedResearchCancelRequest(BaseModel):
    reason: str


class JobResearchReviewRequest(BaseModel):
    action: str = Field(pattern="^(accept|reject)$")
    note: str = Field("", max_length=2000)


class PreApplicationDecisionPrepareRequest(BaseModel):
    research_run_id: Optional[str] = Field(default=None, min_length=1, max_length=80)


class PreApplicationDecisionReviewRequest(BaseModel):
    final_decision: str = Field(
        pattern="^(go|conditional_go|no_go|insufficient_evidence)$"
    )
    note: str = Field("", max_length=2000)


def _operation_outputs(result: dict[str, Any]) -> dict[str, Any]:
    if not result.get("ok"):
        message = "；".join(str(item) for item in result.get("errors") or [])
        raise HTTPException(status_code=400, detail=message or "操作失败")
    outputs = result.get("outputs")
    if not isinstance(outputs, dict):
        raise HTTPException(status_code=502, detail="操作返回了无效结果")
    return outputs


async def _execute(name: str, args: dict[str, Any]) -> dict[str, Any]:
    from app.ops import execute_operation

    result = await execute_operation(name, args, surface="research_api")
    return _operation_outputs(result)


@router.get("/job-runs")
async def job_research_runs(
    job_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
    limit: int = Query(20, ge=1, le=100),
):
    return await _execute(
        "list_job_research_runs",
        {"job_id": job_id, "status": status, "limit": limit},
    )


@router.get("/job-runs/{run_id}")
async def job_research_run(run_id: str):
    return await _execute("get_job_research", {"run_id": run_id})


@router.post("/job-runs/{run_id}/review")
async def review_job_research_run(
    run_id: str,
    data: JobResearchReviewRequest,
):
    return await _execute(
        "review_job_research",
        {"run_id": run_id, **data.model_dump()},
    )


@router.get("/pre-application/{job_id}")
async def pre_application_state(job_id: int):
    return await _execute("get_pre_application_state", {"job_id": job_id})


@router.post("/pre-application/{job_id}/prepare")
async def prepare_pre_application_decision(
    job_id: int,
    data: PreApplicationDecisionPrepareRequest,
):
    return await _execute(
        "prepare_pre_application_decision",
        {"job_id": job_id, **data.model_dump()},
    )


@router.post("/pre-application/decisions/{decision_id}/review")
async def review_pre_application_decision(
    decision_id: str,
    data: PreApplicationDecisionReviewRequest,
):
    return await _execute(
        "review_pre_application_decision",
        {"decision_id": decision_id, **data.model_dump()},
    )


@router.post("/authorized-sessions")
async def start_authorized_session(
    data: AuthorizedResearchStartRequest,
):
    return await _execute(
        "start_authorized_research_session",
        data.model_dump(),
    )


@router.get("/authorized-sessions")
async def authorized_sessions(
    job_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
    limit: int = Query(20, ge=1, le=100),
):
    return await _execute(
        "list_authorized_research_sessions",
        {"job_id": job_id, "status": status, "limit": limit},
    )


@router.get("/authorized-sessions/{session_id}")
async def authorized_session(
    session_id: str,
    include_excerpts: bool = Query(False),
):
    return await _execute(
        "get_authorized_research_session",
        {
            "session_id": session_id,
            "include_excerpts": include_excerpts,
        },
    )


@router.post("/authorized-sessions/{session_id}/read-only")
async def activate_authorized_session(
    session_id: str,
    data: AuthorizedResearchActivateRequest,
):
    return await _execute(
        "activate_authorized_research_read_only",
        {
            "session_id": session_id,
            **data.model_dump(),
        },
    )


@router.post("/authorized-sessions/{session_id}/captures")
async def capture_authorized_page(
    session_id: str,
    data: AuthorizedResearchCaptureRequest,
):
    return await _execute(
        "capture_authorized_research_page",
        {
            "session_id": session_id,
            **data.model_dump(),
        },
    )


@router.post("/authorized-sessions/{session_id}/complete")
async def complete_authorized_session(
    session_id: str,
    data: AuthorizedResearchCompleteRequest,
):
    return await _execute(
        "complete_authorized_research_session",
        {
            "session_id": session_id,
            **data.model_dump(),
        },
    )


@router.post("/authorized-sessions/{session_id}/cancel")
async def cancel_authorized_session(
    session_id: str,
    data: AuthorizedResearchCancelRequest,
):
    return await _execute(
        "cancel_authorized_research_session",
        {
            "session_id": session_id,
            **data.model_dump(),
        },
    )
