"""Resume = a Markdown doc + a template name. One renderer for the live preview and the PDF.

Markdown conventions (what the templates style):
  # 名字                     first line
  电话 · 邮箱 · 城市          first paragraph = contact line
  ## 教育经历                 section
  ### 学校 | 专业 | 2021.09 – 2025.06   left parts | ... | right-aligned last part
  - bullet
"""

from __future__ import annotations

import base64
import html
import mimetypes
import re
import shutil
from pathlib import Path
from typing import Optional

from markdown_it import MarkdownIt

from app.core import store
from app.core.tools import RESUME_TEMPLATE as TEMPLATES

_CSS = Path(__file__).with_name("templates")
_md = MarkdownIt("commonmark", {"html": False, "linkify": False}).enable("table")


def _heading3(match: re.Match) -> str:
    """### A | B | C → A · B ······ C (the editor decorates the same way, see ResumeEditor)."""
    parts = [p.strip() for p in match.group(1).split("|")]
    if len(parts) == 1:
        return f"<h3>{parts[0]}</h3>"
    middle = "".join(f'<span class="sep">|</span><span class="seg">{p}</span>' for p in parts[1:-1])
    return f'<h3>{parts[0]}{middle}<span class="sep-r">|</span><span class="r">{parts[-1]}</span></h3>'


def css(template: str) -> str:
    template = template if template in TEMPLATES else "single"
    return (_CSS / "base.css").read_text(encoding="utf-8") + (_CSS / f"{template}.css").read_text(encoding="utf-8")


def _photo_uri(photo: Optional[str]) -> Optional[str]:
    if not photo:
        return None
    path = store.data_dir("files") / Path(photo).name
    if not path.is_file():
        return None
    return f"data:{mimetypes.guess_type(path.name)[0] or 'image/jpeg'};base64,{base64.b64encode(path.read_bytes()).decode()}"


def render_html(body: str, template: str = "single", photo: Optional[str] = None, title: str = "简历") -> str:
    inner = re.sub(r"<h3>(.*?)</h3>", _heading3, _md.render(body or ""), flags=re.S)
    img = _photo_uri(photo) if template == "photo" else None
    photo_tag = f'<img class="photo" src="{html.escape(img, quote=True)}" alt="">' if img else ""
    return (f'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>{html.escape(title)}</title>'
            f"<style>@page {{ size: A4; margin: 0; }} html, body {{ margin: 0; }}{css(template)}</style></head>"
            f'<body><main class="resume{" photo-on" if img else ""}">{photo_tag}{inner}</main></body></html>')


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
    return render_html(doc.get("body") or "", doc.get("template") or "single", profile.get("photo"), file_name(doc)[:-4])


def file_name(doc: dict) -> str:
    profile = store.first("profile") or {}
    name = "-".join(x for x in (profile.get("name"), doc.get("title") or "简历") if x)
    return re.sub(r"[\\/:*?\"<>|\s]+", "_", name) + ".pdf"
