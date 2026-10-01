"""Native Codex executor adapter for the existing durable OfferU Run host.

No business tools, permissions, approvals, scheduling or state live here.
"""
from __future__ import annotations

import json
from typing import Any

from app.runtime_paths import runtime_data_path
from app.services.agent_bridge.codex_adapter import CodexMainLoopAdapter
from app.services.agent_runtime import PiAgentRuntimeProvider


class CodexOperationWorker:
    def __init__(self) -> None:
        self.active_run_id: str | None = None
        self.adapter: CodexMainLoopAdapter | None = None
        self.workspace = runtime_data_path("codex_run_workspace")

    async def start_run(self, *, run_id, system_prompt, allowed_operations, operation_runner,
                        event_listener=None, session_file="", **_) -> dict[str, Any]:
        if self.active_run_id:
            raise ValueError("Codex 已有未处理的 OfferU Run，请先完成审核或取消。")
        self.active_run_id = run_id
        self.workspace.mkdir(parents=True, exist_ok=True)
        adapter = self.adapter = CodexMainLoopAdapter(thread_params={"config": {
            "features": {"plugins": False, "apps": False, "shell_tool": False},
        }}, turn_timeout=300)
        names = [item["name"] for item in allowed_operations]

        async def operation(name, args):
            if name != "offeru_operation" or not isinstance(args, dict) or args.get("operation") not in names:
                raise ValueError("Operation 不在当前 Skill 授权内。")
            return await operation_runner(args["operation"], args.get("arguments") or {})

        async def event(message):
            if event_listener and message.get("method") == "item/agentMessage/delta":
                await event_listener({"event": "message.delta", "payload": {"delta": (message.get("params") or {}).get("delta", "")}})

        adapter.on_operation = operation
        adapter.on_event = event
        try:
            await adapter.start()
            mcp_names = {str(event.get("params", {}).get("name") or "") for event in adapter.events()
                         if event.get("method") == "mcpServer/startupStatus/updated"}
            adapter.thread_params["config"]["mcp_servers"] = {name: {"enabled": False} for name in mcp_names if name}
            instructions = system_prompt + "\nUse only offeru_operation. Do not use shell, native file tools, other MCP servers or self-confirm proposals.\nOperation schemas:\n" + json.dumps(allowed_operations, ensure_ascii=False)
            if session_file:
                # Resume the exact native identity; failure must never create
                # a replacement thread and repeat unknown work.
                response = await adapter._request("thread/resume", {
                    "threadId": session_file, "cwd": str(self.workspace),
                    "approvalPolicy": "never", "sandbox": "read-only",
                    "developerInstructions": instructions, **adapter.thread_params,
                })
                adapter.thread_id = str((response.get("thread") or {}).get("id") or "")
                if adapter.thread_id != session_file:
                    raise ValueError("Codex 恢复了不同的会话，拒绝继续。")
                thread = {"threadId": adapter.thread_id, "model": response.get("model"), "modelProvider": response.get("modelProvider")}
            else:
                adapter.thread_params["developerInstructions"] = instructions
                thread = await adapter.create_thread(cwd=str(self.workspace), tool_schemas=[{
                    "name": "offeru_operation", "description": "Invoke an allowed OfferU Operation; mutations are proposals requiring independent user approval.",
                    "inputSchema": {"type": "object", "properties": {
                        "operation": {"type": "string", "enum": names},
                        "arguments": {"type": "object", "additionalProperties": True},
                    }, "required": ["operation", "arguments"], "additionalProperties": False},
                }])
            return {"session_id": thread["threadId"], "session_file": thread["threadId"],
                    "model": thread.get("model") or "", "model_provider": thread.get("modelProvider") or "",
                    "sdk_version": str(adapter.server_info.get("version") or ""), "active_tools": ["offeru_operation"]}
        except BaseException:
            await self.dispose_run(run_id)
            raise

    async def prompt(self, *, run_id, message, **_) -> dict[str, Any]:
        if self.active_run_id != run_id or self.adapter is None:
            raise ValueError("Codex 不拥有此 Run。")
        response = await self.adapter.start_turn(prompt=message, cwd=str(self.workspace))
        turn = response.get("completed") or {}
        if (turn.get("turn") or {}).get("status") in {"failed", "interrupted"}:
            raise RuntimeError("Codex turn 未完成，请检查原宿主后恢复。")
        return {"assistant_message": response["finalMessage"], "thread_id": response["threadId"], "turn_id": response["turnId"]}

    async def abort_run(self, run_id) -> dict:
        if self.active_run_id != run_id or self.adapter is None:
            raise ValueError("Codex 不拥有此 Run。")
        result = await self.adapter.cancel()
        if not result.get("cancelled"):
            raise RuntimeError("Codex 未确认取消；请检查原宿主。")
        return result

    async def dispose_run(self, run_id) -> dict:
        if self.active_run_id != run_id:
            raise ValueError("Codex 不拥有此 Run。")
        if self.adapter is not None:
            await self.adapter.close()
        self.adapter = None
        self.active_run_id = None
        return {"disposed": True}


_worker = CodexOperationWorker()


class CodexAgentRunProvider(PiAgentRuntimeProvider):
    """Reuse the existing Run, proposal, rejection and cancellation authority."""
    provider_id = "codex"

    async def status(self):
        from app.services.agent_connection import get_agent_connections
        snapshot = await get_agent_connections()
        item = next((item for item in snapshot["items"] if item["id"] == "codex"), {})
        return {"provider_id": "codex", "runtime": "codex_app_server", "status": item.get("status", "missing"),
                "available": bool(item.get("installed") and item.get("compatible")), "authenticated": item.get("authenticated"),
                "capabilities": {"approval": True, "resume": True, "stream": True}, "last_error": item.get("last_error", "")}

    async def start_run(self, **kwargs):
        from app.services.pi_agent_host import start_pi_agent_run
        return await start_pi_agent_run(**kwargs, worker=_worker, provider_config={}, provider_metadata={
            "provider_id": "codex", "runtime": "codex_app_server", "source": "native_host",
            "protocol_version": "offeru.agent-runtime.v1",
        })

    async def resume_run(self, run_id):
        from app.services.pi_agent_host import resume_pi_agent_run
        return await resume_pi_agent_run(run_id, worker=_worker, provider_config={}, provider_metadata={
            "provider_id": "codex", "runtime": "codex_app_server", "source": "native_host",
        })

    async def confirm_run(self, run_id, *, action_id):
        from app.services.pi_agent_host import confirm_pi_agent_action
        return await confirm_pi_agent_action(run_id, action_id=action_id, worker=_worker)

    async def reject_run(self, run_id, *, action_id):
        from app.services.pi_agent_host import reject_pi_agent_action
        return await reject_pi_agent_action(run_id, action_id=action_id, worker=_worker)

    async def abort_run(self, run_id):
        from app.services.pi_agent_host import abort_pi_agent_run
        return await abort_pi_agent_run(run_id, worker=_worker)
