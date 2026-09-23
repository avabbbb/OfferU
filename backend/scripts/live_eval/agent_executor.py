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
import contextlib
import json
import os
import shutil
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[3]
BACKEND_DIR = PROJECT_ROOT / "backend"
DEFAULT_EVAL_DIR = Path(os.environ.get("OFFERU_PRIVATE_EVAL_ROOT") or r"H:\tmp\offeru\private-eval")
DEFAULT_RUN_ROOT = Path(
    os.environ.get("OFFERU_LIVE_EVAL_AGENT_ROOT")
    or r"H:\tmp\offeru\live-eval-runs\agent"
)
DEFAULT_OMP_MODEL = os.environ.get("OFFERU_LIVE_EVAL_OMP_MODEL") or "avabbbb/devin/swe-2"
DEFAULT_OMP_THINKING = os.environ.get("OFFERU_LIVE_EVAL_OMP_THINKING") or "xhigh"

_TERMINAL_AGENT_END = "agent_end"
_RPC_READY_TYPES = {"ready", "rpc_ready"}


@dataclass(slots=True)
class OmpRpcExecution:
    ok: bool
    model_requested: str
    thinking_requested: str
    model_observed: str = ""
    thinking_observed: str = ""
    session_id: str = ""
    elapsed_s: float = 0.0
    final_text: str = ""
    events: list[dict[str, Any]] = field(default_factory=list)
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    state_before: dict[str, Any] = field(default_factory=dict)
    state_after: dict[str, Any] = field(default_factory=dict)
    stderr: str = ""
    error: str = ""
    aborted: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


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
        upper = key.upper()
        if upper.startswith("CODEBUDDY_GATEWAY_") or upper.startswith("CODEBUDDY_CONVERSATION_"):
            env.pop(key, None)
        if upper in {"CODEBUDDY_HOST", "CODEBUDDY_PROJECT_DIR"}:
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
    OfferU Proposal/HITL and the CLI confirm command is explicitly denied.
    """

    path = run_dir / "omp-eval.yml"
    path.write_text(
        """tools:
  approvalMode: always-ask
  approval:
    read: allow
    grep: allow
    glob: allow
bash:
  patterns:
    - match: "*app.cli confirm*"
      approval: deny
    - match: "python* -m app.cli *"
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
- Do not call app.cli confirm. Side-effect Operations must remain pending for the human to review in OfferU.
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


async def _read_stderr(stream: asyncio.StreamReader | None, sink: list[str]) -> None:
    if stream is None:
        return
    async for raw in stream:
        sink.append(raw.decode("utf-8", errors="replace"))


async def _read_frame(
    proc: asyncio.subprocess.Process,
    *,
    deadline: float,
) -> dict[str, Any]:
    if proc.stdout is None:
        raise RuntimeError("OMP RPC stdout is unavailable")
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("OMP RPC deadline exceeded")
    raw = await asyncio.wait_for(proc.stdout.readline(), timeout=remaining)
    if not raw:
        raise RuntimeError(f"OMP RPC exited before completion (code={proc.returncode})")
    try:
        value = json.loads(raw.decode("utf-8", errors="replace"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"OMP RPC emitted non-JSON stdout: {raw[:200]!r}") from exc
    if not isinstance(value, dict):
        raise RuntimeError("OMP RPC frame must be a JSON object")
    return value


async def _request(
    proc: asyncio.subprocess.Process,
    events: list[dict[str, Any]],
    payload: dict[str, Any],
    *,
    deadline: float,
) -> dict[str, Any]:
    request_id = str(payload["id"])
    await _send_frame(proc, payload)
    while True:
        frame = await _read_frame(proc, deadline=deadline)
        events.append(frame)
        if frame.get("type") == "response" and str(frame.get("id") or "") == request_id:
            if frame.get("success") is False:
                raise RuntimeError(str(frame.get("error") or f"RPC command {request_id} failed"))
            return frame


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
    """Run one real OMP Agent turn and capture model-issued tool events."""

    run_dir.mkdir(parents=True, exist_ok=True)
    resolved_omp = omp_bin or shutil.which("omp") or ""
    if not resolved_omp:
        return OmpRpcExecution(
            ok=False,
            model_requested=model,
            thinking_requested=thinking,
            error="OMP executable not found on PATH",
        )
    if not eval_db.is_file():
        return OmpRpcExecution(
            ok=False,
            model_requested=model,
            thinking_requested=thinking,
            error=f"Eval database does not exist: {eval_db}",
        )

    config_path = _write_omp_eval_config(run_dir)
    env = _agent_environment(eval_db, run_dir)
    command = [
        resolved_omp,
        "--mode",
        "rpc",
        "--no-session",
        "--model",
        model,
        "--thinking",
        thinking,
        "--config",
        str(config_path),
        "--tools",
        "read,bash,grep,glob",
    ]

    started = time.perf_counter()
    proc = await asyncio.create_subprocess_exec(
        *command,
        cwd=str(PROJECT_ROOT),
        env=env,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stderr_chunks: list[str] = []
    stderr_task = asyncio.create_task(_read_stderr(proc.stderr, stderr_chunks))
    events: list[dict[str, Any]] = []
    tool_calls: list[dict[str, Any]] = []
    final_parts: list[str] = []
    state_before: dict[str, Any] = {}
    state_after: dict[str, Any] = {}
    aborted = False
    deadline = time.monotonic() + timeout

    try:
        # OMP emits a ready frame before command processing.  Older builds may
        # begin with a notice; retain every frame until ready/response-capable.
        while True:
            frame = await _read_frame(proc, deadline=deadline)
            events.append(frame)
            if str(frame.get("type") or "") in _RPC_READY_TYPES:
                break
            if frame.get("type") == "extension_error":
                raise RuntimeError(str(frame.get("error") or "OMP extension startup error"))

        before = await _request(
            proc,
            events,
            {"id": "state-before", "type": "get_state"},
            deadline=deadline,
        )
        state_before = _extract_response_data(before)

        await _send_frame(
            proc,
            {
                "id": "prompt-1",
                "type": "prompt",
                "message": _offeru_agent_prompt(user_prompt),
            },
        )

        prompt_accepted = False
        terminal = False
        while not terminal:
            frame = await _read_frame(proc, deadline=deadline)
            events.append(frame)
            frame_type = str(frame.get("type") or "")

            if frame_type == "response" and frame.get("id") == "prompt-1":
                if frame.get("success") is False:
                    raise RuntimeError(str(frame.get("error") or "OMP prompt rejected"))
                prompt_accepted = True
                continue

            if frame_type == "prompt_result" and frame.get("id") == "prompt-1":
                if frame.get("agentInvoked") is False:
                    raise RuntimeError("OMP prompt resolved locally without invoking the Agent")
                continue

            if frame_type == "tool_execution_start":
                tool_calls.append(_record_tool_start(frame))
                continue

            if frame_type == "tool_execution_end":
                tool_calls.append(
                    {
                        "tool": "result",
                        "input": "",
                        "tool_call_id": str(
                            frame.get("toolCallId") or frame.get("tool_call_id") or ""
                        ),
                        "source": "runtime",
                        "is_error": bool(frame.get("isError")),
                    }
                )
                continue

            if frame_type == "message_update":
                update = frame.get("assistantMessageEvent")
                if isinstance(update, dict) and update.get("type") == "text_delta":
                    final_parts.append(str(update.get("delta") or ""))
                continue

            if frame_type == "extension_ui_request":
                # Eval is non-interactive at the OMP layer. Business approval is
                # handled in OfferU UI, not by satisfying arbitrary OMP prompts.
                request_id = str(frame.get("id") or "")
                if request_id:
                    await _send_frame(
                        proc,
                        {
                            "type": "extension_ui_response",
                            "id": request_id,
                            "cancelled": True,
                        },
                    )
                continue

            if frame_type == _TERMINAL_AGENT_END and frame.get("isTerminal") is not False:
                terminal = True

        if not prompt_accepted:
            raise RuntimeError("OMP Agent ended before prompt acknowledgement")

        after = await _request(
            proc,
            events,
            {"id": "state-after", "type": "get_state"},
            deadline=deadline,
        )
        state_after = _extract_response_data(after)

    except (TimeoutError, asyncio.TimeoutError):
        aborted = True
        with contextlib.suppress(Exception):
            await _send_frame(proc, {"id": "abort-timeout", "type": "abort"})
        await asyncio.sleep(0.2)
        if proc.returncode is None:
            proc.kill()
        error = f"OMP Agent timeout after {timeout}s"
    except Exception as exc:  # noqa: BLE001 - harness must turn failures into artifacts
        error = f"{type(exc).__name__}: {exc}"
        if proc.returncode is None:
            proc.kill()
    else:
        error = ""
    finally:
        if proc.stdin is not None and not proc.stdin.is_closing():
            proc.stdin.close()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(proc.wait(), timeout=5)
        if proc.returncode is None:
            proc.kill()
            with contextlib.suppress(Exception):
                await proc.wait()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(stderr_task, timeout=2)

    observed_state = state_after or state_before
    model_observed, thinking_observed, session_id = _extract_identity(observed_state)
    result = OmpRpcExecution(
        ok=not error and bool(events),
        model_requested=model,
        thinking_requested=thinking,
        model_observed=model_observed,
        thinking_observed=thinking_observed,
        session_id=session_id,
        elapsed_s=round(time.perf_counter() - started, 2),
        final_text="".join(final_parts).strip(),
        events=events,
        tool_calls=tool_calls,
        state_before=state_before,
        state_after=state_after,
        stderr="".join(stderr_chunks)[-8000:],
        error=error,
        aborted=aborted,
    )

    (run_dir / "omp-rpc-events.ndjson").write_text(
        "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in events),
        encoding="utf-8",
    )
    (run_dir / "agent-execution.json").write_text(
        json.dumps(result.to_dict(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return result


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
