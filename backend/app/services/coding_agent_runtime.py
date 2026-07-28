from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.services.agent_files import atomic_write_json


RUNTIME_DEFINITIONS = {
    "codex": {
        "name": "Codex CLI",
        "binary": "codex",
        "version_args": ["--version"],
        "help_args": ["exec", "--help"],
        "required_flags": (
            "--config",
            "--sandbox",
            "--skip-git-repo-check",
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--output-schema",
            "--json",
        ),
        "supported": True,
        "isolation": "read-only sandbox, approvals disabled, ephemeral session, user config and rules disabled",
        "capabilities_decl": {
            "schema_mode": "flag",
            "supports_live_web_search": True,
        },
    },
    "claude": {
        "name": "Claude Code",
        "binary": "claude",
        "version_args": ["--version"],
        "help_args": ["--help"],
        "required_flags": (
            "--print",
            "--input-format",
            "--output-format",
            "--json-schema",
            "--permission-mode",
            "--tools",
            "--no-session-persistence",
            "--safe-mode",
        ),
        "supported": True,
        "isolation": "safe mode, plan permission mode, tools limited to web search in live mode, no session persistence",
        "capabilities_decl": {
            "schema_mode": "flag",
            "supports_live_web_search": True,
        },
    },
    "gemini": {
        "name": "Gemini CLI",
        "binary": "gemini",
        "version_args": ["--version"],
        "help_args": ["--help"],
        "required_flags": (
            "--prompt",
            "--output-format",
            "--approval-mode",
        ),
        "supported": True,
        "isolation": "headless default approval mode (write tools blocked), structured output requested via prompt",
        "capabilities_decl": {
            "schema_mode": "prompt",
            "supports_live_web_search": True,
        },
    },
    "opencode": {
        "name": "OpenCode",
        "binary": "opencode",
        "version_args": ["--version"],
        "help_args": ["--help"],
        "required_flags": (),
        "supported": False,
        "isolation": "detected only; no verified headless contract configured",
        "capabilities_decl": {
            "schema_mode": "prompt",
            "supports_live_web_search": False,
        },
    },
}

_PROBE_CACHE: dict[str, tuple[str, int, dict[str, Any]]] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _command(executable: str, args: list[str]) -> tuple[str, list[str]]:
    suffix = Path(executable).suffix.lower()
    if os.name == "nt" and suffix in {".cmd", ".bat"}:
        return "cmd.exe", ["/d", "/s", "/c", executable, *args]
    if os.name == "nt" and suffix == ".ps1":
        return "powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", executable, *args]
    return executable, args


async def _capture(executable: str, args: list[str], timeout: int = 5) -> tuple[int, str, str]:
    command, command_args = _command(executable, args)
    process = await asyncio.create_subprocess_exec(
        command,
        *command_args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()
        raise
    return (
        int(process.returncode or 0),
        stdout.decode("utf-8", errors="replace"),
        stderr.decode("utf-8", errors="replace"),
    )


async def _probe(runtime_id: str, *, refresh: bool = False) -> dict[str, Any]:
    definition = RUNTIME_DEFINITIONS[runtime_id]
    executable = shutil.which(definition["binary"])
    if not executable:
        return {
            "id": runtime_id,
            **definition,
            "available": False,
            "contract_compatible": False,
            "executable_path": None,
            "version": None,
            "capabilities": {},
            "missing_required_flags": list(definition["required_flags"]),
        }

    try:
        executable_mtime = int(Path(executable).stat().st_mtime_ns)
    except OSError:
        executable_mtime = 0
    cached = _PROBE_CACHE.get(runtime_id)
    if not refresh and cached and cached[0] == executable and cached[1] == executable_mtime:
        return dict(cached[2])

    version = ""
    help_text = ""
    try:
        version_code, version_stdout, version_stderr = await _capture(
            executable,
            list(definition["version_args"]),
        )
        version_lines = (version_stdout + "\n" + version_stderr).strip().splitlines()
        version = version_lines[0].strip() if version_code == 0 and version_lines else ""
        help_code, help_stdout, help_stderr = await _capture(
            executable,
            list(definition["help_args"]),
        )
        help_text = help_stdout + "\n" + help_stderr if help_code == 0 else ""
    except (OSError, asyncio.TimeoutError):
        pass

    capabilities = {
        flag: flag in help_text
        for flag in definition["required_flags"]
    }
    missing = [flag for flag, present in capabilities.items() if not present]
    result = {
        "id": runtime_id,
        **definition,
        "available": bool(version),
        "contract_compatible": bool(version) and bool(definition["supported"]) and not missing,
        "executable_path": executable,
        "version": version or None,
        "capabilities": capabilities,
        "missing_required_flags": missing,
    }
    _PROBE_CACHE[runtime_id] = (executable, executable_mtime, result)
    return dict(result)


async def list_coding_agent_runtimes() -> dict[str, Any]:
    items = await asyncio.gather(*(_probe(runtime_id) for runtime_id in RUNTIME_DEFINITIONS))
    compatible = [
        item["id"]
        for item in items
        if item["available"] and item["supported"] and item["contract_compatible"]
    ]
    return {
        "items": items,
        "available_supported": compatible,
        "available_compatible": compatible,
    }


def _schema_prompt_suffix(output_schema: dict[str, Any]) -> str:
    """schema_mode == "prompt" 的 runtime 无法用 CLI flag 强制输出结构，
    只能把 schema 内嵌进 prompt 尾部，由消费方事实门做二次校验。"""
    return (
        "\n\nOutput contract: respond with a single JSON object only (no prose,"
        " no markdown fences) that validates against this JSON schema:\n"
        + json.dumps(output_schema, ensure_ascii=False, separators=(",", ":"))
    )


def _runtime_args(
    runtime_id: str,
    *,
    output_schema: dict[str, Any],
    schema_path: Path,
    web_search_mode: str = "disabled",
) -> list[str]:
    clean_web_search_mode = str(web_search_mode or "disabled").strip().lower()
    if clean_web_search_mode not in {"disabled", "live"}:
        raise ValueError("web_search_mode 仅支持 disabled 或 live")
    if runtime_id == "codex":
        args = [
            "exec",
            "--config",
            'approval_policy="never"',
        ]
        if clean_web_search_mode == "live":
            args.extend(["--config", 'web_search="live"'])
        return [
            *args,
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--output-schema",
            str(schema_path),
            "--json",
            "-",
        ]
    if runtime_id == "claude":
        # live 模式仅放行网页检索类工具；disabled 保持全工具关闭。
        tools = "WebSearch,WebFetch" if clean_web_search_mode == "live" else ""
        return [
            "--print",
            "--input-format",
            "text",
            "--output-format",
            "json",
            "--json-schema",
            json.dumps(output_schema, ensure_ascii=False, separators=(",", ":")),
            "--permission-mode",
            "plan",
            "--tools",
            tools,
            "--no-session-persistence",
            "--safe-mode",
        ]
    if runtime_id == "gemini":
        # gemini 无 schema flag；prompt 由 run_coding_agent 追加 schema 后缀，
        # 经 stdin 传入（gemini 非交互模式读 stdin），--prompt 仅作 capability probe。
        return [
            "--approval-mode",
            "default",
            "--output-format",
            "json",
        ]
    raise ValueError(f"未配置可执行的 coding-agent runtime: {runtime_id}")


def _extract_worker_text(runtime_id: str, stdout: str) -> tuple[str, int]:
    candidates: list[str] = []
    structured_candidates: list[str] = []
    event_count = 0
    if runtime_id == "gemini":
        # gemini --output-format json 输出单个 JSON 文档 {"response": "...", ...}
        try:
            document = json.loads(stdout.strip())
        except json.JSONDecodeError:
            document = None
        if isinstance(document, dict):
            event_count = 1
            response = document.get("response")
            if isinstance(response, str) and response.strip():
                return response, event_count
        return stdout.strip(), event_count
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        event_count += 1
        if runtime_id == "codex":
            item = event.get("item")
            if isinstance(item, dict) and item.get("type") == "agent_message" and item.get("text"):
                candidates.append(str(item["text"]))
        elif runtime_id == "claude":
            structured_output = event.get("structured_output")
            if isinstance(structured_output, dict):
                structured_candidates.append(json.dumps(structured_output, ensure_ascii=False))
            if event.get("type") == "result" and event.get("result"):
                candidates.append(str(event["result"]))
            elif event.get("result"):
                candidates.append(str(event["result"]))
            message = event.get("message")
            content = message.get("content") if isinstance(message, dict) else None
            if isinstance(content, list):
                candidates.extend(
                    str(block.get("text"))
                    for block in content
                    if isinstance(block, dict) and block.get("type") == "text" and block.get("text")
                )
    if structured_candidates:
        return structured_candidates[-1], event_count
    return (candidates[-1] if candidates else stdout.strip(), event_count)


def _decode_structured_output(text: str, *, schema_mode: str = "flag") -> dict[str, Any]:
    try:
        payload = json.loads(str(text or "").strip())
    except json.JSONDecodeError as exc:
        if schema_mode == "prompt":
            # prompt 模式无 CLI 层 schema 强制，容忍 markdown 包裹等输出习惯。
            from app.agents.llm import extract_json

            recovered = extract_json(str(text or ""))
            if isinstance(recovered, dict):
                return recovered
        raise ValueError("coding-agent 未返回符合 schema 的 JSON 对象") from exc
    if not isinstance(payload, dict):
        raise ValueError("coding-agent 结构化结果必须是 JSON 对象")
    return payload


async def select_runtime(
    preferred: str | None = None,
    *,
    require_web_search: bool = False,
    require_schema_flag: bool = False,
) -> dict[str, Any]:
    """按优先级选择首个可用且契约兼容的 coding-agent runtime。

    - preferred 非空时只校验该 runtime（不满足即报错，不静默换选）。
    - 否则按 settings.coding_agent_priority（默认 claude,codex,gemini）依次探测。
    - require_web_search / require_schema_flag 按 capabilities_decl 过滤。
    """
    from app.config import get_settings

    def _capability_ok(runtime_id: str) -> bool:
        decl = RUNTIME_DEFINITIONS.get(runtime_id, {}).get("capabilities_decl", {})
        if require_web_search and not decl.get("supports_live_web_search"):
            return False
        if require_schema_flag and decl.get("schema_mode") != "flag":
            return False
        return True

    clean_preferred = str(preferred or "").strip().lower()
    if clean_preferred:
        if clean_preferred not in RUNTIME_DEFINITIONS:
            raise ValueError(f"未知的 coding-agent runtime: {clean_preferred}")
        if not _capability_ok(clean_preferred):
            raise ValueError(
                f"{RUNTIME_DEFINITIONS[clean_preferred]['name']} 不满足本任务能力要求"
            )
        selected = await _probe(clean_preferred)
        if not selected.get("available"):
            raise ValueError(f"{selected['name']} 不在 PATH 中或无法读取版本")
        if not selected.get("supported") or not selected.get("contract_compatible"):
            missing = ", ".join(selected.get("missing_required_flags") or []) or "unknown capability"
            raise ValueError(f"{selected['name']} 契约不兼容，缺少: {missing}")
        return selected

    priority = [
        item.strip().lower()
        for item in str(get_settings().coding_agent_priority or "").split(",")
        if item.strip()
    ] or ["claude", "codex", "gemini"]
    tried: list[str] = []
    for runtime_id in priority:
        if runtime_id not in RUNTIME_DEFINITIONS or not _capability_ok(runtime_id):
            continue
        tried.append(runtime_id)
        selected = await _probe(runtime_id)
        if (
            selected.get("available")
            and selected.get("supported")
            and selected.get("contract_compatible")
        ):
            return selected
    raise ValueError(
        "没有可用且契约兼容的 coding-agent runtime"
        + (f"（已尝试: {', '.join(tried)}）" if tried else "")
    )


async def run_coding_agent(
    *,
    runtime_id: str,
    prompt: str,
    cwd: Path,
    output_schema: dict[str, Any],
    timeout_seconds: int = 240,
    web_search_mode: str = "disabled",
) -> dict[str, Any]:
    definition = RUNTIME_DEFINITIONS.get(runtime_id)
    if not definition or not definition["supported"]:
        raise ValueError(f"不支持的 coding-agent runtime: {runtime_id}")
    if not isinstance(output_schema, dict) or output_schema.get("type") != "object":
        raise ValueError("coding-agent output_schema 必须是 JSON object schema")
    clean_web_search_mode = str(web_search_mode or "disabled").strip().lower()
    if clean_web_search_mode not in {"disabled", "live"}:
        raise ValueError("web_search_mode 仅支持 disabled 或 live")
    capabilities_decl = definition.get("capabilities_decl", {})
    if clean_web_search_mode == "live" and not capabilities_decl.get("supports_live_web_search"):
        raise ValueError(f"{definition['name']} 未声明实时网页搜索能力")

    runtime = await _probe(runtime_id)
    if not runtime["available"]:
        raise RuntimeError(f"{definition['name']} 不在 PATH 中或无法读取版本")
    if not runtime["contract_compatible"]:
        missing = ", ".join(runtime["missing_required_flags"]) or "unknown capability"
        raise RuntimeError(f"{definition['name']} 当前 CLI 契约不兼容，缺少: {missing}")

    schema_mode = str(capabilities_decl.get("schema_mode") or "flag")
    effective_prompt = prompt
    if schema_mode == "prompt":
        effective_prompt = prompt + _schema_prompt_suffix(output_schema)

    cwd.mkdir(parents=True, exist_ok=True)
    schema_path = cwd / "output.schema.json"
    atomic_write_json(schema_path, output_schema)
    executable = str(runtime["executable_path"])
    command, args = _command(
        executable,
        _runtime_args(
            runtime_id,
            output_schema=output_schema,
            schema_path=schema_path,
            web_search_mode=clean_web_search_mode,
        ),
    )
    environment = dict(os.environ)
    environment["NO_COLOR"] = "1"
    started_at = _now()
    started = time.perf_counter()
    process = await asyncio.create_subprocess_exec(
        command,
        *args,
        cwd=str(cwd),
        env=environment,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout_bytes, stderr_bytes = await asyncio.wait_for(
            process.communicate(effective_prompt.encode("utf-8")),
            timeout=max(30, min(int(timeout_seconds), 900)),
        )
    except asyncio.CancelledError:
        process.kill()
        await process.wait()
        raise
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()
        raise RuntimeError(f"{definition['name']} worker 超时")

    stdout = stdout_bytes.decode("utf-8", errors="replace")[-2_000_000:]
    stderr = stderr_bytes.decode("utf-8", errors="replace")[-20_000:]
    if process.returncode != 0:
        raise RuntimeError(f"{definition['name']} worker 退出码 {process.returncode}: {stderr[-1000:]}")

    text, event_count = _extract_worker_text(runtime_id, stdout)
    structured = _decode_structured_output(text, schema_mode=schema_mode)
    if runtime_id == "codex":
        sandbox_policy = "read-only"
        tool_policy = f"available inside read-only sandbox; web_search={clean_web_search_mode}"
        session_policy = "ephemeral"
    elif runtime_id == "claude":
        sandbox_policy = "safe-mode + plan"
        tool_policy = (
            "WebSearch,WebFetch only" if clean_web_search_mode == "live" else "disabled"
        )
        session_policy = "disabled"
    else:
        sandbox_policy = str(definition.get("isolation") or "unknown")
        tool_policy = f"runtime default; web_search={clean_web_search_mode}"
        session_policy = "unknown"
    return {
        "runtime_id": runtime_id,
        "runtime_version": runtime.get("version"),
        "text": text,
        "structured": structured,
        "stderr": stderr,
        "trace": {
            "started_at": started_at,
            "completed_at": _now(),
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
            "exit_code": int(process.returncode or 0),
            "event_count": event_count,
            "schema_enforced": schema_mode == "flag",
            "schema_path": str(schema_path),
            "sandbox": sandbox_policy,
            "tools": tool_policy,
            "web_search": clean_web_search_mode,
            "session_persistence": session_policy,
        },
    }
