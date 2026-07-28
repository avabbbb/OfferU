# backend/app/agents/runtimes/detection.py
"""Agent 检测逻辑（PATH 扫描 + 版本探测）"""
import os
import subprocess
import asyncio
from pathlib import Path
from typing import Optional, List
from .types import RuntimeAgentDef, AgentDetection

def resolve_on_path(bin_name: str) -> Optional[str]:
    """在 PATH 中查找可执行文件"""
    path_dirs = os.environ.get("PATH", "").split(os.pathsep)

    # 添加常见工具链目录
    user_home = Path.home()
    toolchain_dirs = [
        user_home / ".local" / "bin",
        user_home / ".bun" / "bin",
        user_home / ".npm-global" / "bin",
        Path("/opt/homebrew/bin"),  # macOS Homebrew
        Path("/usr/local/bin"),
    ]

    all_dirs = path_dirs + [str(d) for d in toolchain_dirs if d.exists()]

    # Windows 可执行文件扩展名
    exts = [".exe", ".cmd", ".bat"] if os.name == "nt" else [""]

    for dir_path in all_dirs:
        for ext in exts:
            full_path = Path(dir_path) / (bin_name + ext)
            if full_path.exists() and full_path.is_file():
                return str(full_path)

    return None

async def probe_version(
    executable_path: str,
    version_args: List[str],
    timeout_ms: int = 3000
) -> Optional[str]:
    """探测 Agent 版本"""
    try:
        proc = await asyncio.create_subprocess_exec(
            executable_path,
            *version_args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )

        stdout, _ = await asyncio.wait_for(
            proc.communicate(),
            timeout=timeout_ms / 1000
        )

        version = stdout.decode().strip().split("\n")[0]
        return version if version else None

    except (asyncio.TimeoutError, FileNotFoundError, PermissionError):
        return None

async def detect_agent(agent_def: RuntimeAgentDef) -> AgentDetection:
    """检测单个 Agent 是否可用"""
    # 1. 优先使用环境变量覆盖
    env_key = f"{agent_def.id.upper().replace('-', '_')}_BIN"
    env_override = os.environ.get(env_key)

    if env_override and Path(env_override).exists():
        executable_path = env_override
    else:
        # 2. PATH 扫描
        executable_path = resolve_on_path(agent_def.bin)

        # 3. 尝试 fallback bins
        if not executable_path and agent_def.fallback_bins:
            for fallback in agent_def.fallback_bins:
                executable_path = resolve_on_path(fallback)
                if executable_path:
                    break

    if not executable_path:
        return AgentDetection(
            agent_id=agent_def.id,
            available=False,
            executable_path=None,
            version=None,
            config_dir=None,
            auth_state="missing",
            diagnostics=[f"{agent_def.bin} not found on PATH"]
        )

    # 4. 版本探测
    version = await probe_version(
        executable_path,
        agent_def.version_args or ["--version"]
    )

    # 5. 配置目录探测（~/.claude/, ~/.codex/ 等）
    user_home = Path.home()
    config_dir_name = f".{agent_def.id}"
    config_dir = user_home / config_dir_name

    return AgentDetection(
        agent_id=agent_def.id,
        available=bool(version),
        executable_path=executable_path,
        version=version,
        config_dir=str(config_dir) if config_dir.exists() else None,
        auth_state="ok" if version else "missing",
        diagnostics=[]
    )

async def detect_all_agents(agent_defs: List[RuntimeAgentDef]) -> List[AgentDetection]:
    """并行检测所有 Agent"""
    tasks = [detect_agent(agent_def) for agent_def in agent_defs]
    return await asyncio.gather(*tasks)
