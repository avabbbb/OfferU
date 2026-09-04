"""Route-independent PDF export for Registry-backed resume operations."""

from __future__ import annotations

from html import escape
from typing import Any

from app.models.models import Resume
from app.services.security_redaction import safe_error_message


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return ", ".join(_text(item) for item in value) if isinstance(value, list) else ""
    return str(value).strip()


def _description(value: Any) -> str:
    if isinstance(value, list):
        items = [_description(item) for item in value]
        return "".join(f"<li>{item}</li>" for item in items if item)
    text = _text(value)
    return escape(text) if text else ""


def _section_item_html(section_type: str, item: dict[str, Any]) -> str:
    if section_type in {"education", "educationExperiences"}:
        title = _text(item.get("school") or item.get("schoolName"))
        subtitle = " / ".join(filter(None, (_text(item.get("degree")), _text(item.get("major")))))
    elif section_type in {"experience", "workExperiences", "internshipExperiences"}:
        title = _text(item.get("position") or item.get("positionName"))
        subtitle = _text(item.get("company") or item.get("companyName"))
    elif section_type in {"project", "projects"}:
        title = _text(item.get("name") or item.get("projectName"))
        subtitle = _text(item.get("role") or item.get("projectRole"))
    elif section_type in {"skill", "skills"}:
        title = _text(item.get("category"))
        subtitle = ", ".join(_text(value) for value in (item.get("items") or []) if _text(value))
    else:
        title = _text(item.get("subtitle") or item.get("title") or item.get("experienceTitle"))
        subtitle = ""
    description = item.get("description")
    if description is None:
        description = item.get("descriptions")
    body = _description(description)
    if isinstance(description, list):
        body = f"<ul>{body}</ul>" if body else ""
    pieces = [f"<div class=\"resume-entry\"><strong>{escape(title)}</strong>"]
    if subtitle:
        pieces.append(f"<span class=\"resume-subtitle\">{escape(subtitle)}</span>")
    if body:
        pieces.append(f"<div class=\"resume-description\">{body}</div>")
    pieces.append("</div>")
    return "".join(pieces)


def build_resume_export_html(resume: Resume) -> str:
    """Build a safe, deterministic HTML representation from one Resume source."""

    contact = resume.contact_json if isinstance(resume.contact_json, dict) else {}
    contact_line = " · ".join(
        escape(_text(contact.get(key)))
        for key in ("phone", "email", "website", "github", "linkedin")
        if _text(contact.get(key))
    )
    style = {"primaryColor": "#1f2937", "bodySize": "11pt", "lineHeight": "1.45"}
    template = getattr(resume, "template", None)
    if template is not None and isinstance(template.css_variables, dict):
        style.update(template.css_variables)
    if isinstance(resume.style_config, dict):
        style.update(resume.style_config)
    primary = escape(_text(style.get("primaryColor")) or "#1f2937")
    body_size = escape(_text(style.get("bodySize")) or "11pt")
    line_height = escape(_text(style.get("lineHeight")) or "1.45")

    sections: list[str] = []
    for section in sorted(resume.sections or [], key=lambda item: item.sort_order or 0):
        if not section.visible:
            continue
        items = section.content_json if isinstance(section.content_json, list) else []
        entries = "".join(
            _section_item_html(section.section_type or "custom", item)
            for item in items
            if isinstance(item, dict)
        )
        if entries:
            sections.append(
                f"<section><h2>{escape(_text(section.title))}</h2>{entries}</section>"
            )

    summary = escape(_text(resume.summary))
    summary_html = f"<section><h2>个人简介</h2><p>{summary}</p></section>" if summary else ""
    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
@page {{ size: A4; margin: 16mm; }}
* {{ box-sizing: border-box; }}
body {{ font-family: "Microsoft YaHei", "PingFang SC", Arial, sans-serif; font-size: {body_size}; line-height: {line_height}; color: #111827; margin: 0; }}
h1 {{ margin: 0; color: {primary}; font-size: 24pt; }}
h2 {{ margin: 14pt 0 6pt; padding-bottom: 2pt; border-bottom: 1px solid {primary}; color: {primary}; font-size: 13pt; }}
p {{ margin: 0 0 6pt; }}
.contact {{ margin-top: 4pt; color: #4b5563; }}
.resume-entry {{ margin: 0 0 7pt; break-inside: avoid; }}
.resume-subtitle {{ margin-left: 8pt; color: #4b5563; }}
.resume-description {{ margin-top: 2pt; }}
ul {{ margin: 2pt 0 0 16pt; padding: 0; }}
</style></head><body>
<header><h1>{escape(_text(resume.user_name))}</h1>{f'<div class="contact">{contact_line}</div>' if contact_line else ''}</header>
{summary_html}{''.join(sections)}
</body></html>"""


async def render_resume_pdf(resume: Resume) -> tuple[bytes, str]:
    """Render with the shared PDF service and fail explicitly if unavailable."""

    from app.services.pdf_exporter import export_resume_to_pdf

    html = build_resume_export_html(resume)
    try:
        return await export_resume_to_pdf(html), "playwright"
    except Exception as playwright_error:
        try:
            import anyio
            from weasyprint import HTML

            pdf = await anyio.to_thread.run_sync(lambda: HTML(string=html).write_pdf())
            return pdf, "weasyprint_fallback"
        except Exception as fallback_error:
            raise RuntimeError(
                "PDF 渲染失败。"
                f"（Playwright: {safe_error_message(playwright_error)}; "
                f"备用渲染器: {safe_error_message(fallback_error)}）"
            ) from fallback_error


__all__ = ["build_resume_export_html", "render_resume_pdf"]
