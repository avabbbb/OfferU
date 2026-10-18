"""每天用本机的 boss-cli 同步一次投递和面试记录（默认关闭）。

只跑两个只读命令：`boss applied --json`（最近一页投递）和 `boss interviews --json`。
不搜索、不打招呼、不投递。登录态留在 boss-cli 自己的目录里，OfferU 不读取。
同步时间每天随机落在 10:00–21:00 之间，避免固定时间点。
结果走 boss_import 的同一套合并逻辑：状态只往前推。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import shutil
from datetime import datetime, timedelta
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field

from app.database import async_session
from app.models.models import BossSyncState

logger = logging.getLogger(__name__)

COMMANDS = (("applied",), ("interviews",))
MANUAL_GAP = timedelta(minutes=10)
CHECK_EVERY_SECONDS = 20 * 60
_TASK: Optional[asyncio.Task] = None
_LOCK = asyncio.Lock()


class BossSyncSettingsInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool
    table_id: Optional[int] = Field(default=None, gt=0)


def _boss_bin() -> Optional[str]:
    return os.getenv("OFFERU_BOSS_BIN") or shutil.which("boss")


def _next_run(after: datetime) -> datetime:
    day = after.date() + timedelta(days=1)
    return datetime.combine(day, datetime.min.time()) + timedelta(minutes=random.randint(10 * 60, 21 * 60))


async def _state(db) -> BossSyncState:  # noqa: ANN001
    return await db.get(BossSyncState, 1) or BossSyncState(id=1, enabled=False)


def _view(row: BossSyncState) -> dict[str, Any]:
    return {
        "installed": _boss_bin() is not None,
        "enabled": bool(row.enabled),
        "table_id": row.table_id,
        "next_run_at": row.next_run_at.isoformat() if row.enabled and row.next_run_at else None,
        "last_run_at": row.last_run_at.isoformat() if row.last_run_at else None,
        "last_ok": row.last_ok,
        "last_message": row.last_message or "",
    }


async def get_boss_sync() -> dict[str, Any]:
    async with async_session() as db:
        return _view(await _state(db))


async def set_boss_sync(enabled: bool, table_id: Optional[int] = None) -> dict[str, Any]:
    """开关每天同步。打开时要带上同步进哪张投递表。"""

    if enabled and not table_id:
        raise ValueError("打开同步时需要指定投递表")
    async with async_session() as db:
        row = await _state(db)
        row.enabled = enabled
        if table_id:
            row.table_id = table_id
        # 第一次打开时，今天稍后就跑一次；之后每天随机时间。
        row.next_run_at = datetime.now() + timedelta(minutes=random.randint(5, 60)) if enabled else None
        db.add(row)
        await db.commit()
        return _view(row)


async def _run_boss(args: tuple[str, ...]) -> dict[str, Any]:
    exe = _boss_bin()
    if not exe:
        raise ValueError("没找到 boss 命令。先运行 uv tool install kabi-boss-cli，再 boss login")
    proc = await asyncio.create_subprocess_exec(exe, *args, "--json", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=90)
    except asyncio.TimeoutError:
        proc.kill()
        raise ValueError("boss 命令 90 秒没有返回")
    try:
        data = json.loads(out.decode("utf-8", "replace"))
    except ValueError:
        raise ValueError("boss 命令没有输出 JSON，可能需要升级：uv tool upgrade kabi-boss-cli")
    if not data.get("ok"):
        code = (data.get("error") or {}).get("code")
        if code == "not_authenticated":
            raise ValueError("BOSS 登录过期了。在终端运行 boss login 后再同步")
        if code == "rate_limited":
            raise ValueError("BOSS 提示请求太频繁，今天先不同步")
        raise ValueError(str((data.get("error") or {}).get("message") or "boss 命令出错"))
    return data


async def run_boss_sync(manual: bool = True) -> dict[str, Any]:
    """现在跑一次。手动触发两次之间至少隔 10 分钟。"""

    from app.services.boss_import import import_boss_export

    async with _LOCK:
        async with async_session() as db:
            row = await _state(db)
            table_id = row.table_id
            last = row.last_run_at
        if not table_id:
            raise ValueError("还没有选同步进哪张投递表")
        if manual and last and datetime.now() - last < MANUAL_GAP:
            raise ValueError("刚同步过，10 分钟后再试")
        created = advanced = 0
        ok, message = True, ""
        try:
            for args in COMMANDS:
                result = await import_boss_export(table_id=table_id, payload=await _run_boss(args))
                created += result["created"]
                advanced += result["advanced"]
            message = f"新增 {created} 条，{advanced} 条更新了状态"
        except ValueError as exc:
            ok, message = False, str(exc)
        async with async_session() as db:
            row = await _state(db)
            row.last_run_at = datetime.now()
            row.last_ok = ok
            row.last_message = message[:300]
            if row.enabled:
                row.next_run_at = _next_run(row.last_run_at)
            db.add(row)
            await db.commit()
            view = _view(row)
    if manual and not ok:
        raise ValueError(message)
    return view


async def _loop() -> None:
    while True:
        try:
            async with async_session() as db:
                row = await _state(db)
                due = row.enabled and row.next_run_at and row.next_run_at <= datetime.now()
            if due:
                await run_boss_sync(manual=False)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - 后台循环不能因为一次失败退出
            logger.exception("boss daily sync failed")
        await asyncio.sleep(CHECK_EVERY_SECONDS)


async def start_boss_sync_service() -> None:
    global _TASK
    if _TASK is None or _TASK.done():
        _TASK = asyncio.create_task(_loop())


async def stop_boss_sync_service() -> None:
    global _TASK
    task, _TASK = _TASK, None
    if task and not task.done():
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
