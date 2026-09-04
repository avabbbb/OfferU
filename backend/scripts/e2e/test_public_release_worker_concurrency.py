"""Verify CareerTask execution claim across two local backend processes.

The test uses the public durable task service from two independent Python
processes sharing one isolated SQLite database.  It does not touch the normal
workspace database and does not require an external provider.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


BACKEND_DIR = Path(__file__).resolve().parents[2]
WORKER_CODE = r'''
import asyncio
import json
import sys

from app.database import init_db
import app.models.models  # noqa: F401 - register the ORM metadata before init_db
from app.services import career_tasks


async def main():
    mode = sys.argv[1]
    task_key = sys.argv[2]
    await init_db()
    if mode == "start":
        result = await career_tasks.start_career_task(
            task_type="agent_turn",
            source="release-concurrency",
            target_type="probe",
            target_id="release-concurrency",
            runtime_provider="replay",
            input={"prompt": "cross-process claim probe"},
            output_contract={"type": "object"},
            idempotency_key=task_key,
        )
    else:
        raise SystemExit(f"unsupported worker mode: {mode}")
    worker = career_tasks._LIVE_TASKS.get(result["task_id"])
    if worker is not None:
        await worker
    print(json.dumps(result, ensure_ascii=True), flush=True)


asyncio.run(main())
'''


def _run_worker(database_url: str, task_key: str) -> subprocess.Popen[str]:
    environment = os.environ.copy()
    environment.update(
        {
            "DATABASE_URL": database_url,
            "OFFERU_ENABLE_MCP": "false",
            "MEMORY_DISTILL_INTERVAL_SECONDS": "0",
            "WORK_SOURCE_AUTO_SYNC_INTERVAL_SECONDS": "0",
        }
    )
    return subprocess.Popen(
        [sys.executable, "-c", WORKER_CODE, "start", task_key],
        cwd=BACKEND_DIR,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def _wait_process(process: subprocess.Popen[str], timeout: float = 60.0) -> dict[str, Any]:
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        process.kill()
        process.communicate()
        raise AssertionError("cross-process CareerTask worker timed out") from exc
    if process.returncode != 0:
        raise AssertionError(
            f"cross-process worker failed with code {process.returncode}: {stderr[-2000:]}"
        )
    lines = [line.strip() for line in stdout.splitlines() if line.strip()]
    if not lines:
        raise AssertionError(f"cross-process worker returned no JSON: {stderr[-2000:]}")
    try:
        payload = json.loads(lines[-1])
    except json.JSONDecodeError as exc:
        raise AssertionError(f"cross-process worker returned invalid JSON: {stdout[-2000:]}") from exc
    if not isinstance(payload, dict):
        raise AssertionError("cross-process worker returned a non-object result")
    return payload


async def _read_result(database_url: str, task_id: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    environment = os.environ.copy()
    environment["DATABASE_URL"] = database_url
    environment["OFFERU_ENABLE_MCP"] = "false"
    environment["MEMORY_DISTILL_INTERVAL_SECONDS"] = "0"
    environment["WORK_SOURCE_AUTO_SYNC_INTERVAL_SECONDS"] = "0"
    script = r'''
import asyncio
import json
import sys

from app.database import init_db
import app.models.models  # noqa: F401 - register the ORM metadata before init_db
from app.services.career_tasks import get_career_task, list_career_task_events


async def main():
    await init_db()
    task_id = sys.argv[1]
    print(json.dumps({"task": await get_career_task(task_id), "events": (await list_career_task_events(task_id, limit=50))["events"]}, ensure_ascii=True))


asyncio.run(main())
'''
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        script,
        task_id,
        cwd=str(BACKEND_DIR),
        env=environment,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=30)
    if process.returncode != 0:
        raise AssertionError(f"result reader failed: {stderr.decode()[-2000:]}")
    payload = json.loads(stdout.decode().splitlines()[-1])
    return payload["task"], payload["events"]


def main() -> None:
    started_at = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="offeru-release-concurrency-") as directory:
        database_path = Path(directory) / "career-task.db"
        database_url = f"sqlite+aiosqlite:///{database_path.as_posix()}"
        environment = os.environ.copy()
        environment["DATABASE_URL"] = database_url
        environment["OFFERU_ENABLE_MCP"] = "false"
        environment["MEMORY_DISTILL_INTERVAL_SECONDS"] = "0"
        environment["WORK_SOURCE_AUTO_SYNC_INTERVAL_SECONDS"] = "0"
        init_process = subprocess.run(
            [
                sys.executable,
                "-c",
                "import asyncio; import app.models.models; from app.database import init_db; asyncio.run(init_db())",
            ],
            cwd=BACKEND_DIR,
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )
        if init_process.returncode != 0:
            raise AssertionError(f"isolated database init failed: {init_process.stderr[-2000:]}")

        task_key = f"release-concurrency:{time.time_ns()}"
        workers = [_run_worker(database_url, task_key) for _ in range(2)]
        results = [_wait_process(worker) for worker in workers]
        task_id = str(results[0].get("task_id") or "")
        if not task_id or any(str(result.get("task_id") or "") != task_id for result in results):
            raise AssertionError(f"workers did not reuse one task: {results}")

        task, events = asyncio.run(_read_result(database_url, task_id))
        event_types = [str(event.get("type")) for event in events]
        if task.get("status") != "completed":
            raise AssertionError(f"cross-process task did not complete: {task}")
        if int(task.get("attempt_count") or 0) != 1:
            raise AssertionError(f"cross-process task executed more than once: {task}")
        if event_types.count("task.started") != 1 or event_types.count("task.completed") != 1:
            raise AssertionError(f"cross-process lifecycle duplicated: {event_types}")

        result = {
            "status": "PASS",
            "workers": 2,
            "task_id": task_id,
            "task_status": task["status"],
            "attempt_count": task["attempt_count"],
            "task_started_events": event_types.count("task.started"),
            "task_completed_events": event_types.count("task.completed"),
            "elapsed_seconds": round(time.perf_counter() - started_at, 3),
        }
        print(json.dumps(result, ensure_ascii=True, indent=2), flush=True)


if __name__ == "__main__":
    main()
