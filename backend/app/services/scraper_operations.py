"""Registry-backed persistence for the legacy scraper control surface."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select

from app.database import async_session
from app.models.models import Batch, Pool


async def start_scraper_batch(
    *,
    batch_id: str,
    source: str,
    keywords: list[str] | None = None,
    location: str = "",
    max_results: int = 50,
    pool_name: str,
) -> dict[str, Any]:
    """Create the durable pool and running batch for one scraper task."""
    clean_batch_id = str(batch_id or "").strip()
    clean_source = str(source or "").strip()
    clean_pool_name = str(pool_name or "").strip()
    if not clean_batch_id or not clean_source or not clean_pool_name:
        raise ValueError("batch_id, source and pool_name are required")

    async with async_session() as db:
        existing_batch = (
            await db.execute(select(Batch).where(Batch.id == clean_batch_id))
        ).scalar_one_or_none()
        if existing_batch is not None:
            raise ValueError(f"scraper batch already exists: {clean_batch_id}")

        candidate = clean_pool_name
        index = 2
        while (
            await db.execute(select(Pool).where(Pool.name == candidate))
        ).scalar_one_or_none() is not None:
            candidate = f"{clean_pool_name}（{index}）"
            index += 1

        pool = Pool(name=candidate, scope="inbox")
        db.add(pool)
        await db.flush()
        db.add(
            Batch(
                id=clean_batch_id,
                source=clean_source,
                keywords=list(keywords or []),
                location=str(location or ""),
                max_results=int(max_results),
                status="running",
            )
        )
        await db.commit()
        await db.refresh(pool)
        return {
            "batch_id": clean_batch_id,
            "pool_id": int(pool.id),
            "pool_name": pool.name,
            "status": "running",
        }


async def finalize_scraper_batch(
    *,
    batch_id: str,
    total_fetched: int,
    job_count: int,
    status: str = "completed",
) -> dict[str, Any]:
    """Persist the final deterministic counts/status for a scraper batch."""
    if status not in {"completed", "failed"}:
        raise ValueError("invalid scraper batch status")
    async with async_session() as db:
        batch = (
            await db.execute(select(Batch).where(Batch.id == str(batch_id)))
        ).scalar_one_or_none()
        if batch is None:
            raise ValueError(f"scraper batch not found: {batch_id}")
        batch.total_fetched = max(0, int(total_fetched))
        batch.job_count = max(0, int(job_count))
        batch.status = status
        await db.commit()
        return {
            "batch_id": batch.id,
            "status": batch.status,
            "total_fetched": int(batch.total_fetched or 0),
            "job_count": int(batch.job_count or 0),
        }

