"""Exercise the JOB_SAVED automation claim across independent processes.

The test uses one isolated SQLite database and two backend worker processes.
It verifies that a duplicate signal creates one CareerTask and one inbox
projection, even when both processes receive the same external event.
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
SETUP_CODE = r'''
import asyncio
import json

from app.database import async_session, init_db
from app.models.models import Job


async def main():
    await init_db()
    async with async_session() as db:
        job = Job(
            title="Automation concurrency probe",
            company="OfferU Release",
            source="release-concurrency",
            url="https://example.invalid/release-concurrency",
            raw_description="Replay fixture job for automation claim verification.",
            hash_key="release-automation-concurrency-job",
        )
        db.add(job)
        await db.commit()
        await db.refresh(job)
        print(json.dumps({"job_id": job.id}), flush=True)


asyncio.run(main())
'''
WORKER_CODE = r'''
import asyncio
import json
import sys

from app.database import init_db
from app.services import automation, career_tasks


async def wait_for_task(task_id):
    for _ in range(900):
        snapshot = await career_tasks.get_career_task(task_id)
        if snapshot["status"] in career_tasks.TERMINAL_STATUSES:
            return snapshot
        await asyncio.sleep(0.1)
    raise RuntimeError(f"CareerTask {task_id} did not reach a terminal state")


async def main():
    await init_db()
    result = await automation.record_automation_event(
        event_type="JOB_SAVED",
        source="release-concurrency",
        target_type="job",
        target_id=sys.argv[1],
        payload={"job_id": int(sys.argv[1]), "runtime_provider": "replay"},
        dedupe_key=sys.argv[2],
    )
    event_result = result.get("result") if isinstance(result.get("result"), dict) else {}
    task = event_result.get("task") if isinstance(event_result.get("task"), dict) else {}
    task_id = str(task.get("task_id") or "")
    if task_id:
        worker = career_tasks._LIVE_TASKS.get(task_id)
        if worker is not None:
            await worker
        else:
            await wait_for_task(task_id)
    print(json.dumps({"event": result, "task_id": task_id}, ensure_ascii=True), flush=True)


asyncio.run(main())
'''


def _environment(database_url: str) -> dict[str, str]:
    environment = os.environ.copy()
    environment.update(
        {
            "DATABASE_URL": database_url,
            "OFFERU_ENABLE_MCP": "false",
            "MEMORY_DISTILL_INTERVAL_SECONDS": "0",
            "WORK_SOURCE_AUTO_SYNC_INTERVAL_SECONDS": "0",
        }
    )
    return environment


def _last_json(stdout: str, stderr: str, label: str) -> dict[str, Any]:
    lines = [line.strip() for line in stdout.splitlines() if line.strip()]
    if not lines:
        raise AssertionError(f"{label} returned no JSON: {stderr[-2000:]}")
    try:
        payload = json.loads(lines[-1])
    except json.JSONDecodeError as exc:
        raise AssertionError(f"{label} returned invalid JSON: {stdout[-2000:]}") from exc
    if not isinstance(payload, dict):
        raise AssertionError(f"{label} returned a non-object result")
    return payload


def _run_setup(database_url: str) -> int:
    result = subprocess.run(
        [sys.executable, "-c", SETUP_CODE],
        cwd=BACKEND_DIR,
        env=_environment(database_url),
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(f"automation fixture setup failed: {result.stderr[-2000:]}")
    payload = _last_json(result.stdout, result.stderr, "automation fixture setup")
    job_id = int(payload.get("job_id") or 0)
    if job_id <= 0:
        raise AssertionError(f"automation fixture setup returned invalid job: {payload}")
    return job_id


def _run_worker(database_url: str, job_id: int, dedupe_key: str) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [sys.executable, "-c", WORKER_CODE, str(job_id), dedupe_key],
        cwd=BACKEND_DIR,
        env=_environment(database_url),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def _wait_worker(process: subprocess.Popen[str]) -> dict[str, Any]:
    try:
        stdout, stderr = process.communicate(timeout=90)
    except subprocess.TimeoutExpired as exc:
        process.kill()
        process.communicate()
        raise AssertionError("cross-process automation worker timed out") from exc
    if process.returncode != 0:
        raise AssertionError(
            f"cross-process automation worker failed with code {process.returncode}: "
            f"{stderr[-2000:]}"
        )
    return _last_json(stdout, stderr, "cross-process automation worker")


async def _read_state(database_url: str) -> dict[str, Any]:
    environment = _environment(database_url)
    script = r'''
import asyncio
import json

from sqlalchemy import select

from app.database import async_session, init_db
from app.models.models import AutomationEvent, AutomationInboxItem, CareerTask, CareerTaskEvent


async def main():
    await init_db()
    async with async_session() as db:
        events = (await db.execute(select(AutomationEvent))).scalars().all()
        tasks = (await db.execute(select(CareerTask))).scalars().all()
        inbox = (await db.execute(select(AutomationInboxItem))).scalars().all()
        task_events = (await db.execute(select(CareerTaskEvent))).scalars().all()
    print(json.dumps({
        "events": [{"event_id": item.event_id, "status": item.status, "result": item.result_json} for item in events],
        "tasks": [{"task_id": item.task_id, "status": item.status, "attempt_count": item.attempt_count} for item in tasks],
        "inbox": [{"item_id": item.item_id, "task_id": item.task_id} for item in inbox],
        "task_events": [{"task_id": item.task_id, "event_type": item.event_type} for item in task_events],
    }, ensure_ascii=True))


asyncio.run(main())
'''
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        script,
        cwd=str(BACKEND_DIR),
        env=environment,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=30)
    if process.returncode != 0:
        raise AssertionError(f"automation state reader failed: {stderr.decode()[-2000:]}")
    return _last_json(stdout.decode(), stderr.decode(), "automation state reader")


def main() -> None:
    started_at = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="offeru-release-automation-") as directory:
        database_url = f"sqlite+aiosqlite:///{(Path(directory) / 'automation.db').as_posix()}"
        job_id = _run_setup(database_url)
        dedupe_key = f"release-automation-concurrency:{time.time_ns()}"
        workers = [_run_worker(database_url, job_id, dedupe_key) for _ in range(2)]
        results = [_wait_worker(worker) for worker in workers]
        state = asyncio.run(_read_state(database_url))

    events = state["events"]
    tasks = state["tasks"]
    inbox = state["inbox"]
    task_events = state["task_events"]
    event_types = [str(item["event_type"]) for item in task_events]
    if len(events) != 1 or events[0]["status"] != "completed":
        raise AssertionError(f"automation event was not committed exactly once: {state}")
    if len(tasks) != 1 or tasks[0]["status"] != "completed" or tasks[0]["attempt_count"] != 1:
        raise AssertionError(f"automation task was not executed exactly once: {state}")
    if len(inbox) != 1 or inbox[0]["task_id"] != tasks[0]["task_id"]:
        raise AssertionError(f"automation inbox was duplicated or detached: {state}")
    if event_types.count("task.started") != 1 or event_types.count("task.completed") != 1:
        raise AssertionError(f"task lifecycle was duplicated: {event_types}")
    event_ids = {
        str((result.get("event") or {}).get("event_id") or "")
        for result in results
    }
    if event_ids != {events[0]["event_id"]}:
        raise AssertionError(f"workers did not reuse one automation event: {results}")

    print(
        json.dumps(
            {
                "status": "PASS",
                "workers": 2,
                "automation_event_id": events[0]["event_id"],
                "event_status": events[0]["status"],
                "task_id": tasks[0]["task_id"],
                "task_status": tasks[0]["status"],
                "attempt_count": tasks[0]["attempt_count"],
                "inbox_items": len(inbox),
                "task_started_events": event_types.count("task.started"),
                "task_completed_events": event_types.count("task.completed"),
                "elapsed_seconds": round(time.perf_counter() - started_at, 3),
            },
            ensure_ascii=True,
            indent=2,
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
