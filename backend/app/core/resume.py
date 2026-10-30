"""Resume = doc.resume（结构化，见 resume_model）+ doc.style。预览和 PDF 用同一个渲染函数。

HTML 结构（模板 CSS 只认这些）：
  h1 名字 → p.contact 联系方式 / 求职意向 → section > h2 节标题 → div.item > h3（标题 · 副标题 · 城市 ······ 时间）、p 正文、ul > li 要点
每个可编辑的元素带 data-path（如 sections.1.items.0.bullets.2），预览里点哪儿就改哪儿。

doc.style (validated by tools.check_style) only overrides the template's defaults. Every value becomes a CSS
variable on .resume (style_vars); base.css and the template files only consume those variables.
"""

from __future__ import annotations

import base64
import html
import mimetypes
import re
import shutil
from pathlib import Path
from typing import Any, Optional

from app.core import store
from app.core.resume_model import TARGET_PREFIX, resume_of
from app.core.tools import LEGACY_TEMPLATE, RESUME_TEMPLATE

_CSS = Path(__file__).with_name("templates")
_MARGIN = ("top", "right", "bottom", "left")
_BOLD = re.compile(re.escape(chr(42) * 2) + r"(.+?)" + re.escape(chr(42) * 2))

FONTS = {
    "sans": '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", "Noto Sans CJK SC", system-ui, sans-serif',
    "serif": '"Songti SC", "STSong", "SimSun", "Noto Serif SC", "Noto Serif CJK SC", serif',
    "kai": '"Kaiti SC", "STKaiti", "KaiTi", "Noto Serif SC", serif',
}

# clear 对标超级简历；kami 沿用 #99 / #108 量好的 Kami 版式；compact 给内容多的人。
DEFAULTS: dict[str, dict[str, Any]] = {
    "clear": {"font": "sans", "bodySize": 9.5, "lineHeight": 1.45, "sectionGap": 9, "itemGap": 4.5,
              "margin": {"top": 11, "right": 13, "bottom": 11, "left": 13}, "accent": "#141413"},
    "kami": {"font": "serif", "bodySize": 9.2, "lineHeight": 1.42, "sectionGap": 16, "itemGap": 7,
             "margin": {"top": 14, "right": 16, "bottom": 14, "left": 16}, "accent": "#1B365D"},
    "compact": {"font": "sans", "bodySize": 9.2, "lineHeight": 1.4, "sectionGap": 7, "itemGap": 3,
                "margin": {"top": 10, "right": 12, "bottom": 10, "left": 12}, "accent": "#1D1D1F"},
}


def resolve_style(style: Optional[dict] = None, legacy_template: Optional[str] = None) -> dict[str, Any]:
    """Template defaults < old doc.template < doc.style. Always returns every key."""
    given = dict(LEGACY_TEMPLATE.get(legacy_template or "", {}))
    given.update({k: v for k, v in (style or {}).items() if v is not None})
    template = given["template"] if given.get("template") in RESUME_TEMPLATE else "clear"
    base = DEFAULTS[template]
    out = dict(base, photo=False, logo=None)
    out.update(given)
    out["template"] = template
    out["margin"] = dict(base["margin"], **(given.get("margin") or {}))
    return out


def style_vars(style: dict[str, Any]) -> str:
    margin = " ".join(f"--margin-{side}: {style['margin'][side]}mm;" for side in _MARGIN)
    return (f".resume {{ --font: {FONTS[style['font']]}; --body-size: {style['bodySize']}pt; "
            f"--line-height: {style['lineHeight']}; --section-gap: {style['sectionGap']}pt; "
            f"--item-gap: {style['itemGap']}pt; --accent: {style['accent']}; {margin} }}")


def _sheet(style: dict[str, Any]) -> str:
    return ((_CSS / "base.css").read_text(encoding="utf-8") + (_CSS / f"{style['template']}.css").read_text(encoding="utf-8")
            + style_vars(style))


def css(template: str) -> str:
    """A template's stylesheet with its default style. Old names (single / photo) still resolve."""
    return _sheet(resolve_style(None, template) if template in LEGACY_TEMPLATE else resolve_style({"template": template}))


def _inline(text: str) -> str:
    """转义，行内只认加粗。"""
    return _BOLD.sub(r"<strong>\1</strong>", html.escape(text, quote=False))


def _item_head(item: dict[str, Any], path: str) -> str:
    """标题 · 副标题 · 城市 ······ 时间（时间靠右）。"""
    title, subtitle, location, date = (item[k].strip() for k in ("title", "subtitle", "location", "date"))
    middle = "".join(f'<span class="sep">|</span><span class="seg">{_inline(p)}</span>' for p in (subtitle, location) if p)
    right = f'<span class="sep-r">|</span><span class="r">{_inline(date)}</span>' if date else ""
    if not (title or middle or right):
        return ""
    return f'<h3 data-path="{path}">{_inline(title)}{middle}{right}</h3>'


def resume_html(resume: dict[str, Any]) -> str:
    """结构化简历 → 纸面 HTML。隐藏的节不出；元素带 data-path。"""
    basics = resume["basics"]
    lines = []
    if contacts := [c.strip() for c in basics["contacts"] if c.strip()]:
        lines.append(" · ".join(_inline(c) for c in contacts))
    if basics["target"].strip():
        lines.append(_inline(TARGET_PREFIX + basics["target"].strip()))
    out = [f'<h1 data-path="basics.name">{_inline(basics["name"].strip())}</h1>',
           f'<p class="contact" data-path="basics.contacts">{"<br>".join(lines)}</p>']
    for i, sec in enumerate(resume["sections"]):
        if sec["hidden"]:
            continue
        path = f"sections.{i}"
        out.append(f'<section data-path="{path}"><h2 data-path="{path}.title">{_inline(sec["title"].strip()) or "未命名"}</h2>')
        for j, item in enumerate(sec["items"]):
            ip = f"{path}.items.{j}"
            out.append(f'<div class="item" data-path="{ip}">{_item_head(item, ip + ".head")}')
            out += [f'<p data-path="{ip}.text">{_inline(line.strip())}</p>' for line in item["text"].split("\n") if line.strip()]
            bullets = [f'<li data-path="{ip}.bullets.{k}">{_inline(b.strip())}</li>' for k, b in enumerate(item["bullets"]) if b.strip()]
            if bullets:
                out.append("<ul>" + "".join(bullets) + "</ul>")
            out.append("</div>")
        out.append("</section>")
    return "".join(out)


def _file_uri(name: Optional[str]) -> Optional[str]:
    if not name:
        return None
    path = store.data_dir("files") / Path(name).name
    if not path.is_file():
        return None
    return f"data:{mimetypes.guess_type(path.name)[0] or 'image/jpeg'};base64,{base64.b64encode(path.read_bytes()).decode()}"


def render_html(resume: dict[str, Any], style: Optional[dict] = None, photo: Optional[str] = None, title: str = "简历") -> str:
    """The one renderer: the preview iframe shows this page and the PDF prints it. resume 要先过 resume_model.normalize。"""
    style = resolve_style(style)
    figures = {"photo": _file_uri(photo) if style["photo"] else None, "logo": _file_uri(style["logo"])}
    tags = "".join(f'<img class="{cls}" src="{html.escape(uri, quote=True)}" alt="">' for cls, uri in figures.items() if uri)
    classes = " ".join(["resume", f"t-{style['template']}", *(f"{cls}-on" for cls, uri in figures.items() if uri)])
    return (f'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>{html.escape(title)}</title>'
            f"<style>@page {{ size: A4; margin: 0; }} html, body {{ margin: 0; }}{_sheet(style)}</style></head>"
            f'<body><main class="{classes}">{tags}{resume_html(resume)}</main></body></html>')


def _launch(playwright):
    """Use whatever Chromium is on the machine: Chrome, Edge, or one on PATH."""
    for channel in ("chrome", "msedge"):
        try:
            return playwright.chromium.launch(channel=channel)
        except Exception:  # noqa: BLE001 - not installed, try the next one
            pass
    for name in ("chromium", "chromium-browser", "google-chrome"):
        if path := shutil.which(name):
            return playwright.chromium.launch(executable_path=path)
    return playwright.chromium.launch()


def pdf_bytes(page_html: str) -> bytes:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = _launch(playwright)
        try:
            page = browser.new_page()
            page.set_content(page_html, wait_until="load")
            return page.pdf(format="A4", print_background=True, prefer_css_page_size=True)
        finally:
            browser.close()


def doc_html(doc: dict) -> str:
    profile = store.first("profile") or {}
    style = resolve_style(doc.get("style"), doc.get("template"))
    return render_html(resume_of(doc), style, profile.get("photo"), file_name(doc)[:-4])


def file_name(doc: dict) -> str:
    profile = store.first("profile") or {}
    name = "-".join(x for x in (profile.get("name"), doc.get("title") or "简历") if x)
    return re.sub(r"[\\/:*?\"<>|\s]+", "_", name) + ".pdf"
