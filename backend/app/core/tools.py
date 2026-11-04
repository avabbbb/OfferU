"""The shared tools. Workbench (HTTP), built-in agent, external agents (MCP / `offeru tool`) all call these, nothing else.

Few and general on purpose: one save / get / list / search / delete / undo over five record types,
plus overview (what to do now) and fetch_page. Agents write directly; every write can be undone.
"""

from __future__ import annotations

import asyncio
import fnmatch
import json
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
DOC_KIND = {"resume": "简历", "apply_chat": "官网投递对话", "email": "投递邮件", "review": "面试复盘", "research": "调研", "evaluation": "岗位评估", "note": "笔记"}
MEMORY_KIND = {"experience": "实习 / 工作", "project": "项目", "education": "教育", "skill": "技能",
               "award": "奖项 / 证书", "preference": "偏好", "note": "其他"}
TYPE_LABEL = {"profile": "档案", "memory": "记忆", "job": "岗位", "event": "事项", "doc": "文档"}
MAIL_ACTOR = "邮箱"

FIELDS = {
    "profile": "唯一一份。name, school, major, degree, grad_year, phone, email, city, target（求职方向）, stage（用户自己说的阶段）, about, photo（证件照文件名）",
    "memory": f"职业记忆，一条一件事。kind: {'/'.join(MEMORY_KIND)}; title; body（具体经历、数字、用户原话）; start, end; tags",
    "job": f"岗位和投递状态。company, title, status: {'/'.join(JOB_STATUS)}; url, city, jd, notes, applied_at; source（来源站点：xhs / boss / feishu / moka / beisen / 域名）, images（页面图片链接，JD 可能在图里）；截止日期存 event kind=deadline",
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


# 同一个岗位再存一次时更新原记录，不新建。BOSS 链接里的 lid、securityId 每次打开都不一样，按 job_detail 里的岗位编号认；
# 小红书按笔记编号认；其他站点去掉跟踪参数后按 主机+路径+查询 认。
TRACKING_PARAMS = ("lid", "securityid", "ka", "spm", "from", "share", "sessionid", "xsec_token", "xsec_source", "share_from_user_hidden")


def job_url_key(url: str) -> str:
    from urllib.parse import parse_qsl, urlencode, urlsplit

    try:
        parts = urlsplit(str(url or "").strip())
    except ValueError:
        return ""
    host = (parts.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    if not host:
        return ""
    path = parts.path.rstrip("/")
    if host.endswith("zhipin.com") and (hit := re.search(r"job_detail.([0-9A-Za-z_~-]+)", path)):
        return "boss:" + hit.group(1)
    if host.endswith("xiaohongshu.com") and (hit := re.search(r"(?:explore|item).([0-9A-Za-z]+)", path)):
        return "xhs:" + hit.group(1)
    query = sorted((k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
                   if not k.lower().startswith("utm_") and k.lower() not in TRACKING_PARAMS)
    return host + path + ("?" + urlencode(query) if query else "")


def find_job_by_url(url: str) -> Optional[dict[str, Any]]:
    key = job_url_key(url)
    if not key:
        return None
    for job in store.all_of("job"):
        if job.get("url") and job_url_key(job["url"]) == key:
            return job
    return None


def merge_saved_job(existing: dict[str, Any], data: dict[str, Any]) -> dict[str, Any]:
    """重复存同一个岗位：只补原来空着的字段，JD 更长才换；不动投递状态，免得把已投递打回想投。"""
    out: dict[str, Any] = {}
    for key, value in data.items():
        if key in ("status", "applied_at") or value is None or value == "" or value == []:
            continue
        old = existing.get(key)
        if old is None or old == "" or old == []:
            out[key] = value
        elif key == "jd" and len(str(value)) > len(str(old)):
            out[key] = value
    return out


class SaveIn(_In):
    type: RecordType
    data: dict[str, Any] = Field(description="要写的字段；更新时只传要改的，传 null 删除该字段")
    id: Optional[int] = Field(None, description="不传就新建；profile 不用传")


def save(type: str, data: dict[str, Any], id: Optional[int] = None, *, actor: str) -> dict[str, Any]:
    if type == "profile" and id is None and (existing := store.first("profile")):
        id = existing["id"]
    existed = False
    if type == "job" and id is None and data.get("url") and (prev := find_job_by_url(str(data["url"]))):
        existed, id = True, prev["id"]
        data = merge_saved_job(prev, data)
        if not data:
            return {"record": prev, "change_id": None, "existed": True}
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
    return {"record": record, "change_id": change, "existed": existed}


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
    from app.core import posting_guard

    # 岗位页是第三方文本：隐藏内容和不可见字符不进正文，像指令的行只计数（posting_guard）。
    title = posting_guard.clean_text(title)[0]
    text, findings = posting_guard.guard(raw, is_html=True)
    return {"url": url, "title": title, "text": text[:20_000], "truncated": len(text) > 20_000,
            "guard": posting_guard.counts(findings), "warning": posting_guard.warning(findings)}


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
    out = {"doc_id": event["doc_id"], "change_id": event["change_id"], "body": event["body"]}
    out.update({key: event.get(key) for key in ("pages", "rounds", "notes", "grounding")})
    return out


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


# 只给「公司 岗位」时去官网找岗位页。
def _is_job_name(text: str) -> bool:
    """一行、很短、不是链接：当成「公司 岗位」去联网找，而不是当 JD 存。"""
    return "\n" not in text and len(text) <= 60 and not re.search(r"https?://", text)


def _hit(result: Any, key: str) -> str:
    return str((result.get(key) if isinstance(result, dict) else getattr(result, key, "")) or "")


def _find_official_posting(name: str) -> tuple[str, dict[str, Any]]:
    """只有「公司 岗位」时拿官方 JD：腾讯、百度先查招聘官网公开接口；其余联网搜，只认公司自有招聘域名和
    公司开通的托管招聘系统（Moka、飞书招聘、北森等），镜像站、聚合站一律不采用。"""
    from urllib.parse import urlparse

    from app.config import get_settings
    from app.core import job_sources
    from app.services import job_capture
    from app.services import web_search as service

    company, rest = job_sources.split_name(name)
    if company in job_sources.API_COMPANIES:
        try:
            posting, similar = job_sources.find_via_api(company, rest)
        except Exception:  # 接口不通就退回联网搜，不当成「官网没有」
            posting, similar = None, None
        if posting:
            return posting["url"], posting
        if similar is not None:
            near = f"官网上名字相近的有：{'、'.join(similar)}，要的是其中一个就贴它的链接。" if similar else ""
            raise ValueError(f"{company}招聘官网没找到「{rest}」，没存。{near}"
                             "这个岗位可能只挂在 BOSS 等平台上：把 JD 文字贴进来就行")

    settings = get_settings()
    if not (settings.bocha_api_key or settings.tavily_api_key or settings.serper_api_key or service._ddgs_available()):
        raise ValueError(f"只有「{name}」要联网找官方岗位页，但没配搜索服务：在设置里填 Bocha / Tavily / Serper 的 key"
                         "（或装 ddgs）。也可以直接贴岗位链接或 JD")
    blocked = tuple(service.RESTRICTED_DOMAINS) + tuple(job_capture.CAPTURE_PASTE_ONLY_DOMAINS)
    tokens = [t for t in re.split(r"[\s·|/,，、]+", name) if t]
    owner = (company or (tokens[0] if tokens else "")).lower()
    seen: set[str] = set()
    skipped: list[str] = []
    ranked: list[tuple[int, str]] = []
    for query in (f"{name} 招聘 官网", f"{name} 岗位详情 投递"):
        for r in _await(lambda q=query: service.web_search(q, limit=8)) or []:
            url = _hit(r, "url").strip()
            host = (urlparse(url).hostname or "").lower()
            if not url or url in seen or not host or any(host == d or host.endswith("." + d) for d in blocked):
                continue
            seen.add(url)
            kind = job_sources.official_kind(url, company)
            if not kind:  # 镜像站、聚合站、新闻页：正文里有公司名也不采用
                skipped.append(host)
                continue
            title = _hit(r, "title").lower()
            ranked.append(((4 if kind == "own" else 2) + sum(2 for t in tokens if t.lower() in title), url))
    ranked.sort(key=lambda x: -x[0])
    tried: list[str] = []
    for _, url in ranked[:4]:
        try:
            page = fetch_page(url)
        except Exception:
            tried.append(urlparse(url).hostname or url)
            continue
        body = f"{page.get('title', '')}\n{page.get('text', '')}".lower()
        matched = sum(1 for t in tokens if t.lower() in body)
        if len(page.get("text", "")) >= 200 and owner and owner in body and matched + matched >= len(tokens):
            return url, page
        tried.append(urlparse(url).hostname or url)
    where = f"（试过：{'、'.join(dict.fromkeys(tried))}）" if tried else ""
    other = f"搜到的 {'、'.join(list(dict.fromkeys(skipped))[:4])} 不是官方招聘站，没采用。" if skipped else ""
    raise ValueError(f"联网没找到「{name}」能直接读到正文的官方岗位页{where}，没存。{other}把官网岗位链接或 JD 文字贴进来")


class AddJobIn(_In):
    text: str = Field(description="岗位详情页链接、整段 JD 文本，或只写「公司 岗位」（会联网找官方岗位页）")


def add_job(text: str, *, actor: str) -> dict[str, Any]:
    """贴链接、JD 或只写「公司 岗位」建岗位：只有名字时先联网找官方岗位页；链接抓正文（抓不到就报错，不存空壳），再由模型拆出公司、岗位、城市、截止、投递方式。"""
    from urllib.parse import urlparse

    from app.core import job_intake, posting_guard

    text = text.strip()
    if not text:
        raise ValueError("要给岗位链接或 JD 文本")
    url = text if re.fullmatch(r"https?://\S+", text) else None
    page = None
    if not url and _is_job_name(text):
        url, page = _find_official_posting(text)
    source = text
    if url:
        page = page or fetch_page(url)
        if len(page["text"]) < 200:
            raise ValueError("这个页面要登录或靠 JS 渲染，抓不到正文，没存。用插件「存为岗位」，或者把 JD 文字贴进来")
        source = f"{page['title']}\n{page['text']}"
        guard, warn = page.get("guard"), page.get("warning")
    else:
        source, findings = posting_guard.guard(text, is_html=False)
        guard, warn = posting_guard.counts(findings), posting_guard.warning(findings)
    fields = _await(lambda: job_intake.extract(source)) if job_intake.available() else job_intake.guess(source)
    deadline = fields.pop("deadline", None)
    how = fields.pop("apply", None)
    data = {**fields, "jd": fields.get("jd") or source, "url": url,
            "source": urlparse(url).hostname if url else None,
            "notes": "\n".join(filter(None, [warn, f"投递方式：{how}" if how else None])) or None}
    if not (data.get("company") or data.get("title")):
        data["title"] = job_intake.guess(source)["title"]
    saved = save("job", {k: v for k, v in data.items() if v}, actor=actor)
    out = {"record": saved["record"], "change_ids": [c for c in [saved["change_id"]] if c], "existed": saved.get("existed", False),
           "guard": guard}
    if warn:
        out["warning"] = warn
    if deadline and not out["existed"]:
        event = save("event", {"title": f"截止：{label(saved['record'])}", "kind": "deadline", "at": deadline,
                               "job_id": saved["record"]["id"]}, actor=actor)
        out["change_ids"].append(event["change_id"])
    return out


class EvaluateJobsIn(_In):
    ids: Optional[list[int]] = Field(None, description="只评这些岗位；不传就评所有没评过、没结束、有 JD 的岗位")
    redo: bool = Field(False, description="不传 ids 时，true 表示评过的也重评")


def evaluate_jobs(ids: Optional[list[int]] = None, redo: bool = False, *, actor: str) -> dict[str, Any]:
    """逐个岗位出评估报告（岗位下的 evaluation 文档，重评覆盖同一份），0–100 分和三句理由写回 job.score / reasons。"""
    from app.core import job_eval

    if not job_eval.available():
        raise ValueError("没配模型，没法自动评估。你自己评就用 save 给 job 写 score（0–100）和 reasons（三句）")
    if ids:
        jobs = []
        for id_ in ids:
            job = store.get("job", int(id_))
            if job is None:
                raise ValueError(f"岗位 #{id_} 不存在")
            if not str(job.get("jd") or "").strip():
                raise ValueError(f"「{label(job)}」还没有 JD，先贴 JD 再评估")
            jobs.append(job)
    else:
        jobs = [j for j in store.all_of("job") if j.get("status") not in ("rejected", "closed")
                and str(j.get("jd") or "").strip() and (redo or j.get("score") is None)]
    if not jobs:
        return {"count": 0, "change_ids": [], "items": [], "failed": []}
    text = job_eval.candidate(store.first("profile"), store.all_of("memory"))
    change_ids: list[int] = []
    items: list[dict[str, Any]] = []
    failed: list[str] = []
    for job in jobs:
        result = _await(lambda j=job: job_eval.evaluate(text, j))
        if not result:
            failed.append(label(job))
            continue
        old = next((d for d in store.all_of("doc", job_id=job["id"]) if d.get("kind") == "evaluation"), None)
        doc = save("doc", {"kind": "evaluation", "job_id": job["id"], "title": f"岗位评估 · {label(job)}",
                           "body": result["markdown"]}, id=old["id"] if old else None, actor=actor)
        scored = save("job", {"score": result["score"], "reasons": result["reasons"]}, id=job["id"], actor=actor)
        change_ids += [doc["change_id"], scored["change_id"]]
        items.append({"id": job["id"], "label": label(job), "score": result["score"],
                      "reasons": result["reasons"], "doc_id": doc["record"]["id"]})
    if not items:
        raise ValueError("模型没返回可用的评估，岗位没动：" + "、".join(failed))
    items.sort(key=lambda i: -i["score"])
    return {"count": len(items), "change_ids": change_ids, "items": items, "failed": failed}


APPLY_PROMPT = """你在帮候选人填招聘官网的网申问题。只用给出的档案、职业记忆、岗位 JD 和这个岗位的定制简历里的事实作答，不编造经历和数字。
要求：直接给能粘贴进表单的回答，第一人称；题目有字数限制就遵守，没有就控制在 300 字内；资料里没有的信息写「（待补充：…）」提醒候选人。
之前答过的题要和这次口径一致，不重复同一个例子。"""


class ApplyAnswerIn(_In):
    job_id: int = Field(description="岗位 id（要有 JD）")
    question: str = Field(description="官网上的问题原文，有字数限制一起贴")


def apply_answer(job_id: int, question: str, *, actor: str) -> dict[str, Any]:
    """按 JD 和这个岗位的定制简历回答官网网申问题，问答追加到岗位下的 apply_chat 文档（一条改动，可撤销）。"""
    from app.core import job_eval

    job = store.get("job", int(job_id))
    if job is None:
        raise ValueError(f"岗位 #{job_id} 不存在")
    question = question.strip()
    if not question:
        raise ValueError("问题是空的")
    if not job_eval.available():
        raise ValueError("没配模型，没法自动回答。你自己写好就用 save 存成 kind=apply_chat 的文档")
    docs = store.all_of("doc", job_id=job["id"])
    resume = next((d for d in sorted(docs, key=lambda d: -d["id"]) if d.get("kind") == "resume"), None)
    chat = next((d for d in docs if d.get("kind") == "apply_chat"), None)
    resume_text = ""
    if resume:
        resume_text = str(resume.get("body") or "") or json.dumps(resume.get("resume") or {}, ensure_ascii=False)
    context = (job_eval.candidate(store.first("profile"), store.all_of("memory"))
               + "\n\n岗位：\n" + job_eval.job_text(job)
               + "\n\n定制简历：\n" + (resume_text[:6000] or "（这个岗位还没有定制简历）"))
    history = str((chat or {}).get("body") or "")
    reply = _await(lambda: _apply_reply(context, question, history))
    if not reply:
        raise ValueError("模型没返回回答，什么都没存")
    entry = f"### 问：{question}\n\n{reply}\n"
    body = f"{history.rstrip()}\n\n{entry}" if history.strip() else entry
    saved = save("doc", {"kind": "apply_chat", "job_id": job["id"], "title": f"官网投递对话 · {label(job)}", "body": body},
                 id=chat["id"] if chat else None, actor=actor)
    return {"answer": reply, "doc_id": saved["record"]["id"], "change_id": saved["change_id"],
            "used_resume": resume["id"] if resume else None}


async def _apply_reply(context: str, question: str, history: str) -> str:
    from app.agents.llm import chat_completion

    user = context + ("\n\n之前答过的题：\n" + history[-4000:] if history else "") + "\n\n现在要回答：\n" + question
    raw = await chat_completion([{"role": "system", "content": APPLY_PROMPT}, {"role": "user", "content": user}],
                                temperature=0.4, max_tokens=1500)
    return str(raw or "").strip()


EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+")
MAIL_RULE_RE = re.compile(r"邮件|主题|标题|附件|命名|PDF|pdf")


class DraftEmailIn(_In):
    job_id: int = Field(description="岗位 id（JD 或备注里要有投递邮箱）")
    resume_id: Optional[int] = Field(None, description="附哪份简历；不传就用这个岗位下最新的简历，没有就用主简历")


SUBJECT_FORMAT_RE = re.compile(
    r"(?:邮件)?(?:标题|主题)(?:格式)?(?:请)?(?:注明|命名为|写成|统一为|为|是|按)?\s*[：:]?\s*[「“\"'【]?([^，,。；;\n」”\"'】]+)")
SUBJECT_SEP_RE = re.compile(r"(\s*[-_—–+＋|｜]\s*)")
SUBJECT_FIELDS: tuple[tuple[tuple[str, ...], Any], ...] = (
    (("姓名", "名字"), lambda p, j: p.get("name")),
    (("学校", "院校", "毕业院校"), lambda p, j: p.get("school")),
    (("专业",), lambda p, j: p.get("major")),
    (("学历",), lambda p, j: p.get("degree")),
    (("岗位", "职位", "应聘岗位", "应聘职位", "岗位名称", "意向岗位"), lambda p, j: j.get("title")),
    (("届别", "年级", "毕业年份", "毕业时间", "届"), lambda p, j: f"{p['grad_year']}届" if p.get("grad_year") else None),
    (("电话", "手机", "手机号", "联系方式"), lambda p, j: p.get("phone")),
    (("城市", "实习城市", "意向城市", "工作城市"), lambda p, j: j.get("city")),
)


def mail_subject(text: str, profile: dict[str, Any], job: dict[str, Any]) -> tuple[str, list[str]]:
    """按 JD 写的标题格式（如「姓名-学校-岗位-到岗时间」）逐段填；档案里没有的段留 [到岗时间] 占位并列进待补。
    JD 没给格式就用「姓名-学校-岗位」。返回 (标题, 待补字段)。"""
    title = job.get("title") or "岗位"
    default = "-".join(x for x in (profile.get("name"), profile.get("school"), title) if x) or f"应聘{title}"
    for match in SUBJECT_FORMAT_RE.finditer(text):
        pieces = SUBJECT_SEP_RE.split(match.group(1).strip())
        if len(pieces) < 3:  # 不是「A-B-C」这种分段格式，看下一处
            continue
        out: list[str] = []
        todo: list[str] = []
        for i, piece in enumerate(pieces):
            if i % 2:
                out.append(piece.strip())
                continue
            token = piece.strip()
            value = next((get(profile, job) for names, get in SUBJECT_FIELDS if token in names), None)
            value = value or profile.get(token)  # 档案里有同名字段（如「到岗时间」）也认
            if value:
                out.append(str(value))
            elif token:
                out.append(f"[{token}]")
                todo.append(token)
        return "".join(out), todo
    return default, []


def draft_email(job_id: int, resume_id: Optional[int] = None, *, actor: str) -> dict[str, Any]:
    """从 JD 拆出投递邮箱和邮件要求，写好标题正文、导出简历 PDF，存成岗位下的 email 文档。不发送，用户确认后自己发。"""
    job = store.get("job", int(job_id))
    if job is None:
        raise ValueError(f"岗位 #{job_id} 不存在")
    text = "\n".join(str(job.get(k) or "") for k in ("jd", "notes"))
    emails = list(dict.fromkeys(EMAIL_RE.findall(text)))
    if not emails:
        raise ValueError("JD 和备注里没找到投递邮箱，先把邮箱贴进备注")
    rules = [s.strip() for s in re.split(r"[\n。；;]", text) if s.strip() and MAIL_RULE_RE.search(s)][:5]
    profile = store.first("profile") or {}
    name = profile.get("name") or ""
    title = job.get("title") or "岗位"
    subject, subject_todo = mail_subject(text, profile, job)
    docs = sorted(store.all_of("doc"), key=lambda d: -d["id"])
    if resume_id is not None:
        resume = store.get("doc", int(resume_id))
        if resume is None or resume.get("kind") != "resume":
            raise ValueError(f"简历 #{resume_id} 不存在")
    else:
        resume = (next((d for d in docs if d.get("kind") == "resume" and d.get("job_id") == job["id"]), None)
                  or next((d for d in reversed(docs) if d.get("kind") == "resume" and not d.get("job_id")), None))
    attachment = attach_error = None
    if resume:
        try:
            attachment = export_resume_pdf(resume["id"], actor=actor)["path"]
        except Exception as exc:  # noqa: BLE001 - 没装浏览器也要把草稿存下来
            attach_error = f"简历 PDF 没导出来：{exc}"
    intro = "".join(str(profile.get(k) or "") for k in ("school", "major", "degree"))
    sign = "\n".join(str(x) for x in (name, profile.get("phone"), profile.get("email")) if x)
    body = (f"您好：\n\n我是{name or '（姓名）'}{('，' + intro) if intro else ''}，想应聘贵司「{title}」岗位，简历见附件。\n\n"
            f"期待您的回复，谢谢！\n\n{sign}").rstrip()
    existing = next((d for d in docs if d.get("kind") == "email" and d.get("job_id") == job["id"]), None)
    saved = save("doc", {"kind": "email", "job_id": job["id"], "title": f"投递邮件 · {label(job)}", "to": emails[0],
                         "subject": subject, "body": body, "attachment": attachment, "rules": rules or None},
                 id=existing["id"] if existing else None, actor=actor)
    return {"to": emails[0], "cc": emails[1:], "subject": subject, "body": body, "attachment": attachment,
            "attach_error": attach_error, "subject_todo": subject_todo or None, "rules": rules, "doc_id": saved["record"]["id"], "change_id": saved["change_id"]}


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
         description="搜公开网页，返回标题、链接、摘要；要正文再用 fetch_page。没配搜索服务会报错，照实告诉用户。"
                     "做岗位调研时官网、招聘官网、权威媒体优先，记下每个来源的链接和日期，按系统提示里的调研结构存成 research 文档。"),
    Tool(name="export_resume_pdf", input=ExportIn, fn=export_resume_pdf,
         description="把一份简历（doc kind=resume）按它的排版（style）导出成 PDF，和工作台预览是同一份 HTML，返回文件路径。"),
    Tool(name="fetch_page", input=FetchIn, fn=fetch_page, description="抓取一个公开网页的文字（比如岗位详情页链接），需要登录或 JS 的页面可能拿不到内容。"),
    Tool(name="email_sync", input=EmailSyncIn, fn=email_sync,
         description="邮箱同步。status：已连的邮箱、最近几次同步、今天邮箱写了几条改动；sync：立刻拉一次新邮件，识别投递回执、笔试、面试、offer、拒信，"
                     "直接改岗位状态（只前进）并把笔试面试时间写成事项，返回写了哪些改动（都能撤销）。连邮箱和断开在设置页。"),
    Tool(name="tailor_resume", input=TailorIn, fn=tailor_resume,
         description="按岗位 JD 改写简历：只用档案和记忆里的事实，参考这个岗位的评估报告（有的话）。传岗位简历就原地改；传主简历（没挂岗位）"
                     "就写进这个岗位的定制简历，没有就新建一份，主简历不动。一条改动，可撤销；返回写入的 doc_id 和新正文。会调模型，要一两分钟。"),
    Tool(name="split_resume", input=SplitResumeIn, fn=split_resume,
         description="把一份旧简历（原文 text 或文件 path）拆成一条条 memory 直接存进档案，只整理不编造；每条一条改动，返回 change_ids 可逐条撤销。"
                     "会调模型，要一两分钟。你自己能拆就用 read_file + save。"),
    Tool(name="add_job", input=AddJobIn, fn=add_job,
         description="用户贴来岗位链接或 JD 文本时用：抓链接正文、拆出公司 / 岗位 / 城市 / JD，截止日期另存成 deadline 事项，返回岗位和 change_ids（可撤销）。"
                     "页面要登录或靠 JS 渲染时报错不存，让用户用插件「存为岗位」或贴 JD。会调模型。存完接着用 evaluate_jobs 评估这个岗位。"),
    Tool(name="evaluate_jobs", input=EvaluateJobsIn, fn=evaluate_jobs,
         description="评估岗位值不值得投：每个岗位出一份评估报告（结论、JD 逐条要求对档案的命中和差距、来源真假、职级薪资、简历怎么改、面试准备、反问），"
                     "存成岗位下的 evaluation 文档（重评覆盖同一份），0–100 分和三句理由写回 job.score / reasons，每步一条改动可撤销。"
                     "不联网：公司、竞品、面经调研另存 research。add_job 存完就传 ids 评这一个；不传 ids 评所有没评过的。会调模型，每个岗位几十秒。"),
    Tool(name="apply_answer", input=ApplyAnswerIn, fn=apply_answer,
         description="回答招聘官网的网申问题：用岗位 JD、这个岗位的定制简历、档案和记忆作答，问答追加到岗位下的 apply_chat 文档（一条改动，可撤销），返回回答。会调模型。"),
    Tool(name="draft_email", input=DraftEmailIn, fn=draft_email,
         description="写邮件投递草稿：从岗位 JD / 备注里拆出投递邮箱和标题、附件要求，按档案写标题和正文，导出简历 PDF，存成岗位下的 email 文档（可撤销）。"
                     "不会发送：把草稿给用户看，用户在邮件客户端里确认后自己发。标题格式和 JD 要求不一致时提醒用户改。"),
]}


def call(name: str, args: Optional[dict[str, Any]], *, actor: str) -> dict[str, Any]:
    tool = TOOLS.get(name)
    if tool is None:
        raise ValueError(f"没有工具 {name}，可用：{', '.join(TOOLS)}")
    parsed = tool.input.model_validate(args or {})
    return tool.fn(**parsed.model_dump(exclude_unset=True), actor=actor)
