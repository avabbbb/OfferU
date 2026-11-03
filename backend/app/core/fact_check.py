"""改写后的确定性事实核对：新简历里的数字、日期、机构名、英文技能词，在档案、记忆和原简历里找不到出处的列出来。

不调模型，只做字符串比对，所以会有漏报，也可能把换了写法的真事实当成找不到（比如「三成」和「30%」）。
因此结果只作提醒返回，不挡写库；改写本身是一条可撤销的改动。
名字和联系方式那段（第一个 ## 之前）不查：它们本来就从档案来。
"""

import re
import unicodedata
from typing import Any

_ROW_SPLIT = re.compile(r"\s{0,}[|｜]\s{0,}")
_DATE = re.compile(r"(?<!\d)((?:19|20)\d{2})\s{0,}[.\-/年]\s{0,}(\d{1,2})(?:\s{0,}月)?(?!\d)")
_NUMBER = re.compile(r"(?<![\d.])\d+(?:\.\d+)?(?!\d)")
_WORD = re.compile(r"(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9+#]{0,}(?:[.\-][A-Za-z0-9+#]+){0,}")
# 不算技能的常见英文小词；其余英文词都当技能/专有名词核对。
_STOP = {"a", "an", "and", "or", "of", "the", "to", "in", "on", "for", "with", "by", "at", "as", "is", "vs", "etc"}
LIMIT = 30


def _norm(text: str) -> str:
    """全角转半角、小写、去空白。"""
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", text)).lower()


def _dates(text: str) -> set[str]:
    return {f"{int(y)}-{int(m)}" for y, m in _DATE.findall(unicodedata.normalize("NFKC", text))}


def _numbers(text: str) -> set[str]:
    plain = _DATE.sub(" ", unicodedata.normalize("NFKC", text)).replace(",", "")
    return {n.rstrip("0").rstrip(".") if "." in n else n for n in _NUMBER.findall(plain)}


def _words(text: str) -> set[str]:
    return {w.lower() for w in _WORD.findall(unicodedata.normalize("NFKC", text))}


def check(body: str, sources: list[str]) -> list[dict[str, Any]]:
    """返回 [{kind: 数字/日期/机构/英文词, text, line}]，按出现顺序去重，最多 LIMIT 条。"""
    source = "\n".join(s for s in sources if s)
    flat, dates, numbers, words = _norm(source), _dates(source), _numbers(source), _words(source)
    found: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    def add(kind: str, text: str, line: str) -> None:
        if (kind, text) not in seen and len(found) < LIMIT:
            seen.add((kind, text))
            found.append({"kind": kind, "text": text, "line": line.strip()[:120]})

    started = False
    for line in body.splitlines():
        if line.startswith("## "):
            started = True
            continue
        if not started or not line.strip():
            continue
        text = line.lstrip("#- " + chr(42)).strip()
        if line.startswith("### "):
            org = _ROW_SPLIT.split(text)[0].strip()
            if org and _norm(org) not in flat:
                add("机构", org, line)
        for y, m in _DATE.findall(unicodedata.normalize("NFKC", text)):
            if f"{int(y)}-{int(m)}" not in dates:
                add("日期", f"{y}.{m}", line)
        for number in sorted(_numbers(text), key=text.find):
            if number not in numbers:
                add("数字", number, line)
        for word in _WORD.findall(unicodedata.normalize("NFKC", text)):
            if word.lower() not in _STOP and len(word) > 1 and word.lower() not in words:
                add("英文词", word, line)
    return found
