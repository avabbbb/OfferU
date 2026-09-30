"""Opt-in frozen-product/live-Codex readback; never career or human-approval E2E."""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import urllib.request

BACKEND = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BACKEND))


async def verify(executable: Path, artifacts: Path, *, asgi: bool = False) -> dict:
    artifacts = artifacts.resolve()
    if os.name == "nt" and artifacts.drive.upper() == "C:":
        raise ValueError("Acceptance artifacts must use non-system-drive storage")
    artifacts.mkdir(parents=True, exist_ok=True)
    data = artifacts / "data"
    work = artifacts / "workspace"
    work.mkdir(exist_ok=True)
    environment = {**os.environ, "OFFERU_DATA_DIR": str(data), "TEMP": str(artifacts), "TMP": str(artifacts)}
    environment.pop("DATABASE_URL", None)

    def command(*args: str) -> dict:
        output = subprocess.check_output(
            [str(executable), "--data-dir", str(data), "cli", *args],
            cwd=work, env=environment, timeout=60,
        )
        return json.loads(output)

    client = None
    if asgi:
        os.environ.update(environment)
        os.environ.pop("DATABASE_URL", None)
        from app.database import init_db
        from app.main import app
        import httpx
        await init_db()
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8766")

    async def http(path: str, body: dict | None = None) -> bytes:
        if client is not None:
            response = await client.request("PUT" if body is not None else "GET", path, json=body,
                                            headers={"Origin": "http://127.0.0.1:7410"})
            response.raise_for_status()
            return response.content
        request = urllib.request.Request(
            "http://127.0.0.1:8766" + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Content-Type": "application/json", "Origin": "http://127.0.0.1:7410"},
            method="PUT" if body is not None else "GET",
        )
        # Isolated loopback service; do not inherit a system web proxy.
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=3) as response:
            return response.read()

    if not asgi:
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 8766))  # Fail instead of stopping/reusing a user's service.
    with (artifacts / "runtime.log").open("w", encoding="utf-8") as log:
        process = None if asgi else subprocess.Popen(
            [str(executable), "--data-dir", str(data), "serve"], cwd=work, env=environment,
            stdout=log, stderr=log,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        adapter = None
        result = {"scope": "frozen CLI and live model-issued bootstrap only", "status": "failed",
                  "frozen_api": not asgi, "asgi_api": asgi}
        try:
            for _ in range(120):
                if process is not None and process.poll() is not None:
                    raise RuntimeError("Isolated frozen service exited")
                try:
                    health = json.loads(await http("/api/health"))
                    if health.get("service") == "OfferU":
                        break
                except (OSError, ValueError):
                    pass
                await asyncio.sleep(.5)
            else:
                raise TimeoutError("Isolated service did not become ready")
            context = json.loads(await http("/api/agent/context", {
                "route": "/jobs/9001", "title": "Binding fixture job",
                "entity_type": "job", "entity_id": "9001", "updated_by": "ui",
            }))
            assert context["ok"] and context["outputs"]["entity_id"] == "9001"
            content = (await asyncio.to_thread(command, "skill"))["content"]
            assert "python -m app.cli" not in content and "<offeru-cli>" not in content
            skill_path = work / ".agents/skills/offeru/SKILL.md"
            skill_path.parent.mkdir(parents=True, exist_ok=True)
            skill_path.write_text(content, encoding="utf-8")
            manifest = await asyncio.to_thread(command, "manifest")
            assert manifest["tool_contract"]["version"] == "offeru.tool-contract.v1"
            assert "-m app.cli" not in manifest["commands"]["manifest"]
            assert manifest["operations"] == []
            schema = await asyncio.to_thread(command, "schema", "get_current_view")
            assert schema["ok"]
            result.update(frozen_cli=True, bound_skill=True)

            from app.services.agent_bridge.codex_adapter import CodexMainLoopAdapter
            adapter = CodexMainLoopAdapter(turn_timeout=180, thread_params={
                "ephemeral": True,
                "config": {"developer_instructions": "Only use get_current_view. No shell, mutation or other career reads."},
            })
            await adapter.start()
            skills = await adapter.list_skills(cwd=str(work), force_reload=True)
            assert any(item.get("name") == "offeru" and Path(item.get("path", "")).resolve() == skill_path for item in skills)
            names = {str(event.get("params", {}).get("name") or "") for event in adapter.events()
                     if event.get("method") == "mcpServer/startupStatus/updated"}
            adapter.thread_params["config"]["mcp_servers"] = {name: {"enabled": False} for name in names if name}
            calls = []

            async def operation(name: str, args: dict) -> dict:
                if name != "get_current_view":
                    raise ValueError("Bootstrap only permits get_current_view")
                response = await asyncio.to_thread(command, "run", name, "--args", json.dumps(args))
                assert response["ok"]
                calls.append({"operation": name, "outputs": response["outputs"]})
                return response["outputs"]

            adapter.on_operation = operation
            thread = await adapter.create_thread(cwd=str(work), tool_descriptions=[
                "get_current_view(scope: string = default) — Read the current page and explicit selection only.",
            ])
            response = await adapter.start_turn(cwd=str(work), skill={"type": "skill", "name": "offeru", "path": str(skill_path)},
                prompt="通过 OfferU connection_bootstrap 和本轮 get_current_view 工具读取当前页面，报告实际标题与实体 ID，然后停止。不要读取其他资料或执行写操作。")
            assert calls and calls[0]["outputs"]["entity_id"] == "9001"
            assert "9001" in response["finalMessage"]
            assert thread["model"]  # Native thread response, not a hard-coded model label.
            result.update(status="passed", model=thread["model"], thread_id=response["threadId"], turn_id=response["turnId"],
                          operations=[item["operation"] for item in calls], skill_discovered=True)
            (artifacts / "calls.json").write_text(json.dumps(calls, ensure_ascii=False, indent=2), encoding="utf-8")
            (artifacts / "native-events.json").write_text(json.dumps(adapter.events(), ensure_ascii=False), encoding="utf-8")
        except Exception as exc:
            from app.services.security_redaction import safe_error_message
            result["error"] = safe_error_message(exc)
            raise
        finally:
            if adapter is not None:
                await adapter.close()
            if client is not None:
                await client.aclose()
            if process is not None:
                import psutil
                try:
                    for child in reversed(psutil.Process(process.pid).children(recursive=True)):
                        child.terminate()
                    process.terminate()
                    process.wait(timeout=10)
                except (psutil.NoSuchProcess, subprocess.TimeoutExpired):
                    pass
            (artifacts / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--executable", required=True, type=Path)
    parser.add_argument("--artifacts", required=True, type=Path)
    parser.add_argument("--asgi", action="store_true", help="Isolated in-process API; does not certify frozen API serving")
    args = parser.parse_args()
    print(json.dumps(asyncio.run(verify(args.executable.resolve(), args.artifacts, asgi=args.asgi)), ensure_ascii=False))
