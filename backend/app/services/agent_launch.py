"""Open a visible local Agent session that completes the OfferU connection readback.

Reached only from an explicit user click. The launched CLI keeps its own
account, model, credentials and proxy: OfferU passes nothing but an initial
prompt (no secrets) and a neutral working directory.
"""

from __future__ import annotations

import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable

from app.services.security_redaction import redact_sensitive_text

# Interactive start-with-prompt syntax, verified against each installed CLI's
# --help on 2026-10-25: codex [PROMPT], claude [prompt],
# opencode --prompt <p> (TUI), pi [messages...], omp [MESSAGES].
# Providers without a verified syntax (gemini, codebuddy, dsh, external) get
# the copy fallback only.
_PROMPT_ARGS: dict[str, Callable[[str], list[str]]] = {
    "codex": lambda prompt: [prompt],
    "claude": lambda prompt: [prompt],
    "opencode": lambda prompt: ["--prompt", prompt],
    "pi": lambda prompt: [prompt],
    "omp": lambda prompt: [prompt],
}

# The prompt crosses console command lines (npm .cmd shims on Windows, a
# Terminal do script on macOS), so it never carries a shell metacharacter:
# double/single quote, backslash, backtick, $ % ^ & | < > ; or a line break.
_UNSAFE_PROMPT_CHARS = frozenset("\"'\\`$%^&|<>;\n\r")
_HEX = frozenset("0123456789abcdef")


def supports_launch(provider_id: str) -> bool:
    return provider_id in _PROMPT_ARGS


def _assert_safe(text: str) -> None:
    if any(char in _UNSAFE_PROMPT_CHARS for char in text):
        raise ValueError("启动提示包含不安全字符")


def build_init_prompt(provider_id: str, challenge_id: str) -> str:
    """First message of the new session: readback first, then OfferU initialization."""
    if not provider_id.isalnum() or len(challenge_id) != 32 or not set(challenge_id) <= _HEX:
        raise ValueError("连接参数无效")
    prompt = (
        "请加载 OfferU Skill（offeru）并按它的规则操作。"
        f"第一步：选择 connection_probe，调用 get_agent_connection_nonce，参数 provider_id={provider_id}，"
        f"challenge_id={challenge_id}，完成 OfferU 连接验证。"
        "第二步：验证完成后按 OfferU Skill 读取当前视图、职业档案和进度状态，用中文简要总结我现在的情况和下一步建议。"
        "不要修改 Agent 的账号、模型、凭据或代理，任何写操作先征得我确认。"
    )
    _assert_safe(prompt)
    return prompt


def build_agent_argv(provider_id: str, executable: str, prompt: str) -> list[str]:
    """The Agent CLI and its start-with-prompt arguments, as an argument list."""
    if not supports_launch(provider_id):
        raise ValueError("当前 Agent 尚无已验证的启动语法")
    if not executable:
        raise ValueError("未检测到本机 Agent")
    _assert_safe(prompt)
    return [executable, *_PROMPT_ARGS[provider_id](prompt)]


def format_command(argv: list[str], *, platform: str = sys.platform) -> str:
    """A command the user can paste into cmd (Windows) or a POSIX shell."""
    return subprocess.list2cmdline(argv) if platform == "win32" else shlex.join(argv)


def build_terminal_launch(
    argv: list[str],
    cwd: Path,
    *,
    platform: str = sys.platform,
    which: Callable[[str], str | None] = shutil.which,
) -> tuple[list[str], dict[str, Any]] | None:
    """Arguments and Popen options that open argv in a new visible terminal window."""
    if platform == "win32":
        # A new console window; npm .cmd/.bat shims need cmd.exe to run at all.
        # No `start` re-parsing: the prompt is already free of cmd metacharacters.
        command = list(argv)
        suffix = Path(command[0]).suffix.lower()
        if suffix in {".cmd", ".bat"}:
            command = ["cmd.exe", "/d", "/s", "/k", *command]
        elif suffix == ".ps1":
            command = ["powershell.exe", "-NoExit", "-File", *command]
        return command, {"cwd": str(cwd), "creationflags": getattr(subprocess, "CREATE_NEW_CONSOLE", 0x10)}
    if platform == "darwin":
        script = f"cd {shlex.quote(str(cwd))} && {shlex.join(argv)}"
        literal = '"' + script.replace("\\", "\\\\").replace('"', '\\"') + '"'
        return [
            "osascript",
            "-e", f'tell application "Terminal" to do script {literal}',
            "-e", 'tell application "Terminal" to activate',
        ], {"start_new_session": True}
    terminal = which("x-terminal-emulator")
    if not terminal:
        return None
    return [terminal, "-e", *argv], {"cwd": str(cwd), "start_new_session": True}


def launch(
    provider_id: str,
    executable: str,
    prompt: str,
    cwd: Path,
    *,
    platform: str = sys.platform,
    which: Callable[[str], str | None] = shutil.which,
    spawn: Callable[..., Any] = subprocess.Popen,
) -> dict[str, Any]:
    """Spawn the terminal; never waits on the Agent session."""
    agent_argv = build_agent_argv(provider_id, executable, prompt)
    command = format_command(agent_argv, platform=platform)
    plan = build_terminal_launch(agent_argv, cwd, platform=platform, which=which)
    if plan is None:
        return {"launched": False, "command": command, "error": "未找到可用的终端窗口，请复制启动命令到终端运行。"}
    terminal_argv, options = plan
    try:
        cwd.mkdir(parents=True, exist_ok=True)
        spawn(terminal_argv, **options)
    except (OSError, ValueError) as exc:
        return {
            "launched": False,
            "command": command,
            "error": redact_sensitive_text(f"打开终端失败：{exc}", max_length=300),
        }
    return {"launched": True, "command": command, "error": ""}
