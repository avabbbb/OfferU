"""没配内置模型时，把一次模型调用交给本机已装的外置 Agent（Claude / Codex / omp / OpenCode 等）。

只在内置模型解析失败（resolve_llm_client_config 报 ValueError，多半是没配置）时启用；配了内置模型照旧走内置。
外置 Agent 按 settings.coding_agent_priority 选第一个可用、契约兼容的，在空的工作目录里只读、不联网地跑，
只带回文本答案；写库仍由调用方走原来的校验。settings.llm_fallback_to_agent = False 可关掉。
"""

import json
import uuid
from typing import Any, Optional

TIMEOUT_SECONDS = 300
ANSWER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"answer": {"type": "string"}},
    "required": ["answer"],
    "additionalProperties": False,
}
RULES = (
    "你在替 OfferU 的内置模型完成一次模型调用。不要读写文件、不要运行命令、不要联网，只根据下面的消息作答。\n"
    "按 system 消息的要求回答最后一条 user 消息，把完整回答原样放进 JSON 对象的 answer 字段（字符串），不要加解释。"
)


def enabled() -> bool:
    from app.config import get_settings

    return bool(get_settings().llm_fallback_to_agent)


def needed() -> bool:
    """内置模型用不了、而且允许交给外置 Agent。"""
    from app.agents.llm import resolve_llm_client_config

    if not enabled():
        return False
    try:
        resolve_llm_client_config()
    except ValueError:
        return True
    return False


def build_prompt(messages: list[dict], json_mode: bool = False) -> str:
    parts = [RULES]
    if json_mode:
        parts.append("answer 的内容本身必须是一个合法的 JSON 对象（序列化成字符串）。")
    for message in messages:
        content = message.get("content")
        text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
        parts.append(f"### {message.get('role') or 'user'}\n{text}")
    return "\n\n".join(parts)


def answer_of(result: dict[str, Any]) -> str:
    structured = result.get("structured")
    if isinstance(structured, dict) and isinstance(structured.get("answer"), str):
        return structured["answer"]
    return str(result.get("text") or "")


async def complete(messages: list[dict], json_mode: bool = False, cause: Optional[Exception] = None,
                   timeout_seconds: int = TIMEOUT_SECONDS) -> str:
    """跑一次外置 Agent，返回回答文本。没有可用的外置 Agent 时抛 ValueError，带上内置模型原来的报错。"""
    from app.runtime_paths import runtime_data_path
    from app.services.coding_agent_runtime import DeepTaskSpec, execute_deep_task, select_local_executor

    try:
        runtime = await select_local_executor()
    except ValueError as exc:
        head = str(cause) if cause else "内置模型不可用"
        raise ValueError(f"{head}；也没有找到可以接手的外置 Agent（{exc}）") from (cause or exc)
    cwd = runtime_data_path("agent_llm_fallback")
    cwd.mkdir(parents=True, exist_ok=True)
    result = await execute_deep_task(DeepTaskSpec(
        runtime_id=str(runtime["id"]),
        prompt=build_prompt(messages, json_mode),
        cwd=cwd,
        output_schema=ANSWER_SCHEMA,
        timeout_seconds=timeout_seconds,
        task_type="llm_fallback",
        task_id=f"llm_{uuid.uuid4().hex}",
        max_turns=4,
    ))
    return answer_of(result)


def endpoint_is_local() -> bool:
    """内置模型是否在本机（决定要不要脱敏）。没配模型时会交给外置 Agent，它们多半连云端，按远端算。"""
    from app.agents.llm import _is_local_llm, resolve_llm_client_config

    try:
        resolved = resolve_llm_client_config()
    except ValueError:
        return False
    return _is_local_llm(resolved.get("base_url", ""))
