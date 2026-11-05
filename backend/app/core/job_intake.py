"""贴进来的岗位链接正文或 JD 文本 → job 字段。调模型；没配模型时只做不会错的拆分（岗位名、截止日期），正文整段当 JD。

只整理不编造：字段都来自原文，没有就留空。写库由调用方走 tools.save。

除了顶层字段（company / title / city / jd），收集时还把 JD 拆成 job.posting（岗位调研的 L0 层）：
team, hire_type, years, education, salary, job_code, posted_at, responsibilities[], hard_reqs[], soft_reqs[], keywords[], essence。
关键词和编号必须在原文里出现；essence 是概括（口径 inference），展示时要标出来。
"""

from __future__ import annotations

import re
from datetime import date
from typing import Any

from app.core.resume_split import available  # noqa: F401  同一套「配了模型或允许交给本机 Agent」判断

PROMPT = """你是岗位信息整理助手。从岗位页面文字或 JD 里拆字段，只输出严格 JSON：
{"company": "", "title": "", "city": "", "deadline": "", "apply": "", "jd": "",
 "team": "", "hire_type": "", "years": "", "education": "", "salary": "", "job_code": "", "posted_at": "",
 "responsibilities": [], "hard_reqs": [], "soft_reqs": [], "keywords": [], "essence": ""}
规则：
1. 只用原文里有的信息，没有就留空，不猜。
2. title 是岗位名称，不带公司名。
3. deadline：原文写了投递截止日期就写成 YYYY-MM-DD，没有就留空。
4. apply：投递方式的原话，比如投递邮箱、邮件标题格式、附件要求；在官网投递就留空。
5. jd：岗位职责和要求的原文，去掉导航、页脚、其他岗位推荐等无关文字，不改写。
6. team：部门、事业群或产品线（如「百度搭子」「抖音电商」），原文没写就留空。
7. hire_type：校招 / 实习 / 社招 三选一，原文看不出就留空。
8. years、education、salary、job_code：原文怎么写就怎么写（如「3 年以上」「本科及以上」「20-35K」「J102408」），没写就留空，不估。
9. posted_at：原文写了发布或更新日期就写成 YYYY-MM-DD，没有就留空。
10. responsibilities：岗位职责，一条一项，保留原文措辞，最多 12 条。
11. hard_reqs：必须满足的要求（年限、学历、专业、技能门槛）；soft_reqs：加分项、优先条件。一条一项，原文措辞，各最多 12 条。
12. keywords：5–15 个技能、工具、领域词，必须是原文里出现过的词，按重要程度排。
13. essence：一句话（不超过 60 字）说清这个岗位实际在做什么，可以概括，但不能加入原文没有的事实。
"""

LIMITS = {"company": 80, "title": 120, "city": 40, "apply": 500, "jd": 20_000}
# job.posting 里的字符串字段和列表字段（条数上限）。
TEXTS = {"team": 80, "years": 40, "education": 40, "salary": 60, "job_code": 40, "essence": 80}
LISTS = {"responsibilities": 12, "hard_reqs": 12, "soft_reqs": 12, "keywords": 15}
HIRE_TYPES = ("校招", "实习", "社招")
# 招聘官网链接的路径段常带招聘类型（百度 /jobs/detail/SOCIAL/…，字节 /experienced/、/campus/）。只认整段，不做子串匹配。
URL_HIRE = {"social": "社招", "experienced": "社招", "campus": "校招", "graduate": "校招", "intern": "实习", "internship": "实习"}


def hire_from_url(url: Any) -> str:
    """模型没拆出招聘类型时的兜底：按链接路径段定。实习优先（/campus/intern/ 算实习）。"""
    from urllib.parse import urlparse

    parts = {p.lower() for p in urlparse(str(url or "")).path.split("/") if p}
    found = {URL_HIRE[p] for p in parts if p in URL_HIRE}
    for name in ("实习", "校招", "社招"):
        if name in found:
            return name
    return ""


BULLET = re.compile(r"^\s{0,}(?:[-•·●]|\d{1,2}\s{0,}[.、)）])\s{0,}")


def _date(value: Any) -> str:
    try:
        return date.fromisoformat(str(value or "").strip()).isoformat()
    except ValueError:
        return ""


def _items(value: Any, cap: int, size: int) -> list[str]:
    """列表字段：去掉行首序号和圆点、空项和重复项，每项截到 size 字，最多 cap 项。"""
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        text = BULLET.sub("", str(item or "").strip()).strip()[:size]
        if text and text not in out:
            out.append(text)
    return out[:cap]


def posting(parsed: dict[str, Any], text: str = "") -> dict[str, Any]:
    """job.posting：不在取值范围内的丢掉；给了原文就只留原文里出现过的关键词和编号。"""
    out: dict[str, Any] = {key: str(parsed.get(key) or "").strip()[:size] for key, size in TEXTS.items()}
    hire = str(parsed.get("hire_type") or "").strip()
    out["hire_type"] = hire if hire in HIRE_TYPES else ""
    out["posted_at"] = _date(parsed.get("posted_at"))
    for key, cap in LISTS.items():
        out[key] = _items(parsed.get(key), cap, 40 if key == "keywords" else 200)
    if text:
        low = text.lower()
        out["keywords"] = [k for k in out["keywords"] if k.lower() in low]
        if out["job_code"] and out["job_code"].lower() not in low:
            out["job_code"] = ""
    return {key: value for key, value in out.items() if value}


def normalize(parsed: dict[str, Any], text: str = "") -> dict[str, Any]:
    out = {key: str(parsed.get(key) or "").strip()[:limit] for key, limit in LIMITS.items()}
    out["deadline"] = _date(parsed.get("deadline"))
    out = {key: value for key, value in out.items() if value}
    detail = posting(parsed, text)
    if detail:
        out["posting"] = detail
    return out


TITLE_HINT = re.compile(r"实习|工程师|开发|产品|运营|设计|分析|经理|助理|专员|顾问|研究员|管培|算法|测试|销售|市场")
DEADLINE_RE = re.compile(r"截止[^0-9\n]{0,8}(20\d{2})\s{0,}[-./年]\s{0,}(\d{1,2})\s{0,}[-./月]\s{0,}(\d{1,2})")


def guess(text: str) -> dict[str, Any]:
    """没模型时的兜底：第一行截到第一个标点，按 · | 切开取像岗位名的一段（最多 40 字）；
    写了「截止 2026-11-30」这类日期就认出来；整段当 JD。不猜公司和城市，不出 posting。"""
    first = next((line.strip() for line in text.splitlines() if line.strip()), "")
    head = re.split(r"[，,。；;：:！!？?]", first, maxsplit=1)[0].strip()
    parts = [p.strip() for p in re.split(r"[·|｜]", head) if p.strip()]
    title = next((p for p in parts if TITLE_HINT.search(p)), parts[0] if parts else head)
    out: dict[str, Any] = {"title": title[:40], "jd": text.strip()[:20_000]}
    found = DEADLINE_RE.search(text)
    if found:
        try:
            out["deadline"] = date(int(found[1]), int(found[2]), int(found[3])).isoformat()
        except ValueError:
            pass
    return out


async def extract(text: str) -> dict[str, Any]:
    from app.agents.llm import chat_completion, extract_json

    raw = await chat_completion(
        [{"role": "system", "content": PROMPT}, {"role": "user", "content": text[:20_000]}],
        temperature=0.1,
        json_mode=True,
        max_tokens=8000,
    )
    parsed = extract_json(raw or "")
    if not isinstance(parsed, dict):
        raise ValueError("模型没返回可用的岗位字段，没存")
    return normalize(parsed, text)
