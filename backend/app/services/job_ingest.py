"""批量岗位导入服务（EXT-JOB-002）。

单一事实写入路径：/api/jobs/ingest 只作为本服务的薄 Adapter，
插件端同步、CLI、其他 surface 的岗位入库都必须通过
`import_job_batch` Operation（幂等键 = hash_key，批次幂等键 = batch_id）。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select

from app.database import async_session
from app.models.models import Batch, Job
from app.services.campus_detector import detect_campus


class JobIngestItem(BaseModel):
    """单条岗位导入载荷；extra 字段一律拒绝。"""

    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=500)
    company: str = Field(min_length=1, max_length=300)
    location: str = Field(default="", max_length=200)
    url: str = Field(default="", max_length=2048)
    apply_url: str = Field(default="", max_length=2048)
    source: str = Field(default="manual", min_length=1, max_length=40)
    raw_description: str = Field(default="", max_length=50_000)
    posted_at: Optional[str] = Field(default=None, max_length=64)
    batch_id: Optional[str] = Field(default=None, max_length=64)
    hash_key: str = Field(min_length=1, max_length=120)
    summary: str = Field(default="", max_length=5_000)
    keywords: list[str] = Field(default_factory=list, max_length=50)
    salary_min: Optional[int] = None
    salary_max: Optional[int] = None
    salary_text: str = Field(default="", max_length=200)
    education: str = Field(default="", max_length=100)
    experience: str = Field(default="", max_length=100)
    job_type: str = Field(default="", max_length=100)
    company_size: str = Field(default="", max_length=100)
    company_industry: str = Field(default="", max_length=200)
    company_logo: str = Field(default="", max_length=2048)
    is_campus: bool = False

    @field_validator("title", "company", "source", "hash_key")
    @classmethod
    def validate_required_text(cls, value: str) -> str:
        """Reject whitespace-only identity fields and persist their normalized value."""
        normalized = value.strip()
        if not normalized:
            raise ValueError("must not be blank")
        return normalized


def _parse_posted_at(value: Optional[str]) -> Optional[datetime]:
    text = (value or "").strip()
    if not text:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(text[:26], fmt)
        except ValueError:
            continue
    return None


async def import_job_batch(
    jobs: list[dict[str, Any]],
    source: str = "manual",
    batch_id: Optional[str] = None,
    keywords: Optional[list[str]] = None,
    location: str = "",
) -> dict[str, Any]:
    """逐条幂等批量导入岗位。

    - 重复 hash_key 跳过（重复同步不创建重复 Job）；
    - 同 batch_id 重放不会创建新批次或重复计数；
    - 单条失败记录到 failed，不中断整批。
    """
    items = [JobIngestItem(**item) for item in jobs]
    clean_keywords = keywords or []
    resolved_batch_id = (batch_id or "").strip() or f"browser-{datetime.utcnow().strftime('%Y%m%d%H%M%S')}"

    created = 0
    skipped = 0
    accepted_hash_keys: list[str] = []
    created_hash_keys: list[str] = []
    skipped_hash_keys: list[str] = []
    failed: list[dict[str, str]] = []

    async with async_session() as db:
        async def ensure_batch(db_batch_id: str, batch_source: str) -> None:
            existing = (
                await db.execute(select(Batch).where(Batch.id == db_batch_id))
            ).scalar_one_or_none()
            if existing is None:
                db.add(
                    Batch(
                        id=db_batch_id,
                        source=batch_source or "",
                        keywords=clean_keywords or [],
                        location=location or "",
                    )
                )

        await ensure_batch(resolved_batch_id, source)

        for item in items:
            existing = (
                await db.execute(select(Job).where(Job.hash_key == item.hash_key))
            ).scalar_one_or_none()
            if existing is not None:
                skipped += 1
                accepted_hash_keys.append(item.hash_key)
                skipped_hash_keys.append(item.hash_key)
                continue

            job_batch_id = item.batch_id or resolved_batch_id
            if job_batch_id != resolved_batch_id:
                await ensure_batch(job_batch_id, item.source)

            job = Job(
                title=item.title,
                company=item.company,
                location=item.location,
                url=item.url,
                apply_url=item.apply_url,
                source=item.source,
                raw_description=item.raw_description,
                posted_at=_parse_posted_at(item.posted_at),
                batch_id=job_batch_id,
                triage_status="inbox",
                hash_key=item.hash_key,
                summary=item.summary,
                keywords=item.keywords,
                salary_min=item.salary_min,
                salary_max=item.salary_max,
                salary_text=item.salary_text,
                education=item.education,
                experience=item.experience,
                job_type=item.job_type,
                company_size=item.company_size,
                company_industry=item.company_industry,
                company_logo=item.company_logo,
                is_campus=item.is_campus
                or detect_campus(
                    title=item.title,
                    source=item.source,
                    experience=item.experience,
                    job_type=item.job_type,
                    raw_description=item.raw_description,
                ),
            )
            db.add(job)
            created += 1
            accepted_hash_keys.append(item.hash_key)
            created_hash_keys.append(item.hash_key)

        await db.flush()
        batch = (
            await db.execute(select(Batch).where(Batch.id == resolved_batch_id))
        ).scalar_one_or_none()
        if batch is not None:
            batch.total_fetched = (batch.total_fetched or 0) + created

        await db.commit()

    return {
        "created": created,
        "skipped": skipped,
        "batch_id": resolved_batch_id,
        "accepted_hash_keys": accepted_hash_keys,
        "created_hash_keys": created_hash_keys,
        "skipped_hash_keys": skipped_hash_keys,
        "failed": failed,
    }
