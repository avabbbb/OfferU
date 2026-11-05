"""旧简历原文 → 一条条 memory。调模型；没配内置模型且开了 llm_fallback_to_agent 时由 chat_completion 交给本机 Agent。

只整理不改写：事实和数字都来自原文。非本机端点（含外置 Agent）先脱敏、回来再还原。
写库由调用方走 tools.save，每条一条可撤销的改动。
"""

from __future__ import annotations

from typing import Any, Optional

KINDS = ("experience", "project", "education", "skill", "award")

PROMPT = """你是求职档案整理助手。把用户的简历原文拆成一条条经历，只输出严格 JSON：
{"items": [{"kind": "experience|project|education|skill|award", "title": "", "body": "", "start": "", "end": "", "mode": ""}]}
规则：
1. 一段实习/工作、一个项目、一段教育各是一条。PDF 的视觉换行不是新条目，同一段经历的多行合并进 body。
2. title：实习/工作写「公司 · 职位」，项目写项目名（有角色就加上），教育写「学校 · 专业 · 学位」，技能写分类，奖项/证书写名称。
3. body：保留原文的全部事实和数字；原文有分点就每点一行、以「- 」开头。不改写、不编造、不加原文没有的内容。
4. start / end：原文有时间就写成 YYYY-MM 或 YYYY，至今写「至今」，没有就留空。
5. 姓名、电话、邮箱等联系方式不要拆成条目。原文里形如占位符的内容原样保留。
6. mode：实习/工作填「全职」「实习」或「兼职」，教育填「全日制」或「非全日制」。只按原文判断（节标题「实习经历」「工作经历」、职位里的「实习生」、「全日制」字样等），看不出来就留空，不要猜。
"""


def available() -> bool:
    """配了内置模型，或者允许交给本机 Agent。"""
    from app.agents import agent_fallback
    from app.agents.llm import resolve_llm_client_config

    try:
        resolve_llm_client_config()
    except ValueError:
        return agent_fallback.enabled()
    return True


def normalize(item: Any) -> Optional[dict[str, Any]]:
    if not isinstance(item, dict):
        return None
    kind = str(item.get("kind") or "").strip()
    title = str(item.get("title") or "").strip()[:120]
    body = str(item.get("body") or "").strip()
    if not title and not body:
        return None
    out: dict[str, Any] = {"kind": kind if kind in KINDS else "note", "title": title, "body": body}
    from app.core.tools import MEMORY_MODE

    mode = str(item.get("mode") or "").strip()
    if mode in MEMORY_MODE.get(out["kind"], ()):
        out["mode"] = mode
    for key in ("start", "end"):
        value = str(item.get(key) or "").strip()
        if value:
            out[key] = value[:20]
    return out


async def extract(text: str) -> list[dict[str, Any]]:
    from app.agents.agent_fallback import endpoint_is_local
    from app.agents.desensitize import desensitize, restore
    from app.agents.llm import chat_completion, extract_json

    safe, mapping = text[:30_000], {}
    if not endpoint_is_local():
        safe, mapping = desensitize(safe)
    raw = await chat_completion(
        [{"role": "system", "content": PROMPT}, {"role": "user", "content": safe}],
        temperature=0.1,
        json_mode=True,
        max_tokens=6000,
    )
    if mapping:
        raw = restore(raw or "", mapping)
    parsed = extract_json(raw or "")
    items = parsed.get("items") if isinstance(parsed, dict) else None
    if not isinstance(items, list):
        raise ValueError("模型没返回可用的条目，档案没动")
    return [m for m in (normalize(i) for i in items) if m]
