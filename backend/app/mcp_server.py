from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import Any

from app.ops import get_operation_schema, list_operations
from app.services.operation_projection import (
    confirm_operation_proposal,
    execute_or_propose_operation,
)

try:
    from mcp.server.fastmcp import FastMCP

    HAS_MCP_SERVER = True
except ImportError:
    HAS_MCP_SERVER = False

    class FastMCP:  # type: ignore[no-redef]
        """Fallback used when the optional MCP package is unavailable."""

        def __init__(self, *args, **kwargs):
            self.settings = type("Settings", (), {"streamable_http_path": "/"})()

        def tool(self, *args, **kwargs):
            def decorator(fn):
                return fn

            return decorator

        def resource(self, *args, **kwargs):
            def decorator(fn):
                return fn

            return decorator

        @property
        def session_manager(self):
            @asynccontextmanager
            async def _noop():
                yield

            return type("NoopSessionManager", (), {"run": lambda self: _noop()})()

        def streamable_http_app(self):
            raise RuntimeError("MCP package is not installed")


mcp = FastMCP(
    "OfferU Operation Registry",
    instructions=(
        "OfferU MCP 是统一 Operation Registry 的薄投影，不包含数据库、业务服务或任意 HTTP 逃生口。"
        "先用 operation_catalog / operation_schema 发现能力。读操作直接执行；副作用操作只会创建持久化提案。"
        "只有在用户明确确认提案后，客户端才可调用 confirm_operation。"
    ),
    stateless_http=True,
    json_response=True,
)


@mcp.tool()
async def operation_catalog(
    group: str = "",
    mutation_only: bool = False,
) -> dict[str, Any]:
    """List Registry-generated Operation contracts."""

    operations = list_operations()
    if group:
        operations = [item for item in operations if item.get("group") == group]
    if mutation_only:
        operations = [
            item
            for item in operations
            if any(
                effect in {"write", "llm", "external"}
                for effect in item.get("side_effects") or []
            )
        ]
    return {
        "ok": True,
        "operation_count": len(operations),
        "operations": operations,
    }


@mcp.tool()
async def operation_schema(operation: str) -> dict[str, Any]:
    """Read one Operation schema from the same Registry used by Python and CLI."""

    schema = get_operation_schema(operation)
    if schema is None:
        return {"ok": False, "errors": [f"未知操作: {operation}"]}
    return {"ok": True, "schema": schema}


@mcp.tool()
async def offeru_operation(
    operation: str,
    args: dict[str, Any] | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Execute a read or create a persisted proposal for a side-effect Operation."""

    return await execute_or_propose_operation(
        operation,
        args or {},
        surface="mcp",
        dry_run=dry_run,
    )


@mcp.tool()
async def confirm_operation(
    run_id: str,
    action_id: str = "",
) -> dict[str, Any]:
    """Execute one persisted proposal after explicit user confirmation."""

    return await confirm_operation_proposal(
        run_id,
        action_id=action_id,
        surface="mcp",
    )


@mcp.resource("profile://current")
async def resource_profile() -> str:
    """Read the current profile through the Operation Registry."""

    result = await execute_or_propose_operation(
        "get_profile",
        {},
        surface="mcp",
    )
    return json.dumps(result, ensure_ascii=False, indent=2)
