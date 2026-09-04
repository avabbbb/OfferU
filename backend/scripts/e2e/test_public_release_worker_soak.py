"""Run a bounded real-backend CareerTask worker matrix in an isolated workspace.

This is intentionally separate from the UI smoke: it drives the public HTTP
surface, waits for the durable worker result, and validates the persisted task
and automation counts without touching the database directly.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from typing import Any

import httpx

from release_endpoints import is_offeru_health_payload, release_api_url, release_version

API_URL = release_api_url()
CYCLES = max(1, int(os.getenv("OFFERU_WORKER_SOAK_CYCLES", "100")))
POLL_SECONDS = max(0.05, float(os.getenv("OFFERU_WORKER_SOAK_POLL_SECONDS", "0.1")))
TASK_TIMEOUT_SECONDS = max(
    5.0,
    float(os.getenv("OFFERU_WORKER_SOAK_TASK_TIMEOUT_SECONDS", "60")),
)


def _request(client: httpx.Client, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
    response = client.request(method, f"{API_URL}{path}", **kwargs)
    if not response.is_success:
        raise AssertionError(f"{method} {path} failed: {response.status_code}")
    payload = response.json()
    if not isinstance(payload, dict):
        raise AssertionError(f"{method} {path} returned a non-object payload")
    return payload


def _wait_for_task(client: httpx.Client, job_id: int) -> dict[str, Any]:
    deadline = time.monotonic() + TASK_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        payload = _request(
            client,
            "GET",
            f"/api/agent/runtime/career-tasks?target_type=job&target_id={job_id}&limit=10",
        )
        task = next(
            (
                item
                for item in payload.get("tasks", [])
                if isinstance(item, dict) and item.get("task_type") == "role_intelligence"
            ),
            None,
        )
        if isinstance(task, dict) and task.get("status") in {
            "completed",
            "failed",
            "blocked",
            "cancelled",
        }:
            return task
        time.sleep(POLL_SECONDS)
    raise AssertionError(f"CareerTask for job {job_id} did not reach a terminal state")


def _job_payload(run_key: str, index: int) -> dict[str, Any]:
    title = f"AI 产品经理 Worker {index:03d}"
    company = f"Worker Orbit {run_key}-{index:03d}"
    description = "负责 AI 产品规划、用户需求分析、评测体系建设与跨团队交付。"
    digest = hashlib.sha256(
        f"{title}\n{company}\n{description}".encode("utf-8")
    ).hexdigest()
    return {
        "title": title,
        "company": company,
        "source": "manual",
        "raw_description": description,
        "summary": description,
        "hash_key": f"worker-soak:{run_key}:{digest}",
    }


def main() -> None:
    run_key = str(int(time.time() * 1000))
    started_at = time.perf_counter()
    job_ids: list[int] = []
    task_ids: list[str] = []
    statuses: list[str] = []

    with httpx.Client(timeout=30.0, trust_env=False) as client:
        health = _request(client, "GET", "/api/health")
        if not is_offeru_health_payload(
            health,
            expected_version=release_version(),
            expected_build_mode="local-development",
        ):
            raise AssertionError(f"backend is not healthy: {health}")

        for index in range(1, CYCLES + 1):
            response = _request(
                client,
                "POST",
                "/api/jobs/ingest",
                json={
                    "source": "manual",
                    "runtime_provider": "replay",
                    "batch_id": f"worker-soak-{run_key}-{index:03d}",
                    "jobs": [_job_payload(run_key, index)],
                },
            )
            created = response.get("created_job_ids")
            if not isinstance(created, list) or len(created) != 1:
                raise AssertionError(f"cycle {index} did not create exactly one Job: {response}")
            job_id = int(created[0])
            task = _wait_for_task(client, job_id)
            if task.get("status") != "completed":
                raise AssertionError(f"cycle {index} task did not complete: {task}")
            if task.get("runtime_provider") != "replay":
                raise AssertionError(f"cycle {index} used an unexpected provider: {task}")
            if int(task.get("attempt_count") or 0) != 1:
                raise AssertionError(f"cycle {index} retried unexpectedly: {task}")

            events = _request(
                client,
                "GET",
                f"/api/agent/runtime/career-tasks/{task['task_id']}/events?limit=20",
            ).get("events", [])
            event_types = {
                str(item.get("type")) for item in events if isinstance(item, dict)
            }
            if not {"task.queued", "task.started", "task.completed"}.issubset(event_types):
                raise AssertionError(
                    f"cycle {index} lacks durable worker lifecycle events: {event_types}"
                )
            job_ids.append(job_id)
            task_ids.append(str(task["task_id"]))
            statuses.append(str(task["status"]))
            if index % 10 == 0 or index == CYCLES:
                print(f"worker cycles: {index}/{CYCLES}", flush=True)

        jobs = _request(client, "GET", "/api/jobs/?page_size=100")
        matching_jobs = [
            item
            for item in jobs.get("items", [])
            if isinstance(item, dict)
            and str(item.get("company") or "").startswith(f"Worker Orbit {run_key}-")
        ]
        if len(matching_jobs) != CYCLES:
            raise AssertionError(
                f"expected {CYCLES} worker Jobs, found {len(matching_jobs)}"
            )

        tasks = _request(
            client,
            "GET",
            "/api/agent/runtime/career-tasks?task_type=role_intelligence&limit=200",
        )
        matching_tasks = [
            item
            for item in tasks.get("tasks", [])
            if isinstance(item, dict) and str(item.get("task_id")) in set(task_ids)
        ]
        if len(matching_tasks) != CYCLES:
            raise AssertionError(
                f"expected {CYCLES} unique persisted tasks, found {len(matching_tasks)}"
            )

        automation = _request(
            client,
            "GET",
            "/api/agent/runtime/automation/events?event_type=JOB_SAVED&limit=200",
        )
        matching_events = [
            item
            for item in automation.get("events", [])
            if isinstance(item, dict)
            and str(item.get("target_id")) in {str(job_id) for job_id in job_ids}
        ]
        if len(matching_events) != CYCLES:
            raise AssertionError(
                f"expected {CYCLES} unique JOB_SAVED events, found {len(matching_events)}"
            )

        integrity = _request(client, "GET", "/api/agent/data/safety/integrity")
        integrity_check = integrity.get("integrity_check")
        foreign_key_violations = integrity.get("foreign_key_violations")
        integrity_ok = integrity_check == "ok" or integrity_check == ["ok"]
        foreign_keys_ok = foreign_key_violations == 0 or foreign_key_violations == []
        if not integrity_ok or not foreign_keys_ok:
            raise AssertionError(f"worker soak database integrity failed: {integrity}")

    result = {
        "status": "PASS",
        "cycles_requested": CYCLES,
        "cycles_completed": len(statuses),
        "unique_jobs": len(set(job_ids)),
        "unique_tasks": len(set(task_ids)),
        "unique_automation_events": len(matching_events),
        "task_statuses": sorted(set(statuses)),
        "task_attempts": 1,
        "database_integrity": integrity_check,
        "foreign_key_violations": foreign_key_violations,
        "elapsed_seconds": round(time.perf_counter() - started_at, 3),
        "runtime_provider": "replay",
    }
    print(json.dumps(result, ensure_ascii=True, indent=2), flush=True)


if __name__ == "__main__":
    main()
