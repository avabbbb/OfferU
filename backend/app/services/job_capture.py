# =============================================
# Job Capture — 「粘贴岗位描述原文或链接 → 岗位草稿」
# =============================================
# 只做两件事：
# 1. 识别用户粘贴的是原文还是链接；
# 2. 产出一份待用户确认的岗位草稿（标题/公司/地点/正文/链接）。
#
# 红线：
# - 链接只发一次匿名 GET（复用 web_search.fetch_public_html 的公网/重定向校验），
#   不带 Cookie、不重试、不模拟登录；反爬/需登录站点直接返回 needs_text，
#   请用户自己复制原文。绝不绕过任何平台风控。
# - 本模块不写数据库。建岗位必须由用户确认草稿后走 import_jd Operation。
# =============================================

from __future__ import annotations

import json
import re
from typing import Any

# 在 web_search.RESTRICTED_DOMAINS 之外，这些招聘站点的岗位详情需要登录或
# 由脚本渲染，匿名抓取要么拿不到正文、要么触发风控：一律请用户粘贴原文。
CAPTURE_PASTE_ONLY_DOMAINS: tuple[str, ...] = (
    "linkedin.com",
    "liepin.com",
    "lagou.com",
)

MIN_JD_CHARS = 80
MAX_JD_CHARS = 50_000
MAX_INPUT_CHARS = 60_000

_URL_RE = re.compile(r"https?://[^\s<>\"'）)】]+", re.IGNORECASE)

_LABELS = {
    "title": (
        "职位名称", "岗位名称", "招聘岗位", "职位", "岗位",
        "job title", "position", "role", "title",
    ),
    "company": (
        "公司名称", "企业名称", "招聘公司", "公司", "企业", "雇主",
        "company", "employer", "organization",
    ),
    "location": (
        "工作地点", "工作城市", "办公地点", "地点", "城市", "base",
        "location", "city",
    ),
}


def _clean_line(value: str, limit: int) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip(" \t|·•-—:：")
    return text[:limit].strip()


def _label_value(lines: list[str], labels: tuple[str, ...], limit: int) -> str:
    pattern = re.compile(
        r"^\s*[【\[]?\s*(?:" + "|".join(re.escape(label) for label in labels) + r")\s*[】\]]?\s*[:：]\s*(.+)$",
        re.IGNORECASE,
    )
    for line in lines[:60]:
        match = pattern.match(line)
        if match:
            value = _clean_line(match.group(1), limit)
            if value:
                return value
    return ""


def _looks_like_heading(line: str) -> bool:
    text = line.strip()
    if not 2 <= len(text) <= 40:
        return False
    if text[-1] in "。.，,；;！!？?:：":
        return False
    if _URL_RE.search(text):
        return False
    return not re.match(r"^(岗位职责|职位描述|任职要求|工作职责|岗位要求|职位要求|job description|responsibilities|requirements)\b", text, re.IGNORECASE)


def extract_job_fields_from_text(text: str) -> dict[str, str]:
    """从原文里尽量读出标题/公司/地点；读不出来的留空交给用户补。"""
    lines = [line.strip() for line in str(text or "").splitlines() if line.strip()]
    title = _label_value(lines, _LABELS["title"], 500)
    company = _label_value(lines, _LABELS["company"], 300)
    location = _label_value(lines, _LABELS["location"], 200)
    if not title and lines and _looks_like_heading(lines[0]):
        head = lines[0]
        # 「字节跳动 - 后端开发工程师」/「后端开发工程师 | 字节跳动」
        parts = [part.strip() for part in re.split(r"\s+[-–—|｜]\s+", head) if part.strip()]
        if len(parts) == 2 and not company:
            first, second = parts
            role_hint = re.compile(r"(工程师|经理|实习|专员|设计师|分析师|开发|运营|产品|engineer|manager|intern|analyst|designer|developer)", re.IGNORECASE)
            if role_hint.search(second) and not role_hint.search(first):
                company, title = first, second
            else:
                title, company = first, second
        else:
            title = _clean_line(head, 500)
    return {"title": title, "company": company, "location": location}


def _iter_json_ld(node: Any):
    if isinstance(node, list):
        for item in node:
            yield from _iter_json_ld(item)
    elif isinstance(node, dict):
        yield node
        graph = node.get("@graph")
        if graph is not None:
            yield from _iter_json_ld(graph)


def _is_job_posting(node: dict[str, Any]) -> bool:
    kind = node.get("@type")
    kinds = kind if isinstance(kind, list) else [kind]
    return any(str(item or "").lower() == "jobposting" for item in kinds)


def _job_location(value: Any) -> str:
    for item in value if isinstance(value, list) else [value]:
        if isinstance(item, dict):
            address = item.get("address", item)
            if isinstance(address, dict):
                parts = [
                    str(address.get(key) or "").strip()
                    for key in ("addressLocality", "addressRegion", "addressCountry")
                ]
                text = ", ".join(part for part in parts if part)
                if text:
                    return text
            elif isinstance(address, str) and address.strip():
                return address.strip()
        elif isinstance(item, str) and item.strip():
            return item.strip()
    return ""


def extract_job_posting_from_html(html: str) -> dict[str, str] | None:
    """读取 schema.org JobPosting（大多数 ATS 招聘页都会内嵌）。"""
    from app.services.web_search import html_to_readable_text

    try:
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(html, "html.parser")
        scripts = soup.find_all("script", attrs={"type": re.compile("ld\\+json", re.I)})
        payloads = [script.string or script.get_text() or "" for script in scripts]
    except Exception:
        payloads = re.findall(
            r"<script[^>]+ld\+json[^>]*>(.*?)</script>", html, flags=re.I | re.S
        )
    for raw in payloads:
        try:
            data = json.loads(raw)
        except (TypeError, ValueError):
            continue
        for node in _iter_json_ld(data):
            if not _is_job_posting(node):
                continue
            org = node.get("hiringOrganization")
            company = org.get("name") if isinstance(org, dict) else org
            description = html_to_readable_text(
                str(node.get("description") or ""), max_chars=MAX_JD_CHARS
            )
            return {
                "title": _clean_line(str(node.get("title") or ""), 500),
                "company": _clean_line(str(company or ""), 300),
                "location": _clean_line(_job_location(node.get("jobLocation")), 200),
                "jd_text": description,
            }
    return None


def _page_meta(html: str) -> dict[str, str]:
    try:
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(html, "html.parser")

        def meta(prop: str) -> str:
            tag = soup.find("meta", attrs={"property": prop}) or soup.find(
                "meta", attrs={"name": prop}
            )
            return str(tag.get("content") or "").strip() if tag else ""

        title = meta("og:title") or (soup.title.get_text().strip() if soup.title else "")
        return {"title": title, "site": meta("og:site_name")}
    except Exception:
        return {"title": "", "site": ""}


def _split_input(raw: str) -> tuple[str, str]:
    """返回 (url, text)。只有一个链接且没有其他内容时才算链接模式。"""
    text = str(raw or "").strip()[:MAX_INPUT_CHARS]
    if not text:
        return "", ""
    match = _URL_RE.search(text)
    if match and match.group(0) == text:
        return text, ""
    return (match.group(0) if match else ""), text


def _missing(draft: dict[str, str]) -> list[str]:
    missing = [key for key in ("title", "company") if not draft.get(key)]
    if len(draft.get("jd_text") or "") < MIN_JD_CHARS:
        missing.append("jd_text")
    return missing


def _needs_text(url: str, message: str) -> dict[str, Any]:
    return {
        "status": "needs_text",
        "source_kind": "url",
        "message": message,
        "draft": {"title": "", "company": "", "location": "", "url": url, "jd_text": ""},
        "missing": ["title", "company", "jd_text"],
    }


async def draft_job_posting(text: str) -> dict[str, Any]:
    """把粘贴内容变成岗位草稿；不写库。"""
    url, body = _split_input(text)
    if not url and not body:
        raise ValueError("请粘贴岗位描述原文或岗位链接")

    if body:
        fields = extract_job_fields_from_text(body)
        draft = {**fields, "url": url, "jd_text": body[:MAX_JD_CHARS]}
        missing = _missing(draft)
        return {
            "status": "ready" if not missing else "incomplete",
            "source_kind": "text",
            "message": "",
            "draft": draft,
            "missing": missing,
        }

    from app.services.web_search import (
        RestrictedSiteError,
        fetch_public_html,
        html_to_readable_text,
    )

    try:
        final_url, html = await fetch_public_html(
            url, extra_restricted_domains=CAPTURE_PASTE_ONLY_DOMAINS
        )
    except RestrictedSiteError:
        return _needs_text(
            url,
            "这个招聘站需要登录，OfferU 不会替你抓取。请在页面里复制岗位描述原文粘贴过来，链接会一起保存。",
        )
    except Exception:
        return _needs_text(
            url,
            "这个链接没读到内容（可能需要登录或已下线）。请复制岗位描述原文粘贴过来。",
        )

    structured = extract_job_posting_from_html(html)
    if structured and len(structured.get("jd_text") or "") >= MIN_JD_CHARS:
        draft = {**structured, "url": final_url}
        missing = _missing(draft)
        return {
            "status": "ready" if not missing else "incomplete",
            "source_kind": "structured",
            "message": "",
            "draft": draft,
            "missing": missing,
        }

    page_text = html_to_readable_text(html, max_chars=MAX_JD_CHARS)
    if len(page_text) < MIN_JD_CHARS:
        return _needs_text(
            final_url,
            "页面需要脚本渲染或登录，没读到岗位描述。请复制岗位描述原文粘贴过来。",
        )
    meta = _page_meta(html)
    fields = extract_job_fields_from_text(page_text)
    draft = {
        "title": fields["title"] or _clean_line(meta["title"], 500),
        "company": fields["company"] or _clean_line(meta["site"], 300),
        "location": fields["location"],
        "url": final_url,
        "jd_text": page_text,
    }
    missing = _missing(draft)
    return {
        "status": "incomplete" if missing else "ready",
        "source_kind": "page",
        # 整页正文混着导航和推荐岗位，必须让用户看一眼再建。
        "message": "这是整页文字，可能混入了无关内容，确认前请删掉多余部分。",
        "draft": draft,
        "missing": missing,
    }
