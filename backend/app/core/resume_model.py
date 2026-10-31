"""结构化简历：doc.resume 是事实来源，doc.body（Markdown）由它派生，给 agent、搜索和旧代码读。

Resume  = {version: 1, basics: {name, target, contacts: [str]}, sections: [Section]}
Section = {id, type, title, hidden, items: [Item]}
Item    = {id, title, subtitle, date, location, bullets: [str], text}

Markdown 写法（agent 和模型只写这个，保存时转成结构）：
  # 名字
  电话 · 邮箱 · 城市            名字后第一段 = 联系方式
  求职意向：产品经理            可选
  ## 教育经历                   节
  ### 学校 | 专业 | 2021.09 – 2025.06    最后一段是时间；4 段时第 3 段是城市
  - 要点                        行内只认 **加粗**
  其他段落                      条目正文（自我评价、技能）
"""

from __future__ import annotations

import re
import secrets
from typing import Any

SECTION_TYPES = ("education", "work", "internship", "project", "campus", "skills", "awards", "summary", "custom")
# 按顺序匹配：「实习工作经历」算实习。
_TYPE_WORDS = (
    ("education", ("教育", "学历")),
    ("internship", ("实习",)),
    ("work", ("工作", "职业经历", "任职")),
    ("project", ("项目",)),
    ("campus", ("校园", "社团", "学生", "社会实践", "志愿")),
    ("skills", ("技能", "证书", "语言能力")),
    ("awards", ("荣誉", "获奖", "奖项", "奖励")),
    ("summary", ("评价", "总结", "简介", "关于我", "个人优势")),
)
TARGET_PREFIX = "求职意向："
_TARGET_RE = re.compile(r"^(?:求职意向|意向岗位|求职方向)\s*[：:]\s*")
_CONTACT_SPLIT = re.compile(r"\s*(?:·|\||｜)\s*")
_ROW_SPLIT = re.compile(r"\s*(?:\||｜)\s*")
_BULLET = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+")


def new_id() -> str:
    return secrets.token_hex(4)


def section_type(title: str) -> str:
    for type_, words in _TYPE_WORDS:
        if any(word in title for word in words):
            return type_
    return "custom"


def _text(value: Any, where: str) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list, bool)):
        raise ValueError(f"doc.resume.{where} 要是文字")
    return str(value)


def _list(value: Any, where: str) -> list:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError(f"doc.resume.{where} 要是数组")
    return value


def _id(value: Any) -> str:
    return value if isinstance(value, str) and value.strip() else new_id()


def empty_item() -> dict[str, Any]:
    return {"id": new_id(), "title": "", "subtitle": "", "date": "", "location": "", "bullets": [], "text": ""}


def normalize(resume: Any) -> dict[str, Any]:
    """缺的字段补空值、id 补齐、type 不认识就算 custom；类型不对直接报错（不静默丢）。不 strip，免得编辑中光标跳。"""
    if not isinstance(resume, dict):
        raise ValueError("doc.resume 要是对象：{basics, sections}")
    basics = resume.get("basics") or {}
    if not isinstance(basics, dict):
        raise ValueError("doc.resume.basics 要是对象：{name, target, contacts}")
    sections = []
    for i, sec in enumerate(_list(resume.get("sections"), "sections")):
        if not isinstance(sec, dict):
            raise ValueError(f"doc.resume.sections[{i}] 要是对象")
        title = _text(sec.get("title"), f"sections[{i}].title")
        items = []
        for j, item in enumerate(_list(sec.get("items"), f"sections[{i}].items")):
            if not isinstance(item, dict):
                raise ValueError(f"doc.resume.sections[{i}].items[{j}] 要是对象")
            where = f"sections[{i}].items[{j}]"
            items.append({
                "id": _id(item.get("id")),
                **{key: _text(item.get(key), f"{where}.{key}") for key in ("title", "subtitle", "date", "location")},
                "bullets": [_text(b, f"{where}.bullets") for b in _list(item.get("bullets"), f"{where}.bullets")],
                "text": _text(item.get("text"), f"{where}.text"),
            })
        type_ = sec.get("type") if sec.get("type") in SECTION_TYPES else section_type(title)
        sections.append({"id": _id(sec.get("id")), "type": type_, "title": title, "hidden": bool(sec.get("hidden")),
                         "items": items})
    return {
        "version": 1,
        "basics": {
            "name": _text(basics.get("name"), "basics.name"),
            "target": _text(basics.get("target"), "basics.target"),
            "contacts": [_text(c, "basics.contacts") for c in _list(basics.get("contacts"), "basics.contacts")],
        },
        "sections": sections,
    }


def _row(heading: str) -> dict[str, Any]:
    """### 标题 | 副标题 | (城市 |) 时间 → item 头。只有一段就是标题。"""
    parts = _ROW_SPLIT.split(heading.strip())
    item = empty_item()
    item["title"] = parts[0]
    if len(parts) > 1:
        item["date"] = parts[-1]
        middle = parts[1:-1]
        if len(middle) == 1:
            item["subtitle"] = middle[0]
        elif middle:
            item["subtitle"] = " · ".join(p for p in middle[:-1] if p)
            item["location"] = middle[-1]
    return item


def from_markdown(body: str) -> dict[str, Any]:
    """旧数据、agent、模型给的 Markdown → Resume。认不出来的行都当正文，不丢字。"""
    name, target, contacts = "", "", []
    sections: list[dict[str, Any]] = []
    section: dict[str, Any] | None = None
    item: dict[str, Any] | None = None
    para: list[str] = []
    seen_name = False

    def current_item() -> dict[str, Any]:
        nonlocal item, section
        if section is None:
            section = {"id": new_id(), "type": "custom", "title": "", "hidden": False, "items": []}
            sections.append(section)
        if item is None:
            item = empty_item()
            section["items"].append(item)
        return item

    def flush() -> None:
        nonlocal target, contacts
        if not para:
            return
        text = "\n".join(para)
        para.clear()
        if section is None:
            if _TARGET_RE.match(text):
                target = _TARGET_RE.sub("", text).strip()
            elif not contacts:
                contacts = [c for line in text.split("\n") for c in _CONTACT_SPLIT.split(line) if c]
            else:
                target = target or text
            return
        it = current_item()
        it["text"] = (it["text"] + "\n" + text).strip("\n")

    for raw in (body or "").splitlines():
        line = raw.rstrip()
        if line.strip() in ("", "&nbsp;"):
            flush()
            continue
        if line.startswith("# ") and not seen_name and section is None:
            flush()
            name, seen_name = line[2:].strip(), True
        elif line.startswith("## ") or line.startswith("# "):
            flush()
            title = line.lstrip("#").strip()
            section = {"id": new_id(), "type": section_type(title), "title": title, "hidden": False, "items": []}
            sections.append(section)
            item = None
        elif line.startswith("### "):
            flush()
            item = _row(line[4:])
            current_item()  # 没有 ## 时挂到一个无标题节
            if item not in section["items"]:
                section["items"].append(item)
        elif _BULLET.match(line):
            flush()
            current_item()["bullets"].append(_BULLET.sub("", line).strip())
        elif raw[:1] in (" ", "\t") and item is not None and item["bullets"] and not para:
            item["bullets"][-1] += " " + line.strip()  # 要点的续行
        else:
            para.append(line.strip())
    flush()
    return normalize({"basics": {"name": name, "target": target, "contacts": contacts}, "sections": sections})


def _one_line(text: str) -> str:
    return " ".join(text.split())


def to_markdown(resume: dict[str, Any]) -> str:
    """Resume → Markdown（隐藏的节不写，body 就是简历上看得到的内容）。from_markdown 能原样读回来。"""
    resume = normalize(resume)
    basics = resume["basics"]
    out = [f"# {_one_line(basics['name'])}".rstrip()]
    contacts = [_one_line(c) for c in basics["contacts"] if c.strip()]
    if contacts:
        out += ["", " · ".join(contacts)]
    if basics["target"].strip():
        out += ["", TARGET_PREFIX + _one_line(basics["target"])]
    for sec in resume["sections"]:
        if sec["hidden"]:
            continue
        out += ["", f"## {_one_line(sec['title']) or '未命名'}"]
        for it in sec["items"]:
            title, subtitle, location, date = (_one_line(it[k]) for k in ("title", "subtitle", "location", "date"))
            if subtitle or location or date:
                middle = [subtitle, location] if location else ([subtitle] if subtitle else [])
                out += ["", "### " + " | ".join([title, *middle, date])]
            elif title:
                out += ["", f"### {title}"]
            text = "\n".join(line.strip() for line in it["text"].split("\n") if line.strip())
            if text:
                out += ["", text]
            bullets = [_one_line(b) for b in it["bullets"] if b.strip()]
            if bullets:
                out += [""] + [f"- {b}" for b in bullets]
    return "\n".join(out).strip() + "\n"


def resume_of(doc: dict[str, Any]) -> dict[str, Any]:
    """读简历：有 doc.resume 用它，旧 doc 只有 body 就从 Markdown 解析（不写库）。"""
    if isinstance(doc.get("resume"), dict):
        return normalize(doc["resume"])
    return from_markdown(str(doc.get("body") or ""))


def is_filled(resume: dict[str, Any]) -> bool:
    """至少有名字和一个有内容的节，才算一份简历（tailor 用来挡住模型的胡话）。"""
    return bool(resume["basics"]["name"].strip()) and any(
        any(it["title"].strip() or it["text"].strip() or any(b.strip() for b in it["bullets"]) for it in sec["items"])
        for sec in resume["sections"])
