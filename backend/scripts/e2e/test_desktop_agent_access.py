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


async def verify(executable: Path, artifacts: Path, *, career_run: bool = False) -> dict:
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
    from app.services.agent_bridge import codex_adapter
    from app.services.agent_provider_health import get_provider_health
    from app.runtime_paths import runtime_data_path
    import httpx
    from playwright.async_api import async_playwright, expect

    await init_db()
    if career_run:
        from app.database import async_session
        from app.models.models import Job, Profile
        async with async_session() as db:
            db.add(Job(id=9001, title="Agent Runtime Engineer", company="Acceptance Fixture", source="fixture",
                       raw_description="Build Agent Runtime and permission/audit tools. Python experience required.", hash_key="contextual-native-9001"))
            db.add(Profile(name="Acceptance Fixture", headline="Agent Runtime project; Python tools and permission audit", is_default=True))
            await db.commit()
    workspace = runtime_data_path("agent_integration_probe_workspace")
    workspace.mkdir(parents=True, exist_ok=True)
    content = json.loads(subprocess.check_output(
        [str(executable), "--data-dir", str(data), "cli", "skill"], cwd=workspace,
        timeout=180,
    ))["content"]
    assert "python -m app.cli" not in content and "<offeru-cli>" not in content
    root = workspace / ".agents/skills"
    dist = BACKEND.parent / "frontend/dist"
    assert (dist / "index.html").is_file(), "Build the real frontend first"
    calls, page_errors, career_requests = [], [], []
    native_close = codex_adapter.CodexMainLoopAdapter.close
    async def record_native_close(adapter):
        (artifacts / f"native-events-{adapter.thread_id or 'startup'}.json").write_text(
            json.dumps(adapter.events(), ensure_ascii=False, indent=2), encoding="utf-8")
        await native_close(adapter)
    result = {"status": "failed", "desktop_marker": "simulated", "api": "isolated_asgi", "native_webview": "not_run"}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8766") as client:
        async def route_request(route):
            request = route.request
            url = urlsplit(request.url)
            if url.netloc == "127.0.0.1:8766":
                if request.method == "POST" and url.path == "/api/agent/runtime/runs/stream":
                    career_requests.append(json.loads(request.post_data or "{}"))
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
                 patch.object(agent_integration.AgentIntegrationAdapter, "skill_root", return_value=root), \
                 patch.object(codex_adapter.CodexMainLoopAdapter, "close", record_native_close):
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
                        await expect(connect).to_be_visible(timeout=55000)
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
                        if career_run:
                            result["status"] = "failed"
                            await page.get_by_role("dialog").get_by_role("button", name="Close", exact=True).click()
                            await expect(panel).not_to_be_visible()
                            await page.evaluate("location.hash='/jobs/9001'")
                            dock = page.get_by_test_id("contextual-agent-dock")
                            await dock.get_by_role("button", name="与我的 Agent 处理当前页面", exact=False).click()
                            await expect(dock.get_by_test_id("agent-bound-page")).to_contain_text("#9001", timeout=20000)
                            await dock.get_by_label("当前 Agent Skill").select_option("evaluate_job")
                            await expect(dock.get_by_label("执行 Agent")).to_have_value("external")
                            await dock.locator("textarea").fill("读取当前岗位9001和当前档案，指出已有证据与待确认项，不要给总分。用save_career_artifact提交一份与岗位9001绑定的job_evaluation待审核草稿，然后停止。不要确认、投递或改岗位状态。")
                            await dock.get_by_role("button", name="发送", exact=True).click()
                            for _ in range(340):
                                await asyncio.sleep(1)
                                if career_requests:
                                    from app.services.agent_run_state import load_agent_run
                                    run = await load_agent_run(career_requests[-1]["run_id"])
                                    if run and run["status"] in {"waiting_confirmation", "failed", "completed", "needs_reconciliation"}:
                                        if (run.get("final_result") or {}).get("turn_finished"):
                                            break
                            else:
                                raise TimeoutError("Visible native career Run did not settle")
                            assert run["llm_runtime"]["provider_id"] == "codex", run
                            assert run["status"] == "waiting_confirmation", run
                            steps = [step for step in run["steps"] if step["tool"] == "save_career_artifact"]
                            assert steps and steps[0]["args"]["related_job_id"] == 9001
                            assert steps[0]["status"] == "waiting_confirmation", steps
                            from app.services.codex_run import _worker
                            native_events = _worker.adapter.events()
                            (artifacts / "career-native-events.json").write_text(json.dumps(native_events, ensure_ascii=False, indent=2), encoding="utf-8")
                            native_drafts = [event["params"]["arguments"]["arguments"]["content_markdown"]
                                for event in native_events if event.get("method") == "item/tool/call"
                                and event["params"].get("tool") == "offeru_operation"
                                and event["params"]["arguments"].get("operation") == "save_career_artifact"]
                            assert steps[0]["args"]["content_markdown"] in native_drafts
                            assert career_requests[-1]["context_version"] > 0
                            assert run["context_version"] == career_requests[-1]["context_version"]
                            await expect(dock.get_by_role("button", name="确认", exact=True).first).to_be_visible(timeout=20000)
                            await dock.get_by_text("查看提案内容与依据", exact=True).first.click()
                            await expect(dock.locator("details pre").first).to_contain_text(steps[0]["args"]["content_markdown"])
                            await page.screenshot(path=str(artifacts / "career-proposal.png"), full_page=True)
                            from app.services.agent_run_state import list_agent_run_events
                            events = await list_agent_run_events(run["id"])
                            completed = [event["payload"].get("operation") for event in events if event["type"] == "operation.completed"]
                            assert "get_profile" in completed and "get_job" in completed, completed
                            assert "save_career_artifact" not in completed
                            (artifacts / "career-run.json").write_text(json.dumps(run, ensure_ascii=False, indent=2), encoding="utf-8")
                            (artifacts / "career-events.json").write_text(json.dumps(events, ensure_ascii=False, indent=2), encoding="utf-8")
                            result.update(status="passed", career_run=run["id"], career_provider="codex", career_model=run["llm_runtime"].get("model"),
                                          career_operations=completed, proposal_target=9001, human_confirmation="not_performed", fixture_career_data=True)
                    finally:
                        result["page_errors"] = page_errors
                        if result["status"] != "passed":
                            await page.screenshot(path=str(artifacts / "failed.png"), full_page=True)
                            (artifacts / "page.txt").write_text(await page.locator("body").inner_text(), encoding="utf-8")
                        await browser.close()
        finally:
            if career_run:
                from app.services.codex_run import _worker
                if _worker.active_run_id:
                    await _worker.dispose_run(_worker.active_run_id)
            (artifacts / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            (artifacts / "requests.json").write_text(json.dumps(calls, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--executable", type=Path, required=True)
    parser.add_argument("--artifacts", type=Path, required=True)
    parser.add_argument("--career-run", action="store_true")
    args = parser.parse_args()
    print(json.dumps(asyncio.run(verify(args.executable.resolve(), args.artifacts.resolve(), career_run=args.career_run)), ensure_ascii=False))
