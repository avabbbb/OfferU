"""The shared tools. Workbench (HTTP), built-in agent, external agents (MCP / `offeru tool`) all call these, nothing else.

Few and general on purpose: one save / get / list / search / delete / undo over five record types,
plus overview (what to do now) and fetch_page. Agents write directly; every write can be undone.
"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from app.core import store

JOB_STATUS = {"saved": "想投", "applied": "已投递", "test": "笔试 / 测评", "interview": "面试中",
              "offer": "offer", "rejected": "未通过", "closed": "不投了"}
EVENT_KIND = {"todo": "待办", "deadline": "截止", "test": "笔试 / 测评", "interview": "面试"}
RESUME_TEMPLATE = {"single": "单栏", "compact": "紧凑", "photo": "带照片"}
DOC_KIND = {"resume": "简历", "apply_chat": "官网投递对话", "review": "面试复盘", "research": "调研", "note": "笔记"}
MEMORY_KIND = {"experience": "实习 / 工作", "project": "项目", "education": "教育", "skill": "技能",
               "award": "奖项 / 证书", "preference": "偏好", "note": "其他"}
TYPE_LABEL = {"profile": "档案", "memory": "记忆", "job": "岗位", "event": "事项", "doc": "文档"}

FIELDS = {
    "profile": "唯一一份。name, school, major, degree, grad_year, phone, email, city, target（求职方向）, stage（用户自己说的阶段）, about, photo（证件照文件名）",
    "memory": f"职业记忆，一条一件事。kind: {'/'.join(MEMORY_KIND)}; title; body（具体经历、数字、用户原话）; start, end; tags",
    "job": f"岗位和投递状态。company, title, status: {'/'.join(JOB_STATUS)}; url, city, jd, notes, applied_at",
    "event": f"待办和日程。title, kind: {'/'.join(EVENT_KIND)}; at（YYYY-MM-DD 或 YYYY-MM-DDTHH:MM，可空）, done, job_id, notes",
    "doc": f"文档。kind: {'/'.join(DOC_KIND)}; title, body（Markdown）, job_id, template（简历模板：single 单栏 / compact 紧凑 / photo 带照片）。简历 body 的写法：第一行 # 名字，下一段是联系方式，## 分节，### 学校或公司 | 专业或职位 | 时间（最后一段靠右），- 要点",
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
    out = {k: v for k, v in record.items() if k not in ("jd", "body", "messages", "created_at")}
    for key in ("jd", "body"):
        if record.get(key):
            out[key] = str(record[key])[:160] + ("…" if len(str(record[key])) > 160 else "")
    out["label"] = label(record)
    return out


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
        one_of("template", RESUME_TEMPLATE)
        if creating and not data.get("kind"):
            raise ValueError("文档要有 kind")
    elif type_ == "memory":
        one_of("kind", MEMORY_KIND)
        if creating and not (data.get("title") or data.get("body")):
            raise ValueError("记忆要有 title 或 body")
    if data.get("job_id") is not None and store.get("job", int(data["job_id"])) is None:
        raise ValueError(f"岗位 #{data['job_id']} 不存在")


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
    Tool(name="export_resume_pdf", input=ExportIn, fn=export_resume_pdf,
         description="把一份简历（doc kind=resume）按它的模板导出成 PDF，返回文件路径。"),
    Tool(name="fetch_page", input=FetchIn, fn=fetch_page, description="抓取一个公开网页的文字（比如岗位详情页链接），需要登录或 JS 的页面可能拿不到内容。"),
]}


def call(name: str, args: Optional[dict[str, Any]], *, actor: str) -> dict[str, Any]:
    tool = TOOLS.get(name)
    if tool is None:
        raise ValueError(f"没有工具 {name}，可用：{', '.join(TOOLS)}")
    parsed = tool.input.model_validate(args or {})
    return tool.fn(**parsed.model_dump(exclude_unset=True), actor=actor)
