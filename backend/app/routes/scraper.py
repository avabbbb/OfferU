# =============================================
# 爬虫管理路由 — 数据源控制面板 API
# =============================================
# GET  /api/scraper/sources      获取所有数据源状态
# POST /api/scraper/run          手动触发爬取任务
# GET  /api/scraper/tasks        获取任务列表
# =============================================

from __future__ import annotations

import asyncio
import hashlib
import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.models import Job, Batch
from app.ops import execute_operation
from app.services.scrapers.base import get_all_scrapers, get_scraper
from app.services.campus_detector import detect_campus
from app.services.runtime_credentials import load_scraper_cookie
from app.services.security_redaction import safe_error_message

router = APIRouter()
logger = logging.getLogger(__name__)


# ---- 内存中的任务状态（轻量实现，后续可换 Redis / DB） ----
# 限制最多保留 200 条任务记录，超出后丢弃最旧的
_MAX_TASK_HISTORY = 200
_tasks: list[dict] = []


def _append_task(task: dict) -> None:
    """添加任务记录，超过上限时丢弃最旧的条目"""
    _tasks.append(task)
    if len(_tasks) > _MAX_TASK_HISTORY:
        del _tasks[:len(_tasks) - _MAX_TASK_HISTORY]


class RunRequest(BaseModel):
    """爬取任务请求"""
    source: str  # boss / zhilian / linkedin / shixiseng / maimai / corporate
    keywords: list[str] = ["校招"]
    location: str = ""
    max_results: int = 50


# ---- 数据源定义（含未实现的占位） ----
AVAILABLE_SOURCES = [
    {"key": "shixiseng", "name": "实习僧", "status": "ready", "description": "实习/校招垂直平台，反爬友好，数据丰富"},
    {"key": "boss", "name": "BOSS直聘", "status": "ready", "description": "国内主流招聘平台，需在设置中配置 Cookie"},
    {"key": "zhilian", "name": "智联招聘", "status": "ready", "description": "老牌招聘平台，支持 Cookie 认证（可选）"},
    {"key": "jobspy", "name": "JobSpy 聚合", "status": "ready", "description": "一键聚合 LinkedIn / Indeed / Google 国际岗位"},
    {"key": "linkedin", "name": "领英 (Apify)", "status": "skeleton", "description": "通过 Apify API 抓取，需配置 API Key"},
    {"key": "bytedance", "name": "字节跳动", "status": "skeleton", "description": "字节跳动官网招聘 (jobs.bytedance.com)"},
    {"key": "alibaba", "name": "阿里巴巴", "status": "skeleton", "description": "阿里巴巴人才官网 (talent.alibaba.com)"},
    {"key": "tencent", "name": "腾讯", "status": "skeleton", "description": "腾讯招聘官网 (careers.tencent.com)"},
    {"key": "maimai", "name": "脉脉", "status": "unsupported", "description": "脉脉无公开岗位接口，暂不支持"},
]

SOURCE_NAME_MAP = {item["key"]: item["name"] for item in AVAILABLE_SOURCES}


def _build_pool_name(source_key: str, keywords: list[str]) -> str:
    source_label = SOURCE_NAME_MAP.get(source_key, source_key)
    date_label = datetime.utcnow().strftime("%Y年%m月%d日")
    keyword_text = "、".join([kw.strip() for kw in keywords if kw.strip()]) or "全量"
    return f"{source_label}{date_label}+{keyword_text}"


async def _operation_outputs(name: str, args: dict) -> dict:
    result = await execute_operation(name, args, surface="scraper_api")
    if not result.get("ok"):
        detail = "；".join(
            safe_error_message(ValueError(str(item)))
            for item in result.get("errors") or []
        )
        raise HTTPException(status_code=400, detail=detail or "操作失败")
    outputs = result.get("outputs")
    if not isinstance(outputs, dict):
        raise HTTPException(status_code=502, detail="操作返回了无效结果")
    return outputs


@router.get("/sources")
async def list_sources():
    """获取所有数据源及其状态"""
    registered = get_all_scrapers()
    result = []
    for src in AVAILABLE_SOURCES:
        is_registered = src["key"] in registered
        result.append({
            **src,
            "registered": is_registered,
            # 仅 status=ready 的源在注册后显示 ready，skeleton/planned 保持原状
            "status": src["status"] if src["status"] != "ready" and not is_registered else src["status"],
        })
    return result


@router.post("/run")
async def run_scraper(req: RunRequest):
    """
    手动触发爬取任务
    返回任务 ID，任务异步执行
    """
    scraper = get_scraper(req.source)
    if not scraper:
        raise HTTPException(
            status_code=400,
            detail=f"数据源 '{req.source}' 尚未实现，当前为骨架/计划状态"
        )

    task_id = hashlib.md5(f"{req.source}-{datetime.utcnow().isoformat()}".encode()).hexdigest()[:12]
    batch_id = f"batch-{datetime.utcnow().strftime('%Y%m%d%H%M%S')}-{task_id[:4]}"
    pool_base_name = _build_pool_name(req.source, req.keywords)
    batch = await _operation_outputs(
        "start_scraper_batch",
        {
            "batch_id": batch_id,
            "source": req.source,
            "keywords": req.keywords,
            "location": req.location,
            "max_results": req.max_results,
            "pool_name": pool_base_name,
        },
    )

    task_info = {
        "id": task_id,
        "batch_id": batch_id,
        "pool_id": batch["pool_id"],
        "pool_name": batch["pool_name"],
        "source": req.source,
        "keywords": req.keywords,
        "location": req.location,
        "status": "running",
        "created_at": datetime.utcnow().isoformat(),
        "result": None,
    }
    _append_task(task_info)

    # 异步执行爬虫任务
    asyncio.create_task(_execute_scraper(task_info, scraper, req))

    return {
        "task_id": task_id,
        "batch_id": batch_id,
        "pool_id": batch["pool_id"],
        "pool_name": batch["pool_name"],
        "status": "running",
    }


async def _execute_scraper(task_info: dict, scraper, req: RunRequest):
    """异步执行爬取 + 数据入库"""
    try:
        items = await scraper.search(
            keywords=req.keywords,
            location=req.location,
            max_results=req.max_results,
        )
        logger.info("[scraper] search returned %s items for source=%s", len(items), req.source)

        # Cookie 过期警告：BOSS/智联返回空结果 + Cookie 已配置 → 可能过期
        warning = ""
        if not items:
            if req.source == "boss":
                if load_scraper_cookie("boss_cookie"):
                    warning = "Cookie 可能已过期，请重新登录 zhipin.com 并更新 Cookie"
                else:
                    warning = "未配置 Cookie，请在设置页粘贴 BOSS直聘 Cookie"
            elif req.source == "zhilian":
                if not load_scraper_cookie("zhilian_cookie"):
                    warning = "未获取到数据，可尝试在设置页配置智联招聘 Cookie"
            if not warning:
                warning = "本次任务没有抓到新岗位，可能是关键词/城市无结果，或平台反爬拦截。"

        job_payloads = []
        for item in items:
            raw = f"{item.title}-{item.company}-{item.url}"
            source = item.source or scraper.source_name
            job_payloads.append(
                {
                    "title": item.title,
                    "company": item.company,
                    "location": item.location,
                    "url": item.url,
                    "apply_url": item.apply_url,
                    "source": source,
                    "raw_description": item.raw_description,
                    "posted_at": item.posted_at or None,
                    "batch_id": task_info.get("batch_id", "legacy-import"),
                    "hash_key": item.hash_key or hashlib.md5(raw.encode()).hexdigest(),
                    "salary_text": item.salary,
                    "job_type": item.employment_type,
                    "company_industry": item.industries,
                    "is_campus": detect_campus(
                        title=item.title,
                        source=source,
                        experience=item.seniority_level,
                        job_type=item.employment_type,
                        raw_description=item.raw_description,
                    ),
                }
            )

        if job_payloads:
            ingest = await execute_operation(
                "import_job_batch",
                {
                    "jobs": job_payloads,
                    "source": req.source,
                    "batch_id": task_info.get("batch_id"),
                    "keywords": req.keywords,
                    "location": req.location,
                    "pool_id": task_info.get("pool_id"),
                },
                surface="scraper_background",
            )
            if not ingest.get("ok"):
                raise RuntimeError("；".join(str(item) for item in ingest.get("errors") or []) or "岗位导入失败")
            ingest_output = ingest.get("outputs") if isinstance(ingest.get("outputs"), dict) else {}
        else:
            ingest_output = {"created": 0, "skipped": 0, "failed": []}

        created = int(ingest_output.get("created") or 0)
        skipped = int(ingest_output.get("skipped") or 0)
        finalized = await execute_operation(
            "finalize_scraper_batch",
            {
                "batch_id": task_info.get("batch_id"),
                "total_fetched": len(items),
                "job_count": created,
                "status": "completed",
            },
            surface="scraper_background",
        )
        if not finalized.get("ok"):
            raise RuntimeError("；".join(str(item) for item in finalized.get("errors") or []) or "批次收口失败")

        task_info["status"] = "completed"
        task_info["result"] = {
            "created": created,
            "skipped": skipped,
            "total": len(items),
            "batch_id": task_info.get("batch_id"),
            "pool_id": task_info.get("pool_id"),
            "pool_name": task_info.get("pool_name"),
            "warning": warning,
        }
    except Exception as e:
        logger.error("[scraper] task failed: %s", safe_error_message(e))
        task_info["status"] = "failed"
        task_info["result"] = {"error": safe_error_message(e)}
        try:
            await execute_operation(
                "finalize_scraper_batch",
                {
                    "batch_id": task_info.get("batch_id"),
                    "total_fetched": 0,
                    "job_count": 0,
                    "status": "failed",
                },
                surface="scraper_background",
            )
        except Exception as exc:
            logger.error(
                "[scraper] failed to persist batch failure: %s",
                safe_error_message(exc),
            )


@router.get("/tasks")
async def list_tasks(db: AsyncSession = Depends(get_db)):
    """获取最近的爬取任务列表。内存任务丢失时，回退展示数据库中的批次记录。"""
    memory_tasks = list(reversed(_tasks[-50:]))
    seen_batches = {
        item.get("batch_id")
        for item in memory_tasks
        if isinstance(item, dict) and item.get("batch_id")
    }

    persisted_tasks: list[dict] = []
    batches = (
        await db.execute(
            select(Batch)
            .order_by(Batch.created_at.desc())
            .limit(50)
        )
    ).scalars().all()

    for batch in batches:
        if batch.id in seen_batches:
            continue
        created = (
            await db.execute(
                select(func.count()).select_from(Job).where(Job.batch_id == batch.id)
            )
        ).scalar() or 0
        warning = ""
        total_fetched = int(batch.total_fetched or created or 0)
        if batch.status == "completed" and total_fetched == 0:
            warning = "本次任务没有抓到新岗位，可能是关键词/城市无结果、平台需要 Cookie，或平台反爬拦截。"
        elif batch.status == "completed" and int(created) == 0 and total_fetched > 0:
            warning = f"本次抓到 {total_fetched} 个岗位，但都已存在，因此没有新增。"
        persisted_tasks.append(
            {
                "id": batch.id,
                "batch_id": batch.id,
                "pool_id": None,
                "pool_name": "",
                "source": batch.source,
                "keywords": batch.keywords or [],
                "location": batch.location or "",
                "status": batch.status,
                "created_at": batch.created_at.isoformat() if batch.created_at else "",
                "result": {
                    "created": int(created),
                    "skipped": max(total_fetched - int(created), 0),
                    "total": total_fetched,
                    "batch_id": batch.id,
                    "warning": warning,
                },
            }
        )

    return (memory_tasks + persisted_tasks)[:50]
