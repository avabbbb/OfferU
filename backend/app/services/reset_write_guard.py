"""Serialize stale-context materializers against an authorized fresh reset."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator


_RESET_WRITE_LOCK = asyncio.Lock()


@asynccontextmanager
async def reset_write_guard() -> AsyncIterator[None]:
    async with _RESET_WRITE_LOCK:
        yield
