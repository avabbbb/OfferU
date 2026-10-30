"""Resume = a Markdown doc + a style. One renderer for the live preview and the PDF.

Markdown conventions (what the templates style):
  # 名字                     first line
  电话 · 邮箱 · 城市          first paragraph = contact line
  ## 教育经历                 section
  ### 学校 | 专业 | 2021.09 – 2025.06   left parts | ... | right-aligned last part
  - bullet

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

from markdown_it import MarkdownIt

from app.core import store
from app.core.tools import LEGACY_TEMPLATE, RESUME_TEMPLATE

_CSS = Path(__file__).with_name("templates")
_md = MarkdownIt("commonmark", {"html": False, "linkify": False}).enable("table")
_MARGIN = ("top", "right", "bottom", "left")

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
    given = {**LEGACY_TEMPLATE.get(legacy_template or "", {}), **{k: v for k, v in (style or {}).items() if v is not None}}
    template = given["template"] if given.get("template") in RESUME_TEMPLATE else "clear"
    base = DEFAULTS[template]
    out = {**base, "photo": False, "logo": None, **given, "template": template}
    out["margin"] = {**base["margin"], **(given.get("margin") or {})}
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


def _heading3(match: re.Match) -> str:
    """### A | B | C → A · B ······ C (the editor decorates the same way, see ResumeEditor)."""
    attrs, parts = match.group(1), [p.strip() for p in match.group(2).split("|")]
    if len(parts) == 1:
        return f"<h3{attrs}>{parts[0]}</h3>"
    middle = "".join(f'<span class="sep">|</span><span class="seg">{p}</span>' for p in parts[1:-1])
    return f'<h3{attrs}>{parts[0]}{middle}<span class="sep-r">|</span><span class="r">{parts[-1]}</span></h3>'


def body_html(body: str) -> str:
    """Markdown → HTML. Every block carries data-line (its first source line) so a click in the preview finds its block."""
    tokens = _md.parse(body or "")
    for token in tokens:
        if token.map and token.nesting == 1:
            token.attrSet("data-line", str(token.map[0]))
    return re.sub(r"<h3([^>]*)>(.*?)</h3>", _heading3, _md.renderer.render(tokens, _md.options, {}), flags=re.S)


def _file_uri(name: Optional[str]) -> Optional[str]:
    if not name:
        return None
    path = store.data_dir("files") / Path(name).name
    if not path.is_file():
        return None
    return f"data:{mimetypes.guess_type(path.name)[0] or 'image/jpeg'};base64,{base64.b64encode(path.read_bytes()).decode()}"


def render_html(body: str, style: Optional[dict] = None, photo: Optional[str] = None, title: str = "简历") -> str:
    """The one renderer: the preview iframe shows this page and the PDF prints it."""
    style = resolve_style(style)
    figures = {"photo": _file_uri(photo) if style["photo"] else None, "logo": _file_uri(style["logo"])}
    tags = "".join(f'<img class="{cls}" src="{html.escape(uri, quote=True)}" alt="">' for cls, uri in figures.items() if uri)
    classes = " ".join(["resume", f"t-{style['template']}", *(f"{cls}-on" for cls, uri in figures.items() if uri)])
    return (f'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>{html.escape(title)}</title>'
            f"<style>@page {{ size: A4; margin: 0; }} html, body {{ margin: 0; }}{_sheet(style)}</style></head>"
            f'<body><main class="{classes}">{tags}{body_html(body)}</main></body></html>')


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
    return render_html(doc.get("body") or "", style, profile.get("photo"), file_name(doc)[:-4])


def file_name(doc: dict) -> str:
    profile = store.first("profile") or {}
    name = "-".join(x for x in (profile.get("name"), doc.get("title") or "简历") if x)
    return re.sub(r"[\\/:*?\"<>|\s]+", "_", name) + ".pdf"
