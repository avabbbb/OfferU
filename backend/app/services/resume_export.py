"""Render one immutable resume snapshot with the same React template as the editor."""
from __future__ import annotations

import json
import mimetypes
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

import httpx

from app.models.models import Resume
from app.runtime_paths import packaged_resource_dir, resume_frontend_dir, runtime_uploads_dir
from app.services.security_redaction import safe_error_message

FRONTEND_BASE_URL = "http://127.0.0.1:7410"
API_BASE_URL = "http://127.0.0.1:8766"


def resume_render_snapshot(resume: Resume) -> dict:
    """Do not re-read the live record while the browser is rendering an export."""
    return {
        "id": resume.id,
        "user_name": resume.user_name,
        "title": resume.title,
        "photo_url": resume.photo_url or "",
        "summary": resume.summary or "",
        "contact_json": resume.contact_json or {},
        "style_config": resume.style_config or {},
        "sections": [
            {key: getattr(section, key) for key in
             ("id", "section_type", "title", "visible", "sort_order", "content_json")}
            for section in resume.sections
        ],
    }


def local_resume_image(url: str):
    """Only serve existing raster uploads, with the same canonical path boundary."""
    parsed = urlsplit(url)
    if f"{parsed.scheme}://{parsed.netloc}" != API_BASE_URL:
        return None
    path = unquote(parsed.path)
    if not path.startswith("/uploads/"):
        return None
    root = runtime_uploads_dir().resolve()
    target = (root / path.removeprefix("/uploads/")).resolve()
    if not target.is_relative_to(root) or target.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
        return None
    return target if target.is_file() else None


def local_frontend_asset(root: Path, url: str) -> Path | None:
    parsed = urlsplit(url)
    if f"{parsed.scheme}://{parsed.netloc}" != FRONTEND_BASE_URL:
        return None
    root = root.resolve()
    target = (root / (unquote(parsed.path).lstrip("/") or "index.html")).resolve()
    if not target.is_relative_to(root) or target.suffix.lower() not in {".html", ".js", ".mjs", ".json", ".css", ".woff", ".woff2", ".ttf", ".otf", ".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico", ".wasm"}:
        return None
    return target if target.is_file() else None


async def export_frontend_assets() -> Path | None:
    """Release always uses its own build. Development may use a running Vite server."""
    if packaged_resource_dir() is None:
        try:
            async with httpx.AsyncClient(trust_env=False, timeout=2) as client:
                response = await client.get(FRONTEND_BASE_URL, follow_redirects=False)
                if response.status_code == 200:
                    return None
        except httpx.HTTPError:
            pass
    root = resume_frontend_dir()
    if not (root / "index.html").is_file():
        raise RuntimeError("缺少简历排版资源，请修复或重新安装 OfferU；源码环境请先构建前端")
    return root


async def render_resume_snapshot_pdf(snapshot: dict) -> bytes:
    """Use managed Chromium; never downgrade a designed resume to plain text."""
    from playwright.async_api import async_playwright

    assets = await export_frontend_assets()

    resume_id = int(snapshot["id"])
    # Serialize now: subsequent edits must not affect the export in progress.
    payload = json.dumps(snapshot, ensure_ascii=False)
    paper = "Letter" if snapshot.get("style_config", {}).get("pageSize") == "LETTER" else "A4"
    async with async_playwright() as playwright:
        # In frozen builds, use the bundled headless shell; don't set a global env var
        # that would hijack headed browser instances (authorized_research, ui_cli).
        packaged = packaged_resource_dir()
        launch_kwargs: dict = {"headless": True}
        if packaged is not None:
            browsers_root = packaged / "resume-browsers"
            if browsers_root.is_dir():
                # Playwright installs to {browsers_root}/chromium_headless_shell-*/chrome-{win,linux,mac}/headless_shell[.exe]
                shell_dirs = sorted(browsers_root.glob("chromium_headless_shell-*/chrome-*"))
                for sd in shell_dirs:
                    candidate = sd / ("headless_shell.exe" if sys.platform == "win32" else "headless_shell")
                    if candidate.is_file():
                        launch_kwargs["executable_path"] = str(candidate)
                        break
        browser = await playwright.chromium.launch(**launch_kwargs)
        try:
            context = await browser.new_context(service_workers="block")

            async def route_request(route):
                request = route.request
                parsed = urlsplit(request.url)
                origin = f"{parsed.scheme}://{parsed.netloc}"
                if request.method != "GET":
                    await route.abort()
                elif origin == API_BASE_URL and parsed.path.rstrip("/") == f"/api/resume/{resume_id}":
                    await route.fulfill(status=200, content_type="application/json", body=payload,
                                        headers={"Access-Control-Allow-Origin": FRONTEND_BASE_URL})
                elif image_path := local_resume_image(request.url):
                    await route.fulfill(path=str(image_path), content_type=mimetypes.guess_type(str(image_path))[0])
                elif origin == FRONTEND_BASE_URL and not parsed.path.startswith(("/api/", "/uploads/")):
                    if assets is None:
                        await route.continue_()
                    elif asset := local_frontend_asset(assets, request.url):
                        content_type = {".js": "application/javascript", ".mjs": "application/javascript", ".css": "text/css", ".json": "application/json", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".wasm": "application/wasm", ".svg": "image/svg+xml"}.get(asset.suffix.lower()) or mimetypes.guess_type(str(asset))[0] or "application/octet-stream"
                        await route.fulfill(path=str(asset), content_type=content_type)
                    else:
                        await route.abort()
                else:
                    # Printing must not fetch arbitrary URLs from personal content.
                    await route.abort()

            await context.route("**/*", route_request)
            page = await context.new_page()
            await page.goto(f"{FRONTEND_BASE_URL}/#/resume/print/{resume_id}", wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_selector('[data-offeru-print-ready="true"] .resume-body', timeout=15000)
            await page.emulate_media(media="print")
            await page.add_style_tag(content=f"@page {{ size: {paper}; margin: 0; }}")
            await page.evaluate("""async () => {
                await document.fonts.ready;
                await Promise.all(Array.from(document.querySelectorAll('.resume-body img')).map(async (image) => {
                    await image.decode();
                    if (!image.naturalWidth) throw new Error('Resume image failed to load');
                }));
            }""")
            return await page.pdf(format=paper, print_background=True, prefer_css_page_size=True,
                                  margin={"top": "0", "right": "0", "bottom": "0", "left": "0"})
        finally:
            await browser.close()


async def render_resume_pdf(resume: Resume) -> tuple[bytes, str]:
    try:
        return await render_resume_snapshot_pdf(resume_render_snapshot(resume)), "react-preview"
    except Exception as exc:
        raise RuntimeError(
            "PDF 渲染失败，未生成降级版本。请确认 OfferU 排版资源、字体和图片可用。"
            f"（{safe_error_message(exc)}）"
        ) from exc
