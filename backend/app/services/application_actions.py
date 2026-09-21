"""Assisted application action boundary.

Read-side job discovery stays behind JobSource. External write actions are a
separate capability plane so platform adapters cannot silently become a second
Career Truth or bypass Proposal/HITL.

This module intentionally implements *preview only*. No external platform write
is performed here.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from typing import Any, Literal, Protocol, runtime_checkable

from sqlalchemy import select

from app.database import async_session
from app.models.models import ApplicationAttempt, Job
from app.services.pre_application_decisions import get_pre_application_state
from app.services.resume_workspace import get_resume_workspace


ApplicationActionKind = Literal[
    "greet",
    "send_message",
    "send_resume",
    "exchange_contact",
]
ApplicationActionStatus = Literal[
    "READY",
    "AUTH_REQUIRED",
    "DEGRADED",
    "UNAVAILABLE",
    "EXPERIMENTAL",
]

_ALLOWED_ACTIONS: frozenset[str] = frozenset(
    {"greet", "send_message", "send_resume", "exchange_contact"}
)
_READY_PRE_APPLICATION_STAGES: frozenset[str] = frozenset(
    {"ready_for_resume_proposal", "resume_proposal_ready"}
)


@dataclass(frozen=True)
class ApplicationActionCapabilities:
    """External write capabilities for one platform connector.

    These capabilities deliberately do not live on JobSourceCapabilities:
    reading/searching jobs and mutating an external recruitment platform are
    different trust boundaries.
    """

    greet: bool = False
    send_message: bool = False
    send_resume: bool = False
    exchange_contact: bool = False

    def supports(self, action: ApplicationActionKind) -> bool:
        return bool(getattr(self, action, False))


@dataclass(frozen=True)
class ApplicationActionRequest:
    source: str
    job_id: int
    external_job_ref: str
    action: ApplicationActionKind
    resume_id: int | None = None
    message: str = ""


@dataclass(frozen=True)
class ApplicationActionPreview:
    schema: str
    state: Literal["ready_for_proposal", "blocked"]
    action: ApplicationActionKind
    source: str
    job_id: int
    external_job_ref: str
    idempotency_key: str
    requires_confirmation: bool
    execution_available: bool
    blocking_reasons: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()
    materials: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["blocking_reasons"] = list(self.blocking_reasons)
        payload["warnings"] = list(self.warnings)
        return payload


@runtime_checkable
class ApplicationActionConnector(Protocol):
    """Write-plane connector for a recruitment platform.

    Implementations may use a CLI, browser bridge, or other user-authorized
    mechanism, but execution must still be invoked through a protected OfferU
    Operation. A JobSource implementation alone never satisfies this protocol.
    """

    source_id: str

    async def status(self) -> ApplicationActionStatus:
        ...

    async def capabilities(self) -> ApplicationActionCapabilities:
        ...

    async def preview(self, request: ApplicationActionRequest) -> ApplicationActionPreview:
        ...

    async def execute(
        self,
        request: ApplicationActionRequest,
        *,
        idempotency_key: str,
    ) -> dict[str, Any]:
        ...


def _message_fingerprint(message: str) -> str:
    return hashlib.sha256(message.encode("utf-8")).hexdigest() if message else ""


def application_action_idempotency_key(request: ApplicationActionRequest) -> str:
    """Stable key for exactly-once external action claims.

    Raw message text is not embedded in the key or returned payload; only its
    digest participates in identity.
    """

    payload = {
        "source": request.source,
        "job_id": request.job_id,
        "external_job_ref": request.external_job_ref,
        "action": request.action,
        "resume_id": request.resume_id,
        "message_sha256": _message_fingerprint(request.message),
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return "application_action:" + hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _external_ref(job: Job) -> str:
    source = str(job.source or "").strip()
    hash_key = str(job.hash_key or "").strip()
    prefix = f"{source}:"
    if source and hash_key.startswith(prefix):
        return hash_key[len(prefix):]
    return ""


def build_application_action_preview(
    *,
    request: ApplicationActionRequest,
    pre_application_stage: str,
    resume_packet: dict[str, Any] | None = None,
    has_application_attempt: bool = False,
) -> ApplicationActionPreview:
    """Pure planner used by the Operation and deterministic tests."""

    blockers: list[str] = []
    warnings: list[str] = [
        "这是 dry-run 计划；没有向外部招聘平台发送任何内容。",
        "真正外部写操作必须通过独立 ApplicationActionConnector 和 OfferU Proposal/HITL。",
    ]

    if request.action not in _ALLOWED_ACTIONS:
        raise ValueError(f"unsupported application action: {request.action}")
    if request.job_id <= 0:
        raise ValueError("job_id must be positive")
    if request.resume_id is not None and request.resume_id <= 0:
        raise ValueError("resume_id must be positive")
    if len(request.message) > 4000:
        raise ValueError("message exceeds 4000 characters")

    if pre_application_stage not in _READY_PRE_APPLICATION_STAGES:
        blockers.append("投前决策尚未确认投或有条件投。")

    if not request.source:
        blockers.append("岗位缺少可路由的数据源。")

    if not request.external_job_ref:
        warnings.append("当前岗位没有稳定 external_job_ref；执行器接入前需要先解析平台目标。")

    materials: dict[str, Any] = {
        "resume_id": request.resume_id,
        "message_present": bool(request.message.strip()),
        "resume_packet_status": None,
        "application_attempt_exists": bool(has_application_attempt),
    }

    if request.action == "send_resume":
        if request.resume_id is None:
            blockers.append("发送简历前必须选择一份岗位简历。")
        if resume_packet is None:
            blockers.append("发送简历前必须读取并验证 Application Packet。")
        else:
            materials["resume_packet_status"] = str(resume_packet.get("status") or "")
            if resume_packet.get("job_id") != request.job_id:
                blockers.append("Application Packet 与目标岗位不一致。")
            if resume_packet.get("resume_id") != request.resume_id:
                blockers.append("Application Packet 与所选简历不一致。")
            if resume_packet.get("status") != "ready":
                blockers.append("Application Packet 尚未 ready。")

    if request.action == "send_message" and not request.message.strip():
        blockers.append("发送消息前必须先准备可审阅的消息草稿。")

    if request.action == "exchange_contact" and not has_application_attempt:
        blockers.append("交换联系方式前需要已有的投递尝试记录。")

    return ApplicationActionPreview(
        schema="offeru.application_action_preview.v1",
        state="blocked" if blockers else "ready_for_proposal",
        action=request.action,
        source=request.source,
        job_id=request.job_id,
        external_job_ref=request.external_job_ref,
        idempotency_key=application_action_idempotency_key(request),
        requires_confirmation=True,
        execution_available=False,
        blocking_reasons=tuple(blockers),
        warnings=tuple(warnings),
        materials=materials,
    )


async def preview_application_action(
    *,
    job_id: int,
    action: ApplicationActionKind,
    resume_id: int | None = None,
    message: str = "",
) -> dict[str, Any]:
    """Build a reviewable action plan without touching the external platform."""

    if action not in _ALLOWED_ACTIONS:
        raise ValueError(f"unsupported application action: {action}")

    async with async_session() as db:
        job = await db.get(Job, job_id)
        if job is None:
            raise ValueError(f"Job #{job_id} 不存在")
        has_attempt = (
            await db.execute(
                select(ApplicationAttempt.id)
                .where(ApplicationAttempt.job_id == job_id)
                .limit(1)
            )
        ).scalar_one_or_none() is not None

    pre_application = await get_pre_application_state(job_id)
    resume_packet: dict[str, Any] | None = None
    resume_packet_error = ""
    if action == "send_resume" and resume_id is not None:
        try:
            workspace = await get_resume_workspace(resume_id)
        except ValueError as exc:
            # Preview is diagnostic: an unready/mismatched workspace should
            # become a blocker, not turn the dry-run endpoint into an error.
            resume_packet_error = str(exc)
        else:
            packet = workspace.get("application_packet")
            if isinstance(packet, dict):
                resume_packet = packet

    request = ApplicationActionRequest(
        source=str(job.source or "").strip(),
        job_id=job.id,
        external_job_ref=_external_ref(job),
        action=action,
        resume_id=resume_id,
        message=message,
    )
    preview = build_application_action_preview(
        request=request,
        pre_application_stage=str(pre_application.get("stage") or ""),
        resume_packet=resume_packet,
        has_application_attempt=has_attempt,
    )
    payload = preview.to_dict()
    if resume_packet_error:
        reasons = list(payload["blocking_reasons"])
        reasons.append(f"Application Packet 不可用：{resume_packet_error}")
        payload["blocking_reasons"] = list(dict.fromkeys(reasons))
        payload["state"] = "blocked"
    return payload


async def list_application_action_connectors() -> dict[str, Any]:
    """Read-only capability matrix for registered write-plane connectors.

    Phase 1 returns an honest empty/unavailable matrix — no external executor
    is wired, so this never claims an executable path exists.
    """
    from app.services.application_action_registry import (
        application_action_connector_registry,
    )

    return await application_action_connector_registry.capability_matrix()
