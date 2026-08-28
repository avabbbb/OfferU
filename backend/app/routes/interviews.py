from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field


router = APIRouter()


class InterviewCreate(BaseModel):
    title: str = "未命名面试"
    target_company: str = ""
    target_position: str = ""
    target_job_id: Optional[int] = None
    resume_id: Optional[int] = None
    profile_id: Optional[int] = None
    interview_type: str = "behavioral"
    difficulty: str = "medium"
    question_count: int = Field(5, ge=1, le=10)
    scoring_skill_id: str = "evidence-interview-score"
    scoring_skill_version: Optional[int] = None
    role_benchmark_run_id: Optional[str] = Field(default=None, min_length=1, max_length=64)
    model_provider: str
    data_consent: bool
    consented_data_categories: list[str]
    user_confirmed: bool


class MessageCreate(BaseModel):
    question_index: int = Field(ge=0)
    content: str = Field(min_length=1, max_length=30_000)
    model_provider: str
    user_confirmed: bool


class BehaviorEventsCreate(BaseModel):
    events: list[dict[str, Any]] = Field(min_length=1, max_length=200)
    user_confirmed: bool


class ScoringSkillCreate(BaseModel):
    skill_id: str
    name: str
    definition: dict[str, Any]
    user_confirmed: bool


class DeleteInterviewRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=500)
    user_confirmed: bool


class RestartInterviewRequest(BaseModel):
    user_confirmed: bool


def _operation_outputs(result: dict[str, Any]) -> dict[str, Any]:
    if not result.get("ok"):
        message = "；".join(str(item) for item in result.get("errors") or [])
        status = 404 if "不存在" in message or "not found" in message.lower() else 400
        raise HTTPException(status_code=status, detail=message or "操作失败")
    outputs = result.get("outputs")
    if not isinstance(outputs, dict):
        raise HTTPException(status_code=502, detail="操作返回了无效结果")
    return outputs


async def _execute(name: str, args: dict[str, Any]) -> dict[str, Any]:
    from app.ops import execute_operation

    result = await execute_operation(name, args, surface="interview_api")
    return _operation_outputs(result)


@router.get("/runtime")
async def interview_runtime():
    return await _execute("get_ai_interview_runtime", {})


@router.get("/scoring-skills")
async def scoring_skills(
    status: str = Query("active"),
    limit: int = Query(50, ge=1, le=200),
):
    return await _execute(
        "list_interview_scoring_skills",
        {"status": status, "limit": limit},
    )


@router.post("/scoring-skills")
async def create_scoring_skill(data: ScoringSkillCreate):
    return await _execute(
        "create_interview_scoring_skill",
        data.model_dump(),
    )


@router.get("/scoring-skills/{skill_id}")
async def scoring_skill(
    skill_id: str,
    version: Optional[int] = Query(None, ge=1),
):
    return await _execute(
        "get_interview_scoring_skill",
        {"skill_id": skill_id, "version": version},
    )


@router.get("/")
async def list_interviews(
    status: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=300),
):
    outputs = await _execute(
        "list_ai_interviews",
        {"status": status, "limit": limit},
    )
    return outputs.get("items", [])


@router.post("/")
async def create_interview(data: InterviewCreate):
    return await _execute("create_ai_interview", data.model_dump())


@router.get("/focus-plan")
async def prepare_role_interview_focus(
    job_id: int = Query(..., gt=0),
    run_id: Optional[str] = Query(None, min_length=1, max_length=64),
    profile_id: Optional[int] = Query(None, gt=0),
    focus_count: int = Query(5, ge=3, le=5),
    question_count: int = Query(5, ge=5, le=8),
):
    return await _execute(
        "prepare_role_interview_focus",
        {
            "job_id": job_id,
            "run_id": run_id,
            "profile_id": profile_id,
            "focus_count": focus_count,
            "question_count": question_count,
        },
    )


@router.get("/{interview_id}")
async def get_interview(
    interview_id: int,
    detail: str = Query("full"),
):
    return await _execute(
        "get_ai_interview",
        {"interview_id": interview_id, "detail": detail},
    )


@router.post("/{interview_id}/messages")
async def send_message(interview_id: int, data: MessageCreate):
    return await _execute(
        "submit_ai_interview_answer",
        {"interview_id": interview_id, **data.model_dump()},
    )


@router.post("/{interview_id}/behavior-events")
async def ingest_behavior_events(
    interview_id: int,
    data: BehaviorEventsCreate,
):
    return await _execute(
        "ingest_interview_behavior_events",
        {"interview_id": interview_id, **data.model_dump()},
    )


@router.post("/{interview_id}/restart")
async def restart_interview(
    interview_id: int,
    data: RestartInterviewRequest,
):
    return await _execute(
        "restart_ai_interview",
        {"interview_id": interview_id, **data.model_dump()},
    )


@router.delete("/{interview_id}")
async def delete_interview(
    interview_id: int,
    data: DeleteInterviewRequest,
):
    return await _execute(
        "delete_ai_interview",
        {"interview_id": interview_id, **data.model_dump()},
    )
