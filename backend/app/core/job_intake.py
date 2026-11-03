"""贴进来的岗位链接正文或 JD 文本 → job 字段。调模型；没配模型时只取第一行当岗位名，正文整段当 JD。

只整理不编造：字段都来自原文，没有就留空。写库由调用方走 tools.save。
"""

from __future__ import annotations

from datetime import date
from typing import Any

from app.core.resume_split import available  # noqa: F401  同一套「配了模型或允许交给本机 Agent」判断

PROMPT = """你是岗位信息整理助手。从岗位页面文字或 JD 里拆字段，只输出严格 JSON：
{"company": "", "title": "", "city": "", "deadline": "", "apply": "", "jd": ""}
规则：
1. 只用原文里有的信息，没有就留空，不猜。
2. title 是岗位名称，不带公司名。
3. deadline：原文写了投递截止日期就写成 YYYY-MM-DD，没有就留空。
4. apply：投递方式的原话，比如投递邮箱、邮件标题格式、附件要求；在官网投递就留空。
5. jd：岗位职责和要求的原文，去掉导航、页脚、其他岗位推荐等无关文字，不改写。
"""

LIMITS = {"company": 80, "title": 120, "city": 40, "apply": 500, "jd": 20_000}


def normalize(parsed: dict[str, Any]) -> dict[str, Any]:
    out = {key: str(parsed.get(key) or "").strip()[:limit] for key, limit in LIMITS.items()}
    deadline = str(parsed.get("deadline") or "").strip()
    try:
        out["deadline"] = date.fromisoformat(deadline).isoformat()
    except ValueError:
        out["deadline"] = ""
    return {key: value for key, value in out.items() if value}


def guess(text: str) -> dict[str, Any]:
    """没模型时的兜底：第一行当岗位名，整段当 JD。"""
    first = next((line.strip() for line in text.splitlines() if line.strip()), "")
    return {"title": first[:120], "jd": text.strip()[:20_000]}


async def extract(text: str) -> dict[str, Any]:
    from app.agents.llm import chat_completion, extract_json

    raw = await chat_completion(
        [{"role": "system", "content": PROMPT}, {"role": "user", "content": text[:20_000]}],
        temperature=0.1,
        json_mode=True,
        max_tokens=6000,
    )
    parsed = extract_json(raw or "")
    if not isinstance(parsed, dict):
        raise ValueError("模型没返回可用的岗位字段，没存")
    return normalize(parsed)
