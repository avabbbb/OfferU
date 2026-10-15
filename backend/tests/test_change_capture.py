"""Generic undo: whatever rows an Agent write touched go back, cascades included."""

from __future__ import annotations

import asyncio
from unittest.mock import patch

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.database import Base
from app.models.models import Job, Pool
from app.services import change_capture as cc


def test_delete_with_cascade_and_later_edit_are_seen(tmp_path):
    async def run():
        engine = create_async_engine(f"sqlite+aiosqlite:///{(tmp_path / 'cc.db').as_posix()}")
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with engine.begin() as conn:
            await conn.exec_driver_sql("PRAGMA foreign_keys=ON")
            await conn.run_sync(Base.metadata.create_all)
        with patch.object(cc, "async_session", sessions):
            async with sessions() as db:
                pool = Pool(name="字节池")
                db.add(pool)
                await db.flush()
                db.add(Job(title="后端", company="字节", source="manual", pool_id=pool.id,
                           hash_key="h1", location="北京", raw_description="x", url="https://x"))
                await db.commit()
                pool_id = pool.id

            with cc.capture() as cap:  # the "Agent write": rename, add a pool, delete the first
                async with sessions() as db:
                    await db.execute(update(Pool).where(Pool.id == pool_id).values(name="改名"))
                    db.add(Pool(name="Agent 新池"))
                    await db.commit()
                    await db.execute(update(Job).values(pool_id=None))  # what ON DELETE SET NULL does
                    await db.delete(await db.get(Pool, pool_id))
                    await db.commit()
            changes = cc.to_undo(cap)
            assert not cap.lossy and {c["table"] for c in changes} == {"pools", "jobs"}
            after = await cc.current_rows(changes)
            assert not await cc.changed_since(changes, after)

            await cc.restore(changes)
            async with sessions() as db:
                assert [p.name for p in (await db.execute(select(Pool))).scalars()] == ["字节池"]
                assert (await db.execute(select(Job.pool_id))).scalar() == pool_id
            assert await cc.changed_since(changes, after)
        await engine.dispose()

    asyncio.run(run())
