"""Live runtime stream tasks shared by HTTP transport and fresh-reset cleanup."""
import asyncio
from typing import Any

BACKGROUND_RUNTIME_TASKS: set[asyncio.Task[Any]] = set()
