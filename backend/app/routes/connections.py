"""Connections API — 前端 Connections 页消费的数据源状态投影。

只暴露用户可读的状态/能力/最近同步，绝不回传 CLI 细节、cookie、端口。
BOSS 显示为 "Experimental"，符合 Goal §8/§20。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from app.services.job_sources.protocol import JobSourceCapabilities, JobSourceStatus
from app.services.job_sources.router import job_source_router

router = APIRouter()

_CAP_LABELS = {
    "search": "job_discovery",
    "detail": "job_details",
    "recommend": "recommendations",
    "application_records": "application_progress",
    "inbox": "inbox",
}

_SOURCE_LABELS = {
    "manual": ("Manual", "Jobs you add by hand / URL"),
    "web": ("Web", "Existing captured & scraped jobs"),
    "boss": ("BOSS Zhipin", "Experimental local connector"),
}


def _cap_names(caps: JobSourceCapabilities) -> list[str]:
    return [name for field, name in _CAP_LABELS.items() if getattr(caps, field, False)]


@router.get("/")
async def list_connections() -> dict[str, Any]:
    """聚合所有注册 JobSource 的用户可读状态。"""
    statuses = await job_source_router.statuses()
    connections = []
    for src in job_source_router.sources():
        try:
            caps = await src.capabilities()
        except Exception:
            caps = JobSourceCapabilities()
        status = statuses.get(src.source_id, "UNAVAILABLE")
        label, blurb = _SOURCE_LABELS.get(src.source_id, (src.source_id, ""))
        experimental = src.source_id == "boss" or status == "EXPERIMENTAL"
        connections.append(
            {
                "source_id": src.source_id,
                "label": label,
                "description": blurb,
                "experimental": experimental,
                "status": status,
                "connected": status in ("READY", "EXPERIMENTAL", "DEGRADED"),
                "capabilities": _cap_names(caps),
                "last_sync": None,  # V1 不持久化 sync 记录；后续接 sync log
            }
        )
    return {"ok": True, "connections": connections}
