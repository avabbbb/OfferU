# backend/app/agents/runtimes/defs/claude.py
"""Claude Code Agent 定义（完整移植）"""
from typing import List, Dict, Any
from ..types import RuntimeAgentDef

DEFAULT_MODEL_OPTION = {"id": "default", "label": "Default"}

CLAUDE_FALLBACK_MODELS = [
    DEFAULT_MODEL_OPTION,
    {"id": "sonnet", "label": "Sonnet (alias)"},
    {"id": "opus", "label": "Opus (alias)"},
    {"id": "haiku", "label": "Haiku (alias)"},
    {"id": "claude-opus-4-5", "label": "claude-opus-4-5"},
    {"id": "claude-sonnet-4-5", "label": "claude-sonnet-4-5"},
    {"id": "claude-haiku-4-5", "label": "claude-haiku-4-5"},
]

def build_claude_args(
    prompt: str,
    image_paths: List[str],
    extra_allowed_dirs: List[str] = None,
    options: Dict[str, Any] = None,
    runtime_context: Dict[str, Any] = None
) -> List[str]:
    """构建 Claude Code 命令行参数"""
    extra_allowed_dirs = extra_allowed_dirs or []
    options = options or {}
    runtime_context = runtime_context or {}

    args = [
        "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose"
    ]

    # 包含部分消息（仅新版本支持）
    # 实际使用时需要从 agentCapabilities 读取
    # if caps.get("partialMessages"):
    #     args.append("--include-partial-messages")

    # 模型选择
    if options.get("model") and options["model"] != "default":
        args.extend(["--model", options["model"]])

    # 额外允许目录
    dirs = [d for d in extra_allowed_dirs if isinstance(d, str) and d]
    if dirs:
        args.extend(["--add-dir", *dirs])

    # 会话恢复
    if runtime_context.get("resumeSessionId"):
        args.extend(["--resume", runtime_context["resumeSessionId"]])
    elif runtime_context.get("newSessionId"):
        args.extend(["--session-id", runtime_context["newSessionId"]])

    # 不覆盖 Claude Code 的用户/项目权限策略。非交互运行若需要额外授权，
    # 必须由上层 Operation Registry 明确确认，不能强制跳过权限检查。

    return args

claude_agent_def = RuntimeAgentDef(
    id="claude",
    name="Claude Code",
    bin="claude",
    fallback_bins=["openclaude"],  # OpenClaude fork 支持
    version_args=["--version"],
    help_args=["-p", "--help"],
    capability_flags={
        "--include-partial-messages": "partialMessages",
        "--add-dir": "addDir",
    },
    fallback_models=CLAUDE_FALLBACK_MODELS,
    build_args=build_claude_args,
    prompt_via_stdin=True,
    prompt_input_format="stream-json",
    stream_format="claude-stream-json",
    external_mcp_injection="claude-mcp-json",
    resumes_session_via_cli=True,
)
