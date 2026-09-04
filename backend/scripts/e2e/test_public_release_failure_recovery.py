"""Verify cross-process CareerTask failure, retry and restart recovery.

The matrix deliberately uses isolated SQLite and deterministic fault injection.
It proves that provider-shaped failures are durable, redacted and retryable,
and that a second backend process can recover a task left running by a
terminated process.  It does not claim that an external provider is healthy.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


BACKEND_DIR = Path(__file__).resolve().parents[2]
CANARY = "OFFERU_RELEASE_CANARY_SECRET_RELIABILITY"

CHILD_CODE = rf'''
import asyncio
import json
import os
import sys
from pathlib import Path

from app.database import init_db
from app.services import career_tasks


async def _no_projection(_task_id):
    return None


async def _fault(task):
    del task
    mode = os.getenv("OFFERU_FAILURE_MODE", "")
    if mode == "auth":
        raise RuntimeError("401 invalid_api_key={CANARY}")
    if mode == "timeout":
        raise TimeoutError("provider network timeout")
    raise RuntimeError(f"unsupported release fault mode: {{mode}}")


async def _hold(task):
    del task
    await asyncio.Event().wait()


async def _wait_for_task(task_id):
    for _ in range(600):
        snapshot = await career_tasks.get_career_task(task_id)
        if snapshot["status"] in career_tasks.TERMINAL_STATUSES:
            return snapshot
        await asyncio.sleep(0.1)
    raise RuntimeError(f"CareerTask {{task_id}} did not reach a terminal state")


def _signal(path, payload):
    if path:
        Path(path).write_text(json.dumps(payload, ensure_ascii=True), encoding="utf-8")


async def main():
    await init_db()
    career_tasks._notify_automation = _no_projection
    mode = sys.argv[1]
    task_key = sys.argv[2]
    signal_path = os.getenv("OFFERU_FAILURE_SIGNAL", "")

    if mode == "start":
        fault_mode = os.getenv("OFFERU_FAILURE_MODE", "")
        if fault_mode in {{"auth", "timeout"}}:
            career_tasks._run_agent_turn = _fault
        result = await career_tasks.start_career_task(
            task_type="agent_turn",
            source="release-failure-recovery",
            target_type="probe",
            target_id="release-failure-recovery",
            runtime_provider="replay",
            input={{"prompt": "release failure recovery probe"}},
            output_contract={{"type": "object"}},
            idempotency_key=task_key,
        )
        task_id = result["task_id"]
        _signal(signal_path, {{"task_id": task_id, "status": result["status"]}})
        if fault_mode == "restart":
            career_tasks._run_agent_turn = _hold
            await asyncio.Event().wait()
        worker = career_tasks._LIVE_TASKS.get(task_id)
        if worker is not None:
            await worker
        final = await career_tasks.get_career_task(task_id)
        print(json.dumps({{"initial": result, "final": final}}, ensure_ascii=True), flush=True)
        return

    if mode == "retry":
        task_id = sys.argv[3]
        result = await career_tasks.retry_career_task(task_id)
        worker = career_tasks._LIVE_TASKS.get(task_id)
        if worker is not None:
            await worker
        final = await _wait_for_task(task_id)
        print(json.dumps({{"retry": result, "final": final}}, ensure_ascii=True), flush=True)
        return

    if mode == "recover-and-retry":
        task_id = sys.argv[3]
        recovery = await career_tasks.recover_career_tasks()
        retry = await career_tasks.retry_career_task(task_id)
        worker = career_tasks._LIVE_TASKS.get(task_id)
        if worker is not None:
            await worker
        final = await _wait_for_task(task_id)
        print(json.dumps({{"recovery": recovery, "retry": retry, "final": final}}, ensure_ascii=True), flush=True)
        return

    raise SystemExit(f"unsupported mode: {{mode}}")


asyncio.run(main())
'''

READ_CODE = r'''
import asyncio
import json
import sys

from app.database import init_db
from app.services.career_tasks import get_career_task, list_career_task_events


async def main():
    await init_db()
    task_id = sys.argv[1]
    print(json.dumps({
        "task": await get_career_task(task_id),
        "events": (await list_career_task_events(task_id, limit=100))["events"],
    }, ensure_ascii=True))


asyncio.run(main())
'''


def _environment(database_url: str, *, signal_path: Path | None = None, failure_mode: str = "") -> dict[str, str]:
    environment = os.environ.copy()
    environment.update(
        {
            "DATABASE_URL": database_url,
            "OFFERU_ENABLE_MCP": "false",
            "MEMORY_DISTILL_INTERVAL_SECONDS": "0",
            "WORK_SOURCE_AUTO_SYNC_INTERVAL_SECONDS": "0",
            "OFFERU_FAILURE_MODE": failure_mode,
        }
    )
    if signal_path is not None:
        environment["OFFERU_FAILURE_SIGNAL"] = str(signal_path)
    else:
        environment.pop("OFFERU_FAILURE_SIGNAL", None)
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


def _run_child(
    database_url: str,
    mode: str,
    task_key: str,
    *,
    task_id: str = "",
    failure_mode: str = "",
) -> dict[str, Any]:
    result = subprocess.run(
        [sys.executable, "-c", CHILD_CODE, mode, task_key, task_id],
        cwd=BACKEND_DIR,
        env=_environment(database_url, failure_mode=failure_mode),
        capture_output=True,
        text=True,
        timeout=90,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"{mode} child failed with code {result.returncode}: {result.stderr[-2000:]}"
        )
    return _last_json(result.stdout, result.stderr, mode)


def _start_restart_child(
    database_url: str,
    task_key: str,
    signal_path: Path,
) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [sys.executable, "-c", CHILD_CODE, "start", task_key, ""],
        cwd=BACKEND_DIR,
        env=_environment(database_url, signal_path=signal_path, failure_mode="restart"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def _read_state(database_url: str, task_id: str) -> dict[str, Any]:
    result = subprocess.run(
        [sys.executable, "-c", READ_CODE, task_id],
        cwd=BACKEND_DIR,
        env=_environment(database_url),
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(f"state reader failed: {result.stderr[-2000:]}")
    return _last_json(result.stdout, result.stderr, "state reader")


def _wait_for_status(database_url: str, task_id: str, status: str) -> dict[str, Any]:
    deadline = time.monotonic() + 30
    last_error = ""
    while time.monotonic() < deadline:
        try:
            state = _read_state(database_url, task_id)
        except AssertionError as exc:
            last_error = str(exc)
            time.sleep(0.2)
            continue
        if state["task"].get("status") == status:
            return state
        time.sleep(0.2)
    raise AssertionError(
        f"CareerTask {task_id} did not reach {status}; last reader error={last_error}"
    )


def _terminate_owned(process: subprocess.Popen[str]) -> tuple[str, str]:
    if process.poll() is None:
        process.terminate()
    try:
        stdout, stderr = process.communicate(timeout=15)
    except subprocess.TimeoutExpired as exc:
        process.kill()
        stdout, stderr = process.communicate(timeout=15)
        raise AssertionError("restart fault-injection child did not terminate") from exc
    return stdout, stderr


def _assert_failure_case(
    database_url: str,
    task_key: str,
    failure_mode: str,
    expected_status: str,
    expected_event: str,
) -> dict[str, Any]:
    first = _run_child(
        database_url,
        "start",
        task_key,
        failure_mode=failure_mode,
    )
    final = first["final"]
    if final.get("status") != expected_status:
        raise AssertionError(f"{failure_mode} did not persist expected status: {first}")
    if final.get("error") != (
        "provider authentication failed" if failure_mode == "auth" else "provider network timeout"
    ):
        raise AssertionError(f"{failure_mode} error was not user-safe: {final}")
    if not final.get("retryable") or int(final.get("attempt_count") or 0) != 1:
        raise AssertionError(f"{failure_mode} was not retryable after first attempt: {final}")
    if CANARY in json.dumps(first, ensure_ascii=True):
        raise AssertionError(f"{failure_mode} leaked the canary")

    task_id = str(final["task_id"])
    retried = _run_child(database_url, "retry", task_key, task_id=task_id)
    retry_final = retried["final"]
    if retry_final.get("status") != "completed":
        raise AssertionError(f"{failure_mode} retry did not complete: {retried}")
    if int(retry_final.get("attempt_count") or 0) != 2:
        raise AssertionError(f"{failure_mode} retry attempt count was wrong: {retry_final}")
    state = _read_state(database_url, task_id)
    event_types = [str(item.get("type")) for item in state["events"]]
    if event_types.count(expected_event) != 1:
        raise AssertionError(f"{failure_mode} failure event was duplicated: {event_types}")
    if event_types.count("task.started") != 2 or event_types.count("task.completed") != 1:
        raise AssertionError(f"{failure_mode} retry lifecycle was not durable: {event_types}")
    return {
        "failure_mode": failure_mode,
        "first_status": final["status"],
        "retry_status": retry_final["status"],
        "attempt_count": retry_final["attempt_count"],
        "failure_event": expected_event,
    }


def _assert_restart_case(database_url: str, task_key: str, signal_path: Path) -> dict[str, Any]:
    process = _start_restart_child(database_url, task_key, signal_path)
    try:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and not signal_path.exists():
            if process.poll() is not None:
                stdout, stderr = process.communicate()
                raise AssertionError(
                    f"restart child exited before signaling: {stdout[-2000:]} {stderr[-2000:]}"
                )
            time.sleep(0.1)
        if not signal_path.exists():
            raise AssertionError("restart child did not create its task signal")
        signal = json.loads(signal_path.read_text(encoding="utf-8"))
        task_id = str(signal.get("task_id") or "")
        if not task_id:
            raise AssertionError(f"restart child signal had no task_id: {signal}")
        _wait_for_status(database_url, task_id, "running")
    finally:
        _terminate_owned(process)

    recovered = _run_child(database_url, "recover-and-retry", task_key, task_id=task_id)
    final = recovered["final"]
    if recovered["recovery"].get("blocked") != 1:
        raise AssertionError(f"restart recovery did not block the interrupted task: {recovered}")
    if final.get("status") != "completed" or int(final.get("attempt_count") or 0) != 2:
        raise AssertionError(f"restart retry did not complete exactly once: {recovered}")
    state = _read_state(database_url, task_id)
    event_types = [str(item.get("type")) for item in state["events"]]
    if event_types.count("task.blocked") != 1 or event_types.count("task.completed") != 1:
        raise AssertionError(f"restart lifecycle was not durable: {event_types}")
    return {
        "failure_mode": "backend_restart",
        "recovery_blocked": recovered["recovery"]["blocked"],
        "final_status": final["status"],
        "attempt_count": final["attempt_count"],
        "task_blocked_events": event_types.count("task.blocked"),
    }


def main() -> None:
    started_at = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="offeru-release-failure-recovery-") as directory:
        database_url = f"sqlite+aiosqlite:///{(Path(directory) / 'failure-recovery.db').as_posix()}"
        cases = [
            _assert_failure_case(
                database_url,
                f"release-failure:auth:{time.time_ns()}",
                "auth",
                "blocked",
                "task.blocked",
            ),
            _assert_failure_case(
                database_url,
                f"release-failure:timeout:{time.time_ns()}",
                "timeout",
                "failed",
                "task.failed",
            ),
        ]
        signal_path = Path(directory) / "restart-signal.json"
        cases.append(
            _assert_restart_case(
                database_url,
                f"release-failure:restart:{time.time_ns()}",
                signal_path,
            )
        )

    print(
        json.dumps(
            {
                "status": "PASS",
                "cases": cases,
                "isolated_database": True,
                "external_provider_claim": False,
                "browser": "none",
                "web_url": "not_used",
                "provider_8080_used": False,
                "elapsed_seconds": round(time.perf_counter() - started_at, 3),
            },
            ensure_ascii=True,
            indent=2,
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
