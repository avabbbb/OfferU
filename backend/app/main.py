# =============================================
# OfferU - FastAPI 应用入口
# =============================================
# 启动命令: uvicorn app.main:app --reload --host 127.0.0.1 --port 8766
# 职责：注册路由、CORS、生命周期事件
# =============================================

import os
import re
import logging
from contextlib import asynccontextmanager
from typing import Optional
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.config import get_settings
from app.services.diagnostics import new_error_id, record_error
from app.services.security_redaction import (
    redact_sensitive_text,
    redact_sensitive_value,
    safe_error_message,
)
from app.runtime_paths import runtime_uploads_dir

logger = logging.getLogger("offeru.api")
settings = get_settings()
from app.services.data_safety import apply_pending_restore_before_database_connect

# A staged restore must replace the SQLite file before app.database creates its
# engine. Data Safety is deliberately local SQLite-only; Docker development can
# use an external database and must not fail during import just because there is
# no local restore target. External database backup/restore belongs to that
# database's own operational boundary and is never reported as applied here.
if settings.database_url.strip().lower().startswith("sqlite"):
    startup_restore = apply_pending_restore_before_database_connect(
        database_url=settings.database_url,
    )
else:
    startup_restore = {
        "applied": False,
        "reason": "external_database_data_safety_not_applicable",
    }

from app.database import init_db
if settings.offeru_enable_mcp:
    try:
        from app.mcp_server import HAS_MCP_SERVER, mcp as mcp_server
        _HAS_MCP = HAS_MCP_SERVER
    except ImportError:
        mcp_server = None
        _HAS_MCP = False
else:
    mcp_server = None
    _HAS_MCP = False
from app.routes import jobs, resume, calendar, email, config, applications, scraper, pools, profile, profile_agent, optimize, interview, main_agent, interviews, research, memory, bridge, connections

@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用启动时初始化数据库表与 MCP 会话管理器。"""
    await init_db()
    # JobSource V1: local sources wrap the existing jobs table.
    from app.services.job_sources.router import job_source_router
    from app.services.job_sources.adapters.local import ManualJobSource, WebJobSource
    job_source_router.register(ManualJobSource())
    job_source_router.register(WebJobSource())
    from app.services.startup_recovery import (
        finish_startup_recovery,
        reset_startup_recovery,
        run_startup_recovery,
    )

    reset_startup_recovery()
    from app.services.agent_run_state import recover_interrupted_agent_runs

    await run_startup_recovery("agent_runs", recover_interrupted_agent_runs)
    from app.services.career_tasks import recover_career_tasks

    await run_startup_recovery("career_tasks", recover_career_tasks)
    from app.services.automation import recover_automation_events

    await run_startup_recovery("automation_events", recover_automation_events)
    from app.services.job_research import recover_interrupted_research_runs

    await run_startup_recovery("research_runs", recover_interrupted_research_runs)
    from app.services.ai_interviews import recover_interrupted_interview_state

    await run_startup_recovery("interview_state", recover_interrupted_interview_state)
    # Local engine discovery is optional and performs network probes. Keep it
    # out of the critical startup path so a stopped local engine or inherited
    # network policy can never hold the API before it begins serving requests.
    from app.services.coding_agent_runtime import recover_hosted_executor_sessions

    await run_startup_recovery("hosted_executors", recover_hosted_executor_sessions)
    from app.services.email_sync import (
        start_email_sync_service,
        stop_email_sync_service,
    )
    from app.services.authorized_research import (
        recover_authorized_research_sessions,
        stop_authorized_research_service,
    )
    from app.services.memory_distiller import (
        start_memory_distill_service,
        stop_memory_distill_service,
    )
    from app.services.work_sources import (
        start_work_source_auto_sync,
        stop_work_source_auto_sync,
    )

    await run_startup_recovery(
        "authorized_research",
        recover_authorized_research_sessions,
    )

    async def _start_memory_distill() -> None:
        start_memory_distill_service()

    async def _start_work_source_auto_sync() -> None:
        start_work_source_auto_sync()

    await run_startup_recovery("email_sync", start_email_sync_service)
    from app.services.boss_sync import start_boss_sync_service, stop_boss_sync_service

    await run_startup_recovery("boss_sync", start_boss_sync_service)
    await run_startup_recovery("memory_distill", _start_memory_distill)
    await run_startup_recovery(
        "work_source_auto_sync",
        _start_work_source_auto_sync,
    )
    finish_startup_recovery()
    try:
        if _HAS_MCP and mcp_server is not None:
            async with mcp_server.session_manager.run():
                yield
        else:
            yield
    finally:
        from app.services.coding_agent_runtime import shutdown_hosted_executors
        from app.services.embedded_agent_worker import close_embedded_agent_worker

        await shutdown_hosted_executors()
        await close_embedded_agent_worker()
        await stop_authorized_research_service()
        await stop_email_sync_service()
        await stop_boss_sync_service()
        await stop_memory_distill_service()
        await stop_work_source_auto_sync()


app = FastAPI(
    title="OfferU API",
    description="AI 驱动的智能求职助手后端",
    version="0.4.0",
    lifespan=lifespan,
)

# ---- CORS 允许前端跨域访问 ----
# cors_origins 以逗号分隔多个来源，如 "http://localhost:7410,http://127.0.0.1:7410"
# allow_credentials=True 允许带 cookie 的跨域请求（Gmail OAuth 回调需要）
#
# CORS_ORIGINS 可被系统环境变量静默覆盖（pydantic-settings 优先级 进程env > .env > 默认）。
# 一旦放宽为 * 或外部来源，任意网页即可跨域调用 8766 的未鉴权写端点（如 PUT /api/config
# 重指 LLM base_url 形成数据外泄链）。因此 env 提供的值必须过白名单：仅允许本机回环、
# tauri 协议与浏览器扩展来源；其余一律拒绝并明示，绝不静默放宽。
_CORS_ALLOWED_HOSTS = {"localhost", "127.0.0.1", "[::1]", "tauri.localhost"}


def _is_allowed_cors_origin(origin: str) -> bool:
    if origin in ("tauri://localhost",):
        return True
    try:
        parts = urlsplit(origin)
    except ValueError:
        return False
    if parts.scheme not in ("http", "https", "tauri"):
        return False
    host = (parts.hostname or "").lower()
    return host in _CORS_ALLOWED_HOSTS


_EXTENSION_ORIGIN = r"^(chrome-extension|ms-browser-extension)://[a-z0-9]{16,64}$"
cors_origins = []
_dropped_cors_origins: list[str] = []
for _origin in (o.strip() for o in settings.cors_origins.split(",")):
    if not _origin:
        continue
    if _is_allowed_cors_origin(_origin):
        if _origin not in cors_origins:
            cors_origins.append(_origin)
    else:
        _dropped_cors_origins.append(_origin)
if _dropped_cors_origins:
    logger.warning(
        "CORS_ORIGINS 含非本机来源已拒绝: %s（仅允许 localhost/127.0.0.1/tauri 来源）",
        _dropped_cors_origins,
    )
# 前端 dev 端口 7410 无条件可用：系统环境变量 CORS_ORIGINS 会覆盖 settings，
# 且该变量可能在旧值（5140/3000）上漂移，导致浏览器请求被 CORS 拦截。
for _offeru_frontend_origin in ("http://localhost:7410", "http://127.0.0.1:7410"):
    if _offeru_frontend_origin not in cors_origins:
        cors_origins.append(_offeru_frontend_origin)
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_origin_regex=_EXTENSION_ORIGIN,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Accept", "Content-Type"],
)

# The OfferU UI itself: the dev/web frontend and the desktop WebView.
_TRUSTED_WRITE_ORIGINS = frozenset(
    {
        *cors_origins,
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
        # `offeru start` serves the workbench from the API origin itself.
        "http://127.0.0.1:8766",
        "http://localhost:8766",
    }
)


def _safe_http_detail(detail: object) -> object:
    if isinstance(detail, (dict, list, tuple)):
        return redact_sensitive_value(detail)
    return redact_sensitive_text(detail, max_length=500)


def _error_response(
    request: Request,
    *,
    status_code: int,
    detail: object,
    kind: str,
    error_id: str | None = None,
    headers: dict[str, str] | None = None,
    diagnostic_message: object | None = None,
) -> JSONResponse:
    resolved_error_id = error_id or new_error_id()
    request.state.offeru_error_id = resolved_error_id
    record_error(
        resolved_error_id,
        method=request.method,
        path=request.url.path,
        status_code=status_code,
        kind=kind,
        message=detail if diagnostic_message is None else diagnostic_message,
    )
    response = JSONResponse(
        status_code=status_code,
        content={
            "detail": _safe_http_detail(detail),
            "error_id": resolved_error_id,
        },
        headers=headers,
    )
    response.headers["X-OfferU-Error-Id"] = resolved_error_id
    return response


@app.exception_handler(HTTPException)
async def offeru_http_exception_handler(
    request: Request,
    exc: HTTPException,
) -> JSONResponse:
    return _error_response(
        request,
        status_code=exc.status_code,
        detail=exc.detail or "请求失败",
        kind="http_exception",
        headers=dict(exc.headers or {}),
    )


@app.exception_handler(StarletteHTTPException)
async def offeru_starlette_http_exception_handler(
    request: Request,
    exc: StarletteHTTPException,
) -> JSONResponse:
    return _error_response(
        request,
        status_code=exc.status_code,
        detail=exc.detail or "请求失败",
        kind="starlette_http_exception",
        headers=dict(exc.headers or {}),
    )


@app.exception_handler(RequestValidationError)
async def offeru_validation_exception_handler(
    request: Request,
    exc: RequestValidationError,
) -> JSONResponse:
    # Deliberately omit FastAPI's `input` field: it can contain a pasted token,
    # cookie or other user-provided secret even when the validation message is safe.
    details = [
        {
            "loc": [str(part)[:80] for part in (item.get("loc") or [])[:8]],
            "type": redact_sensitive_text(item.get("type"), max_length=80),
            "msg": redact_sensitive_text(item.get("msg"), max_length=240),
        }
        for item in exc.errors()
    ][:20]
    return _error_response(
        request,
        status_code=422,
        detail=details,
        kind="validation_error",
    )


@app.exception_handler(Exception)
async def offeru_unhandled_exception_handler(
    request: Request,
    exc: Exception,
) -> JSONResponse:
    error_id = new_error_id()
    safe_message = safe_error_message(exc, fallback="未处理的服务器错误")
    logger.error(
        "Unhandled API error id=%s type=%s message=%s",
        error_id,
        type(exc).__name__,
        safe_message,
    )
    return _error_response(
        request,
        status_code=500,
        detail="服务器内部错误，请提供错误 ID。",
        kind="unhandled_exception",
        error_id=error_id,
        diagnostic_message=safe_message,
    )


_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1", "[::1]", "tauri.localhost"}


@app.middleware("http")
async def add_security_headers(request, call_next):
    # DNS-rebinding boundary: the API binds loopback and has no login, so a
    # hostile site could otherwise rebind to 127.0.0.1 and issue same-origin
    # writes. Reject any Host that is not loopback/tauri (fail-closed).
    raw_host = (request.headers.get("host") or "").strip().lower()
    # IPv6 字面量形如 [::1]:8766；按 ']' 取主机段，否则按 ':' 去端口。
    host_header = (
        raw_host[1 : raw_host.index("]")]
        if raw_host.startswith("[") and "]" in raw_host
        else raw_host.split(":", 1)[0]
    )
    if (
        request.url.path.startswith("/api/")
        or request.url.path.startswith("/mcp")
    ) and host_header not in _LOOPBACK_HOSTS:
        return _error_response(
            request,
            status_code=403,
            detail="请求被拒绝：仅允许本机回环来源",
            kind="forbidden_host",
        )
    # CSRF boundary: a button click runs directly (no second confirmation), so
    # a state-changing request must come from the OfferU UI itself. Browsers
    # always send Origin on cross-site writes; CLI/MCP/sidecar calls send none.
    origin = request.headers.get("origin")
    if (
        request.method not in ("GET", "HEAD", "OPTIONS")
        and origin
        and origin not in _TRUSTED_WRITE_ORIGINS
        and not re.match(_EXTENSION_ORIGIN, origin)
    ):
        return _error_response(
            request,
            status_code=403,
            detail="请求被拒绝：只接受 OfferU 自己页面发起的修改",
            kind="forbidden_origin",
        )
    try:
        response = await call_next(request)
    except Exception as exc:
        # Keep a final fail-closed boundary for exceptions raised by streaming
        # or middleware code before FastAPI can select an exception handler.
        response = _error_response(
            request,
            status_code=500,
            detail="服务器内部错误，请提供错误 ID。",
            kind="middleware_exception",
            diagnostic_message=safe_error_message(
                exc,
                fallback="未处理的服务器错误",
            ),
        )
        logger.error(
            "Unhandled middleware error id=%s type=%s message=%s",
            response.headers.get("X-OfferU-Error-Id", ""),
            type(exc).__name__,
            safe_error_message(exc, fallback="未处理的服务器错误"),
        )
    if response.status_code >= 400 and not response.headers.get("X-OfferU-Error-Id"):
        error_id = new_error_id()
        request.state.offeru_error_id = error_id
        record_error(
            error_id,
            method=request.method,
            path=request.url.path,
            status_code=response.status_code,
            kind="http_response",
            message=f"HTTP {response.status_code}",
        )
        response.headers["X-OfferU-Error-Id"] = error_id
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()")
    if request.url.path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-store")
    return response

# ---- 注册路由 ----
app.include_router(jobs.router, prefix="/api/jobs", tags=["Jobs"])
app.include_router(pools.router, prefix="/api/pools", tags=["Pools"])
app.include_router(profile.router, prefix="/api/profile", tags=["Profile"])
app.include_router(profile_agent.router, prefix="/api/profile/agent", tags=["Profile Agent"])
app.include_router(main_agent.router, prefix="/api/agent", tags=["Agent"])
app.include_router(main_agent.runtime_router, prefix="/api/agent", tags=["Agent Runtime"])
app.include_router(optimize.router, prefix="/api/optimize", tags=["Optimize"])
app.include_router(resume.router, prefix="/api/resume", tags=["Resume"])
app.include_router(interviews.router, prefix="/api/interviews", tags=["Interviews"])
app.include_router(calendar.router, prefix="/api/calendar", tags=["Calendar"])
app.include_router(email.router, prefix="/api/email", tags=["Email"])
app.include_router(research.router, prefix="/api/research", tags=["Research"])
app.include_router(config.router, prefix="/api/config", tags=["Config"])
app.include_router(applications.router, prefix="/api/applications", tags=["Applications"])
app.include_router(scraper.router, prefix="/api/scraper", tags=["Scraper"])
app.include_router(interview.router, prefix="/api/interview", tags=["Interview"])
app.include_router(memory.router, prefix="/api/memory", tags=["Memory"])
app.include_router(bridge.router, prefix="/api/bridge", tags=["Bridge"])
app.include_router(connections.router, prefix="/api/connections", tags=["Connections"])

# ---- 静态文件（头像等上传文件） ----
UPLOAD_DIR = os.fspath(runtime_uploads_dir())
os.makedirs(UPLOAD_DIR, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")

# ---- MCP Server (Streamable HTTP) ----
if _HAS_MCP and mcp_server is not None:
    mcp_server.settings.streamable_http_path = "/"
    app.mount("/mcp", mcp_server.streamable_http_app())


class _PairRequest(BaseModel):
    code: str


@app.post("/api/ui/pair")
async def pair_ui(req: _PairRequest):
    """`offeru start` 打开的页面用一次性配对码换取审批能力。"""
    from app.services.ui_approval_capability import exchange_pairing_code

    token = exchange_pairing_code(req.code)
    if token is None:
        raise HTTPException(status_code=403, detail="配对码无效或已过期，请重新运行 offeru start")
    return {"token": token}


class _CheckInAnswer(BaseModel):
    key: str
    choice: str = ""
    text: str = ""
    question: str = ""


@app.get("/api/career/next-step")
async def career_next_step():
    from app.services.career_stage import get_career_next_step

    return await get_career_next_step()


@app.post("/api/career/check-in")
async def career_check_in(req: _CheckInAnswer):
    from app.services.career_stage import answer_check_in

    try:
        return await answer_check_in(req.key, req.choice, req.text, question=req.question)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class _ApplyFormPaste(BaseModel):
    page_text: str


class _ApplyFormFieldEdit(BaseModel):
    value: Optional[str] = None
    copied: Optional[bool] = None


@app.get("/api/jobs/{job_id}/apply-form")
async def latest_apply_form(job_id: int):
    from app.services.apply_form import get_latest_apply_form

    return {"form": await get_latest_apply_form(job_id)}


@app.post("/api/jobs/{job_id}/apply-form")
async def paste_apply_form(job_id: int, req: _ApplyFormPaste):
    from app.services.apply_form import create_apply_form

    try:
        return {"form": await create_apply_form(job_id, req.page_text)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.patch("/api/apply-forms/{form_id}/fields/{field_id}")
async def edit_apply_form_field(form_id: int, field_id: str, req: _ApplyFormFieldEdit):
    from app.services.apply_form import update_apply_form_field

    try:
        return {"form": await update_apply_form_field(form_id, field_id, req.value, req.copied)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/apply-forms/{form_id}/fields/{field_id}/regenerate")
async def regenerate_apply_form_field_route(form_id: int, field_id: str):
    from app.services.apply_form import regenerate_apply_form_field

    try:
        return {"form": await regenerate_apply_form_field(form_id, field_id)}
    except LookupError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/health")
async def health_check():
    from app.services.startup_recovery import get_startup_recovery_status
    from app.services.runtime_identity import get_runtime_identity

    identity = get_runtime_identity(app.version)
    database_url = settings.database_url
    database_path = (
        database_url.rsplit("///", 1)[-1]
        if database_url.startswith("sqlite") and "///" in database_url
        else "configured external database"
    )
    database_filename = (
        os.path.basename(database_path.replace("\\", "/"))
        if database_path != "configured external database"
        else database_path
    ) or "configured local database"
    return {
        "status": "ok",
        "service": "OfferU",
        "version": app.version,
        "build_mode": os.getenv("OFFERU_BUILD_MODE", "local-development"),
        "database_path": database_filename,
        "database_path_redacted": True,
        "runtime_mode": os.getenv("OFFERU_RUNTIME_MODE") or os.getenv("OFFERU_INTERVIEW_RUNTIME") or "local",
        "runtime_instance_id": identity["runtime_instance_id"],
        "build_identity": {key: identity[key] for key in (
            "version", "commit", "build_timestamp", "data_root", "runtime_type",
            "dirty", "source_fingerprint", "build_source",
        )},
        "runtime": "python",
        "architecture": "file-first-agent-kernel",
        "mcp_enabled": _HAS_MCP,
        "startup_restore": startup_restore,
        "startup_recovery": get_startup_recovery_status(),
    }


@app.get("/api/diagnostics/runtime-identity")
async def diagnostics_runtime_identity(request: Request) -> dict[str, object]:
    import ipaddress
    if request.client is None:
        raise HTTPException(status_code=403, detail="本地诊断信息仅供本机查看")
    try:
        if not ipaddress.ip_address(request.client.host).is_loopback:
            raise HTTPException(status_code=403, detail="本地诊断信息仅供本机查看")
    except ValueError as exc:
        raise HTTPException(status_code=403, detail="本地诊断信息仅供本机查看") from exc
    from app.services.runtime_identity import get_runtime_identity
    return get_runtime_identity(app.version)


# ---- Lite install: serve the workbench from the API origin ----
def _mount_workbench() -> None:
    from app.runtime_paths import packaged_resource_dir

    packaged = packaged_resource_dir()
    web = packaged / "resume-frontend" if packaged else None
    if os.getenv("OFFERU_RUNTIME_MODE") == "lite" and web and (web / "index.html").is_file():
        app.mount("/", StaticFiles(directory=web, html=True), name="workbench")


_mount_workbench()
