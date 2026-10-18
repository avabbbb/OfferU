"""海投：用本机 boss-cli 搜岗位，按简历打分，使用者勾选后逐个打招呼。

- 搜索结果按简历命中的技能 / 标签打分，默认只勾高分；
- 每天最多打 50 个招呼，同一个岗位只打一次；
- 两个招呼之间随机等 20–60 秒，一次只跑一批；
- 打过招呼的岗位直接记进总表（已投递），并顺手补上职位描述。
"""

from __future__ import annotations

import asyncio
import json
import random
import re
from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select

from app.database import async_session
from app.models.models import ApplicationTable, BossGreetLog, Resume, ResumeSection
from app.services.boss_sync import _run_boss

DAILY_CAP = 50
GAP_SECONDS = (20, 60)
PICK_SCORE = 60
_RUN: dict[str, Any] = {"running": False, "items": []}
_TASK: Optional[asyncio.Task] = None


class BossBlastSearchInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    keyword: str = Field(min_length=1, max_length=40)
    city: str = Field(default="全国", max_length=20)
    page: int = Field(default=1, ge=1, le=5)


class BossBlastJob(BaseModel):
    model_config = ConfigDict(extra="forbid")

    security_id: str = Field(min_length=1, max_length=300)
    lid: str = Field(default="", max_length=300)
    encrypt_job_id: str = Field(min_length=1, max_length=100)
    title: str = Field(max_length=300)
    company: str = Field(max_length=300)
    salary: str = Field(default="", max_length=100)
    city: str = Field(default="", max_length=100)


class BossBlastStartInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    table_id: Optional[int] = Field(default=None, gt=0)
    jobs: list[BossBlastJob] = Field(min_length=1, max_length=DAILY_CAP)


async def _resume() -> tuple[str, str]:
    """最近改过的那份简历：(标题, 全文小写)。"""

    async with async_session() as db:
        resume = (await db.execute(select(Resume).order_by(Resume.updated_at.desc(), Resume.id.desc()).limit(1))).scalar_one_or_none()
        if resume is None:
            return "", ""
        sections = (await db.execute(select(ResumeSection.content_json).where(ResumeSection.resume_id == resume.id))).scalars().all()
    text = " ".join([resume.title or "", resume.summary or ""] + [json.dumps(s, ensure_ascii=False) for s in sections])
    return resume.title or "未命名简历", text.lower()


def score_job(item: dict[str, Any], resume_text: str) -> dict[str, Any]:
    """岗位要求的技能 / 标签里，简历提到了几个。没有可比的词时给 0 分。"""

    terms: list[str] = []
    for key in ("skills", "jobLabels"):
        for term in item.get(key) or []:
            term = str(term).strip()
            if term and term not in terms and not re.search(r"\d+个?[年天月周]|本科|硕士|博士|大专|学历|经验|在校|应届", term):
                terms.append(term)
    hits = [t for t in terms if t.lower() in resume_text]
    score = round(100 * len(hits) / len(terms)) if terms else 0
    return {"score": score, "hits": hits, "misses": [t for t in terms if t not in hits]}


async def _today_count(db) -> int:  # noqa: ANN001
    start = datetime.combine(datetime.now().date(), datetime.min.time())
    return int((await db.scalar(select(func.count()).select_from(BossGreetLog).where(BossGreetLog.ok.is_(True), BossGreetLog.created_at >= start))) or 0)


async def _quota() -> dict[str, int]:
    async with async_session() as db:
        today = await _today_count(db)
    return {"today": today, "cap": DAILY_CAP, "left": max(0, DAILY_CAP - today)}


async def search_boss_jobs(keyword: str, city: str = "全国", page: int = 1) -> dict[str, Any]:
    data = (await _run_boss(("search", keyword, "-c", city or "全国", "-p", str(page)))).get("data") or {}
    title, text = await _resume()
    jobs = [j for j in data.get("jobList") or [] if isinstance(j, dict) and j.get("securityId") and j.get("encryptJobId")]
    async with async_session() as db:
        greeted = set((await db.execute(select(BossGreetLog.encrypt_job_id).where(BossGreetLog.ok.is_(True), BossGreetLog.encrypt_job_id.in_([j["encryptJobId"] for j in jobs])))).scalars())
    items = []
    for job in jobs:
        match = score_job(job, text)
        items.append(
            {
                "security_id": job["securityId"],
                "lid": str(job.get("lid") or ""),
                "encrypt_job_id": job["encryptJobId"],
                "title": str(job.get("jobName") or ""),
                "company": str(job.get("brandName") or ""),
                "salary": str(job.get("salaryDesc") or ""),
                "city": str(job.get("cityName") or ""),
                "greeted": job["encryptJobId"] in greeted,
                **match,
                "picked": bool(text) and match["score"] >= PICK_SCORE and job["encryptJobId"] not in greeted,
            }
        )
    items.sort(key=lambda i: (i["greeted"], -i["score"]))
    return {"resume_title": title, "has_more": bool(data.get("hasMore")), "items": items, **await _quota()}


def _view() -> dict[str, Any]:
    return {"running": _RUN["running"], "items": _RUN["items"]}


async def get_boss_greet() -> dict[str, Any]:
    return {**_view(), **await _quota()}


async def _greet_all(table_id: int, jobs: list[dict[str, Any]]) -> None:
    from app.services.boss_import import fill_boss_job_detail, import_boss_export

    try:
        for index, (job, item) in enumerate(zip(jobs, _RUN["items"])):
            if index:
                await asyncio.sleep(random.uniform(*GAP_SECONDS))
            item["status"] = "sending"
            try:
                args = ("greet", job["security_id"]) + (("--lid", job["lid"]) if job["lid"] else ())
                await _run_boss(args)
                ok, message = True, ""
            except ValueError as exc:
                ok, message = False, str(exc)
            async with async_session() as db:
                db.add(BossGreetLog(encrypt_job_id=job["encrypt_job_id"], title=job["title"][:300], company=job["company"][:300], ok=ok, message=message[:300]))
                await db.commit()
            item.update(status="done" if ok else "failed", message=message)
            if ok:
                card = {"jobName": job["title"], "brandName": job["company"], "encryptJobId": job["encrypt_job_id"], "securityId": job["security_id"], "salaryDesc": job["salary"], "cityName": job["city"]}
                imported = await import_boss_export(table_id=table_id, payload={"cardList": [card]})
                # 反正要等下一个间隔，顺手把职位描述补上；补不上不影响招呼。
                for job_id in imported["job_ids"]:
                    try:
                        await fill_boss_job_detail(job_id)
                    except ValueError:
                        pass
            elif "登录" in message or "频繁" in message:
                for rest in _RUN["items"][index + 1 :]:
                    rest.update(status="skipped", message="已停止：" + message)
                break
    finally:
        _RUN["running"] = False


async def start_boss_greet(jobs: list[dict[str, Any]], table_id: Optional[int] = None) -> dict[str, Any]:
    """开始给勾选的岗位逐个打招呼。超过今天剩余额度、或已经打过的岗位不会发。不指定投递表时记进总表。"""

    global _TASK
    if _RUN["running"]:
        raise ValueError("上一批还没发完")
    jobs = [j.model_dump() if isinstance(j, BaseModel) else dict(j) for j in jobs]
    async with async_session() as db:
        left = DAILY_CAP - await _today_count(db)
        if table_id is None:
            table_id = await db.scalar(select(ApplicationTable.id).order_by(ApplicationTable.is_total.desc(), ApplicationTable.id).limit(1))
        done = set((await db.execute(select(BossGreetLog.encrypt_job_id).where(BossGreetLog.ok.is_(True), BossGreetLog.encrypt_job_id.in_([j["encrypt_job_id"] for j in jobs])))).scalars())
    jobs = [j for j in jobs if j["encrypt_job_id"] not in done]
    if not table_id:
        raise ValueError("还没有投递表")
    if not jobs:
        raise ValueError("勾选的岗位都已经打过招呼了")
    if len(jobs) > left:
        raise ValueError(f"今天还能打 {max(0, left)} 个招呼，少勾几个")
    _RUN.update(running=True, items=[{"encrypt_job_id": j["encrypt_job_id"], "title": j["title"], "company": j["company"], "status": "waiting", "message": ""} for j in jobs])
    _TASK = asyncio.create_task(_greet_all(table_id, jobs))
    return await get_boss_greet()
