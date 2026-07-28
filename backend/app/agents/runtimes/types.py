# backend/app/agents/runtimes/types.py
"""Agent 运行时类型定义"""
from typing import Optional, List, Dict, Callable, Literal
from dataclasses import dataclass
from enum import Enum

class AgentCapability(Enum):
    """Agent 能力标记"""
    SURGICAL_EDIT = "surgical_edit"
    NATIVE_SKILL_LOADING = "native_skill_loading"
    STREAMING = "streaming"
    RESUME = "resume"
    PERMISSION_MODE = "permission_mode"

@dataclass
class AgentDetection:
    """Agent 检测结果"""
    agent_id: str
    available: bool
    executable_path: Optional[str]
    version: Optional[str]
    config_dir: Optional[str]
    auth_state: Literal["ok", "missing", "expired"]
    diagnostics: List[str] = None

@dataclass
class AgentRunParams:
    """Agent 运行参数"""
    run_id: str
    cwd: str
    system_prompt: str
    user_prompt: str
    skill_dir: Optional[str] = None
    allowed_tools: Optional[List[str]] = None
    timeout_ms: int = 120000
    model: Optional[str] = None

@dataclass
class RuntimeAgentDef:
    """Agent 定义（移植自 Open Design）"""
    id: str                                    # "claude" | "codex" | ...
    name: str                                  # "Claude Code"
    bin: str                                   # "claude"
    fallback_bins: List[str] = None           # ["openclaude"]
    version_args: List[str] = None            # ["--version"]
    help_args: List[str] = None               # ["-p", "--help"]
    capability_flags: Dict[str, str] = None   # {"--add-dir": "addDir"}

    # 模型列表
    fallback_models: List[Dict] = None
    list_models: Optional[Dict] = None         # {"args": [...], "parse": fn}
    fetch_models: Optional[Callable] = None

    # 命令构建
    build_args: Callable = None                # (prompt, images, dirs, opts) -> List[str]
    prompt_via_stdin: bool = False
    prompt_input_format: str = "text"         # "text" | "stream-json"
    stream_format: str = "plain"              # "claude-stream-json" | "codex-json"

    # 高级特性
    external_mcp_injection: Optional[str] = None  # "claude-mcp-json"
    resumes_session_via_cli: bool = False
