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
    "serif": '"Source Han Serif SC", "Noto Serif SC", "Noto Serif CJK SC", "Songti SC", "STSong", "SimSun", Georgia, serif',
    "kai": '"Kaiti SC", "STKaiti", "KaiTi", "Noto Serif SC", serif',
}

# clear 对标超级简历；kami 沿用 #99 / #108 量好的 Kami 版式；compact 给内容多的人。
# classic 照用户留档简历量：微软雅黑、白底黑字、正文 10.5pt、页边距约 8mm；新简历默认用它。
DEFAULTS: dict[str, dict[str, Any]] = {
    "classic": {"font": "sans", "bodySize": 10.5, "lineHeight": 1.3, "sectionGap": 10, "itemGap": 3,
                "margin": {"top": 7, "right": 8, "bottom": 7, "left": 8}, "accent": "#000000"},
    "clear": {"font": "sans", "bodySize": 9.5, "lineHeight": 1.45, "sectionGap": 9, "itemGap": 4.5,
              "margin": {"top": 11, "right": 13, "bottom": 11, "left": 13}, "accent": "#141413"},
    "kami": {"font": "serif", "bodySize": 9.2, "lineHeight": 1.42, "sectionGap": 16, "itemGap": 7,
             "margin": {"top": 11, "right": 13, "bottom": 11, "left": 13}, "accent": "#1B365D"},
    "compact": {"font": "sans", "bodySize": 9.2, "lineHeight": 1.4, "sectionGap": 7, "itemGap": 3,
                "margin": {"top": 10, "right": 12, "bottom": 10, "left": 12}, "accent": "#1D1D1F"},
}


def resolve_style(style: Optional[dict] = None, legacy_template: Optional[str] = None) -> dict[str, Any]:
    """Template defaults < old doc.template < doc.style. Always returns every key."""
    given = dict(LEGACY_TEMPLATE.get(legacy_template or "", {}))
    given.update({k: v for k, v in (style or {}).items() if v is not None})
    template = given["template"] if given.get("template") in RESUME_TEMPLATE else "classic"
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


_ITALIC = re.compile(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)")
_LINK = re.compile(r"\[([^\]]+)\]\((https?://[^\s)]+)\)")
# 下划线 ++词++：前面不能紧挨字母数字或 +（「C++、C++11」不算），两头不能是空白；ASCII 让 \w 和前端 JS 一样只认英文数字。
_UNDER = re.compile(r"(?<![\w+])\+\+(?=\S)(.+?)(?<=\S)\+\+(?![\w+])", re.ASCII)
_LINE = re.compile(r"^( *)(?:\{(center|right|justify)\} )?(- |\d+\. )?")


def parse_line(raw: str) -> dict[str, Any]:
    """一行标记拆成缩进、对齐、列表和正文，和前端 lib/richMarkup 的 parseLine 一致（共用用例见 richMarkup.cases.json）。"""
    m = _LINE.match(raw)
    mark = m.group(3) or ""
    return {"indent": min(len(m.group(1)) // 2, 4), "align": m.group(2) or "",
            "list": "ul" if mark == "- " else "ol" if mark else "", "text": raw[m.end():]}


def _inline(text: str) -> str:
    """转义，行内认加粗、斜体、++下划线++ 和 [文字](链接)。"""
    out = _ITALIC.sub(r"<em>\1</em>", _BOLD.sub(r"<strong>\1</strong>", html.escape(text, quote=False)))
    out = _UNDER.sub(r"<u>\1</u>", out)
    return _LINK.sub(lambda m: f'<a href="{m.group(2).replace(chr(34), "%22")}">{m.group(1)}</a>', out)


def _block_style(indent: int, align: str) -> str:
    rules = ([f"margin-left:{2 * indent}em"] if indent else []) + ([f"text-align:{align}"] if align else [])
    return f' style="{";".join(rules)}"' if rules else ""


def _text_html(text: str, path: str) -> list[str]:
    """正文，一行一块（和前端 lib/richMarkup 同一套标记）：行首每 2 个空格缩进一级（最多 4 级），
    {center} / {right} / {justify} 对齐；连续的 "- " 行成无序列表，"1. " 行成有序列表。"""
    out: list[str] = []
    kind, rows = "", []

    def flush() -> None:
        nonlocal kind, rows
        if rows:
            out.append(f'<{kind} data-path="{path}">' + "".join(rows) + f"</{kind}>")
        kind, rows = "", []

    for raw in text.split("\n"):
        line = parse_line(raw)
        body = line["text"].strip()
        attrs = _block_style(line["indent"], line["align"])
        if not line["list"]:
            flush()
            if body:
                out.append(f'<p data-path="{path}"{attrs}>{_inline(body)}</p>')
            continue
        k = line["list"]
        if k != kind:
            flush()
            kind = k
        rows.append(f"<li{attrs}>{_inline(body)}</li>")
    flush()
    return out


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
    from app.core.resume_model import contact_text

    if contacts := [contact_text(c).strip() for c in basics["contacts"] if c["value"].strip()]:
        # 参考版式：每行两项键值，用竖线隔开，多的接着换行。
        lines += [" | ".join(_inline(c) for c in contacts[i:i + 2]) for i in range(0, len(contacts), 2)]
    if basics["target"].strip():
        lines.append(_inline(TARGET_PREFIX + basics["target"].strip()))
    out = []
    if name := basics["name"].strip():
        out.append(f'<h1 data-path="basics.name">{_inline(name)}</h1>')
    if lines:
        out.append(f'<p class="contact" data-path="basics.contacts">{"<br>".join(lines)}</p>')
    for i, sec in enumerate(resume["sections"]):
        if sec["hidden"]:
            continue
        path = f"sections.{i}"
        out.append(f'<section data-path="{path}"><h2 data-path="{path}.title">{_inline(sec["title"].strip()) or "未命名"}</h2>')
        for j, item in enumerate(sec["items"]):
            ip = f"{path}.items.{j}"
            out.append(f'<div class="item" data-path="{ip}">{_item_head(item, ip + ".head")}')
            out += _text_html(item["text"], ip + ".text")
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


def png_bytes(page_html: str) -> bytes:
    """和 PDF 同一份 HTML 截图：A4 宽 794px、2 倍像素，只截 main.resume，超过一页就是长图。"""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = _launch(playwright)
        try:
            page = browser.new_page(viewport={"width": 794, "height": 1123}, device_scale_factor=2)
            page.set_content(page_html, wait_until="load")
            return page.locator("main.resume").screenshot(type="png")
        finally:
            browser.close()


def page_count(page_html: str) -> float:
    """和 PDF 同一份 HTML，在 A4 宽度下量 main.resume 的高度，按 A4 页高（1123px）折成页数。"""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = _launch(playwright)
        try:
            page = browser.new_page(viewport={"width": 794, "height": 1123})
            page.set_content(page_html, wait_until="load")
            height = page.locator("main.resume").evaluate("el => el.scrollHeight")
            return round(float(height) / 1123, 2)
        finally:
            browser.close()



def doc_html(doc: dict) -> str:
    profile = store.first("profile") or {}
    style = resolve_style(doc.get("style"), doc.get("template"))
    return render_html(resume_of(doc), style, profile.get("photo"), file_name(doc)[:-4])


def safe_stem(name: str) -> str:
    """文件名只替换 Windows 不允许的字符；空白压成一个空格，不改成下划线（JD 里的岗位名常带空格）。"""
    stem = re.sub(r"[\\/:*?\"<>|]+", "_", name or "")
    return re.sub(r"\s+", " ", stem).strip(" _.")


def file_name(doc: dict) -> str:
    profile = store.first("profile") or {}
    name = "-".join(x for x in (profile.get("name"), doc.get("title") or "简历") if x)
    return (safe_stem(name) or "简历") + ".pdf"
