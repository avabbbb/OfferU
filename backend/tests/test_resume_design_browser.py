"""Opt-in browser + real Registry/SQLite/export regression; no production DB or human confirmation.

Run with OFFERU_RESUME_BROWSER_TEST=1 and the local frontend ready on 7410.
All resume requests execute real ASGI routes; unrelated shell APIs are fixtures.
"""
import asyncio
import os
from pathlib import Path
from contextlib import ExitStack
from urllib.parse import urlsplit
from unittest.mock import patch

import httpx
import pytest
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from PIL import Image
from sqlalchemy import select

from app.database import get_db
from app.models.models import Resume
from app.routes.resume import router
from test_resume_design import scenario


@pytest.mark.skipif(os.environ.get("OFFERU_RESUME_BROWSER_TEST") != "1", reason="requires managed Chromium and frontend 7410")
def test_editor_persists_assets_restores_versions_and_exports(tmp_path):
    from playwright.async_api import async_playwright, expect
    import pymupdf

    async def check(sessions, resume_id):
        async with httpx.AsyncClient(trust_env=False, timeout=5) as ready:
            (await ready.get("http://127.0.0.1:7410")).raise_for_status()
        uploads = tmp_path / "uploads"
        uploads.mkdir()
        app = FastAPI()
        app.include_router(router, prefix="/api/resume")
        app.mount("/uploads", StaticFiles(directory=uploads), name="uploads")
        async def db_override():
            async with sessions() as db:
                yield db
        app.dependency_overrides[get_db] = db_override
        image_paths = []
        for kind, color in (("photo", "navy"), ("logo", "red")):
            path = tmp_path / f"{kind}.png"
            Image.new("RGB", (40, 60), color).save(path)
            image_paths.append(path)
        with ExitStack() as patches:
            patches.enter_context(patch("app.services.resume_workspace.async_session", sessions))
            patches.enter_context(patch("app.services.resume_export.runtime_uploads_dir", return_value=uploads))
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8766") as client, async_playwright() as pw:
                browser = await pw.chromium.launch(headless=True)
                context = await browser.new_context(viewport={"width": 1800, "height": 1200}, service_workers="block", accept_downloads=True)
                await context.add_init_script("localStorage.setItem('offeru_onboarding',JSON.stringify({wizardCompleted:true,wizardSkipped:false,wizardStep:0}))")
                failures = []
                async def bridge(route):
                    request = route.request
                    path = urlsplit(request.url).path
                    if path.startswith(("/api/resume", "/uploads/")):
                        response = await client.request(request.method, path, content=request.post_data_buffer,
                                                        headers={"content-type": request.headers.get("content-type", "application/json")})
                        if response.status_code >= 400:
                            failures.append(f"{request.method} {path}: {response.status_code} {response.text[:300]}")
                        await route.fulfill(status=response.status_code, body=response.content,
                                            content_type=response.headers.get("content-type", "application/json"),
                                            headers={"Access-Control-Allow-Origin": "http://127.0.0.1:7410"})
                    elif path == "/api/health":
                        await route.fulfill(json={"status": "ok", "service": "OfferU", "runtime": "python", "version": "0.4.0"})
                    elif path.startswith("/api/"):
                        await route.fulfill(json={})
                    else:
                        await route.continue_()
                await context.route("**/*", bridge)
                page = await context.new_page()
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                try:
                    await page.goto(f"http://127.0.0.1:7410/#/resume/{resume_id}")
                    await page.get_by_test_id("resume-panel-design").click()
                    await page.get_by_label("标题颜色", exact=True).fill("#7c3aed")
                    await page.get_by_label("正文字号 (pt)", exact=True).fill("10.75")
                    await page.get_by_label("正文字号 (pt)", exact=True).blur()
                    await expect(page.get_by_test_id("resume-save-status")).to_have_text("已保存")
                    for label, path in zip(("上传照片", "上传校徽"), image_paths):
                        await page.get_by_label(label, exact=True).set_input_files(path)
                        await expect(page.get_by_label(label, exact=True)).to_be_enabled()
                    await expect(page.locator(".resume-body img")).to_have_count(2)
                    await page.reload()
                    await page.get_by_test_id("resume-panel-design").click()
                    await expect(page.get_by_label("正文字号 (pt)", exact=True)).to_have_value("10.75")
                    await expect(page.locator(".resume-body img")).to_have_count(2)
                    await expect(page.locator(".reference-section-title").first).to_have_css("color", "rgb(124, 58, 237)")
                    async with page.expect_download() as download_info:
                        await page.get_by_test_id("resume-export-pdf").click()
                    download = await download_info.value
                    pdf_path = tmp_path / "persisted-export.pdf"
                    await download.save_as(pdf_path)
                    with pymupdf.open(pdf_path) as pdf:
                        assert len(pdf) == 1
                        assert len(pdf[0].get_images()) == 2
                        assert "未经修改的正文" in pdf[0].get_text()
                        spans = [span for block in pdf[0].get_text("dict")["blocks"] if block["type"] == 0
                                 for line in block["lines"] for span in line["spans"]]
                        assert any("经历" in span["text"] and span["color"] == 0x7c3aed for span in spans)
                    await page.get_by_role("button", name="移除校徽", exact=True).click()
                    await expect(page.get_by_label("上传校徽", exact=True)).to_be_enabled()
                    await expect(page.locator(".resume-body img")).to_have_count(1)
                    await page.get_by_test_id("resume-panel-versions").click()
                    # Latest entry is post-removal; the next is the preserved pre-removal version.
                    await page.get_by_role("button", name="恢复此版本", exact=True).nth(1).click()
                    await expect(page.locator(".resume-body img")).to_have_count(2)
                    await page.screenshot(path=str(tmp_path / "editor-persisted.png"), full_page=True)
                    async with sessions() as db:
                        resume = (await db.execute(select(Resume).where(Resume.id == resume_id))).scalar_one()
                        assert resume.style_config["accentColorHex"] == "#7c3aed"
                        assert resume.contact_json["schoolLogoUrl"]
                    assert not failures, failures
                    assert not errors, errors
                except Exception:
                    await page.screenshot(path=str(tmp_path / "browser-failure.png"), full_page=True)
                    print("API failures:", failures, "page errors:", errors)
                    raise
                finally:
                    await browser.close()
    asyncio.run(scenario(tmp_path, check))


@pytest.mark.skipif(os.environ.get("OFFERU_RESUME_BROWSER_TEST") != "1", reason="requires managed Chromium and built frontend")
def test_bundled_export_without_network_or_frontend_server(tmp_path):
    from app.services import resume_export
    from playwright.async_api import Route
    import pymupdf

    frontend = Path(__file__).resolve().parents[2] / "frontend" / "dist"
    assert (frontend / "index.html").is_file(), "Build the frontend first"
    for name, color in (("photo", "navy"), ("logo", "red")):
        Image.new("RGB", (40, 60), color).save(tmp_path / f"{name}.png")
    snapshot = {"id": 1, "user_name": "离线排版测试", "title": "简历", "summary": "保留正文",
                "photo_url": "/uploads/photo.png", "contact_json": {"schoolLogoUrl": "/uploads/logo.png"},
                "style_config": {"template": "reference", "accentColorHex": "#7c3aed"},
                "sections": [{"id": 1, "section_type": "custom", "title": "经历", "visible": True, "sort_order": 0,
                              "content_json": [{"description": "<p><strong>保留加粗</strong></p>"}]}]}
    with patch.object(resume_export, "packaged_resource_dir", return_value=tmp_path), \
         patch.object(resume_export, "resume_frontend_dir", return_value=frontend), \
         patch.object(resume_export, "runtime_uploads_dir", return_value=tmp_path), \
         patch.object(resume_export.httpx, "AsyncClient", side_effect=AssertionError("No HTTP client allowed")), \
         patch.object(Route, "continue_", side_effect=AssertionError("No browser network allowed")):
        pdf_bytes = asyncio.run(resume_export.render_resume_snapshot_pdf(snapshot))
    (tmp_path / "offline-resume.pdf").write_bytes(pdf_bytes)
    with pymupdf.open(stream=pdf_bytes, filetype="pdf") as pdf:
        assert len(pdf) == 1 and len(pdf[0].get_images()) == 2
        assert "离线排版测试" in pdf[0].get_text() and "保留加粗" in pdf[0].get_text()
        spans = [span for block in pdf[0].get_text("dict")["blocks"] if block["type"] == 0 for line in block["lines"] for span in line["spans"]]
        assert any("经历" in span["text"] and span["color"] == 0x7c3aed for span in spans)
        pdf[0].get_pixmap().save(tmp_path / "offline-resume.png")
