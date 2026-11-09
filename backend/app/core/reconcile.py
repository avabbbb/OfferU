"""做梦：离线核对职业记忆，找出前后说法对不上的地方。只出待核对的建议，不写库、不调模型。

scan() 读 memory、档案、主简历（没挂岗位的 resume 文档），返回 findings。建议里的 proposed 是一次 save 的参数，
只由用户在档案页点「采纳」时走 tools.save（进最近改动、可撤销）。以后要定时跑，调度里调 scan() 把结果缓存给档案页即可。
"""

from __future__ import annotations

import re
from datetime import date
from difflib import SequenceMatcher
from itertools import combinations
from typing import Any, Optional

from app.core import store

STALE_DAYS = 14
DUP_RATIO = 0.85
GAP_RE = re.compile(r"待补充?|\[gap\]|记不清", re.IGNORECASE)
DONE_RE = re.compile(r"入选|已上线|上线了|已完成|完成了|已获|荣获|获得|已发表|发表了|已录用|已通过")
PLAN_RE = re.compile(r"计划|准备|打算|将要|筹备|待上线|申请中|正在申请")
NUM_RE = re.compile(r"(?<![\d.])(\d+(?:\.\d+)?)\s*(\+|万|[wWkK](?![A-Za-z])|%|％)?")
UNIT = {"万": 10000, "w": 10000, "W": 10000, "k": 1000, "K": 1000}
AFTER_RE = re.compile(r"\s*(?:个|名|位|次|人|家|条|篇|项|倍|余|多)?\s*([\u4e00-\u9fff]{2}|[A-Za-z]{2,})")
BEFORE_RE = re.compile(r"([\u4e00-\u9fff]{2}|[A-Za-z]{2,})\s*(?:约|超过|达到|达|近|共|了)?\s*$")
SPLIT_RE = re.compile(r"[\s|｜/·,，、()（）\-—:：]+")


def _snip(text: str, start: int, end: int) -> str:
    return re.sub(r"\s+", " ", text[max(0, start - 15):end + 15]).strip()


def _norm(title: Any) -> str:
    return SPLIT_RE.sub("", str(title or "")).lower()


def _tokens(memory: dict[str, Any]) -> set[str]:
    return {t.lower() for t in SPLIT_RE.split(str(memory.get("title") or "")) if len(t) >= 2}


def _mentions(text: str) -> list[dict[str, Any]]:
    """文本里的数和它挨着的词（前后各取一个两字词），年份、日期不算。"""
    out = []
    for m in NUM_RE.finditer(text):
        raw, unit = m.group(1), m.group(2) or ""
        rest = text[m.end():]
        if (not unit and 1900 <= int(float(raw)) <= 2100) or re.match(r"\s*[年月日号]", rest):
            continue
        keys = set()
        if after := AFTER_RE.match(rest):
            keys.add(after.group(1).lower())
        if before := BEFORE_RE.search(text[:m.start()]):
            keys.add(before.group(1).lower())
        if not keys:
            continue
        pct = "%" if unit in ("%", "％") else ""
        out.append({"keys": {pct + k for k in keys}, "value": float(raw) * UNIT.get(unit, 1),
                    "raw": m.group(0).strip(), "snippet": _snip(text, m.start(), m.end())})
    return out


def _side(source: str, text: str, *, memory: Optional[dict[str, Any]] = None, field: Optional[str] = None,
          user_words: bool = False) -> dict[str, Any]:
    return {"source": source, "text": text, "memory": memory, "field": field, "user_words": user_words}


def _body(memory: dict[str, Any]) -> dict[str, Any]:
    return _side(f"memory#{memory['id']}", f"{memory.get('title') or ''}\n{memory.get('body') or ''}", memory=memory, field="body")


def _ev(side: dict[str, Any], text: str) -> dict[str, Any]:
    out = {"source": side["source"], "text": text}
    if side["field"]:
        out["field"] = side["field"]
    return out


def _finding(kind: str, ids: list[int], evidence: list[dict[str, Any]], suggestion: str,
             proposed: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    ids = sorted(set(ids))
    key = f"{kind}:{'-'.join(map(str, ids))}:" + "|".join(e["source"] + e.get("field", "") for e in evidence)
    return {"kind": kind, "key": key, "memory_ids": ids, "evidence": evidence, "suggestion": suggestion, "proposed": proposed}


def _number_patch(a, x, b, y) -> Optional[dict[str, Any]]:
    """改哪条：对面是用户原话（原话、主简历、档案）就改记忆正文；两条记忆之间改 Agent 推断的那条。"""
    for side, mine, other, theirs in ((a, x, b, y), (b, y, a, x)):
        memory = side["memory"]
        if side["field"] != "body" or not memory:
            continue
        if other["user_words"] or (memory.get("source") == "agent" and (other["memory"] or {}).get("source") != "agent"):
            body = str(memory.get("body") or "")
            pattern = re.compile(r"(?<![\d.])" + re.escape(mine["raw"]))
            if len(pattern.findall(body)) == 1:
                return {"type": "memory", "id": memory["id"], "data": {"body": pattern.sub(theirs["raw"], body, count=1)}}
    return None


def _drift(a: dict[str, Any], b: dict[str, Any]):
    done, plan = DONE_RE.search(a["text"]), PLAN_RE.search(b["text"])
    if done and plan and not PLAN_RE.search(a["text"]) and not DONE_RE.search(b["text"]):
        return done, plan
    return None


def _ids(*sides: dict[str, Any]) -> list[int]:
    return [s["memory"]["id"] for s in sides if s["memory"]]


def _compare(a: dict[str, Any], b: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    hit = next(((x, y) for x in _mentions(a["text"]) for y in _mentions(b["text"])
                if x["keys"] & y["keys"] and x["value"] != y["value"]), None)
    if hit:
        x, y = hit
        out.append(_finding("conflict", _ids(a, b), [_ev(a, x["snippet"]), _ev(b, y["snippet"])],
                            f"同一个数写法不一样：{x['raw']} 和 {y['raw']}，以哪个为准？", _number_patch(a, x, b, y)))
    for first, second in ((a, b), (b, a)):
        if drift := _drift(first, second):
            done, plan = drift
            out.append(_finding("status_drift", _ids(a, b),
                                [_ev(first, _snip(first["text"], done.start(), done.end())),
                                 _ev(second, _snip(second["text"], plan.start(), plan.end()))],
                                f"一处写「{done.group()}」，一处写「{plan.group()}」，现在到哪一步了？"))
            break
    return out


def _dates(a: dict[str, Any], b: dict[str, Any]) -> list[dict[str, Any]]:
    title = _norm(a.get("title"))
    if not title or a.get("kind") != b.get("kind") or title != _norm(b.get("title")):
        return []
    if not any(a.get(k) and b.get(k) and a[k] != b[k] for k in ("start", "end")):
        return []
    evidence = [{"source": f"memory#{m['id']}", "field": "date", "text": f"{m.get('title')}：{m.get('start') or '?'}–{m.get('end') or '?'}"}
                for m in (a, b)]
    return [_finding("conflict", [a["id"], b["id"]], evidence, "同一段经历写了两个不同的时间，以哪个为准？")]


def _duplicate(a: dict[str, Any], b: dict[str, Any]) -> list[dict[str, Any]]:
    if a.get("kind") != b.get("kind"):
        return []
    ta, tb = _norm(a.get("title")), _norm(b.get("title"))
    ba, bb = str(a.get("body") or "").strip(), str(b.get("body") or "").strip()
    same = bool(ta and ta == tb) or (min(len(ba), len(bb)) >= 20 and SequenceMatcher(None, ba, bb).ratio() >= DUP_RATIO)
    if not same:
        return []
    evidence = [{"source": f"memory#{m['id']}", "text": _snip(f"{m.get('title') or ''} {m.get('body') or ''}", 0, 45)} for m in (a, b)]
    return [_finding("duplicate", [a["id"], b["id"]], evidence, "像是同一件事记了两次：把内容合并到一条，删掉另一条")]


def _profile(memory: dict[str, Any], profile: dict[str, Any]) -> list[dict[str, Any]]:
    school, grad = str(profile.get("school") or ""), str(profile.get("grad_year") or "")[:4]
    end = str(memory.get("end") or "")[:4]
    if (memory.get("kind") != "education" or not (school and grad and end.isdigit())
            or school not in str(memory.get("title") or "") or end == grad):
        return []
    evidence = [{"source": f"memory#{memory['id']}", "field": "date", "text": f"{memory.get('title')}：{memory.get('end')} 毕业"},
                {"source": "profile", "text": f"毕业年份 {profile.get('grad_year')}"}]
    return [_finding("conflict", [memory["id"]], evidence, "毕业时间和档案里的毕业年份对不上，以哪个为准？")]


def _stale(memory: dict[str, Any], today: date, days: int) -> list[dict[str, Any]]:
    text = f"{memory.get('title') or ''}\n{memory.get('body') or ''}"
    gap = GAP_RE.search(text)
    if not gap:
        return []
    try:
        since = date.fromisoformat(str(memory.get("said_at") or memory.get("created_at") or "")[:10])
    except ValueError:
        return []
    age = (today - since).days
    if age < days:
        return []
    evidence = [{"source": f"memory#{memory['id']}", "text": _snip(text, gap.start(), gap.end())}]
    return [_finding("stale_gap", [memory["id"]], evidence, f"「{gap.group()}」放了 {age} 天还没补：补上具体内容，或删掉这句")]


def scan(*, today: Optional[date] = None, stale_days: int = STALE_DAYS) -> list[dict[str, Any]]:
    """只读：冲突（数字、时间）、进度对不上、重复、待补太久。每条 {kind, key, memory_ids, evidence, suggestion, proposed}。"""
    today = today or date.today()
    memories = sorted(store.all_of("memory"), key=lambda m: m["id"])
    profile = store.first("profile") or {}
    master = next((d for d in store.all_of("doc") if d.get("kind") == "resume" and not d.get("job_id")), None)
    others = [_side(f"doc#{master['id']}", block, user_words=True)
              for block in re.split(r"\n(?=#)", str(master.get("body") or "")) if block.strip()] if master else []
    if profile.get("about"):
        others.append(_side("profile", str(profile["about"]), user_words=True))

    findings: list[dict[str, Any]] = []
    for memory in memories:
        if memory.get("quote"):
            quote = _side(f"memory#{memory['id']}", str(memory["quote"]), memory=memory, field="quote", user_words=True)
            findings += _compare(_body(memory), quote)
        tokens = _tokens(memory)
        for other in others:
            if tokens and any(t in other["text"].lower() for t in tokens):
                findings += _compare(_body(memory), other)
        findings += _profile(memory, profile) + _stale(memory, today, stale_days)
    for a, b in combinations(memories, 2):
        if _tokens(a) & _tokens(b):
            findings += _compare(_body(a), _body(b))
        findings += _dates(a, b) + _duplicate(a, b)
    unique: dict[str, dict[str, Any]] = {}
    for finding in findings:
        unique.setdefault(finding["key"], finding)
    return list(unique.values())
