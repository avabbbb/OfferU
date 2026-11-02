"""The shared tools. Workbench (HTTP), built-in agent, external agents (MCP / `offeru tool`) all call these, nothing else.

Few and general on purpose: one save / get / list / search / delete / undo over five record types,
plus overview (what to do now) and fetch_page. Agents write directly; every write can be undone.
"""

from __future__ import annotations

import asyncio
import fnmatch
import os
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from app.core import store

JOB_STATUS = {"saved": "想投", "applied": "已投递", "test": "笔试 / 测评", "interview": "面试中",
              "offer": "offer", "rejected": "未通过", "closed": "不投了"}
EVENT_KIND = {"todo": "待办", "deadline": "截止", "test": "笔试 / 测评", "interview": "面试"}
RESUME_TEMPLATE = {"classic": "经典", "clear": "清晰", "kami": "留白", "compact": "紧凑"}
RESUME_FONT = {"sans": "黑体", "serif": "宋体", "kai": "楷体"}
# Old docs carry doc.template; resume.resolve_style reads it as style. Still accepted on save until the editor writes style.
LEGACY_TEMPLATE = {"single": {"template": "clear"}, "compact": {"template": "compact"}, "photo": {"template": "clear", "photo": True}}
STYLE_RANGE = {"bodySize": (8, 14), "lineHeight": (1.0, 2.0), "sectionGap": (0, 30), "itemGap": (0, 20)}
MARGIN_RANGE = (3, 30)
STYLE_KEYS = ("template", "font", *STYLE_RANGE, "margin", "accent", "photo", "logo")
DOC_KIND = {"resume": "简历", "apply_chat": "官网投递对话", "review": "面试复盘", "research": "调研", "note": "笔记"}
MEMORY_KIND = {"experience": "实习 / 工作", "project": "项目", "education": "教育", "skill": "技能",
               "award": "奖项 / 证书", "preference": "偏好", "note": "其他"}
TYPE_LABEL = {"profile": "档案", "memory": "记忆", "job": "岗位", "event": "事项", "doc": "文档"}
MAIL_ACTOR = "邮箱"

FIELDS = {
    "profile": "唯一一份。name, school, major, degree, grad_year, phone, email, city, target（求职方向）, stage（用户自己说的阶段）, about, photo（证件照文件名）",
    "memory": f"职业记忆，一条一件事。kind: {'/'.join(MEMORY_KIND)}; title; body（具体经历、数字、用户原话）; start, end; tags",
    "job": f"岗位和投递状态。company, title, status: {'/'.join(JOB_STATUS)}; url, city, jd, notes, applied_at",
    "event": f"待办和日程。title, kind: {'/'.join(EVENT_KIND)}; at（YYYY-MM-DD 或 YYYY-MM-DDTHH:MM，可空）, done, job_id, notes",
    "doc": f"文档。kind: {'/'.join(DOC_KIND)}; title, body（Markdown）, job_id, style（简历排版，对象，缺的键用模板默认值，更新时传完整对象：template classic 经典（默认）/ clear 清晰 / kami 留白 / compact 紧凑；font sans 黑体 / serif 宋体 / kai 楷体；bodySize 8–14（pt）；lineHeight 1–2；sectionGap 0–30（pt）；itemGap 0–20（pt）；margin {{top, right, bottom, left}} 3–30（mm）；accent #RRGGBB；photo true 用档案证件照；logo 校徽文件名）。简历以 resume 为准（对象：{{basics: {{name, target, contacts: [{{label（电话 / 邮箱 / 城市 / 微信…，可空）, value}}]}}, sections: [{{id, type, title, hidden, items: [{{id, title, subtitle, date, location, bullets: [文字], text}}]}}]}}），body 由它自动生成；也可以只传 body，写法：第一行 # 名字，下一段是联系方式，## 分节，### 学校或公司 | 专业或职位 | 时间（最后一段靠右），- 要点，保存时转成 resume",
}
RecordType = Literal["profile", "memory", "job", "event", "doc"]


def label(record: dict[str, Any]) -> str:
    kind = record.get("type")
    if kind == "job":
        return " · ".join(filter(None, [record.get("company"), record.get("title")])) or f"岗位 #{record['id']}"
    if kind == "profile":
        return record.get("name") or "我的档案"
    if kind == "doc":
        return record.get("title") or DOC_KIND.get(record.get("kind"), "文档")
    return record.get("title") or str(record.get("body") or "")[:30] or f"{TYPE_LABEL[kind]} #{record['id']}"


def _brief(record: dict[str, Any]) -> dict[str, Any]:
    out = {k: v for k, v in record.items() if k not in ("jd", "body", "resume", "messages", "created_at")}
    for key in ("jd", "body"):
        if record.get(key):
            out[key] = str(record[key])[:160] + ("…" if len(str(record[key])) > 160 else "")
    out["label"] = label(record)
    return out


def check_style(style: Any) -> None:
    """doc.style: unknown keys and out-of-range values are errors, never clamped, so an agent sees what went wrong."""
    if not isinstance(style, dict):
        raise ValueError("doc.style 要是对象")
    if unknown := sorted(set(style) - set(STYLE_KEYS)):
        raise ValueError(f"doc.style 没有 {', '.join(unknown)}；可用：{', '.join(STYLE_KEYS)}")

    def number(key: str, value: Any, low: float, high: float) -> None:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
            raise ValueError(f"doc.style.{key} 要在 {low}–{high} 之间")

    for key, value in style.items():
        if value is None:
            continue
        if key == "template" and value not in RESUME_TEMPLATE:
            raise ValueError(f"doc.style.template 只能是 {', '.join(RESUME_TEMPLATE)}")
        if key == "font" and value not in RESUME_FONT:
            raise ValueError(f"doc.style.font 只能是 {', '.join(RESUME_FONT)}")
        if key in STYLE_RANGE:
            number(key, value, *STYLE_RANGE[key])
        if key == "margin":
            if not isinstance(value, dict) or set(value) - {"top", "right", "bottom", "left"}:
                raise ValueError("doc.style.margin 是 {top, right, bottom, left}，单位 mm")
            for side, mm in value.items():
                number(f"margin.{side}", mm, *MARGIN_RANGE)
        if key == "accent" and not (isinstance(value, str) and re.fullmatch(r"#[0-9A-Fa-f]{6}", value)):
            raise ValueError("doc.style.accent 要是 #RRGGBB")
        if key == "photo" and not isinstance(value, bool):
            raise ValueError("doc.style.photo 是 true / false")
        if key == "logo" and not (isinstance(value, str) and value and Path(value).name == value):
            raise ValueError("doc.style.logo 是上传（POST /api/files）返回的文件名")


REVIEW_QUESTION_KEYS = ("question", "answer", "reflection", "reaction")


def check_questions(questions: Any) -> None:
    """doc.questions（面试复盘的题）：数组，每项 {question, answer, reflection, reaction} 都是字符串，更新时整体替换。"""
    if not isinstance(questions, list) or len(questions) > 60:
        raise ValueError("doc.questions 要是数组，最多 60 道题")
    for index, item in enumerate(questions):
        if not isinstance(item, dict) or set(item) - set(REVIEW_QUESTION_KEYS):
            raise ValueError(f"doc.questions[{index}] 只能有 {', '.join(REVIEW_QUESTION_KEYS)}")
        if not all(isinstance(v, str) for v in item.values()):
            raise ValueError(f"doc.questions[{index}] 的值要是字符串")


def _check(type_: str, data: dict[str, Any], creating: bool) -> None:
    def one_of(field: str, allowed: dict) -> None:
        if data.get(field) is not None and data[field] not in allowed:
            raise ValueError(f"{type_}.{field} 只能是 {', '.join(allowed)}")

    if type_ == "job":
        one_of("status", JOB_STATUS)
        if creating and not (data.get("company") or data.get("title")):
            raise ValueError("岗位至少要有 company 或 title")
    elif type_ == "event":
        one_of("kind", EVENT_KIND)
        if creating and not data.get("title"):
            raise ValueError("事项要有 title")
        if data.get("at"):
            datetime.fromisoformat(str(data["at"]))
    elif type_ == "doc":
        one_of("kind", DOC_KIND)
        one_of("template", LEGACY_TEMPLATE)
        if data.get("style") is not None:
            check_style(data["style"])
        if data.get("questions") is not None:
            check_questions(data["questions"])
        if creating and not data.get("kind"):
            raise ValueError("文档要有 kind")
    elif type_ == "memory":
        one_of("kind", MEMORY_KIND)
        if creating and not (data.get("title") or data.get("body")):
            raise ValueError("记忆要有 title 或 body")
    if data.get("job_id") is not None and store.get("job", int(data["job_id"])) is None:
        raise ValueError(f"岗位 #{data['job_id']} 不存在")


def _with_resume(data: dict[str, Any], id_: Optional[int]) -> dict[str, Any]:
    """简历以 doc.resume 为准，body 从它派生；只给 body（agent / 旧代码）的简历就解析成 resume。"""
    from app.core import resume_model

    if data.get("resume") is not None:
        resume = resume_model.normalize(data["resume"])
    else:
        kind = data.get("kind") or ((store.get("doc", id_) or {}).get("kind") if id_ else None)
        if data.get("body") is None or kind != "resume":
            return data
        resume = resume_model.from_markdown(str(data["body"]))
    return dict(data, resume=resume, body=resume_model.to_markdown(resume))


# ---------- tools ----------

class _In(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SaveIn(_In):
    type: RecordType
    data: dict[str, Any] = Field(description="要写的字段；更新时只传要改的，传 null 删除该字段")
    id: Optional[int] = Field(None, description="不传就新建；profile 不用传")


def save(type: str, data: dict[str, Any], id: Optional[int] = None, *, actor: str) -> dict[str, Any]:
    if type == "profile" and id is None and (existing := store.first("profile")):
        id = existing["id"]
    _check(type, data, creating=id is None)
    if type == "doc":
        data = _with_resume(data, id)
    if type == "event" and data.get("done") is True and id is not None:
        verb = "完成"
    else:
        verb = "新建" if id is None else "更新"
    status_note = ""
    if type == "job" and id is not None and data.get("status"):
        status_note = f"：{JOB_STATUS[data['status']]}"
        if data["status"] == "applied" and not data.get("applied_at"):
            data = {**data, "applied_at": date.today().isoformat()}
    if type == "job" and id is None:
        data = {"status": "saved", **data}
    preview = {**(store.get(type, id) or {} if id else {}), **data, "type": type, "id": id or 0}
    record, change = store.save(type, data, id_=id, actor=actor, summary=f"{verb}{TYPE_LABEL[type]}「{label(preview)}」{status_note}")
    return {"record": record, "change_id": change}


class GetIn(_In):
    type: RecordType
    id: Optional[int] = Field(None, description="profile 不用传")


def get(type: str, id: Optional[int] = None, *, actor: str = "") -> dict[str, Any]:
    record = store.first("profile") if type == "profile" else store.get(type, int(id or 0))
    if record is None:
        if type == "profile":
            return {"record": None}
        raise ValueError(f"{type} #{id} 不存在")
    out: dict[str, Any] = {"record": record}
    if type == "job":
        out["events"] = [_brief(e) for e in store.all_of("event", job_id=record["id"])]
        out["docs"] = [_brief(d) for d in store.all_of("doc", job_id=record["id"])]
    return out


class ListIn(_In):
    type: RecordType
    status: Optional[str] = Field(None, description="岗位状态")
    kind: Optional[str] = None
    job_id: Optional[int] = None
    done: Optional[bool] = Field(None, description="事项是否完成")
    full: bool = Field(False, description="返回全文，不截断")
    limit: int = Field(50, ge=1, le=500)


def list_(type: str, status: Optional[str] = None, kind: Optional[str] = None, job_id: Optional[int] = None,
          done: Optional[bool] = None, full: bool = False, limit: int = 50, *, actor: str = "") -> dict[str, Any]:
    items = store.all_of(type, job_id=job_id)
    if status:
        items = [i for i in items if i.get("status") == status]
    if kind:
        items = [i for i in items if i.get("kind") == kind]
    if done is not None:
        items = [i for i in items if bool(i.get("done")) == done]
    if type == "event":
        items.sort(key=lambda e: (bool(e.get("done")), e.get("at") or "9999"))
    return {"total": len(items), "items": [{**i, "label": label(i)} if full else _brief(i) for i in items[:limit]]}


class SearchIn(_In):
    query: str = Field(min_length=1, description="关键词，空格分开")
    types: Optional[list[RecordType]] = None
    limit: int = Field(20, ge=1, le=100)


def search(query: str, types: Optional[list[str]] = None, limit: int = 20, *, actor: str = "") -> dict[str, Any]:
    terms = [t.lower() for t in query.split() if t]
    hits = []
    for type_ in types or store.TYPES:
        for record in store.all_of(type_):
            raw = " ".join(str(v) for k, v in store._plain(record).items() if k != "job_id" and v not in (None, ""))
            text = raw.lower()
            score = sum(text.count(t) for t in terms)
            if score:
                at = max(0, text.find(terms[0]))
                snippet = raw[max(0, at - 40): at + 80]
                hits.append((score, {"type": type_, "id": record["id"], "label": label(record), "snippet": snippet}))
    hits.sort(key=lambda h: -h[0])
    return {"items": [h for _, h in hits[:limit]]}


class DeleteIn(_In):
    type: RecordType
    id: int


def delete(type: str, id: int, *, actor: str) -> dict[str, Any]:
    record = store.get(type, id)
    if record is None:
        raise ValueError(f"{type} #{id} 不存在")
    return {"change_id": store.delete(type, id, actor=actor, summary=f"删除{TYPE_LABEL[type]}「{label(record)}」")}


class UndoIn(_In):
    change_id: int


def undo(change_id: int, *, actor: str) -> dict[str, Any]:
    return store.undo(change_id, actor=actor)


class ChangesIn(_In):
    limit: int = Field(20, ge=1, le=200)


def changes(limit: int = 20, *, actor: str = "") -> dict[str, Any]:
    return {"items": store.changes(limit)}


class FetchIn(_In):
    url: str


def fetch_page(url: str, *, actor: str = "") -> dict[str, Any]:
    """Plain GET of a public page (e.g. a job posting) as text. Pages that need login or JavaScript come back thin."""
    import html
    import urllib.request

    if not re.match(r"^https?://", url):
        raise ValueError("只支持 http/https 链接")
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 OfferU"})
    with urllib.request.urlopen(request, timeout=15) as response:
        raw = response.read(3_000_000).decode(response.headers.get_content_charset() or "utf-8", "replace")
    title = html.unescape((re.search(r"<title[^>]*>(.*?)</title>", raw, re.S | re.I) or [None, ""])[1]).strip()
    text = re.sub(r"<(script|style|noscript)[^>]*>.*?</\1>", " ", raw, flags=re.S | re.I)
    text = html.unescape(re.sub(r"<[^>]+>", "\n", text))
    text = "\n".join(line.strip() for line in text.splitlines() if line.strip())
    return {"url": url, "title": title, "text": text[:20_000], "truncated": len(text) > 20_000}


class OverviewIn(_In):
    pass


def _mail_today(today: date) -> dict[str, Any]:
    """邮箱同步的每日进度：今天邮箱写了几条改动、最后一条是什么时候。"""
    count, last = store.conn().execute(
        "SELECT COUNT(id), MAX(at) FROM changes WHERE actor = ? AND at >= ?", (MAIL_ACTOR, today.isoformat())).fetchone()
    return {"today_changes": count, "last_change_at": last}


def overview(*, actor: str = "", today: Optional[date] = None) -> dict[str, Any]:
    """现在在哪个阶段、下一步做什么、待办（逾期 / 今天 / 7 天内 / 以后 / 没定时间）、最近改动。"""
    today = today or date.today()
    jobs = store.all_of("job")
    events = [e for e in store.all_of("event") if not e.get("done")]
    jobs_by_id = {j["id"]: j for j in jobs}
    for event in events:
        if event.get("job_id") in jobs_by_id:
            event["job_label"] = label(jobs_by_id[event["job_id"]])
    events.sort(key=lambda e: e.get("at") or "9999")

    def day(e: dict) -> Optional[date]:
        return datetime.fromisoformat(e["at"]).date() if e.get("at") else None

    todos = {"overdue": [], "today": [], "week": [], "later": [], "undated": []}
    for e in events:
        d = day(e)
        bucket = ("undated" if d is None else "overdue" if d < today else "today" if d == today
                  else "week" if d <= today + timedelta(days=7) else "later")
        todos[bucket].append(_brief(e))

    statuses = {s: [j for j in jobs if j.get("status") == s] for s in JOB_STATUS}
    profile = store.first("profile") or {}
    inferred = next((stage for stage, s in (("offer", "offer"), ("interviewing", "interview"), ("testing", "test"),
                                            ("applying", "applied")) if statuses[s]), "preparing" if jobs else "not_started")
    soon = [e for e in todos["today"] + todos["week"] if e.get("kind") in ("test", "interview", "deadline")
            and day(e) <= today + timedelta(days=2)]
    stale = [j for j in statuses["applied"] if (j.get("updated_at") or "")[:10] <= (today - timedelta(days=7)).isoformat()]
    if todos["overdue"]:
        e = todos["overdue"][0]
        step = {"title": f"处理逾期的「{e['label']}」", "why": f"原定 {e['at']}", "link": "/"}
    elif soon:
        e = soon[0]
        step = {"title": f"准备「{e['label']}」", "why": f"{EVENT_KIND[e['kind']]}在 {e['at'].replace('T', ' ')}",
                "link": f"/jobs/{e['job_id']}" if e.get("job_id") else "/"}
    elif not profile.get("name"):
        step = {"title": "先建档案", "why": "填好基本信息和经历，简历和网申都从这里取", "link": "/profile"}
    elif not any(d.get("kind") == "resume" for d in store.all_of("doc")):
        step = {"title": "写一份简历", "why": "从档案生成一份，再按岗位改", "link": "/resume"}
    elif not jobs:
        step = {"title": "存几个想投的岗位", "why": "还没有岗位，OfferU 没法帮你安排", "link": "/jobs"}
    elif statuses["saved"]:
        j = statuses["saved"][-1]
        step = {"title": f"投递「{label(j)}」", "why": f"还有 {len(statuses['saved'])} 个岗位没投", "link": f"/jobs/{j['id']}"}
    elif stale:
        j = stale[0]
        step = {"title": f"跟进「{label(j)}」", "why": "投递超过 7 天没有进展", "link": f"/jobs/{j['id']}"}
    else:
        step = {"title": "今天没有急事", "why": "可以再找几个岗位，或者准备面试", "link": "/jobs"}
    return {
        "today": today.isoformat(),
        "stage": profile.get("stage") or inferred,
        "next_step": step,
        "todos": todos,
        "jobs": {s: len(v) for s, v in statuses.items()},
        "recent_changes": store.changes(5),
        "mail": _mail_today(today),
    }


class ReadFileIn(_In):
    path: str = Field(description="本机文件的绝对路径，或用户上传后拿到的文件名")


def read_file(path: str, *, actor: str = "") -> dict[str, Any]:
    """Text out of a PDF / Word / txt / md file, e.g. an old resume to split into memories."""
    file = Path(path).expanduser()
    if not file.is_absolute():
        file = store.data_dir("files") / Path(path).name
    if not file.is_file():
        raise ValueError(f"找不到文件 {path}")
    suffix = file.suffix.lower()
    if suffix == ".pdf":
        import fitz

        with fitz.open(file) as pdf:
            text = "\n".join(page.get_text() for page in pdf)
    elif suffix == ".docx":
        import docx

        document = docx.Document(str(file))
        text = "\n".join(p.text for p in document.paragraphs)
        text += "".join("\n" + " | ".join(c.text for c in row.cells) for t in document.tables for row in t.rows)
    elif suffix in (".txt", ".md", ".markdown"):
        text = file.read_text(encoding="utf-8", errors="replace")
    else:
        raise ValueError("只支持 PDF、Word（.docx）、txt 和 md")
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return {"path": str(file), "text": text[:30_000], "truncated": len(text) > 30_000}


DOC_SUFFIXES = (".pdf", ".docx", ".txt", ".md", ".markdown")
_WALK_DEPTH = 3
_GREP_MAX_FILES = 300


def _local_dir(dir: str) -> Path:
    folder = Path(dir).expanduser()
    if not folder.is_absolute():
        raise ValueError("dir 要是本机目录的绝对路径，比如 H:\\学习\\留档")
    if not folder.is_dir():
        raise ValueError(f"找不到目录 {dir}")
    return folder


def _walk(folder: Path, pattern: str, recursive: bool, docs_only: bool):
    """Files under folder matching pattern; hidden dirs skipped, unreadable dirs ignored, at most _WALK_DEPTH levels."""
    max_depth = _WALK_DEPTH if recursive else 0
    pattern = (pattern or "*").lower()
    for root, dirs, files in os.walk(folder):
        depth = len(Path(root).relative_to(folder).parts)
        dirs[:] = [d for d in dirs if not d.startswith(".")] if depth < max_depth else []
        for name in files:
            if not fnmatch.fnmatch(name.lower(), pattern):
                continue
            if docs_only and Path(name).suffix.lower() not in DOC_SUFFIXES:
                continue
            yield Path(root) / name


class FindFilesIn(_In):
    dir: str = Field(description="本机目录的绝对路径。用户说「H 盘 学习 留档」就是 H:/学习/留档")
    query: str = Field("", description="要找的文字，空格分开的词都要出现在文件名或正文里；不填就只列文件")
    pattern: str = Field("*", description="文件名通配，比如 *简历*；默认全部")
    recursive: bool | None = Field(None, description="是否进子目录（最多 3 层）；不填时有 query 就进，没有就不进")
    docs_only: bool = Field(True, description="只列 read_file 能读的 PDF / Word / txt / md；有 query 时总是只看这些")
    limit: int = Field(50, ge=1, le=200)


def find_files(dir: str, query: str = "", pattern: str = "*", recursive: bool | None = None,
               docs_only: bool = True, limit: int = 50, *, actor: str = "") -> dict[str, Any]:
    """List a local folder newest first; with query, keep files whose name or text has every term."""
    folder = _local_dir(dir)
    terms = [t.lower() for t in query.split() if t]
    if recursive is None:
        recursive = bool(terms)
    items: list[dict[str, Any]] = []
    scanned = 0
    for file in _walk(folder, pattern, recursive, docs_only or bool(terms)):
        try:
            stat = file.stat()
        except OSError:
            continue
        item = {"path": str(file), "name": file.name, "size": stat.st_size,
                "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="minutes")}
        if terms:
            if scanned >= _GREP_MAX_FILES:
                break
            scanned += 1
            try:
                text = read_file(str(file))["text"]
            except Exception:
                continue
            if not all(t in (file.name + " " + text).lower() for t in terms):
                continue
            at = max(0, text.lower().find(terms[0]))
            item["snippet"] = text[max(0, at - 60): at + 120]
        items.append(item)
    items.sort(key=lambda i: i["modified"], reverse=True)
    try:
        subdirs = sorted(p.name for p in folder.iterdir() if p.is_dir() and not p.name.startswith("."))
    except OSError:
        subdirs = []
    out = {"dir": str(folder), "total": len(items), "items": items[:limit],
           "truncated": len(items) > limit or scanned >= _GREP_MAX_FILES, "dirs": subdirs[:50]}
    if terms:
        out["scanned"] = scanned
    return out


class WebSearchIn(_In):
    query: str = Field(min_length=1)
    limit: int = Field(8, ge=1, le=20)


def web_search(query: str, limit: int = 8, *, actor: str = "") -> dict[str, Any]:
    from app.config import get_settings
    from app.services import web_search as service

    settings = get_settings()
    if not (settings.bocha_api_key or settings.tavily_api_key or settings.serper_api_key or service._ddgs_available()):
        raise ValueError("没配搜索服务：在设置里填 Bocha / Tavily / Serper 的 key（或装 ddgs）后才能搜网页")
    return {"query": query, "items": _await(lambda: service.web_search(query, limit=limit))}


class ExportIn(_In):
    id: int = Field(description="简历 doc 的 id")


def export_resume_pdf(id: int, *, actor: str = "") -> dict[str, Any]:
    from app.core import resume

    doc = store.get("doc", id)
    if doc is None or doc.get("kind") != "resume":
        raise ValueError(f"简历 #{id} 不存在")
    out = store.data_dir("exports") / resume.file_name(doc)
    out.write_bytes(resume.pdf_bytes(resume.doc_html(doc)))
    return {"path": str(out)}


MAIN_LOOP: Optional[asyncio.AbstractEventLoop] = None  # main.py 启动时设置；工具在线程里跑，异步的旧服务投递回主循环


def _await(factory: Callable[[], Any]) -> Any:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        pass
    else:
        raise RuntimeError("事件循环线程里不能同步等异步任务，用 asyncio.to_thread(tools.call, ...)")
    loop = MAIN_LOOP
    if loop is not None and loop.is_running():
        return asyncio.run_coroutine_threadsafe(factory(), loop).result(timeout=600)
    return asyncio.run(factory())


class EmailSyncIn(_In):
    action: Literal["status", "sync"] = Field("status", description="status 看已连邮箱和最近同步；sync 立刻拉一次新邮件并回写")
    account: Optional[str] = Field(None, description="只看 / 只同步这个账号（account_id），不传就是全部")


def email_sync(action: str = "status", account: Optional[str] = None, actor: str = "") -> dict[str, Any]:
    from app.services import email_sync as service

    if action == "sync":
        result = _await(lambda: service.sync_email_notifications(account_id=account))
        runs = result["runs"] if "runs" in result else [result]
        return {"accounts": len(runs), "found": sum(int(r.get("total_found") or 0) for r in runs),
                "new": sum(int(r.get("synced") or 0) for r in runs),
                "changes": [c for r in runs for c in r.get("core_change_ids") or []],
                "failed_accounts": int(result.get("failed_accounts") or 0)}
    accounts = _await(lambda: service.list_email_accounts(status="active", limit=50))["items"]
    runs = _await(lambda: service.list_email_sync_runs(account_id=account, limit=5))["items"]
    keep = ("account_id", "provider", "email_address", "last_synced_at", "last_error")
    return {
        "accounts": [{k: a.get(k) for k in keep} for a in accounts if not account or a["account_id"] == account],
        "recent_runs": [{"status": r["status"], "completed_at": r["completed_at"], "error": r["error"],
                         "found": r["result"].get("total_found"), "changes": len(r["result"].get("core_change_ids") or [])}
                        for r in runs],
        "today": _mail_today(date.today()),
    }


class TailorIn(_In):
    id: int = Field(description="简历 doc 的 id（kind=resume）")
    job_id: Optional[int] = Field(None, description="按哪个岗位改；不传就用简历上关联的岗位（岗位要有 JD）")


def tailor_resume(id: int, job_id: Optional[int] = None, actor: str = "") -> dict[str, Any]:
    from app.core import tailor

    async def collect() -> dict[str, Any]:
        last: dict[str, Any] = {}
        async for event in tailor.run(id, job_id, actor=actor or "Agent"):
            if event["type"] in ("done", "error"):
                last = event
        return last

    event = _await(collect)
    if event.get("type") != "done":
        raise ValueError(event.get("message") or "改写没完成，简历没动")
    return {"doc_id": id, "change_id": event["change_id"], "body": event["body"]}


class SplitResumeIn(_In):
    text: Optional[str] = Field(None, description="简历原文；和 path 二选一")
    path: Optional[str] = Field(None, description="本机文件的绝对路径，或用户上传后拿到的文件名")


def split_resume(text: Optional[str] = None, path: Optional[str] = None, *, actor: str) -> dict[str, Any]:
    from app.core import resume_split

    if not (text or "").strip() and path:
        text = read_file(path)["text"]
    if not (text or "").strip():
        raise ValueError("要给简历原文 text 或文件 path")
    if not resume_split.available():
        raise ValueError("没配模型，也没开「没配模型时交给本机 Agent」，没法自动拆")
    items = _await(lambda: resume_split.extract(text or ""))
    if not items:
        raise ValueError("没从原文里拆出经历，档案没动")
    saved = [save("memory", item, actor=actor) for item in items]
    return {
        "count": len(saved),
        "change_ids": [s["change_id"] for s in saved],
        "items": [{"id": s["record"]["id"], "kind": s["record"].get("kind"), "title": s["record"].get("title")} for s in saved],
    }


# ---------- registry ----------

class Tool(BaseModel):
    name: str
    description: str
    input: type[BaseModel]
    fn: Callable[..., Any]
    model_config = ConfigDict(arbitrary_types_allowed=True)


TOOLS: dict[str, Tool] = {t.name: t for t in [
    Tool(name="overview", input=OverviewIn, fn=overview,
         description="先调这个。用户现在的求职阶段、下一步、待办（逾期/今天/7天内/以后/没定时间）、各状态岗位数、最近改动。"),
    Tool(name="search", input=SearchIn, fn=search,
         description="按关键词搜所有记录（档案、职业记忆、岗位、事项、文档），返回 type、id、摘要。找用户的经历和说过的话先用它。"),
    Tool(name="list", input=ListIn, fn=list_, description="列出某类记录（长文本会截断，要全文用 get）。" + " ".join(f"{k}: {v}。" for k, v in FIELDS.items())),
    Tool(name="get", input=GetIn, fn=get, description="读一条完整记录。读岗位时连带它的事项和文档。"),
    Tool(name="save", input=SaveIn, fn=save,
         description="新建或更新一条记录，直接生效，用户可以在「最近改动」里撤销。" + " ".join(f"{k}: {v}。" for k, v in FIELDS.items())
         + " 用户说了新的经历、偏好、截止时间，直接存。"),
    Tool(name="delete", input=DeleteIn, fn=delete, description="删除一条记录（可撤销）。"),
    Tool(name="undo", input=UndoIn, fn=undo, description="撤销一条改动，把记录恢复到改动之前。"),
    Tool(name="changes", input=ChangesIn, fn=changes, description="最近改动，谁改了什么，最新在前。"),
    Tool(name="read_file", input=ReadFileIn, fn=read_file,
         description="读本机 PDF / Word / txt / md 文件的文字，比如用户的旧简历。读完把经历拆成一条条 memory 存进档案。"),
    Tool(name="find_files", input=FindFilesIn, fn=find_files,
         description="找本机文件：列目录（默认只看 PDF / Word / txt / md，新改的在前，另给子目录名）；给 query 时按文件名或正文里的文字筛，带片段。"
                     "用户说「H 盘 学习 留档」这类位置时，自己拼成绝对路径（H:/学习/留档）先找，挑出像简历的再 read_file，不要让用户报完整路径。"),
    Tool(name="web_search", input=WebSearchIn, fn=web_search,
         description="搜公开网页，返回标题、链接、摘要；要正文再用 fetch_page。没配搜索服务会报错，照实告诉用户。"),
    Tool(name="export_resume_pdf", input=ExportIn, fn=export_resume_pdf,
         description="把一份简历（doc kind=resume）按它的排版（style）导出成 PDF，和工作台预览是同一份 HTML，返回文件路径。"),
    Tool(name="fetch_page", input=FetchIn, fn=fetch_page, description="抓取一个公开网页的文字（比如岗位详情页链接），需要登录或 JS 的页面可能拿不到内容。"),
    Tool(name="email_sync", input=EmailSyncIn, fn=email_sync,
         description="邮箱同步。status：已连的邮箱、最近几次同步、今天邮箱写了几条改动；sync：立刻拉一次新邮件，识别投递回执、笔试、面试、offer、拒信，"
                     "直接改岗位状态（只前进）并把笔试面试时间写成事项，返回写了哪些改动（都能撤销）。连邮箱和断开在设置页。"),
    Tool(name="tailor_resume", input=TailorIn, fn=tailor_resume,
         description="按岗位 JD 改写一份简历：只用档案和记忆里的事实，写完直接覆盖这份简历（一条改动，可撤销），返回新正文。"
                     "要保留原版就先 save 一份副本再改副本。会调模型，要一两分钟。"),
    Tool(name="split_resume", input=SplitResumeIn, fn=split_resume,
         description="把一份旧简历（原文 text 或文件 path）拆成一条条 memory 直接存进档案，只整理不编造；每条一条改动，返回 change_ids 可逐条撤销。"
                     "会调模型，要一两分钟。你自己能拆就用 read_file + save。"),
]}


def call(name: str, args: Optional[dict[str, Any]], *, actor: str) -> dict[str, Any]:
    tool = TOOLS.get(name)
    if tool is None:
        raise ValueError(f"没有工具 {name}，可用：{', '.join(TOOLS)}")
    parsed = tool.input.model_validate(args or {})
    return tool.fn(**parsed.model_dump(exclude_unset=True), actor=actor)
