"""登录态平台采集的同意门：读条款和状态、同意、撤回。"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.core import consent

router = APIRouter()


class Agree(BaseModel):
    version: str


@router.get("/platform-collect")
def platform_collect_status():
    return consent.status()


@router.post("/platform-collect")
def platform_collect_agree(data: Agree):
    try:
        return consent.agree(data.version)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.delete("/platform-collect")
def platform_collect_revoke():
    return consent.revoke()
