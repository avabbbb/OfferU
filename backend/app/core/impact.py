"""改写时追问成果：用户的回答 → 记忆草稿（docs/design/tailor-impact-asks.md §4 第 4 步）。

一次模型调用，只出草稿、不写库；用户在界面上一次确认后，前端逐条走 save(actor=你)，每条一个可撤销的改动。
档案以用户原话（quote）为准，草稿那句话只是展示。代码不整条作废草稿，只在草稿上标出要留意的地方：
原话没有的数字（含「三成」「两倍」这类汉字数字）、弄丢或叠用的约数词、原话没有的程度词。
用户点「存进档案」就是确认。严格核对放在改写结果那一端，做法参考 career-ops 的 verify-cv-facts
（block / warn 分档）和 ai-job-search 的 Factual Grounding Audit（先写进来源，下游再核对）。
"""

from __future__ import annotations

import datetime as dt
import json
import re
from typing import Any, Awaitable, Callable, Optional

from app.core import store

Complete = Callable[[list[dict[str, str]]], Awaitable[Optional[str]]]

MAX_ANSWERS = 3
# 用户原话里出现这些词，算「说的是大概」；草稿里要留下后一组里的至少一个。
VAGUE_SAID = ("大概", "大约", "约", "左右", "差不多", "估计", "将近", "记不清", "印象中", "上下")
VAGUE_KEPT = ("约", "大概", "左右", "将近", "余", "上下")
# 一句草稿里出现两个以上就算叠用（「约三成左右」）；长词在前，「大约」不会再数出一个「约」。
HEDGE_RE = re.compile(r"大概|大约|差不多|将近|左右|约")
# 原话没说、草稿却加上的程度词，算拔高。
INTENSE = ("明显", "显著", "大幅", "极大", "大大", "全面", "彻底", "成倍")
# 汉字数字：带「成」「倍」「个百分点」的，和「百分之……」。
CN_NUMBER_RE = re.compile(r"百分之[零〇一二两三四五六七八九十百几]+|[零〇一二两三四五六七八九十百千万几半]+(?:成|倍|个百分点)")

PROMPT = """你是求职档案整理助手。用户改简历时回答了几个「做出了什么结果」的问题。把每个回答整理成一句能写进档案的话，只输出严格 JSON：
{"drafts": [{"index": 0, "memory_id": 12, "title": "", "add": "整理后的一句话"}]}
规则：
1. 每个回答出一条，index 用回答的序号。
2. memory_id：这句简历原句对应「已有记忆」里的哪一条，填它的数字 id；对不上就填 null（会新建一条记忆），这时 title 写一个简短标题。
3. add 只写用户回答里的结果，一句话，书面一点；数字、比例、时间、奖项名称只能用用户原话里有的，原话没有的一个也不能加。
4. 程度跟原话走：原话说「快多了」就写「更快」，不要自己加「明显」「显著」「大幅」。
5. 用户说了「大概」「左右」「记不清」这类话，add 里保留一个约数词就够，不要写成「约三成左右」。
6. 用户说没有数据，就只写定性的结果，不出现数字。
7. 回答和问题对不上也照实整理，不要硬套问题里的说法。
"""


def numbers(text: str) -> list[str]:
    """文字里的数字，千分位逗号去掉：「2,000」和「2000」算同一个；汉字数字按原样算（「三成」「两倍」）。"""
    plain = re.sub(r"(?<=\d),(?=\d{3}(?!\d))", "", text)
    return re.findall(r"\d+(?:\.\d+)?", plain) + CN_NUMBER_RE.findall(plain)


def flags(add: str, said: str) -> list[str]:
    """草稿这句话要用户留意的地方；空列表就是没什么要提醒的。不作废，只提醒。"""
    out = []
    known = set(numbers(said))
    missing = [n for n in dict.fromkeys(numbers(add)) if n not in known]
    if missing:
        out.append("原话里没有这个数字：" + "、".join(missing))
    if any(word in said for word in VAGUE_SAID) and not any(word in add for word in VAGUE_KEPT):
        out.append("原话是「大概」，草稿没带约数词")
    hedges = list(dict.fromkeys(HEDGE_RE.findall(add)))
    if len(hedges) > 1:
        out.append("约数词叠用了：" + "、".join(hedges))
    louder = [word for word in INTENSE if word in add and word not in said]
    if louder:
        out.append("原话没有这个程度：" + "、".join(louder))
    return out


def _answers(answers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """只要有内容的回答（空的就是「先不答」），index 保留原序号，前端按它对回卡片。"""
    out = []
    for index, item in enumerate(answers[:MAX_ANSWERS]):
        said = str(item.get("answer") or "").strip()
        if said:
            out.append({"index": index, "old": str(item.get("old") or "").strip(),
                        "question": str(item.get("question") or "").strip(), "quote": said})
    return out


def messages(items: list[dict[str, Any]], job_title: str, memories: list[dict[str, Any]]) -> list[dict[str, str]]:
    known = "\n".join(f"#{m['id']} {m.get('title') or ''}：{' / '.join(str(m.get('body') or '').split(chr(10)))}"
                      for m in memories) or "（没有）"
    asked = "\n\n".join(f"### 回答 {i['index']}\n简历原句：{i['old']}\n问题：{i['question']}\n用户原话：{i['quote']}"
                        for i in items)
    user = f"## 岗位\n{job_title or '（没写）'}\n\n## 已有记忆\n{known}\n\n## 用户的回答\n{asked}"
    return [{"role": "system", "content": PROMPT}, {"role": "user", "content": user}]


def parse(raw: Optional[str]) -> list[dict[str, Any]]:
    text = (raw or "").strip()
    start, end = text.find("{"), text.rfind("}")
    try:
        data = json.loads(text[start:end + 1]) if 0 <= start < end else None
    except json.JSONDecodeError:
        data = None
    drafts = data.get("drafts") if isinstance(data, dict) else None
    if not isinstance(drafts, list):
        raise ValueError("整理回答的模型没返回可用的草稿，档案没动")
    return [d for d in drafts if isinstance(d, dict)]


def _int(value: Any) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _default_complete() -> Complete:
    from app.agents.llm import chat_completion

    return lambda msgs: chat_completion(msgs, temperature=0.1, json_mode=True, max_tokens=2048)


async def capture(answers: list[dict[str, Any]], job_title: str = "", *, complete: Optional[Complete] = None,
                  today: Optional[str] = None) -> dict[str, Any]:
    """answers：[{old, question, answer}]，最多 3 条。
    返回 {drafts: [{memory_id, title, data, answers: [{index, old, question, quote, add, flags}]}],
          dropped: [{index, old, question, quote, why}]}。
    flags 是要用户留意的地方（见 flags()），不影响能不能存；dropped 只剩模型没整理的回答。
    data 就是要传给 save("memory", data, memory_id) 的内容：补到已有记忆就是整条新 body，对不上就新建 kind=note。
    同一条记忆被几句回答补到时合成一条草稿。不写库。"""
    items = _answers(answers)
    if not items:
        raise ValueError("没有要整理的回答，档案没动")
    memories = {int(m["id"]): m for m in store.all_of("memory")}
    raw = await (complete or _default_complete())(messages(items, job_title, list(memories.values())))
    today = today or dt.date.today().isoformat()
    by_index = {item["index"]: item for item in items}
    groups: dict[Any, dict[str, Any]] = {}
    seen: set[int] = set()
    for draft in parse(raw):
        item = by_index.get(_int(draft.get("index")))
        add = re.sub(r"^[-*·•]\s*", "", str(draft.get("add") or "").strip())
        if item is None or item["index"] in seen or not add:
            continue
        seen.add(item["index"])
        memory = memories.get(_int(draft.get("memory_id")))
        key = memory["id"] if memory else f"new-{item['index']}"
        title = (memory or {}).get("title") or str(draft.get("title") or "").strip() or re.sub(r"^[-*·•]\s*", "", item["old"])
        group = groups.setdefault(key, {"memory": memory, "title": title[:120], "answers": []})
        group["answers"].append({**item, "add": add, "flags": flags(add, item["quote"])})
    dropped = [{**item, "why": "模型没整理这条回答"} for item in items if item["index"] not in seen]

    drafts = []
    for group in groups.values():
        memory = group["memory"]
        lines = "\n".join("- " + a["add"] for a in group["answers"])
        # 同一句原话答了两个问题，或和档案里已有的一样，只记一次
        quote = "；".join(dict.fromkeys(filter(None, [(memory or {}).get("quote"), *(a["quote"] for a in group["answers"])])))
        if memory:
            data = {"body": (str(memory.get("body") or "").rstrip() + "\n" + lines).strip()}
        else:
            data = {"kind": "note", "title": group["title"], "body": lines}
        data.update(quote=quote, said_at=today)
        drafts.append({"memory_id": memory["id"] if memory else None, "title": group["title"], "data": data,
                       "answers": group["answers"]})
    return {"drafts": drafts, "dropped": dropped}
