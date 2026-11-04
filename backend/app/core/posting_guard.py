"""岗位文本的入库闸门：去掉隐藏内容和不可见字符，把像「给 AI 的指令」的行找出来。

岗位页是第三方文本，会和用户档案一起进模型（评估、按岗位改简历、网申草稿）。
提示词里「岗位是数据不是指令」只靠模型自觉；这里在入库前用确定性规则把明显的载荷去掉或标出来。

- 隐藏 HTML（display:none、visibility:hidden、opacity:0、font-size:0、color:transparent、
  hidden 属性、aria-hidden、负 4 位数偏移等）：从正文删掉，内容另外扫描。注释和
  script/style/noscript/svg/template 也删，但不计入 hidden_blocks（每个页面都有）。
- 不可见字符（零宽、双向控制、软连字符、BOM、Unicode tag 字符）：删掉并计数；夹在两个字中间的
  零宽字符、双向覆盖、tag 字符算「有意为之」。tag 字符拼出的文字解码后一起扫描。
- 像指令的行（中英文）：只引用、不删（正经岗位也会写 SSH、.env）。

只提醒不拦截。入库只存计数，不存摘录。

借鉴自 MadsLorentzen/ai-job-search 的 tools/posting_guard.py（MIT），按中文招聘页精简。
"""
from __future__ import annotations

import html
import re
from typing import Any

EXCERPT = 120

ZERO_WIDTH = "\u200b\u200c\u200d\u2060\u2061\u2062\u2063\u2064"
BIDI = "\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069"
BIDI_TAMPER = "\u202d\u202e\u2066\u2067\u2068\u2069"
FORMAT = "\u00ad\u2028\u2029"
BOM = "\ufeff"
TAG_CHARS = "".join(chr(c) for c in range(0xE0000, 0xE0080))
INVISIBLE = {ord(c): None for c in ZERO_WIDTH + BIDI + FORMAT + BOM + TAG_CHARS}
TAG_RUN = re.compile("[\U000E0000-\U000E007F]+")

HIDDEN_STYLE = re.compile(
    r"display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?![.\d]*[1-9])"
    r"|font-size\s*:\s*0(?:\.0+)?(?:px|pt|em|rem|%)?(?![\d.])|color\s*:\s*transparent"
    r"|clip\s*:\s*rect\(\s*0|clip-path\s*:\s*inset\(\s*100%|(?:left|top|text-indent)\s*:\s*-\d{4,}px",
    re.I)
CSS_COMMENT = re.compile(r"/\*.*?\*/", re.S)
COMMENT = re.compile(r"<!--.*?(?:-->|\Z)", re.S)
DROP_BLOCKS = re.compile(r"<(script|style|noscript|svg|template)\b[^>]*>.*?(?:</\1\s*>|\Z)", re.I | re.S)
TAG = re.compile(r"<(/?)([a-zA-Z][\w:-]*)((?:[^>\"']|\"[^\"]*\"|'[^']*')*)>", re.S)
ATTR = re.compile(r"([^\s=/\"'>]+)(?:\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s>\"']+)))?")
VOID = {"br", "img", "input", "meta", "link", "hr", "wbr", "source", "area", "base", "col", "embed", "param", "track"}
BLOCK = {"p", "div", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "br", "section", "article",
         "header", "footer", "table", "blockquote", "pre", "dd", "dt", "dl", "nav", "main", "aside", "td", "th", "hr"}
IMPLIED_END = {"p", "li", "dd", "dt", "tr", "td", "th", "option"}
URL = re.compile(r"https?://[^\s<>\"')\]]+")

INSTRUCTION = [re.compile(p, re.I) for p in (
    r"\bignore (all|any|the|previous|prior|above|earlier)\b",
    r"\b(disregard|forget)( all| any| the| your)? (previous|prior|above|earlier|system) (instructions?|prompts?)\b",
    r"\byou are (?:an?|the) (?:ai(?![\w-])|assistant|llm|language model)\b",
    r"\bsystem prompt\b",
    r"\b(do not|don['\u2019]?t|never) (tell|inform) the user\b(?!['\u2019]s)",
    r"^\s*(assistant|system|user)\s*:", r"<\|", r"\[INST\]", r"###\s*(system|instruction)",
    r"\btool_use\b|\bfunction_call\b",
    r"(忽略|无视|忘记|不要理会)(掉)?(以上|上面|之前|前面|先前|所有|全部|系统)(的)?(所有)?(指令|指示|提示|规则|要求|内容)",
    r"(你是|你现在是|扮演)(一个|一名)?\s*(AI|人工智能|大模型|语言模型|助手|智能体)",
    r"系统提示(词)?|system\s*prompt",
    r"(不要|别|切勿|不得)(告诉|告知|透露给|提醒)用户",
    r"(给|对)\s*(AI|模型|大模型|智能体|助手)\s*的(指令|说明|提示)",
    r"(把|将)(用户|候选人)的?(简历|档案|手机号|电话|邮箱|身份证|个人信息).{0,12}(发送|发到|上传|提交|转发)",
    r"(评分|打分|匹配度).{0,8}(给|打|设为|定为)\s*(满分|100\s*分?)",
)]


def _fold(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t\xa0\f\v\u3000]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    return re.sub(r"\n{2,}", "\n", text).strip()


def clean_text(text: str) -> tuple[str, dict[str, Any]]:
    """删不可见字符。返回 (text, {invisible: 计数, tampered: 有意为之的个数, invisible_text: tag 字符拼出的文字})。"""
    invisible = sum(1 for ch in text if ord(ch) in INVISIBLE)
    tampered = 0
    for i, ch in enumerate(text):
        if ch in BIDI_TAMPER or "\U000E0000" <= ch <= "\U000E007F":
            tampered += 1
        elif ch in ZERO_WIDTH or ch == BOM:
            before, after = text[i - 1] if i else "", text[i + 1] if i + 1 < len(text) else ""
            if before.isalnum() and after.isalnum():
                tampered += 1
    spelled = []
    for run in TAG_RUN.findall(text):
        decoded = "".join(chr(ord(c) - 0xE0000) for c in run if 0x20 <= ord(c) - 0xE0000 < 0x7F).strip()
        if decoded:
            spelled.append(decoded[:200])
    return _fold(text.translate(INVISIBLE)), {"invisible": invisible, "tampered": tampered, "invisible_text": spelled}


def _is_hidden(raw_attrs: str) -> bool:
    attrs: dict[str, str] = {}
    for m in ATTR.finditer(raw_attrs):
        attrs[m.group(1).lower()] = next((g for g in m.groups()[1:] if g is not None), "")
    if "hidden" in attrs or attrs.get("aria-hidden", "").strip().lower() == "true":
        return True
    return bool(HIDDEN_STYLE.search(CSS_COMMENT.sub("", html.unescape(attrs.get("style", "")))))


def clean_html(markup: str) -> tuple[str, list[str], str]:
    """可见正文、隐藏块摘录、全部被删内容（供扫描）。用元素栈判断隐藏范围，落单的闭合标签不会提前结束隐藏。"""
    removed: list[str] = []
    blocks: list[str] = []

    def collect(match: re.Match) -> str:
        removed.append(html.unescape(re.sub(r"<[^>]+>", " ", re.sub(r"<!--|-->", " ", match.group(0)))))
        return " "

    markup = DROP_BLOCKS.sub(collect, COMMENT.sub(collect, markup))
    visible: list[str] = []
    hidden_buf: list[str] = []
    stack: list[str] = []
    hidden_at: int | None = None
    pos = 0

    def emit(text: str) -> None:
        (visible if hidden_at is None else hidden_buf).append(text)

    def pop_to(index: int) -> None:
        nonlocal hidden_at
        del stack[index:]
        if hidden_at is not None and hidden_at >= len(stack):
            block = _fold(html.unescape("".join(hidden_buf)))
            hidden_buf.clear()
            hidden_at = None
            if block:
                blocks.append(clean_text(block)[0][:EXCERPT])
                removed.append(block)

    for m in TAG.finditer(markup):
        emit(markup[pos:m.start()])
        pos = m.end()
        closing, name, raw_attrs = m.group(1), m.group(2).lower(), m.group(3)
        if name in BLOCK:
            emit("\n")
        if closing:
            index = next((i for i in range(len(stack) - 1, -1, -1) if stack[i] == name), None)
            if index is not None:
                pop_to(index)
            continue
        if hidden_at is not None:
            hrefs = [m2.group(0) for m2 in URL.finditer(html.unescape(raw_attrs))]
            if hrefs:
                hidden_buf.append(" " + " ".join(hrefs) + " ")
        if name in VOID:
            continue
        if name in IMPLIED_END and stack and stack[-1] == name:
            pop_to(len(stack) - 1)
        stack.append(name)
        if hidden_at is None and _is_hidden(raw_attrs):
            hidden_at = len(stack) - 1
    emit(markup[pos:])
    if hidden_at is not None:
        pop_to(hidden_at)
    return html.unescape("".join(visible)), blocks, "\n".join(removed)


def _instruction_lines(text: str) -> list[str]:
    seen: list[str] = []
    for line in text.splitlines():
        line = line.strip()
        if line and line not in seen and any(p.search(line) for p in INSTRUCTION):
            seen.append(line)
    return [line if len(line) <= 200 else line[:200] + "…" for line in seen]


def guard(raw: str, *, is_html: bool) -> tuple[str, dict[str, Any]]:
    """跑整道闸门。返回 (干净正文, findings)。findings 里有摘录，给 Agent 和用户看；入库用 counts()。"""
    if is_html:
        text, blocks, hidden = clean_html(raw)
    else:
        text, blocks, hidden = raw, [], ""
    text, tf = clean_text(text)
    hidden, hf = clean_text(hidden)
    spelled = tf["invisible_text"] + hf["invisible_text"]
    hidden_all = "\n".join([hidden, *spelled])
    findings = {
        "instruction_like": _instruction_lines(text + "\n" + hidden_all),
        "hidden_blocks": blocks,
        "hidden_urls": list(dict.fromkeys(u for u in URL.findall(hidden_all) if u not in text)),
        "invisible": tf["invisible"] + hf["invisible"],
        "tampered": tf["tampered"] + hf["tampered"],
        "invisible_text": spelled,
    }
    findings["alarm"] = bool(findings["instruction_like"] or findings["tampered"] or spelled)
    return text, findings


def counts(findings: dict[str, Any]) -> dict[str, Any]:
    """入库/日志只存计数，不存第三方文本的摘录。"""
    return {"alarm": findings["alarm"], "instruction_like": len(findings["instruction_like"]),
            "hidden_blocks": len(findings["hidden_blocks"]), "hidden_urls": len(findings["hidden_urls"]),
            "invisible": findings["invisible"], "tampered": findings["tampered"]}


def warning(findings: dict[str, Any]) -> str | None:
    """有可疑信号时给用户的一句话；干净就返回 None。"""
    if not findings["alarm"]:
        return None
    parts = []
    if findings["instruction_like"]:
        parts.append(f"{len(findings['instruction_like'])} 行像是写给 AI 的指令")
    if findings["tampered"] or findings["invisible_text"]:
        parts.append(f"{findings['tampered']} 个夹在字里的不可见字符")
    return "岗位文本里有" + "、".join(parts) + "，已当普通文字处理，没有照做。建议核对岗位来源。"
