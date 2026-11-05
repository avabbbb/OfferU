"""岗位评估：读档案、职业记忆和 JD，给一个岗位出固定结构的评估报告（值不值得投、凭什么投、怎么准备）和 0–100 分。

报告和 research 文档是同一套 Markdown 结构和口径标签，岗位页用 ResearchCard 分层展示。
不联网：公司、竞品、面经走 research；这里只用 JD、备注、来源可信度和档案里的事实。
「## 来源」由代码写，模型写的来源一律丢掉，链接不会是编的。写库由调用方走 tools.save。candidate / job_text 网申回答也用。
"""

from __future__ import annotations

import re
from typing import Any, Iterable, Optional
from urllib.parse import urlparse

from app.core.resume_split import available  # noqa: F401  同一套「配了模型或允许交给本机 Agent」判断

SECTIONS = ("岗位摘要", "逐条匹配", "来源与真假", "职级与薪资", "简历怎么改", "面试准备", "反问")

PROMPT = """你是求职顾问。根据候选人的档案和职业记忆，评估一个岗位，只输出严格 JSON：
{"score": 0, "reasons": ["", "", ""], "markdown": ""}

score：0–100 的整数。80 以上值得优先投，60–79 可以投，60 以下不建议。JD 信息太少或档案是空的就给保守分并在理由里说明。
reasons：恰好三句，每句不超过 40 字：最匹配的点 / 最大的差距或风险 / 和偏好（城市、方向、公司类型）是否相符。
markdown：评估报告，严格按这个结构：
# 结论
一句话：这是什么岗位、建议优先投 / 可以投 / 不建议投，为什么。
> 风险：最大的一条风险。
- 3 条关键观察
## 岗位摘要
## 逐条匹配
## 来源与真假
## 职级与薪资
## 简历怎么改
## 面试准备
## 反问
每个板块第一段是一句摘要，下面每条要点一行「- …」，尽量落到「对你意味着什么」。
各板块写什么：
- 岗位摘要：做什么、核心指标、硬性要求（年限、学历、技能）。
- 逐条匹配：JD 每条要求一行，写「要求 → 命中 / 部分命中 / 差距」，命中就点名档案里哪段经历，差距就写怎么补或面试怎么讲。
- 来源与真假：照输入里的「来源可信度」和备注写；年限、薪资、编号前后不一致要点出来；官网查不到就建议投前向 HR 确认。
- 职级与薪资：只用 JD 和备注里写了的；没有就写 [gap]，不估薪资数字。
- 简历怎么改：哪段经历放前面、用 JD 的哪些词、哪些数字要突出；只用档案里的事实，没有的写「（待补充：…）」。
- 面试准备：最可能被问的 4–6 个问题，每个配一段档案里的经历当 STAR 素材。
- 反问：3 个能顺便核实岗位真实情况的反问。
口径标签：每条要点和每个板块的摘要句末尾都必须标一个。来自 JD 或备注的事实标输入里给的 JD 标签（如 [official S1] 或 [community S1]）；
引用候选人档案或记忆的判断标 [inference S2]；纯推断标 [inference]；资料里没有的标 [gap]。
硬规则：只用档案、记忆、JD 和备注里写了的事实，不编经历、数字、公司信息；不要写「## 来源」，来源由系统补。
"""

# 要登录的招聘平台和社区：JD 来自这些地方就是「社区信号」，没在官网核实。
PLATFORMS = {"boss": "BOSS 直聘", "xhs": "小红书", "liepin": "猎聘", "maimai": "脉脉", "lagou": "拉勾", "nowcoder": "牛客"}


PROFILE_KEYS = ("school", "major", "degree", "grad_year", "city", "target", "stage", "about")


def candidate(profile: dict[str, Any] | None, memories: Iterable[dict[str, Any]]) -> str:
    lines = []
    if profile:
        lines.append("档案：" + "；".join(f"{k}={profile[k]}" for k in PROFILE_KEYS if profile.get(k)))
    for m in memories:
        lines.append(f"[{m.get('kind') or 'note'}] {m.get('title') or ''} {str(m.get('body') or '')[:300]}".strip())
    return "\n".join(lines)[:12_000]


POSTING_META = (("hire_type", "招聘类型"), ("team", "部门"), ("years", "年限"), ("education", "学历"),
                ("salary", "薪资"), ("job_code", "编号"), ("posted_at", "发布日"))
POSTING_LISTS = (("responsibilities", "职责"), ("hard_reqs", "硬性要求"), ("soft_reqs", "加分项"))


def posting_block(job: dict[str, Any]) -> str:
    """job.posting 拆好的要求和关键词，给评估和改简历用；没拆过返回空串。"""
    p = job.get("posting") or {}
    if not isinstance(p, dict):
        return ""
    parts = []
    meta = "；".join(f"{name}：{p[key]}" for key, name in POSTING_META if p.get(key))
    if meta:
        parts.append(meta)
    for key, name in POSTING_LISTS:
        items = [str(x) for x in p.get(key) or [] if str(x).strip()]
        if items:
            parts.append(f"{name}：\n" + "\n".join(f"{i}. {x}" for i, x in enumerate(items, 1)))
    if p.get("keywords"):
        parts.append("关键词：" + "、".join(str(k) for k in p["keywords"]))
    if parts and p.get("collaborators"):
        parts.append("协作对象（推断，非原文）：" + "、".join(str(c) for c in p["collaborators"]))
    evidence = [e for e in p.get("evidence") or [] if isinstance(e, dict) and e.get("req") and e.get("need")]
    if parts and evidence:
        parts.append("证明硬性要求要准备的经历（推断）：\n" + "\n".join(f"- {e['req']} → {e['need']}" for e in evidence))
    if parts and p.get("essence"):
        parts.append(f"岗位本质（推断，非原文）：{p['essence']}")
    return "\n".join(parts)


def job_text(job: dict[str, Any]) -> str:
    """有 posting 就给拆条 + JD 原文节选；没有就照旧截 JD 前 3000 字。"""
    head = f"id={job['id']} 公司：{job.get('company') or ''} 岗位：{job.get('title') or ''} 城市：{job.get('city') or ''}"
    jd = str(job.get("jd") or "")
    block = posting_block(job)
    if not block:
        return f"{head}\n{jd[:3000]}"
    return f"{head}\n{block}\n\nJD 原文（节选，要求以上面拆条为准）：\n{jd[:1500]}"


def source_fact(job: dict[str, Any]) -> tuple[str, str]:
    """(口径标签, 来源说明)：官网或公司开通的托管招聘系统是 official，其余都是 community。"""
    from app.core import job_sources

    url = str(job.get("url") or "")
    host = (urlparse(url).hostname or "").lower() if url else ""
    if url:
        kind = job_sources.official_kind(url, str(job.get("company") or ""))
        if kind == "own":
            return "official", f"公司自有招聘官网（{host}）"
        if kind:
            return "official", f"公司开通的托管招聘系统（{host}）"
    source = str(job.get("source") or "").lower()
    platform = PLATFORMS.get(source)
    if platform:
        return "community", f"第三方平台（{platform}），没在招聘官网核实"
    if host:
        return "community", f"非官方页面（{host}），没在招聘官网核实"
    return "community", "用户粘贴的 JD，没有链接，来源未核实"


def sources(job: dict[str, Any], where: str) -> str:
    url = str(job.get("url") or "")
    jd = f"- S1 岗位 JD · {where}" + (f" · {url}" if url else "")
    return f"## 来源\n{jd}\n- S2 你的档案和职业记忆 · OfferU\n"


def normalize(parsed: Any, job: dict[str, Any], where: str) -> Optional[dict[str, Any]]:
    if not isinstance(parsed, dict):
        return None
    markdown = str(parsed.get("markdown") or "").strip()
    if "# 结论" not in markdown:
        return None
    try:
        score = int(round(float(parsed.get("score"))))
    except (TypeError, ValueError):
        return None
    # 模型自己写的来源不采用，由 sources() 重写。
    markdown = re.split(r"(?m)^##\s*(?:来源|sources?)\s*$", markdown, flags=re.IGNORECASE)[0].rstrip()
    reasons = [str(r).strip()[:80] for r in parsed.get("reasons") or [] if str(r).strip()][:3]
    return {"score": max(0, min(100, score)), "reasons": reasons, "markdown": f"{markdown}\n\n{sources(job, where)}"}


async def evaluate(profile_text: str, job: dict[str, Any]) -> Optional[dict[str, Any]]:
    from app.agents.llm import chat_completion, extract_json

    label, where = source_fact(job)
    user = ("候选人：\n" + (profile_text or "（档案是空的）")
            + "\n\n岗位：\n" + job_text(job)
            + "\n备注：" + (str(job.get("notes") or "").strip() or "无")
            + f"\n来源可信度：{where}。JD 里的事实标 [{label} S1]。")
    raw = await chat_completion(
        [{"role": "system", "content": PROMPT}, {"role": "user", "content": user}],
        temperature=0.2,
        json_mode=True,
        max_tokens=6000,
    )
    return normalize(extract_json(raw or ""), job, where)
