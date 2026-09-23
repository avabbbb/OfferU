"""Real OMP Agent executor for OfferU live eval.

This module drives OMP through its documented RPC protocol.  It does not choose
OfferU Skills or Operations on behalf of the model.

The harness owns only:
- process/session lifecycle;
- isolated environment wiring;
- model/thinking selection;
- event capture;
- fail-closed local bash policy;
- timeout/abort.

The model owns:
- Skill discovery;
- Operation selection;
- CLI tool calls;
- interpreting intermediate results.

OfferU still owns business authorization: a side-effect Operation creates a
Proposal and the Agent must leave that Proposal for the human to review.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
import contextlib
from functools import lru_cache
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[3]
BACKEND_DIR = PROJECT_ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.services.coding_agent_runtime import _command as _coding_agent_command
from app.services.security_redaction import redact_secret_text, redact_secret_value, safe_error_message


DEFAULT_EVAL_DIR = Path(os.environ.get("OFFERU_PRIVATE_EVAL_ROOT") or r"H:\tmp\offeru\private-eval")
DEFAULT_RUN_ROOT = Path(
    os.environ.get("OFFERU_LIVE_EVAL_AGENT_ROOT")
    or r"H:\tmp\offeru\live-eval-runs\agent"
)
DEFAULT_OMP_MODEL = os.environ.get("OFFERU_LIVE_EVAL_OMP_MODEL") or "avabbbb/devin/swe-2"
DEFAULT_OMP_THINKING = os.environ.get("OFFERU_LIVE_EVAL_OMP_THINKING") or "xhigh"

_TERMINAL_AGENT_END = "agent_end"
_RPC_READY_TYPES = {"ready", "rpc_ready"}
_MAX_RPC_REASSEMBLED_BYTES = 64 * 1024 * 1024
_RPC_STREAM_LIMIT = 2 * 1024 * 1024
_STDERR_TAIL_BYTES = 16 * 1024


@dataclass(slots=True)
class OmpRpcExecution:
    ok: bool
    model_requested: str
    thinking_requested: str
    model_observed: str = ""
    model_matches_requested: bool = False
    identity_verified: bool = False
    thinking_observed: str = ""
    session_id: str = ""
    agent_started: bool = False
    terminal_received: bool = False
    elapsed_s: float = 0.0
    final_text: str = ""
    events: list[dict[str, Any]] = field(default_factory=list)
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    state_before: dict[str, Any] = field(default_factory=dict)
    state_after: dict[str, Any] = field(default_factory=dict)
    stderr: str = ""
    error: str = ""
    aborted: bool = False
    exit_code: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def resolve_omp_command(
    args: list[str], *, omp_bin: str | None = None
) -> tuple[str, list[str]] | None:
    executable = omp_bin or os.environ.get("OFFERU_OMP_PATH") or shutil.which("omp")
    return _coding_agent_command(executable, args) if executable else None


@lru_cache(maxsize=8)
def _probe_omp_cached(executable: str, mtime_ns: int) -> tuple[str, str]:
    del mtime_ns  # cache key invalidates the result when the installed CLI changes
    try:
        version_command = _coding_agent_command(executable, ["--version"])
        version_result = subprocess.run(
            version_command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
            timeout=20,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        version_text = ((version_result.stdout or "") + (version_result.stderr or "")).strip()
        help_command = _coding_agent_command(executable, ["--help"])
        help_result = subprocess.run(
            help_command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
            timeout=20,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return "", safe_error_message(exc, max_length=500)

    help_text = (help_result.stdout or "") + "\n" + (help_result.stderr or "")
    if version_result.returncode != 0:
        return version_text, "OMP --version returned a non-zero exit code"
    required = ("--mode", "--no-session", "--model", "--thinking", "--config", "--tools", "--approval-mode")
    missing = [flag for flag in required if flag not in help_text]
    if "rpc" not in help_text.lower():
        missing.append("--mode rpc")
    if help_result.returncode != 0:
        return version_text, "OMP --help returned a non-zero exit code"
    if missing:
        return version_text, f"OMP CLI is missing required RPC options: {', '.join(missing)}"
    return version_text, ""


def probe_omp_cli(omp_bin: str | None = None) -> dict[str, Any]:
    executable = omp_bin or os.environ.get("OFFERU_OMP_PATH") or shutil.which("omp")
    if not executable:
        return {"ok": False, "executable": "", "version": "unavailable", "error": "OMP executable not found"}
    try:
        mtime_ns = Path(executable).stat().st_mtime_ns
    except OSError as exc:
        return {
            "ok": False,
            "executable": executable,
            "version": "unavailable",
            "error": safe_error_message(exc, max_length=500),
        }
    version, error = _probe_omp_cached(executable, mtime_ns)
    return {
        "ok": not error,
        "executable": executable,
        "version": redact_secret_text(version.splitlines()[0] if version else "unknown", max_length=80),
        "error": error,
    }


def _venv_scripts_dir() -> Path | None:
    candidates = (
        BACKEND_DIR / ".venv312" / ("Scripts" if os.name == "nt" else "bin"),
        BACKEND_DIR / ".venv" / ("Scripts" if os.name == "nt" else "bin"),
    )
    return next((path for path in candidates if path.is_dir()), None)


def _agent_environment(eval_db: Path, run_dir: Path) -> dict[str, str]:
    """Build an OMP environment without WorkBuddy desktop-session contamination."""

    env = os.environ.copy()
    for key in tuple(env):
        if key.upper().startswith("CODEBUDDY_"):
            env.pop(key, None)

    env["DATABASE_URL"] = f"sqlite+aiosqlite:///{eval_db.resolve().as_posix()}"
    env["OFFERU_DATA_DIR"] = str((run_dir / "offeru-data").resolve())
    env["PYTHONPATH"] = str(BACKEND_DIR.resolve())
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUNBUFFERED"] = "1"
    env["NO_COLOR"] = "1"

    venv_bin = _venv_scripts_dir()
    if venv_bin is not None:
        env["PATH"] = str(venv_bin) + os.pathsep + env.get("PATH", "")
    return env


def _write_omp_eval_config(run_dir: Path) -> Path:
    """Create a least-privilege OMP overlay for Agent-native eval.

    OMP itself may auto-approve normal tool execution, but this eval only permits
    bash calls that target OfferU's CLI.  Human business approval remains inside
    OfferU Proposal/HITL; self-confirm and self-reject CLI commands are denied.
    """

    path = run_dir / "omp-eval.yml"
    path.write_text(
        """tools:
  approvalMode: always-ask
  approval:
    bash: prompt
    read: allow
    grep: allow
    glob: allow
bash:
  patterns:
    - match: "*app.cli confirm*"
      approval: deny
    - match: "*app.cli run reject_agent_run*"
      approval: deny
    - match: "python* -m app.cli *"
      approval: allow
    - match: "python* -m app.cli"
      approval: allow
""",
        encoding="utf-8",
    )
    return path


def _offeru_agent_prompt(user_prompt: str) -> str:
    """Wrap only integration/safety context; do not leak an expected Operation path."""

    return f"""Use the OfferU integration provided by this repository to complete the user's career task.

User request:
{user_prompt}

Acceptance constraints:
- This is an Agent-native acceptance run. You decide which Skill and OfferU Operations are appropriate.
- Read and follow the generated OfferU Skill available in the repository.
- The process environment already points OfferU CLI at the isolated eval database.
- Run OfferU CLI from the repository root as: python -m app.cli <subcommand> ...
- Do not edit project files or use raw database writes/HTTP as a shortcut.
- Do not call app.cli confirm or reject_agent_run. Side-effect Operations must remain pending for the human to review in OfferU.
- Do not claim success unless the CLI result actually supports it.
- If information is missing, say so rather than inventing it.

Do not follow a pre-scripted tool sequence. Solve the user's request using the live Skill/capability contract.
"""


def _extract_response_data(frame: dict[str, Any]) -> dict[str, Any]:
    for key in ("data", "result", "state"):
        value = frame.get(key)
        if isinstance(value, dict):
            return value
    return {}


def _extract_identity(state: dict[str, Any]) -> tuple[str, str, str]:
    """Best-effort identity extraction while retaining full raw state in artifacts."""

    session_id = str(
        state.get("sessionId")
        or state.get("session_id")
        or state.get("session")
        or ""
    )
    thinking = str(
        state.get("thinkingLevel")
        or state.get("thinking_level")
        or state.get("thinking")
        or ""
    )
    model_value = state.get("model") or state.get("currentModel") or state.get("current_model")
    if isinstance(model_value, dict):
        provider = str(model_value.get("provider") or model_value.get("providerId") or "")
        model_id = str(model_value.get("id") or model_value.get("modelId") or "")
        observed = f"{provider}/{model_id}".strip("/")
    else:
        observed = str(model_value or "")
    return observed, thinking, session_id


def _tool_input(frame: dict[str, Any]) -> dict[str, Any]:
    value = frame.get("args")
    if not isinstance(value, dict):
        value = frame.get("input")
    return value if isinstance(value, dict) else {}


def _record_tool_start(frame: dict[str, Any]) -> dict[str, Any]:
    tool_name = str(frame.get("toolName") or frame.get("tool_name") or "")
    payload = _tool_input(frame)
    command = str(payload.get("command") or "")
    rendered = command if tool_name == "bash" else json.dumps(payload, ensure_ascii=False)
    return {
        "tool": tool_name,
        "input": rendered,
        "tool_call_id": str(frame.get("toolCallId") or frame.get("tool_call_id") or ""),
        "source": "model",
    }


async def _send_frame(proc: asyncio.subprocess.Process, payload: dict[str, Any]) -> None:
    if proc.stdin is None:
        raise RuntimeError("OMP RPC stdin is unavailable")
    proc.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
    await proc.stdin.drain()


async def _read_stderr(stream: asyncio.StreamReader | None, sink: bytearray) -> None:
    if stream is None:
        return
    while raw := await stream.read(4096):
        sink.extend(raw)
        if len(sink) > _STDERR_TAIL_BYTES:
            del sink[:-_STDERR_TAIL_BYTES]


async def _drain_stdout(reader: _RpcFrameReader, events: list[dict[str, Any]]) -> None:
    while True:
        try:
            events.append(await reader.read(deadline=time.monotonic() + 30))
        except (TimeoutError, asyncio.TimeoutError):
            return
        except RuntimeError as exc:
            if "exited before completion" not in str(exc):
                events.append(
                    {
                        "type": "error",
                        "source": "omp_rpc_shutdown",
                        "error": safe_error_message(exc, max_length=500),
                    }
                )
            return


class _RpcFrameReader:
    """Read protocol-v1 lines and losslessly reassemble negotiated v2 frames."""

    def __init__(self, stream: asyncio.StreamReader, return_code: Any) -> None:
        self._stream = stream
        self._return_code = return_code
        self._chunk_id = ""
        self._chunk_count = 0
        self._next_chunk = 0
        self._chunk_length = 0
        self._chunk_bytes = bytearray()

    async def read(self, *, deadline: float) -> dict[str, Any]:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("OMP RPC deadline exceeded")
            raw = await asyncio.wait_for(self._stream.readline(), timeout=remaining)
            if not raw:
                raise RuntimeError(
                    f"OMP RPC exited before completion (code={self._return_code()})"
                )
            try:
                frame = json.loads(raw.decode("utf-8", errors="strict"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise RuntimeError("OMP RPC emitted an invalid JSON frame") from exc
            if not isinstance(frame, dict):
                raise RuntimeError("OMP RPC frame must be a JSON object")

            is_chunk = frame.get("type") == "rpc_chunk"
            if self._chunk_id and not is_chunk:
                raise RuntimeError("OMP RPC interrupted a protocol-v2 chunk sequence")
            if not is_chunk:
                return frame

            chunk_id = frame.get("chunkId")
            index = frame.get("index")
            count = frame.get("count")
            byte_length = frame.get("byteLength")
            if (
                not isinstance(chunk_id, str)
                or not chunk_id
                or isinstance(index, bool)
                or not isinstance(index, int)
                or isinstance(count, bool)
                or not isinstance(count, int)
                or isinstance(byte_length, bool)
                or not isinstance(byte_length, int)
                or not 0 < count <= _MAX_RPC_REASSEMBLED_BYTES
                or not 0 <= byte_length <= _MAX_RPC_REASSEMBLED_BYTES
                or not isinstance(frame.get("data"), str)
            ):
                raise RuntimeError("OMP RPC emitted an invalid protocol-v2 chunk header")
            if not self._chunk_id:
                if index != 0:
                    raise RuntimeError("OMP RPC protocol-v2 chunk sequence did not start at 0")
                self._chunk_id = chunk_id
                self._chunk_count = count
                self._chunk_length = byte_length
            if (
                chunk_id != self._chunk_id
                or count != self._chunk_count
                or byte_length != self._chunk_length
                or index != self._next_chunk
            ):
                raise RuntimeError("OMP RPC protocol-v2 chunk sequence is inconsistent")
            try:
                chunk = base64.b64decode(frame["data"], validate=True)
            except (binascii.Error, ValueError) as exc:
                raise RuntimeError("OMP RPC emitted invalid base64 chunk data") from exc
            self._chunk_bytes.extend(chunk)
            if len(self._chunk_bytes) > self._chunk_length:
                raise RuntimeError("OMP RPC protocol-v2 frame exceeded its declared size")
            self._next_chunk += 1
            if self._next_chunk < self._chunk_count:
                continue
            if len(self._chunk_bytes) != self._chunk_length:
                raise RuntimeError("OMP RPC protocol-v2 frame size did not match its declaration")
            try:
                value = json.loads(self._chunk_bytes.decode("utf-8", errors="strict"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise RuntimeError("OMP RPC reassembled an invalid JSON frame") from exc
            self._chunk_id = ""
            self._chunk_count = 0
            self._next_chunk = 0
            self._chunk_length = 0
            self._chunk_bytes.clear()
            if not isinstance(value, dict):
                raise RuntimeError("OMP RPC frame must be a JSON object")
            return value


async def _request(
    proc: asyncio.subprocess.Process,
    reader: _RpcFrameReader,
    events: list[dict[str, Any]],
    payload: dict[str, Any],
    *,
    deadline: float,
) -> dict[str, Any]:
    request_id = str(payload["id"])
    await _send_frame(proc, payload)
    while True:
        frame = await reader.read(deadline=deadline)
        events.append(frame)
        if frame.get("type") == "response" and str(frame.get("id") or "") == request_id:
            if frame.get("success") is False:
                raise RuntimeError(str(frame.get("error") or f"RPC command {request_id} failed"))
            return frame


async def _terminate_process_tree(proc: asyncio.subprocess.Process) -> None:
    if os.name == "nt":
        try:
            await asyncio.to_thread(
                subprocess.run,
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                capture_output=True,
                check=False,
                timeout=10,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except (OSError, subprocess.TimeoutExpired):
            pass
    else:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(proc.pid, signal.SIGTERM)
        try:
            await asyncio.wait_for(proc.wait(), timeout=2)
        except asyncio.TimeoutError:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(proc.pid, signal.SIGKILL)
    if proc.returncode is None:
        with contextlib.suppress(ProcessLookupError):
            proc.kill()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(proc.wait(), timeout=3)


async def run_omp_rpc_agent(
    user_prompt: str,
    *,
    eval_db: Path,
    run_dir: Path,
    model: str = DEFAULT_OMP_MODEL,
    thinking: str = DEFAULT_OMP_THINKING,
    timeout: int = 600,
    omp_bin: str | None = None,
) -> OmpRpcExecution:
    """Run one OMP turn using the same RPC lifecycle as the case runner."""

    session = OmpRpcAgentSession(
        eval_db=eval_db,
        session_dir=run_dir,
        model=model,
        thinking=thinking,
        omp_bin=omp_bin,
    )
    result: OmpRpcExecution | None = None
    close_error = ""
    try:
        await session.start()
        result = await session.run_turn(user_prompt, run_dir=run_dir, timeout=timeout)
    finally:
        close_error = await session.close()
    if result is None:
        result = OmpRpcExecution(
            ok=False,
            model_requested=model,
            thinking_requested=thinking,
            error=session.error or "OMP RPC session ended before a turn completed",
        )
    if session.proc is not None:
        result.exit_code = session.proc.returncode
    if close_error:
        result.error = redact_secret_text(close_error, max_length=1000)
        result.ok = False
        if not result.final_text:
            result.final_text = result.error
    elif session.proc is not None:
        result.ok = result.ok and session.proc.returncode == 0
    (run_dir / "agent-execution.json").write_text(
        json.dumps(result.to_dict(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return result


class OmpRpcAgentSession:
    """Keep one in-memory OMP RPC session alive across a case's user turns."""

    def __init__(
        self, *, eval_db: Path, session_dir: Path, model: str = DEFAULT_OMP_MODEL,
        thinking: str = DEFAULT_OMP_THINKING, omp_bin: str | None = None,
    ) -> None:
        self.eval_db = eval_db
        self.session_dir = session_dir
        self.model = model
        self.thinking = thinking
        self.omp_bin = omp_bin
        self.proc: asyncio.subprocess.Process | None = None
        self.reader: _RpcFrameReader | None = None
        self.stderr_tail = bytearray()
        self.stderr_task: asyncio.Task[None] | None = None
        self.events: list[dict[str, Any]] = []
        self.state_before: dict[str, Any] = {}
        self.state_after: dict[str, Any] = {}
        self.error = ""
        self.turn_count = 0
        self.closed = False

    async def start(self) -> str:
        self.session_dir.mkdir(parents=True, exist_ok=True)
        executable = self.omp_bin or os.environ.get("OFFERU_OMP_PATH") or shutil.which("omp") or ""
        if not executable:
            self.error = "OMP executable not found on PATH"
            return self.error
        if not self.eval_db.is_file():
            self.error = f"Eval database does not exist: {self.eval_db}"
            return self.error
        probe = probe_omp_cli(executable)
        if not probe["ok"]:
            self.error = str(probe.get("error") or "OMP RPC capability probe failed")
            return self.error

        config_path = _write_omp_eval_config(self.session_dir)
        args = [
            "--mode", "rpc", "--no-session", "--model", self.model,
            "--thinking", self.thinking, "--config", str(config_path),
            "--approval-mode", "always-ask", "--tools", "read,bash,grep,glob",
        ]
        command = resolve_omp_command(args, omp_bin=executable)
        if command is None:
            self.error = "OMP executable could not be launched"
            return self.error
        process_kwargs: dict[str, Any] = {"limit": _RPC_STREAM_LIMIT}
        if os.name == "nt":
            process_kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        else:
            process_kwargs["start_new_session"] = True
        try:
            self.proc = await asyncio.create_subprocess_exec(
                command[0], *command[1], cwd=str(PROJECT_ROOT),
                env=_agent_environment(self.eval_db, self.session_dir),
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, **process_kwargs,
            )
            self.stderr_task = asyncio.create_task(_read_stderr(self.proc.stderr, self.stderr_tail))
            if self.proc.stdout is None:
                raise RuntimeError("OMP RPC stdout is unavailable")
            self.reader = _RpcFrameReader(self.proc.stdout, lambda: self.proc.returncode)
            deadline = time.monotonic() + 30
            while True:
                frame = await self.reader.read(deadline=deadline)
                self.events.append(frame)
                if str(frame.get("type") or "") in _RPC_READY_TYPES:
                    break
                if frame.get("type") == "extension_error":
                    raise RuntimeError(str(frame.get("error") or "OMP extension startup error"))
            ready = self.events[-1]
            versions = ready.get("supportedProtocolVersions")
            if isinstance(versions, list) and 2 in versions:
                await _request(
                    self.proc, self.reader, self.events,
                    {"id": "protocol-1", "type": "negotiate_protocol", "protocolVersion": 2},
                    deadline=deadline,
                )
            state = await _request(
                self.proc, self.reader, self.events,
                {"id": "state-before", "type": "get_state"}, deadline=deadline,
            )
            self.state_before = _extract_response_data(state)
            self.state_after = self.state_before
        except asyncio.CancelledError:
            await self._terminate()
            raise
        except Exception as exc:  # noqa: BLE001 - persist startup failures as trial evidence
            self.error = safe_error_message(exc, max_length=1000)
            await self._terminate()
        return self.error

    def _identity(self) -> tuple[str, bool, str, str, bool]:
        observed, thinking, session_id = _extract_identity(self.state_after or self.state_before)
        matches = bool(observed and observed.strip().casefold() == self.model.strip().casefold())
        verified = bool(matches and session_id and thinking.strip().casefold() == self.thinking.strip().casefold())
        return observed, matches, thinking, session_id, verified

    async def run_turn(self, user_prompt: str, *, run_dir: Path, timeout: int = 600) -> OmpRpcExecution:
        run_dir.mkdir(parents=True, exist_ok=True)
        self.turn_count += 1
        if self.error or self.proc is None or self.reader is None or self.closed or self.proc.returncode is not None:
            observed, model_matches, thinking_observed, session_id, identity_verified = self._identity()
            result = OmpRpcExecution(
                ok=False, model_requested=self.model, thinking_requested=self.thinking,
                model_observed=observed, model_matches_requested=model_matches,
                identity_verified=identity_verified, thinking_observed=thinking_observed,
                session_id=session_id, state_before=redact_secret_value(self.state_before),
                state_after=redact_secret_value(self.state_after),
                stderr=redact_secret_text(self.stderr_tail.decode("utf-8", errors="replace"), max_length=_STDERR_TAIL_BYTES),
                error=redact_secret_text(self.error or "OMP RPC session is unavailable", max_length=1000),
                exit_code=self.proc.returncode if self.proc else None,
            )
            self._write_turn_artifacts(run_dir, [], result)
            return result
        started = time.perf_counter()
        events: list[dict[str, Any]] = []
        tool_calls: list[dict[str, Any]] = []
        final_parts: list[str] = []
        state_before = self.state_before
        state_after: dict[str, Any] = self.state_after or state_before
        prompt_id = f"prompt-{self.turn_count}"
        agent_started = terminal = aborted = False
        error = ""
        cancelled = False
        deadline = time.monotonic() + timeout
        try:
            state = await _request(
                self.proc, self.reader, events,
                {"id": f"state-before-{self.turn_count}", "type": "get_state"}, deadline=deadline,
            )
            state_before = _extract_response_data(state)
            state_after = state_before
            self.state_before = state_before
            self.state_after = state_before
            await _send_frame(
                self.proc,
                {"id": prompt_id, "type": "prompt", "message": _offeru_agent_prompt(user_prompt)},
            )
            prompt_accepted = False
            while not (prompt_accepted and terminal):
                frame = await self.reader.read(deadline=deadline)
                events.append(frame)
                frame_type = str(frame.get("type") or "")
                if frame_type == "response" and frame.get("id") == prompt_id:
                    if frame.get("success") is False:
                        raise RuntimeError(str(frame.get("error") or "OMP prompt rejected"))
                    if _extract_response_data(frame).get("agentInvoked") is False:
                        raise RuntimeError("OMP prompt resolved locally without invoking the Agent")
                    prompt_accepted = True
                elif frame_type == "prompt_result" and frame.get("id") == prompt_id:
                    if frame.get("agentInvoked") is False:
                        raise RuntimeError("OMP prompt resolved locally without invoking the Agent")
                elif frame_type == "agent_start":
                    agent_started = True
                elif frame_type == "tool_execution_start":
                    tool_calls.append(_record_tool_start(frame))
                elif frame_type == "message_update":
                    update = frame.get("assistantMessageEvent")
                    if isinstance(update, dict) and update.get("type") == "text_delta":
                        final_parts.append(str(update.get("delta") or ""))
                elif frame_type == "extension_ui_request":
                    request_id = str(frame.get("id") or "")
                    if request_id:
                        await _send_frame(
                            self.proc,
                            {"type": "extension_ui_response", "id": request_id, "cancelled": True},
                        )
                elif frame_type == _TERMINAL_AGENT_END and frame.get("isTerminal") is not False:
                    terminal = True
            state = await _request(
                self.proc, self.reader, events,
                {"id": f"state-after-{self.turn_count}", "type": "get_state"}, deadline=deadline,
            )
            state_after = _extract_response_data(state)
            self.state_after = state_after
        except (TimeoutError, asyncio.TimeoutError):
            aborted = True
            error = f"OMP Agent timeout after {timeout}s"
            with contextlib.suppress(Exception):
                await _send_frame(self.proc, {"id": f"abort-timeout-{self.turn_count}", "type": "abort"})
            await asyncio.sleep(0.2)
            await self._terminate()
        except asyncio.CancelledError:
            aborted = True
            cancelled = True
            error = "OMP Agent task was cancelled"
            await self._terminate()
        except Exception as exc:  # noqa: BLE001 - harness must turn failures into artifacts
            error = safe_error_message(exc, max_length=1000)
            await self._terminate()

        if error and not self.error:
            self.error = error
        observed, model_matches, thinking_observed, session_id, identity_verified = self._identity()
        safe_events = redact_secret_value(events, max_length=_MAX_RPC_REASSEMBLED_BYTES)
        safe_calls = redact_secret_value(tool_calls, max_length=_MAX_RPC_REASSEMBLED_BYTES)
        result = OmpRpcExecution(
            ok=not error and agent_started and terminal,
            model_requested=self.model, thinking_requested=self.thinking,
            model_observed=observed, model_matches_requested=model_matches,
            identity_verified=identity_verified, thinking_observed=thinking_observed,
            session_id=session_id, agent_started=agent_started, terminal_received=terminal,
            elapsed_s=round(time.perf_counter() - started, 2),
            final_text=redact_secret_text("".join(final_parts).strip(), max_length=_MAX_RPC_REASSEMBLED_BYTES),
            events=safe_events, tool_calls=safe_calls,
            state_before=redact_secret_value(state_before, max_length=_MAX_RPC_REASSEMBLED_BYTES),
            state_after=redact_secret_value(state_after, max_length=_MAX_RPC_REASSEMBLED_BYTES),
            stderr=redact_secret_text(self.stderr_tail.decode("utf-8", errors="replace"), max_length=_STDERR_TAIL_BYTES),
            error=redact_secret_text(error, max_length=1000), aborted=aborted,
            exit_code=self.proc.returncode,
        )
        self.events.extend(events)
        self._write_turn_artifacts(run_dir, safe_events, result)
        if cancelled:
            raise asyncio.CancelledError
        return result

    @staticmethod
    def _write_turn_artifacts(
        run_dir: Path, events: list[dict[str, Any]], result: OmpRpcExecution
    ) -> None:
        (run_dir / "omp-rpc-events.ndjson").write_text(
            "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in events), encoding="utf-8",
        )
        (run_dir / "agent-execution.json").write_text(
            json.dumps(result.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8",
        )

    async def _terminate(self) -> None:
        if self.proc is not None:
            await _terminate_process_tree(self.proc)

    async def close(self) -> str:
        if self.closed:
            return self.error
        proc = self.proc
        try:
            if proc is not None:
                if proc.stdin is not None and not proc.stdin.is_closing():
                    proc.stdin.close()
                drain = asyncio.create_task(_drain_stdout(self.reader, self.events)) if self.reader else None
                try:
                    await asyncio.wait_for(proc.wait(), timeout=5)
                except asyncio.TimeoutError:
                    await self._terminate()
                if drain is not None:
                    with contextlib.suppress(Exception):
                        await asyncio.wait_for(drain, timeout=2)
                if self.stderr_task is not None:
                    with contextlib.suppress(Exception):
                        await asyncio.wait_for(self.stderr_task, timeout=2)
                shutdown_error = next(
                    (str(item.get("error") or "OMP RPC shutdown stream failed") for item in self.events
                     if item.get("type") == "error" and item.get("source") == "omp_rpc_shutdown"),
                    "",
                )
                if not self.error and shutdown_error:
                    self.error = shutdown_error
                if not self.error and proc.returncode not in (None, 0):
                    self.error = f"OMP exited with code {proc.returncode}"
        except asyncio.CancelledError:
            if proc is not None:
                await self._terminate()
            raise
        finally:
            safe_events = redact_secret_value(self.events, max_length=_MAX_RPC_REASSEMBLED_BYTES)
            self.session_dir.mkdir(parents=True, exist_ok=True)
            (self.session_dir / "session-events.ndjson").write_text(
                "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in safe_events), encoding="utf-8",
            )
            (self.session_dir / "session.json").write_text(
                json.dumps({
                    "turn_count": self.turn_count, "return_code": proc.returncode if proc else None,
                    "error": redact_secret_text(self.error, max_length=1000),
                    "stderr": redact_secret_text(self.stderr_tail.decode("utf-8", errors="replace"), max_length=_STDERR_TAIL_BYTES),
                }, ensure_ascii=False, indent=2), encoding="utf-8",
            )
            self.closed = True
        return self.error


def _load_case_prompt(cases_file: Path, case_id: str) -> str:
    payload = json.loads(cases_file.read_text(encoding="utf-8"))
    items = payload.get("cases") if isinstance(payload, dict) else []
    for item in items or []:
        if isinstance(item, dict) and str(item.get("case_id") or "") == case_id:
            turns = item.get("user_turns") if isinstance(item.get("user_turns"), list) else []
            if turns:
                return str(turns[0])
    raise ValueError(f"Case not found or has no user turn: {case_id}")


async def _main_async(args: argparse.Namespace) -> int:
    if args.prompt:
        prompt = args.prompt
    else:
        prompt = _load_case_prompt(Path(args.cases_file), args.case)

    run_id = f"omp-{args.case or 'prompt'}-{int(time.time())}"
    run_dir = Path(args.output_root) / run_id
    result = await run_omp_rpc_agent(
        prompt,
        eval_db=Path(args.db),
        run_dir=run_dir,
        model=args.model,
        thinking=args.thinking,
        timeout=args.timeout,
        omp_bin=args.omp_bin or None,
    )
    print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
    return 0 if result.ok else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Real OMP RPC Agent executor for OfferU eval")
    parser.add_argument("--case", default="", help="Eval case id")
    parser.add_argument("--prompt", default="", help="Natural-language task; overrides --case")
    parser.add_argument(
        "--cases-file",
        default=str(DEFAULT_EVAL_DIR / "private_resume_opt_6.json"),
    )
    parser.add_argument("--db", default=str(DEFAULT_EVAL_DIR / "eval.db"))
    parser.add_argument("--model", default=DEFAULT_OMP_MODEL)
    parser.add_argument("--thinking", default=DEFAULT_OMP_THINKING)
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--omp-bin", default="")
    parser.add_argument("--output-root", default=str(DEFAULT_RUN_ROOT))
    args = parser.parse_args()
    if not args.prompt and not args.case:
        parser.error("provide --prompt or --case")
    return asyncio.run(_main_async(args))


if __name__ == "__main__":
    raise SystemExit(main())
