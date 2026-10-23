"""OfferU as an MCP server: the same tools as the workbench (app/core/tools.py), nothing more.

`offeru mcp` runs it over stdio for Codex / Claude Code; the running app also serves it at /mcp.
"""

from __future__ import annotations

import json
from typing import Any

import anyio

from mcp.server.fastmcp import FastMCP
from mcp.types import TextContent, Tool as MCPTool

from app.core.tools import TOOLS, call

HAS_MCP_SERVER = True
INSTRUCTIONS = (
    "OfferU 是用户本地的求职工作台。先调 overview 看阶段、下一步和待办；找用户的经历和说过的话用 search。"
    "写入直接生效，用户能在「最近改动」里撤销，所以该存就存：用户提到的新经历、偏好、截止时间、面试安排都存下来。"
    "只能用用户真实的经历写简历和网申，不编数字。不替用户提交网申、不发消息。"
)


class OfferUMCP(FastMCP):
    async def list_tools(self) -> list[MCPTool]:
        return [MCPTool(name=t.name, description=t.description, inputSchema=t.input.model_json_schema()) for t in TOOLS.values()]

    async def call_tool(self, name: str, arguments: dict[str, Any]):  # type: ignore[override]
        client = None
        try:
            client = self.get_context().session.client_params.clientInfo.name  # type: ignore[union-attr]
        except Exception:  # noqa: BLE001 - client info is optional
            pass
        try:
            result = await anyio.to_thread.run_sync(lambda: call(name, arguments, actor=client or "agent"))
        except Exception as exc:  # noqa: BLE001 - tool errors go back to the agent as text
            return [TextContent(type="text", text=f"错误：{exc}")]
        return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, default=str))]


mcp = OfferUMCP("OfferU", instructions=INSTRUCTIONS, stateless_http=True, json_response=True)
