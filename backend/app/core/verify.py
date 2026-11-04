"""改写结果核对（docs/design/tailor-impact-asks.md 第 3 条）：终稿每一行对照事实来源，分 block / warn 两档，只提示不改稿。

事实来源 = 档案（_facts，含用户原话）+ 改写前的原简历。只靠代码，不调模型：
- block：终稿里的数字在来源里找不到（阿拉伯数字按整数段比，「2万」「20000」「2,000」都归一；汉字数字「三成」「两倍」按原样比）。
- warn：动词越级（来源只说参与/协助，终稿写成负责/主导）、来源带「约/大概」的数字终稿把约数词删了、
  来源里没有的普及度或拔高说法（全网、行业领先、首个……）。
- unchecked：来源是空的就整份没法核对，明说「没检查」，不报错。
"""

from __future__ import annotations

import re
from typing import Any

from app.core.impact import CN_NUMBER_RE, VAGUE_SAID

# 来源里只有前一组、终稿却出现后一组，算动词越级。
WEAK_VERBS = ("参与", "协助", "配合", "支持", "跟进", "辅助")
STRONG_VERBS = ("主导", "牵头", "负责", "带领", "独立完成", "主持", "统筹")
# 普及度、排名、拔高说法：来源里没有就提醒。
CLAIMS = ("全网", "行业领先", "业内领先", "国内领先", "全国首个", "首个", "首创", "唯一", "爆款", "刷屏", "顶尖", "头部")
HEDGES = ("约", "大概", "大约", "左右", "将近", "差不多", "余", "上下")
_UNIT = {"万": 10_000, "千": 1_000, "百": 100, "亿": 100_000_000}
_NUM_RE = re.compile(r"(\d+(?:\.\d+)?)\s*([万千百亿]?)")
_LIST_MARK = re.compile(r"^\s*(?:[-*+]|\d+[.、)])\s*")


def _plain(text: str) -> str:
    return re.sub(r"(?<=\d),(?=\d{3}(?!\d))", "", text)


def _scaled(value: str, unit: str) -> str:
    scaled = float(value) * _UNIT[unit]
    return str(int(scaled)) if scaled == int(scaled) else str(scaled)


def _forms(value: str, unit: str) -> set[str]:
    """来源里一个数字算哪些写法：整串、每一段（2023.06 → 2023、6）、乘上单位后的值（2万 → 20000）。"""
    out = {str(int(part)) for part in value.split(".") if part}
    if unit:
        out.add(_scaled(value, unit))
    if "." in value:
        out.add(value.rstrip("0").rstrip("."))
    return out


def _traced(value: str, unit: str, known: set[str]) -> bool:
    """终稿里的一个数字有没有出处。带单位的按换算后的值比；带小数点的要整串对上或每一段都在，
    免得「2025.06」只因为来源里有个「6」就放行。"""
    if unit:
        return _scaled(value, unit) in known
    if "." in value and value.rstrip("0").rstrip(".") in known:
        return True
    return all(str(int(part)) in known for part in value.split(".") if part)


def known_numbers(text: str) -> set[str]:
    plain = _plain(text)
    out: set[str] = set(CN_NUMBER_RE.findall(plain))
    for value, unit in _NUM_RE.findall(plain):
        out |= _forms(value, unit)
    return out


def _missing(line: str, known: set[str]) -> list[str]:
    """一行里找不到出处的数字（原样）。去掉列表序号，免得「1.」被当成数字。"""
    plain = _plain(_LIST_MARK.sub("", line))
    out = [m.group(0).strip() for m in _NUM_RE.finditer(plain) if not _traced(m.group(1), m.group(2), known)]
    out += [word for word in CN_NUMBER_RE.findall(plain) if word not in known]
    return list(dict.fromkeys(out))


def _hedged(sources: str) -> set[str]:
    """来源里说成约数的数字：和「大概」「左右」这类词在同一个分句里（「大概让处理时间缩短了三成左右」）。"""
    out: set[str] = set()
    for clause in re.split(r"[，,。；;！!？?\n]", _plain(sources)):
        if any(word in clause for word in VAGUE_SAID):
            out |= set(CN_NUMBER_RE.findall(clause)) | set(re.findall(r"\d+(?:\.\d+)?", clause))
    return out


def check(body: str, sources: str) -> dict[str, Any]:
    """返回 {block: [...], warn: [...], unchecked: str}；每条 {line, kind, detail}。只提示，调用方决定怎么展示。"""
    if not sources.strip():
        return {"block": [], "warn": [], "unchecked": "档案和原简历都是空的，没法核对，这份没检查"}
    known = known_numbers(sources)
    hedged = _hedged(sources)
    block: list[dict[str, str]] = []
    warn: list[dict[str, str]] = []
    for raw in body.splitlines():
        line = raw.strip()
        if not line:  # 标题行也看：「### 公司 | 职位 | 日期」里有事实
            continue
        missing = _missing(line, known)
        if missing:
            block.append({"line": line, "kind": "number", "detail": "档案和原简历里找不到：" + "、".join(missing)})
        louder = [v for v in STRONG_VERBS if v in line and v not in sources]
        if louder and any(v in sources for v in WEAK_VERBS):
            warn.append({"line": line, "kind": "verb", "detail": "来源里没有这个说法：" + "、".join(louder) + "（来源写的是参与/协助一类）"})
        dropped = [n for n in hedged if re.search(r"(?<![\d.])" + re.escape(n) + r"(?![\d.])", line) and not any(h in line for h in HEDGES)]
        if dropped:
            warn.append({"line": line, "kind": "hedge", "detail": "来源里是约数，这里没带约数词：" + "、".join(dropped)})
        claims = [c for c in CLAIMS if c in line and c not in sources]
        if claims:
            warn.append({"line": line, "kind": "claim", "detail": "来源里没有这个说法：" + "、".join(claims)})
    return {"block": block, "warn": warn, "unchecked": ""}
