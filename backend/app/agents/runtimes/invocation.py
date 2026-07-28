# backend/app/agents/runtimes/invocation.py
"""Agent 调用逻辑（子进程启动 + 流式输出）"""
import asyncio
import json
from typing import AsyncIterator, Dict, Any, List
from .types import RuntimeAgentDef, AgentRunParams

async def run_agent_stream(
    agent_def: RuntimeAgentDef,
    executable_path: str,
    params: AgentRunParams
) -> AsyncIterator[Dict[str, Any]]:
    """
    运行 Agent 并流式返回事件

    事件格式：
    - {"type": "thinking", "text": "..."}
    - {"type": "tool_call", "name": "Read", "input": {...}, "id": "..."}
    - {"type": "tool_result", "id": "...", "output": "..."}
    - {"type": "text_delta", "text": "..."}
    - {"type": "file_write", "path": "..."}
    - {"type": "done", "reason": "completed"}
    """

    # 1. 构建命令行参数
    args = agent_def.build_args(
        params.user_prompt,
        [],  # image_paths
        [],  # extra_allowed_dirs
        {"model": params.model},
        {}   # runtime_context
    )

    # 2. 启动子进程
    proc = await asyncio.create_subprocess_exec(
        executable_path,
        *args,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=params.cwd
    )

    # 3. 通过 stdin 传递 prompt
    if agent_def.prompt_via_stdin:
        if agent_def.prompt_input_format == "stream-json":
            # Claude Code 格式
            message = json.dumps({
                "role": "user",
                "content": params.system_prompt + "\n\n" + params.user_prompt
            })
        else:
            # 纯文本格式
            message = params.user_prompt

        proc.stdin.write(message.encode())
        await proc.stdin.drain()
        proc.stdin.close()

    # 4. 流式解析 stdout
    async for line in proc.stdout:
        line_str = line.decode().strip()
        if not line_str:
            continue

        try:
            # 根据 stream_format 解析
            if agent_def.stream_format == "claude-stream-json":
                event = json.loads(line_str)
                yield event
            elif agent_def.stream_format == "plain":
                yield {"type": "text_delta", "text": line_str}
            else:
                # 其他格式（Codex / Gemini 等）
                event = json.loads(line_str)
                yield event
        except json.JSONDecodeError:
            # 非 JSON 行，作为文本输出
            yield {"type": "text_delta", "text": line_str}

    # 5. 等待进程结束
    await proc.wait()

    if proc.returncode == 0:
        yield {"type": "done", "reason": "completed"}
    else:
        stderr = await proc.stderr.read()
        yield {
            "type": "error",
            "error": f"Process exited with code {proc.returncode}: {stderr.decode()}"
        }
        yield {"type": "done", "reason": "error"}
