"""Isolated API -> persistence -> frozen CLI -> real Codex readback.

This is not native Desktop/installer or human-approval acceptance. The Skill
fixture is rendered from the public router and the real frozen CLI manifest.
Run explicitly with --sidecar <built exe>; never use production Career data.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys


async def verify(sidecar: Path, root: Path) -> None:
    data, work = root / "data", root / "workspace"
    data.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)
    os.environ["OFFERU_DATA_DIR"] = str(data)
    os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{(data / 'djm.db').as_posix()}"
    import httpx
    from app.database import init_db
    from app.main import app
    from app.services.agent_bridge.codex_adapter import CodexMainLoopAdapter
    from app.services.agent_integration import _SOURCE_SKILL

    await init_db()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8766"
    ) as client:
        reply = await client.put("/api/agent/context", json={
            "route": "/jobs/9001", "title": "Binding Fixture Job",
            "entity_type": "job", "entity_id": "9001", "updated_by": "ui",
        }, headers={"Origin": "http://127.0.0.1:7410"})
        reply.raise_for_status()
        assert reply.json()["outputs"]["entity_id"] == "9001"

    prefix = [str(sidecar), "--data-dir", str(data), "cli"]
    manifest = json.loads(await asyncio.to_thread(subprocess.check_output, prefix + ["manifest"], cwd=work, timeout=60))
    assert manifest["tool_contract"]["version"] == "offeru.tool-contract.v1"
    command = manifest["commands"]["manifest"].removesuffix(" manifest --pretty")
    assert "-m app.cli" not in command
    skill = _SOURCE_SKILL.read_text(encoding="utf-8").replace(
        "<!-- offeru-runtime-binding -->", "**Runtime binding:** isolated frozen CLI fixture."
    ).replace("<offeru-cli>", command)
    skill_path = work / ".agents/skills/offeru/SKILL.md"
    skill_path.parent.mkdir(parents=True, exist_ok=True)
    skill_path.write_text(skill, encoding="utf-8")

    calls: list[dict] = []
    adapter = CodexMainLoopAdapter(turn_timeout=120, thread_params={
        "ephemeral": True, "config": {"developer_instructions":
            "For this bootstrap, call the supplied dynamic OfferU get_current_view tool exactly once. "
            "The host executes its Registry request using the frozen CLI. Do not run shell commands, "
            "do not read database/files or other career data, and do not mutate anything."},
    })
    result = {"status": "failed", "scope": "ASGI API, frozen CLI, rendered Skill fixture, real Codex bootstrap"}
    try:
        await asyncio.wait_for(adapter.start(), 60)
        skills = await adapter.list_skills(cwd=str(work), force_reload=True)
        assert any(item.get("name") == "offeru" and Path(item.get("path", "")).resolve() == skill_path for item in skills)

        async def operation(name: str, args: dict) -> dict:
            if name != "get_current_view":
                raise ValueError("Bootstrap only permits get_current_view")
            raw = await asyncio.to_thread(subprocess.check_output,
                prefix + ["run", name, "--args", json.dumps(args)], cwd=work, timeout=60)
            reply = json.loads(raw)
            assert reply["ok"]
            calls.append({"operation": name, "args": args, "outputs": reply["outputs"]})
            return reply["outputs"]

        adapter.on_operation = operation
        names = {str(event.get("params", {}).get("name") or "") for event in adapter.events()
            if event.get("method") == "mcpServer/startupStatus/updated"}
        adapter.thread_params["config"]["mcp_servers"] = {name: {"enabled": False} for name in names if name}
        thread = await adapter.create_thread(cwd=str(work), tool_descriptions=[
            "get_current_view(scope: string = default) — Read current OfferU page and explicit selection only."])
        response = await adapter.start_turn(cwd=str(work),
            skill={"type": "skill", "name": "offeru", "path": str(skill_path)},
            prompt="执行 connection_bootstrap，通过 get_current_view 读取当前页面，回答实际标题和对象 ID，然后停止。不得读其他资料或写入。")
        assert calls and calls[0]["outputs"]["entity_id"] == "9001"
        assert "9001" in response["finalMessage"]
        with sqlite3.connect(f"file:{(data / 'djm.db').as_posix()}?mode=ro", uri=True) as db:
            audits = db.execute("SELECT operation, surface, ok FROM operation_audit_logs").fetchall()
        assert ("set_current_view", "ui", 1) in audits
        assert ("get_current_view", "cli", 1) in audits
        result.update(status="passed", thread_id=response["threadId"], turn_id=response["turnId"],
            model=thread.get("thread", {}).get("model", ""), model_issued_operations=calls, operation_audits=audits)
    except Exception as exc:
        result.update(error_type=type(exc).__name__)
        raise
    finally:
        result["model_issued_operations"] = calls
        (root / "native-events.json").write_text(json.dumps(adapter.events(), ensure_ascii=False, indent=2), encoding="utf-8")
        await adapter.close()
        (root / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--sidecar", type=Path, required=True)
    parser.add_argument("--evidence-dir", type=Path, default=Path("H:/tmp/offeru/agent-contract-bootstrap"))
    args = parser.parse_args()
    root = args.evidence_dir.resolve()
    if not root.is_relative_to(Path("H:/tmp/offeru").resolve()):
        parser.error("Evidence and test state must stay under H:/tmp/offeru")
    sidecar = args.sidecar.resolve(strict=True)
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    asyncio.run(verify(sidecar, root))
