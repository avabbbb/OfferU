"""改写时追问成果：用户的回答 → 记忆草稿（docs/design/tailor-impact-asks.md §4 第 4 步）。

一次模型调用，只出草稿、不写库；用户在界面上一次确认后，前端逐条走 save(actor=你)，每条一个可撤销的改动。
不编数字靠代码，不靠提示词：草稿新增的那句话里，每个数字都要在用户原话里出现；用户说了「大概」，草稿也要带约数词。
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

PROMPT = """你是求职档案整理助手。用户改简历时回答了几个「做出了什么结果」的问题。把每个回答整理成一句能写进档案的话，只输出严格 JSON：
{"drafts": [{"index": 0, "memory_id": 12, "title": "", "add": "整理后的一句话"}]}
规则：
1. 每个回答出一条，index 用回答的序号。
2. memory_id：这句简历原句对应「已有记忆」里的哪一条，填它的数字 id；对不上就填 null（会新建一条记忆），这时 title 写一个简短标题。
3. add 只写用户回答里的结果，一句话，书面一点，可以写得有分量；数字、比例、时间、奖项名称只能用用户原话里有的，原话没有的一个也不能加。
4. 用户说了「大概」「左右」「记不清」这类话，add 里要保留「约」「大概」「左右」。
5. 用户说没有数据，就只写定性的结果，不出现数字。
"""


def numbers(text: str) -> list[str]:
    """文字里的数字，千分位逗号去掉：「2,000」和「2000」算同一个。"""
    return re.findall(r"\d+(?:\.\d+)?", re.sub(r"(?<=\d),(?=\d{3}(?!\d))", "", text))


def check(add: str, said: str) -> Optional[str]:
    """草稿这句话能不能用；不能就返回原因。"""
    known = set(numbers(said))
    missing = [n for n in dict.fromkeys(numbers(add)) if n not in known]
    if missing:
        return "回答里没有这个数字：" + "、".join(missing)
    if any(word in said for word in VAGUE_SAID) and not any(word in add for word in VAGUE_KEPT):
        return "回答说的是大概，草稿把约数词弄丢了"
    return None


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
    返回 {drafts: [{memory_id, title, data, answers}], dropped: [{index, old, question, quote, add?, why}]}。
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
    dropped: list[dict[str, Any]] = []
    seen: set[int] = set()
    for draft in parse(raw):
        item = by_index.get(_int(draft.get("index")))
        add = re.sub(r"^[-*·•]\s*", "", str(draft.get("add") or "").strip())
        if item is None or item["index"] in seen or not add:
            continue
        seen.add(item["index"])
        if why := check(add, item["quote"]):
            dropped.append({**item, "add": add, "why": why})
            continue
        memory = memories.get(_int(draft.get("memory_id")))
        key = memory["id"] if memory else f"new-{item['index']}"
        title = (memory or {}).get("title") or str(draft.get("title") or "").strip() or re.sub(r"^[-*·•]\s*", "", item["old"])
        group = groups.setdefault(key, {"memory": memory, "title": title[:120], "answers": []})
        group["answers"].append({**item, "add": add})
    dropped += [{**item, "why": "模型没整理这条回答"} for item in items if item["index"] not in seen]

    drafts = []
    for group in groups.values():
        memory = group["memory"]
        lines = "\n".join("- " + a["add"] for a in group["answers"])
        quote = "；".join(filter(None, [(memory or {}).get("quote"), *(a["quote"] for a in group["answers"])]))
        if memory:
            data = {"body": (str(memory.get("body") or "").rstrip() + "\n" + lines).strip()}
        else:
            data = {"kind": "note", "title": group["title"], "body": lines}
        data.update(quote=quote, said_at=today)
        drafts.append({"memory_id": memory["id"] if memory else None, "title": group["title"], "data": data,
                       "answers": group["answers"]})
    return {"drafts": drafts, "dropped": sorted(dropped, key=lambda d: d["index"])}
