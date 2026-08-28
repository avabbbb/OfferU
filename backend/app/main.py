# =============================================
# OfferU - FastAPI 应用入口
# =============================================
# 启动命令: uvicorn app.main:app --reload --host 127.0.0.1 --port 8765
# 职责：注册路由、CORS、生命周期事件
# =============================================

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import get_settings
from app.database import init_db
settings = get_settings()
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
from app.routes import jobs, resume, calendar, email, config, applications, scraper, pools, profile, profile_agent, optimize, interview, main_agent, templates, interviews, research, memory, studio, bridge

@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用启动时初始化数据库表与 MCP 会话管理器。"""
    await init_db()
    from app.services.agent_run_state import recover_interrupted_agent_runs

    try:
        await recover_interrupted_agent_runs()
    except Exception:
        pass  # Agent Run 恢复失败不阻塞启动（与相邻恢复逻辑一致）
    from app.services.career_tasks import recover_career_tasks

    try:
        await recover_career_tasks()
    except Exception:
        pass  # CareerTask 恢复失败不阻塞启动；任务状态仍可由控制面查询
    from app.services.job_research import recover_interrupted_research_runs

    try:
        await recover_interrupted_research_runs()
    except Exception:
        pass  # 调研恢复失败不阻塞启动
    from app.llm_config_store import discover_local_llms

    try:
        await discover_local_llms()
    except Exception:
        pass  # 本地引擎发现失败不阻塞启动
    from app.services.coding_agent_runtime import recover_hosted_executor_sessions

    await recover_hosted_executor_sessions()
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

    await recover_authorized_research_sessions()
    await start_email_sync_service()
    start_memory_distill_service()
    start_work_source_auto_sync()
    try:
        if _HAS_MCP and mcp_server is not None:
            async with mcp_server.session_manager.run():
                yield
        else:
            yield
    finally:
        from app.services.coding_agent_runtime import shutdown_hosted_executors
        from app.services.pi_agent_worker import close_pi_agent_worker

        await shutdown_hosted_executors()
        await close_pi_agent_worker()
        await stop_authorized_research_service()
        await stop_email_sync_service()
        await stop_memory_distill_service()
        await stop_work_source_auto_sync()


app = FastAPI(
    title="OfferU API",
    description="AI 驱动的智能求职助手后端",
    version="0.2.0",
    lifespan=lifespan,
)

cors_origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]

# ---- CORS 允许前端跨域访问 ----
# cors_origins 以逗号分隔多个来源，如 "http://localhost:3000,http://localhost:8080"
# allow_credentials=True 允许带 cookie 的跨域请求（Gmail OAuth 回调需要）
cors_origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
# 前端 dev 端口 7410 无条件可用：系统环境变量 CORS_ORIGINS 会覆盖 settings，
# 且该变量可能在旧值（5140/3000）上漂移，导致浏览器请求被 CORS 拦截。
for _offeru_frontend_origin in ("http://localhost:7410", "http://127.0.0.1:7410"):
    if _offeru_frontend_origin not in cors_origins:
        cors_origins.append(_offeru_frontend_origin)
# DSH Web 浮层（Slice 3 确认浮层）运行在 3080，需要直接轮询/提交提案决定。
for _dsh_web_origin in ("http://localhost:3737", "http://127.0.0.1:3737"):
    if _dsh_web_origin not in cors_origins:
        cors_origins.append(_dsh_web_origin)
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_origin_regex=r"^(chrome-extension|ms-browser-extension)://[a-z0-9]{16,64}$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---- 注册路由 ----
app.include_router(jobs.router, prefix="/api/jobs", tags=["Jobs"])
app.include_router(pools.router, prefix="/api/pools", tags=["Pools"])
app.include_router(profile.router, prefix="/api/profile", tags=["Profile"])
app.include_router(profile_agent.router, prefix="/api/profile/agent", tags=["Profile Agent"])
app.include_router(main_agent.router, prefix="/api/agent", tags=["Agent"])
app.include_router(main_agent.runtime_router, prefix="/api/agent", tags=["Agent Runtime"])
app.include_router(optimize.router, prefix="/api/optimize", tags=["Optimize"])
app.include_router(resume.router, prefix="/api/resume", tags=["Resume"])
app.include_router(templates.router, prefix="/api/templates", tags=["Templates"])
app.include_router(interviews.router, prefix="/api/interviews", tags=["Interviews"])
app.include_router(calendar.router, prefix="/api/calendar", tags=["Calendar"])
app.include_router(email.router, prefix="/api/email", tags=["Email"])
app.include_router(research.router, prefix="/api/research", tags=["Research"])
app.include_router(config.router, prefix="/api/config", tags=["Config"])
app.include_router(applications.router, prefix="/api/applications", tags=["Applications"])
app.include_router(scraper.router, prefix="/api/scraper", tags=["Scraper"])
app.include_router(interview.router, prefix="/api/interview", tags=["Interview"])
app.include_router(memory.router, prefix="/api/memory", tags=["Memory"])
# studio.router 自带 prefix="/api/studio"，直接注册
app.include_router(studio.router)
app.include_router(bridge.router, prefix="/api/bridge", tags=["Bridge"])

# ---- 静态文件（头像等上传文件） ----
UPLOAD_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")

# HTML 简历模板预览图（template_seeder preview_image=/templates/*.png）。
# 图片资产由使用者提供，放在 backend/uploads/templates/ 下。
TEMPLATE_ASSET_DIR = os.path.join(UPLOAD_DIR, "templates")
os.makedirs(TEMPLATE_ASSET_DIR, exist_ok=True)
app.mount("/templates", StaticFiles(directory=TEMPLATE_ASSET_DIR), name="templates")

# ---- MCP Server (Streamable HTTP) ----
if _HAS_MCP and mcp_server is not None:
    mcp_server.settings.streamable_http_path = "/"
    app.mount("/mcp", mcp_server.streamable_http_app())


@app.get("/api/health")
async def health_check():
    return {
        "status": "ok",
        "service": "OfferU",
        "runtime": "python",
        "architecture": "file-first-agent-kernel",
        "mcp_enabled": _HAS_MCP,
    }
