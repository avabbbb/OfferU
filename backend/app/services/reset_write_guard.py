"""Serialize stale-context materializers against an authorized fresh reset."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator


_RESET_WRITE_LOCK = asyncio.Lock()
_RESET_WRITE_OWNER: asyncio.Task | None = None


@asynccontextmanager
async def reset_write_guard() -> AsyncIterator[None]:
    global _RESET_WRITE_OWNER
    current = asyncio.current_task()
    if _RESET_WRITE_OWNER is current:
        yield
        return
    async with _RESET_WRITE_LOCK:
        _RESET_WRITE_OWNER = current
        try:
            yield
        finally:
            _RESET_WRITE_OWNER = None
