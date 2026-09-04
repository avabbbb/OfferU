from __future__ import annotations

import asyncio
import inspect
import json
import logging
import os
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable

from app.services.security_redaction import redact_sensitive_text, safe_error_message


_logger = logging.getLogger(__name__)

PROTOCOL_VERSION = "offeru.pi-worker.v1"
MAX_PROTOCOL_LINE_BYTES = 2 * 1024 * 1024

OperationRunner = Callable[[str, dict[str, Any]], Awaitable[Any]]
EventListener = Callable[[dict[str, Any]], Any]


class PiAgentWorkerError(RuntimeError):
    pass


class PiAgentWorkerClient:
    """Own the local Pi SDK worker without giving it business authority.

    The worker may hold one active Pi Session. OfferU Agent Run state,
    Operation validation, confirmation and audit remain in Python.
    """

    def __init__(self, *, node_path: str | None = None, worker_path: Path | None = None) -> None:
        project_root = Path(__file__).resolve().parents[3]
        configured_runtime_dir = os.environ.get("OFFERU_AGENT_RUNTIME_DIR")
        self._runtime_dir = (
            Path(configured_runtime_dir).resolve()
            if configured_runtime_dir
            else project_root / "agent-runtime"
        )
        configured_worker_path = os.environ.get("OFFERU_PI_WORKER_PATH")
        self._worker_path = worker_path or (
            Path(configured_worker_path).resolve()
            if configured_worker_path
            else self._runtime_dir / "src" / "worker.mjs"
        )
        self._node_path = node_path or os.environ.get("OFFERU_NODE_PATH") or shutil.which("node")
        self._process: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._start_lock = asyncio.Lock()
        self._write_lock = asyncio.Lock()
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._ready: asyncio.Future[dict[str, Any]] | None = None
        self._active_run_id: str | None = None
        self._operation_runner: OperationRunner | None = None
        self._event_listener: EventListener | None = None
        self._stderr_tail: list[str] = []

    @property
    def active_run_id(self) -> str | None:
        return self._active_run_id

    async def probe(self) -> dict[str, Any]:
        await self._ensure_started()
        data = await self._command("runtime.probe", timeout=10)
        if data.get("protocol_version") != PROTOCOL_VERSION:
            raise PiAgentWorkerError(
                f"Pi Worker protocol mismatch: expected {PROTOCOL_VERSION}, got {data.get('protocol_version')}"
            )
        return data

    async def start_run(
        self,
        *,
        run_id: str,
        system_prompt: str,
        provider: dict[str, Any],
        allowed_operations: list[dict[str, Any]],
        operation_runner: OperationRunner,
        event_listener: EventListener | None = None,
        session_directory: str = "",
        session_file: str = "",
    ) -> dict[str, Any]:
        await self._ensure_started()
        if self._active_run_id is not None:
            raise PiAgentWorkerError(f"Pi Worker already owns active Run {self._active_run_id}")
        self._operation_runner = operation_runner
        self._event_listener = event_listener
        try:
            data = await self._command(
                "run.start",
                timeout=30,
                run_id=run_id,
                system_prompt=system_prompt,
                provider=provider,
                allowed_operations=allowed_operations,
                session={
                    "mode": "resume" if session_file else "create",
                    "directory": session_directory,
                    **({"file": session_file} if session_file else {}),
                },
            )
        except Exception:
            self._operation_runner = None
            self._event_listener = None
            raise
        active_tools = set(data.get("active_tools") or [])
        if active_tools != {"offeru_operation"}:
            try:
                await self._command("run.dispose", timeout=10, run_id=run_id)
            finally:
                self._operation_runner = None
                self._event_listener = None
            raise PiAgentWorkerError(
                f"Unsafe Pi tool projection for Run {run_id}: {sorted(active_tools)}"
            )
        self._active_run_id = run_id
        return data

    async def prompt(self, *, run_id: str, message: str, timeout: float = 180) -> dict[str, Any]:
        if self._active_run_id != run_id:
            raise PiAgentWorkerError(f"Pi Worker does not own Run {run_id}")
        return await self._command("run.prompt", timeout=timeout, run_id=run_id, message=message)

    async def abort_run(self, run_id: str) -> dict[str, Any]:
        if self._active_run_id != run_id:
            raise PiAgentWorkerError(f"Pi Worker does not own Run {run_id}")
        return await self._command("run.abort", timeout=15, run_id=run_id)

    async def dispose_run(self, run_id: str) -> dict[str, Any]:
        if self._active_run_id != run_id:
            raise PiAgentWorkerError(f"Pi Worker does not own Run {run_id}")
        try:
            return await self._command("run.dispose", timeout=15, run_id=run_id)
        finally:
            self._active_run_id = None
            self._operation_runner = None
            self._event_listener = None

    async def close(self) -> None:
        process = self._process
        if process is None:
            return
        if process.returncode is None:
            try:
                await self._command("shutdown", timeout=5)
            except Exception as exc:
                _logger.warning(
                    "Pi Worker did not acknowledge shutdown: %s",
                    safe_error_message(exc),
                )
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
        for task in (self._reader_task, self._stderr_task):
            if task is not None and not task.done():
                task.cancel()
        self._process = None
        self._reader_task = None
        self._stderr_task = None
        self._ready = None
        self._active_run_id = None
        self._operation_runner = None
        self._event_listener = None

    async def _ensure_started(self) -> None:
        if self._process is not None and self._process.returncode is None:
            return
        async with self._start_lock:
            if self._process is not None and self._process.returncode is None:
                return
            if not self._node_path:
                raise PiAgentWorkerError("Node.js was not found; Pi SDK requires Node >=22.19.0")
            if not self._worker_path.is_file():
                raise PiAgentWorkerError(f"Pi Worker entrypoint was not found: {self._worker_path}")
            if not (self._runtime_dir / "node_modules" / "@earendil-works" / "pi-coding-agent").is_dir():
                raise PiAgentWorkerError(
                    "Pi SDK dependencies are not installed; run npm install --ignore-scripts in agent-runtime"
                )

            creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
            self._ready = asyncio.get_running_loop().create_future()
            self._process = await asyncio.create_subprocess_exec(
                self._node_path,
                str(self._worker_path),
                cwd=str(self._runtime_dir),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                limit=MAX_PROTOCOL_LINE_BYTES,
                creationflags=creationflags,
            )
            self._reader_task = asyncio.create_task(self._reader_loop(), name="offeru-pi-worker-reader")
            self._stderr_task = asyncio.create_task(self._stderr_loop(), name="offeru-pi-worker-stderr")
            try:
                ready = await asyncio.wait_for(self._ready, timeout=15)
            except Exception:
                await self.close()
                raise
            if ready.get("protocol_version") != PROTOCOL_VERSION:
                await self.close()
                raise PiAgentWorkerError(
                    f"Pi Worker protocol mismatch: expected {PROTOCOL_VERSION}, got {ready.get('protocol_version')}"
                )

    async def _command(self, command_type: str, *, timeout: float, **payload: Any) -> dict[str, Any]:
        process = self._process
        if process is None or process.returncode is not None or process.stdin is None:
            raise PiAgentWorkerError("Pi Worker is not running")
        command_id = f"cmd_{uuid.uuid4().hex}"
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[command_id] = future
        command = {"id": command_id, "type": command_type, **payload}
        raw = (json.dumps(command, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        if len(raw) > MAX_PROTOCOL_LINE_BYTES:
            self._pending.pop(command_id, None)
            raise PiAgentWorkerError(f"Pi Worker command exceeds protocol limit: {command_type}")
        try:
            async with self._write_lock:
                process.stdin.write(raw)
                await process.stdin.drain()
            message = await asyncio.wait_for(future, timeout=timeout)
        except Exception:
            self._pending.pop(command_id, None)
            raise
        if not message.get("success"):
            raise PiAgentWorkerError(str(message.get("error") or f"Pi Worker command failed: {command_type}"))
        data = message.get("data")
        return data if isinstance(data, dict) else {}

    async def _reader_loop(self) -> None:
        process = self._process
        assert process is not None and process.stdout is not None
        try:
            while raw := await process.stdout.readline():
                if len(raw) > MAX_PROTOCOL_LINE_BYTES:
                    raise PiAgentWorkerError("Pi Worker emitted an oversized protocol record")
                try:
                    message = json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise PiAgentWorkerError(f"Pi Worker emitted invalid JSONL: {exc}") from exc
                if message.get("type") == "response":
                    future = self._pending.pop(str(message.get("id") or ""), None)
                    if future is not None and not future.done():
                        future.set_result(message)
                    continue
                if message.get("type") != "event":
                    continue
                if message.get("event") == "runtime.ready" and self._ready is not None and not self._ready.done():
                    payload = message.get("payload")
                    self._ready.set_result(payload if isinstance(payload, dict) else {})
                    continue
                if message.get("event") == "operation.requested":
                    asyncio.create_task(self._handle_operation_request(message))
                await self._notify_event(message)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._fail_pending(PiAgentWorkerError(safe_error_message(exc)))
        finally:
            returncode = await process.wait()
            detail = redact_sensitive_text(
                "; ".join(self._stderr_tail[-3:]), max_length=1500
            )
            message = f"Pi Worker exited with code {returncode}"
            if detail:
                message = f"{message}: {detail}"
            self._fail_pending(PiAgentWorkerError(message))
            self._active_run_id = None
            self._operation_runner = None
            self._event_listener = None

    async def _stderr_loop(self) -> None:
        process = self._process
        assert process is not None and process.stderr is not None
        try:
            while raw := await process.stderr.readline():
                line = raw.decode("utf-8", errors="replace").strip()
                if line:
                    self._stderr_tail.append(redact_sensitive_text(line, max_length=500))
                    self._stderr_tail = self._stderr_tail[-20:]
        except asyncio.CancelledError:
            raise

    async def _handle_operation_request(self, message: dict[str, Any]) -> None:
        payload = message.get("payload") if isinstance(message.get("payload"), dict) else {}
        request_id = str(payload.get("request_id") or "")
        run_id = str(message.get("run_id") or "")
        operation = str(payload.get("operation") or "")
        arguments = payload.get("arguments") if isinstance(payload.get("arguments"), dict) else {}
        runner = self._operation_runner
        if not request_id or run_id != self._active_run_id or runner is None:
            result: Any = {"ok": False, "errors": ["Operation request has no active OfferU Run"]}
        else:
            try:
                result = await runner(operation, arguments)
            except Exception as exc:
                result = {"ok": False, "errors": [safe_error_message(exc)]}
        try:
            await self._command(
                "operation.result",
                timeout=10,
                run_id=run_id,
                request_id=request_id,
                result=result,
            )
        except Exception as exc:
            _logger.error(
                "Failed to return Operation result to Pi Worker: %s",
                safe_error_message(exc),
            )

    async def _notify_event(self, message: dict[str, Any]) -> None:
        listener = self._event_listener
        if listener is None:
            return
        try:
            result = listener(message)
            if inspect.isawaitable(result):
                await result
        except Exception as exc:
            _logger.error("Pi Worker event listener failed: %s", safe_error_message(exc))

    def _fail_pending(self, error: Exception) -> None:
        for future in self._pending.values():
            if not future.done():
                future.set_exception(error)
        self._pending.clear()
        if self._ready is not None and not self._ready.done():
            self._ready.set_exception(error)


_worker = PiAgentWorkerClient()


def get_pi_agent_worker() -> PiAgentWorkerClient:
    return _worker


async def close_pi_agent_worker() -> None:
    await _worker.close()
