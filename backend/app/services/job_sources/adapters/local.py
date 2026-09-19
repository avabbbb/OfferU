"""Manual / Web adapter — 把既有 Job 库 + 手工录入收敛到 JobSource 协议。

manual 源 = 用户手工录入/URL 导入的既有 Job 行，通过 `import_job_batch` 进库。
这个 adapter 让 JobSourceRouter 能统一把存量岗位也作为 corpus 参与
Role Intelligence 比较，而不只是新增外部源。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import or_, select

from app.database import async_session
from app.models.models import Job

from ..protocol import (
    JobObservation,
    JobSearchQuery,
    JobSourceCapabilities,
    JobSourceStatus,
)


def _job_to_observation(job: Job, source_id: str) -> JobObservation:
    captured_at = job.created_at or datetime.now(timezone.utc)
    posted_at = job.posted_at.date().isoformat() if job.posted_at else None
    return JobObservation(
        source=source_id,
        # DB PK 只在单源内有意义：加 source 前缀，杜绝 manual:42 与 web:42 跨源碰撞。
        external_job_id=f"{source_id}:{job.id}",
        source_url=job.url or "",
        title=job.title,
        company=job.company,
        description=job.raw_description or job.summary or "",
        location=job.location or "",
        salary=job.salary_text or "",
        experience=job.experience or "",
        education=job.education or "",
        captured_at=captured_at,
        posted_at=posted_at,
        raw_hash=job.hash_key or "",
        metadata={
            "job_id": job.id,
            "triage_status": job.triage_status,
            "batch_id": job.batch_id,
            # 新鲜度提示：观测距采集的秒数；采集时间本身就是 captured_at。
            "captured_at_age_seconds": max(
                0.0, (datetime.now(timezone.utc) - captured_at).total_seconds()
            ),
        },
    )


class _DbBackedSource:
    """读存量 jobs 表的通用基类；子类用 where 条件区分来源。"""

    source_id = "manual"
    _where_sources: tuple[str, ...] = ("manual",)

    async def status(self) -> JobSourceStatus:
        return "READY"

    async def capabilities(self) -> JobSourceCapabilities:
        return JobSourceCapabilities(search=True, detail=True)

    async def search(self, query: JobSearchQuery) -> list[JobObservation]:
        kw = (query.keywords or "").strip()
        async with async_session() as db:
            stmt = select(Job).where(Job.source.in_(self._where_sources))
            if kw:
                like = f"%{kw}%"
                stmt = stmt.where(
                    or_(Job.title.ilike(like), Job.company.ilike(like), Job.raw_description.ilike(like))
                )
            if query.location:
                stmt = stmt.where(Job.location.ilike(f"%{query.location}%"))
            stmt = stmt.order_by(Job.created_at.desc()).limit(max(1, min(query.limit, 100)))
            rows = (await db.execute(stmt)).scalars().all()
        return [_job_to_observation(j, self.source_id) for j in rows]

    async def get(self, external_job_id: str) -> Optional[JobObservation]:
        raw = str(external_job_id or "").strip()
        # 兼容 "manual:42" 命名空间键与历史裸 "42" 键。
        if ":" in raw:
            raw = raw.rsplit(":", 1)[-1]
        try:
            jid = int(raw)
        except (TypeError, ValueError):
            return None
        async with async_session() as db:
            job = (
                await db.execute(
                    select(Job).where(Job.id == jid, Job.source.in_(self._where_sources))
                )
            ).scalar_one_or_none()
        return _job_to_observation(job, self.source_id) if job else None


class ManualJobSource(_DbBackedSource):
    """手工录入 / URL 导入的存量岗位（source='manual'）。"""

    source_id = "manual"
    _where_sources = ("manual",)


class WebJobSource(_DbBackedSource):
    """既有 web/scraper/扩展入库的岗位（source in linkedin/boss/web/extension 等）。"""

    source_id = "web"
    _where_sources = ("linkedin", "boss", "web", "extension", "browser_extension")
