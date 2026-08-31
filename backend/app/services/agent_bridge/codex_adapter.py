"""Codex App Server main-loop adapter (Slice 6).

Replaces DeepSeek Harness as the main-loop harness for ONE OfferU Run, speaking
the codex app-server stdio JSON-RPC protocol (verified against codex-cli
0.149.0). Responsibilities:

- launch `codex app-server proxy`-backed stdio session bound to a Bridge Run;
- `thread/start` + `turn/start` with a read-only sandbox and approval policy
  `never` (ADR-0052: OfferU overlay is the ONLY approval authority);
- inject the Run's granted Bridge Operations as custom-tool descriptions into
  the turn input (no MCP — ADR-0051 CLI-first);
- answer `custom_tool_call` items by routing to the OfferU Agent Bridge;
- map `turn/interrupt` / steer to Bridge lease-aware events.

COMPATIBILITY (verified against codex-cli 0.149.0, 2026-08-23):
- `thread/start|resume`, `turn/start|interrupt|steer`, plain turns: WORK.
- Dynamic tool projection: WORK (experimental). Declare tools via
  `thread/start.dynamicTools` (requires initialize capability
  `experimentalApi: true`); codex emits `item/tool/call` server requests
  with `DynamicToolCallParams {threadId, turnId, callId, namespace, tool,
  arguments}`; the client answers with the same request id and a
  `DynamicToolCallResponse {contentItems:[{type:"inputText",text}], success}`.
  End-to-end verified: model called offeru_list_jobs → Bridge → SQLite →
  correct first-job title returned. No MCP needed (ADR-0051 CLI-first).

Same behavioral contract as the DSH host half, so the conformance suite runs
against this adapter unchanged.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from typing import Any

from app.services.agent_bridge.errors import BridgeProtocolError
from app.services.security_redaction import safe_error_message

_CUSTOM_TOOL_PROMPT = """\
可用 OfferU 业务工具（通过 custom_tool_call 调用，直接返回结果，不要用 shell/CLI）：
{tool_descriptions}
当用户需要读取 OfferU 岗位、档案或投递数据时，优先调用上述工具并报告结果。
"""


def _resolve_codex_binary() -> str:
    """Locate the codex native binary (npm .cmd shims are not spawnable)."""
    import shutil
    import os

    found = shutil.which("codex")
    if found and found.lower().endswith(".exe"):
        return found
    # npm shim → node_modules/@openai/codex-win32-x64/vendor/.../codex.exe
    candidates = [
        os.path.expanduser(
            r"~\AppData\Roaming\npm\node_modules\@openai\codex\node_modules"
            r"\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe"
        ),
    ]
    for candidate in candidates:
        if os.path.isfile(candidate):
            return candidate
    raise FileNotFoundError(
        "codex binary not found; install via `npm install -g @openai/codex`"
    )


class CodexMainLoopAdapter:
    """One codex app-server session acting as the main loop for a Bridge Run."""

    def __init__(
        self,
        *,
        executable: str | None = None,
        thread_params: dict[str, Any] | None = None,
    ):
        self.executable = executable or _resolve_codex_binary()
        self.thread_params = thread_params or {}
        self.process: asyncio.subprocess.Process | None = None
        self.thread_id = ""
        self.turn_id = ""
        self._request_id = 0
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._reader_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[bytes] | None = None
        self._turn_completed: dict[str, Any] | None = None
        self._message_parts: list[str] = []
        self._final_message = ""
        self._events: list[dict[str, Any]] = []
        self.server_info: dict[str, Any] = {}
        self.protocol_version = "1"

    # ---- lifecycle ----

    async def start(self) -> None:
        """Spawn `codex app-server --stdio` and complete the Initialize handshake."""
        import os

        if self.process is not None:
            await self.close()
        environment = dict(os.environ)
        environment["NO_COLOR"] = "1"
        self.process = await asyncio.create_subprocess_exec(
            self.executable,
            "app-server",
            "--stdio",
            env=environment,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self._reader_task = asyncio.create_task(self._reader())
        assert self.process.stderr is not None
        self._stderr_task = asyncio.create_task(self.process.stderr.read())
        initialize = await self._request(
            "initialize",
            {
                "clientInfo": {
                    "name": "offeru",
                    "title": "OfferU Codex Main Loop",
                    "version": "0.1.0",
                },
                "capabilities": {
                    "experimentalApi": True,  # required for thread/start.dynamicTools
                    "requestAttestation": False,
                },
            },
        )
        # codex 0.149 returns a flat server descriptor (no serverInfo wrapper).
        if not initialize.get("userAgent") and not initialize.get("codexHome"):
            raise RuntimeError(
                "codex app-server initialize failed: "
                + safe_error_message(RuntimeError(str(initialize)))
            )
        self.server_info = initialize
        self.protocol_version = str(
            initialize.get("protocolVersion")
            or initialize.get("protocol_version")
            or self.protocol_version
        )[:80]
        await self._write({"method": "initialized", "params": {}})

    async def close(self) -> None:
        process = self.process
        reader_task = self._reader_task
        stderr_task = self._stderr_task
        self._reader_task = None
        self._stderr_task = None
        for future in self._pending.values():
            if not future.done():
                future.set_exception(RuntimeError("codex app-server closed"))
        self._pending.clear()
        if reader_task is not None and reader_task is not asyncio.current_task():
            reader_task.cancel()
        if stderr_task is not None and stderr_task is not asyncio.current_task():
            stderr_task.cancel()
        for task in (reader_task, stderr_task):
            if task is not None and task is not asyncio.current_task():
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
        if process is not None and process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except asyncio.TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    process.kill()
                await process.wait()
        self.process = None
        self.thread_id = ""
        self.turn_id = ""
        self.server_info = {}
        self._turn_completed = None

    # ---- protocol ----

    async def _request(
        self, method: str, params: dict[str, Any]
    ) -> dict[str, Any]:
        self._request_id += 1
        request_id = self._request_id
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        await self._write({"id": request_id, "method": method, "params": params})
        try:
            return await asyncio.wait_for(future, timeout=300)
        except asyncio.TimeoutError as exc:
            self._pending.pop(request_id, None)
            raise TimeoutError(f"codex {method} timed out") from exc

    async def _write(self, record: dict[str, Any]) -> None:
        if self.process is None or self.process.stdin is None:
            raise RuntimeError("codex app-server not running")
        self.process.stdin.write((json.dumps(record) + "\n").encode("utf-8"))
        await self.process.stdin.drain()

    async def _reader(self) -> None:
        assert self.process is not None and self.process.stdout is not None
        buffer = ""
        while True:
            chunk = await self.process.stdout.readline()
            if not chunk:
                break
            buffer += chunk.decode("utf-8", errors="replace")
            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if msg.get("id") in self._pending:
                    future = self._pending.pop(msg["id"])
                    if not future.done():
                        if msg.get("error"):
                            future.set_exception(
                                RuntimeError(
                                    "codex: "
                                    + safe_error_message(
                                        RuntimeError(str(msg["error"]))
                                    )
                                )
                            )
                        else:
                            future.set_result(msg.get("result") or {})
                else:
                    await self._handle_push(msg)
    async def _handle_push(self, msg: dict[str, Any]) -> None:
        """Handle server-initiated requests (e.g. tool calls, approvals)."""
        self._events.append(msg)
        method = str(msg.get("method") or "")
        request_id = msg.get("id")
        if method in {"custom_tool_call", "dynamic_tool_call", "item/tool/call"}:
            await self._answer_tool_call(msg, request_id=request_id)
        elif method == "item/agentMessage/delta":
            delta = str((msg.get("params") or {}).get("delta") or "")
            if delta:
                self._message_parts.append(delta)
        elif method == "item/completed":
            item = (msg.get("params") or {}).get("item") or {}
            if isinstance(item, dict) and item.get("type") == "agentMessage":
                self._final_message = str(item.get("text") or "")
        elif method == "turn/completed":
            self._turn_completed = msg.get("params") or msg
        elif request_id is not None:
            # Unknown server request: deny with an error (never self-approve).
            await self._write(
                {
                    "id": request_id,
                    "error": {
                        "code": -32001,
                        "message": "OfferU codex main-loop denied this request",
                    },
                }
            )

    async def _answer_tool_call(
        self, msg: dict[str, Any], *, request_id: Any = None
    ) -> None:
        """Answer a model custom_tool_call by routing to the Bridge."""
        params = msg.get("params") or {}
        call_id = str(params.get("callId") or params.get("call_id") or "")
        name = str(params.get("tool") or params.get("name") or "")
        arguments = params.get("arguments") or {}
        try:
            result = await self.on_operation(str(name), arguments)
            output = {"type": "text", "text": json.dumps(result, ensure_ascii=False)}
            success = True
        except BridgeProtocolError as exc:
            output = {"type": "text", "text": f"error: {exc.code} {exc.message}"}
            success = False
        except Exception as exc:  # noqa: BLE001 - answer the model, never crash the loop
            output = {"type": "text", "text": f"error: {type(exc).__name__}: {exc}"}
            success = False
        if request_id is not None:
            # JSON-RPC-style server request: answer with the SAME id and the
            # DynamicToolCallResponse shape {contentItems, success}.
            await self._write(
                {
                    "id": request_id,
                    "result": {
                        "contentItems": [
                            {"type": "inputText", "text": output["text"]}
                        ],
                        "success": success,
                    },
                }
            )
            return
        await self._request(
            "turn/respond",
            {
                "turnId": self.turn_id,
                "item": {
                    "type": "custom_tool_call_output",
                    "call_id": call_id,
                    "output": output,
                    "success": success,
                },
            },
        )

    # ---- provider-neutral lifecycle ----

    async def create_thread(
        self,
        *,
        cwd: str,
        tool_descriptions: list[str] | None = None,
    ) -> dict[str, Any]:
        """Create one read-only thread, exposing only the supplied tools."""

        if self.thread_id:
            return {"threadId": self.thread_id, "reused": True}
        descriptions = tool_descriptions or []
        self._tool_descriptions = []
        for line in descriptions:
            name = line.split("(", 1)[0].split("—", 1)[0].strip()
            if name:
                self._tool_descriptions.append((name, line))
        dynamic_tools = [
            {
                "name": name,
                "description": description,
                "type": "function",
                "inputSchema": {"type": "object", "additionalProperties": True},
            }
            for name, description in self._tool_descriptions
        ]
        thread_response = await self._request(
            "thread/start",
            {
                "cwd": cwd,
                "approvalPolicy": "never",
                "sandbox": "read-only",
                "developerInstructions": (
                    "You are the OfferU main-loop agent. Use the offered "
                    "dynamic tools for business reads. Never self-approve "
                    "side effects; the OfferU workbench overlay decides."
                ),
                **({"dynamicTools": dynamic_tools} if dynamic_tools else {}),
                **self.thread_params,
            },
        )
        thread = thread_response.get("thread") or {}
        self.thread_id = str(thread.get("id") or "")
        if not self.thread_id:
            raise RuntimeError("codex thread/start returned no thread id")
        return {"threadId": self.thread_id, "thread": thread}

    async def start_turn(self, *, prompt: str, cwd: str) -> dict[str, Any]:
        """Start a turn on the current thread and wait for its completion push."""

        if not self.thread_id:
            await self.create_thread(cwd=cwd, tool_descriptions=[])
        self._turn_completed = None
        self._message_parts = []
        self._final_message = ""
        turn_response = await self._request(
            "turn/start",
            {
                "threadId": self.thread_id,
                "input": [
                    {
                        "type": "text",
                        "text": prompt,
                        "text_elements": [],
                    }
                ],
                "cwd": cwd,
                "approvalPolicy": "never",
                "sandboxPolicy": {"type": "readOnly", "networkAccess": False},
            },
        )
        turn = turn_response.get("turn") or {}
        self.turn_id = str(turn.get("id") or "")
        if not self.turn_id:
            raise RuntimeError("codex turn/start returned no turn id")
        completed = await self._completed_turn()
        return {
            "threadId": self.thread_id,
            "turnId": self.turn_id,
            "completed": completed,
            "finalMessage": self._final_message or "".join(self._message_parts),
        }

    async def resume_turn(self, *, prompt: str, cwd: str) -> dict[str, Any]:
        """Resume the bound thread when the server supports thread/resume."""

        if not self.thread_id:
            return await self.start_turn(prompt=prompt, cwd=cwd)
        try:
            await self._request("thread/resume", {"threadId": self.thread_id})
        except Exception:
            # A server without the optional resume method can still continue
            # the same thread through turn/start.
            pass
        return await self.start_turn(prompt=prompt, cwd=cwd)

    async def cancel(self) -> dict[str, Any]:
        if not self.turn_id:
            return {"cancelled": False, "reason": "no_active_turn"}
        try:
            await self._request(
                "turn/interrupt",
                {"threadId": self.thread_id, "turnId": self.turn_id},
            )
        except Exception as exc:  # cancellation remains best-effort
            return {"cancelled": False, "error": safe_error_message(exc)}
        return {"cancelled": True, "threadId": self.thread_id, "turnId": self.turn_id}

    def events(self, *, after: int = 0) -> list[dict[str, Any]]:
        return list(self._events[max(0, int(after)):])

    async def approve(self, **_: Any) -> dict[str, Any]:
        return {"approved": False, "reason": "OfferU overlay owns approvals"}

    async def reject(self, **_: Any) -> dict[str, Any]:
        return {"rejected": True, "reason": "OfferU overlay owns approvals"}

    # ---- main loop ----

    async def run_turn(
        self,
        *,
        prompt: str,
        cwd: str,
        tool_descriptions: list[str],
    ) -> dict[str, Any]:
        """Start a thread (once) and one turn bound to the Bridge Run."""
        if not self.thread_id:
            await self.create_thread(cwd=cwd, tool_descriptions=tool_descriptions)
        tool_block = (
            _CUSTOM_TOOL_PROMPT.format(tool_descriptions="\n".join(tool_descriptions))
            if tool_descriptions
            else ""
        )
        return await self.start_turn(prompt=f"{tool_block}\n{prompt}", cwd=cwd)

    async def _completed_turn(self) -> dict[str, Any]:
        """Wait for the turn/completed push for the current turn."""
        deadline = asyncio.get_running_loop().time() + 360
        while asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.2)
            # Pushes are handled in _reader; completed state is tracked there.
            if self._turn_completed:
                item = self._turn_completed
                self._turn_completed = None
                return item
        raise TimeoutError("codex turn did not complete")

    # ---- callback (set by the Bridge binding) ----

    async def on_operation(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError("bind on_operation before run_turn")
