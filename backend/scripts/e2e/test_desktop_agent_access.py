"""Mounted React + isolated API/SQLite + native Codex connection acceptance.

The Desktop marker is simulated. This does not certify Tauri installation,
native webview IPC, career execution, or independent human confirmation.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import mimetypes
import os
import re
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch
from urllib.parse import urlsplit

BACKEND = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BACKEND))


async def verify(executable: Path, artifacts: Path) -> dict:
    if os.name == "nt" and artifacts.drive.upper() == "C:":
        raise ValueError("Use non-system-drive acceptance storage")
    artifacts.mkdir(parents=True, exist_ok=True)
    data = artifacts / "data"
    os.environ.update(OFFERU_DATA_DIR=str(data), TEMP=str(artifacts), TMP=str(artifacts),
                      CORS_ORIGINS="http://127.0.0.1:7410")
    os.environ.pop("DATABASE_URL", None)
    from app.database import init_db
    from app.main import app
    from app.services import agent_integration, agent_connection
    from app.services.agent_provider_health import get_provider_health
    from app.runtime_paths import runtime_data_path
    import httpx
    from playwright.async_api import async_playwright, expect

    await init_db()
    workspace = runtime_data_path("agent_integration_probe_workspace")
    workspace.mkdir(parents=True, exist_ok=True)
    content = json.loads(subprocess.check_output(
        [str(executable), "--data-dir", str(data), "cli", "skill"], cwd=workspace,
        timeout=60,
    ))["content"]
    assert "python -m app.cli" not in content and "<offeru-cli>" not in content
    root = workspace / ".agents/skills"
    dist = BACKEND.parent / "frontend/dist"
    assert (dist / "index.html").is_file(), "Build the real frontend first"
    calls, page_errors = [], []
    result = {"status": "failed", "desktop_marker": "simulated", "api": "isolated_asgi", "native_webview": "not_run"}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8766") as client:
        async def route_request(route):
            request = route.request
            url = urlsplit(request.url)
            if url.netloc == "127.0.0.1:8766":
                response = await client.request(request.method, url.path + ("?" + url.query if url.query else ""),
                                                content=request.post_data_buffer, headers=request.headers)
                if "connections" in url.path or "/agent/context" in url.path:
                    calls.append({"method": request.method, "path": url.path, "status": response.status_code,
                                  "body": response.json()})
                headers = {k: v for k, v in response.headers.items() if k not in {"content-length", "content-encoding"}}
                await route.fulfill(status=response.status_code, headers=headers, body=response.content)
            elif url.netloc == "127.0.0.1:7410":
                file = (dist / url.path.lstrip("/")).resolve()
                if not file.is_relative_to(dist.resolve()):
                    await route.abort()
                    return
                if not file.is_file():
                    file = dist / "index.html"
                content_type = {".js": "text/javascript", ".css": "text/css", ".html": "text/html"}.get(file.suffix)
                await route.fulfill(body=file.read_bytes(), content_type=content_type or mimetypes.guess_type(file.name)[0] or "application/octet-stream")
            else:
                await route.abort()  # Never contact or reuse a user's service.

        try:
            with patch.object(agent_integration, "_installed_content", return_value=content), \
                 patch.object(agent_integration.AgentIntegrationAdapter, "skill_root", return_value=root):
                async with async_playwright() as playwright:
                    browser = await playwright.chromium.launch(headless=True)
                    try:
                        page = await browser.new_page(viewport={"width": 1440, "height": 1000})
                        page.on("pageerror", lambda exc: page_errors.append(str(exc)))
                        await page.add_init_script("window.isTauri = true; window.__TAURI_INTERNALS__ = {invoke: async () => null};")
                        await page.route("**/*", route_request)
                        await page.goto("http://127.0.0.1:7410/#/settings", wait_until="domcontentloaded")
                        await page.get_by_test_id("agent-connection-status").first.click(timeout=20000)
                        panel = page.get_by_test_id("agent-provider-health-dialog")
                        await expect(panel).to_be_visible()
                        await panel.get_by_role("button", name="发现本机 Agent", exact=True).click()
                        connect = panel.get_by_role("button", name=re.compile(r"^连接 Codex"))
                        await expect(connect).to_be_visible(timeout=25000)
                        await page.screenshot(path=str(artifacts / "discovered.png"), full_page=True)
                        await connect.click()
                        await expect(panel.get_by_text("已验证连接：Agent 已完成真实工具读取。", exact=True)).to_be_visible(timeout=340000)
                        await page.screenshot(path=str(artifacts / "verified.png"), full_page=True)
                        health = await get_provider_health("codex")
                        evidence = health["capabilities"]["connection_check"]["readback_evidence"]
                        assert evidence["successful_calls"] == 1 and evidence["thread_id"] and evidence["turn_id"]
                        agent_connection._CHECKS.clear()
                        refreshed = (await client.get("/api/agent/runtime/connections")).json()
                        codex = next(item for item in refreshed["items"] if item["id"] == "codex")
                        assert codex["connection_verified"] and codex["readback_evidence"] == evidence
                        assert not page_errors, page_errors
                        result.update(status="passed", installed_skill=True, live_readback=evidence,
                                      persistence_after_cache_reset=True, career_mutations=0, page_errors=page_errors)
                    finally:
                        result["page_errors"] = page_errors
                        if result["status"] != "passed":
                            await page.screenshot(path=str(artifacts / "failed.png"), full_page=True)
                            (artifacts / "page.txt").write_text(await page.locator("body").inner_text(), encoding="utf-8")
                        await browser.close()
        finally:
            (artifacts / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            (artifacts / "requests.json").write_text(json.dumps(calls, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--executable", type=Path, required=True)
    parser.add_argument("--artifacts", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(asyncio.run(verify(args.executable.resolve(), args.artifacts.resolve())), ensure_ascii=False))
