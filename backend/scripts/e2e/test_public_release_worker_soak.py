"""Run a bounded no-Agent JOB_SAVED CareerTask matrix in an isolated workspace.

This is intentionally separate from the UI smoke: it drives the public HTTP
surface, waits for the durable worker result, and validates the persisted task
and automation counts without touching the database directly. The clean CI
contract is a blocked, retryable Career Director task and no automatic Role
Intelligence task.
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
JOB_PAGE_SIZE = 100
TERMINAL_TASK_STATUSES = {"completed", "failed", "blocked", "cancelled"}


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
                if isinstance(item, dict)
                and item.get("task_type") == "career_director"
                and item.get("input", {}).get("event_type") == "JOB_SAVED"
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


def _list_jobs_for_run(client: httpx.Client, run_key: str) -> list[dict[str, Any]]:
    """Read this run's Jobs through the public list view, independent of unrelated rows."""

    keyword = f"Worker Orbit {run_key}-"
    jobs: list[dict[str, Any]] = []
    total: int | None = None
    page = 1

    while total is None or len(jobs) < total:
        payload = _request(
            client,
            "GET",
            "/api/jobs/",
            params={"keyword": keyword, "page": page, "page_size": JOB_PAGE_SIZE},
        )
        page_total = payload.get("total")
        page_items = payload.get("items")
        if not isinstance(page_total, int) or not isinstance(page_items, list):
            raise AssertionError(f"Job list returned an invalid page: {payload}")
        if total is not None and page_total != total:
            raise AssertionError(
                f"Job list total changed during pagination: {total} -> {page_total}"
            )
        if any(not isinstance(item, dict) for item in page_items):
            raise AssertionError(f"Job list returned a non-object item: {page_items}")
        total = page_total
        if not page_items and len(jobs) < total:
            raise AssertionError(
                f"Job list page {page} was empty before reaching total {total}"
            )
        jobs.extend(page_items)
        page += 1

    return jobs


def _wait_for_role_tasks(
    client: httpx.Client,
    job_target_ids: set[str],
) -> list[dict[str, Any]]:
    deadline = time.monotonic() + TASK_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        payload = _request(
            client,
            "GET",
            "/api/agent/runtime/career-tasks?task_type=role_intelligence&limit=200",
        )
        tasks = payload.get("tasks", [])
        if not isinstance(tasks, list):
            raise AssertionError(f"Role Intelligence task list is invalid: {payload}")
        matching = [
            item
            for item in tasks
            if isinstance(item, dict) and str(item.get("target_id")) in job_target_ids
        ]
        target_counts: dict[str, int] = {}
        for item in matching:
            target_id = str(item.get("target_id"))
            target_counts[target_id] = target_counts.get(target_id, 0) + 1
        duplicate_targets = sorted(
            target_id for target_id, count in target_counts.items() if count > 1
        )
        if duplicate_targets:
            raise AssertionError(
                f"duplicate Role Intelligence tasks for Jobs: {duplicate_targets}"
            )
        if (
            set(target_counts) == job_target_ids
            and all(item.get("status") in TERMINAL_TASK_STATUSES for item in matching)
        ):
            return matching
        time.sleep(POLL_SECONDS)
    raise AssertionError(
        f"Role Intelligence tasks did not reach terminal states for "
        f"{len(job_target_ids)} Jobs; found {len(target_counts)} targets"
    )


def main() -> None:
    run_key = str(int(time.time() * 1000))
    started_at = time.perf_counter()
    job_ids: list[int] = []
    job_target_ids: set[str] = set()
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
            job_target_ids.add(str(job_id))
            task = _wait_for_task(client, job_id)
            if task.get("status") != "blocked":
                raise AssertionError(f"cycle {index} must expose unavailable Agent: {task}")
            if task.get("runtime_provider") != "embedded":
                raise AssertionError(f"cycle {index} used an unexpected Career Director: {task}")
            if not task.get("retryable") or "岗位已保存" not in str(task.get("error") or ""):
                raise AssertionError(f"cycle {index} hid the no-Agent recovery state: {task}")
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
            if not {"task.queued", "task.started", "task.blocked"}.issubset(event_types):
                raise AssertionError(
                    f"cycle {index} lacks durable worker lifecycle events: {event_types}"
                )
            job_ids.append(job_id)
            task_ids.append(str(task["task_id"]))
            statuses.append(str(task["status"]))
            if index % 10 == 0 or index == CYCLES:
                print(f"worker cycles: {index}/{CYCLES}", flush=True)

        matching_jobs = _list_jobs_for_run(client, run_key)
        if len(matching_jobs) != CYCLES:
            raise AssertionError(
                f"expected {CYCLES} worker Jobs, found {len(matching_jobs)}"
            )
        expected_job_ids = {str(job_id) for job_id in job_ids}
        listed_job_ids = [str(item.get("id")) for item in matching_jobs]
        if len(set(listed_job_ids)) != CYCLES or set(listed_job_ids) != expected_job_ids:
            raise AssertionError(
                "worker Job listing did not return each created Job exactly once: "
                f"expected={len(expected_job_ids)}, actual={len(set(listed_job_ids))}"
            )
        if any(
            not str(item.get("company") or "").startswith(f"Worker Orbit {run_key}-")
            for item in matching_jobs
        ):
            raise AssertionError("worker Job listing included a Job outside this run")

        tasks = _request(
            client,
            "GET",
            "/api/agent/runtime/career-tasks?task_type=career_director&limit=200",
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
            and str(item.get("target_id")) in job_target_ids
        ]
        if len(matching_events) != CYCLES:
            raise AssertionError(
                f"expected {CYCLES} unique JOB_SAVED events, found {len(matching_events)}"
            )
        events_by_job: dict[str, dict[str, Any]] = {}
        for event in matching_events:
            target_id = str(event.get("target_id") or "")
            if target_id in events_by_job:
                raise AssertionError(f"Job {target_id} has duplicate JOB_SAVED events")
            if event.get("status") != "dispatched":
                raise AssertionError(
                    f"JOB_SAVED event for Job {target_id} was not durably dispatched"
                )
            events_by_job[target_id] = event
        if set(events_by_job) != job_target_ids:
            raise AssertionError("JOB_SAVED events do not cover every worker Job exactly once")

        role_tasks = _wait_for_role_tasks(client, job_target_ids)
        if len(role_tasks) != CYCLES:
            raise AssertionError(
                f"expected one Role Intelligence task per Job, found {len(role_tasks)}"
            )
        role_task_ids: set[str] = set()
        role_task_statuses: list[str] = []
        for task in role_tasks:
            target_id = str(task.get("target_id") or "")
            event = events_by_job[target_id]
            task_input = task.get("input") if isinstance(task.get("input"), dict) else {}
            task_id = str(task.get("task_id") or "")
            if not task_id or task_id in role_task_ids:
                raise AssertionError("Role Intelligence tasks did not have unique task IDs")
            role_task_ids.add(task_id)
            if task.get("task_type") != "role_intelligence" or task.get("source") != "automation":
                raise AssertionError(f"Job {target_id} has an unexpected Role Intelligence task: {task}")
            if task.get("runtime_provider") != "replay":
                raise AssertionError(
                    f"Role Intelligence task {task_id} used an unexpected provider"
                )
            if (
                str(task_input.get("job_id") or "") != target_id
                or task_input.get("automation_event_id") != event.get("event_id")
            ):
                raise AssertionError(
                    f"Role Intelligence task {task_id} is not bound to its JOB_SAVED event"
                )
            event_result = event.get("result") if isinstance(event.get("result"), dict) else {}
            event_role_task = event_result.get("role_intelligence_task")
            if not isinstance(event_role_task, dict) or event_role_task.get("task_id") != task_id:
                raise AssertionError(
                    f"JOB_SAVED event {event.get('event_id')} lacks the Role Intelligence task receipt"
                )

            status = str(task.get("status") or "")
            role_task_statuses.append(status)
            attempt_count = int(task.get("attempt_count") or 0)
            max_attempts = int(task.get("max_attempts") or 0)
            if max_attempts < 1 or attempt_count > max_attempts:
                raise AssertionError(f"Role Intelligence task {task_id} exceeded its retry bound")
            if status == "completed":
                result = task.get("result") if isinstance(task.get("result"), dict) else {}
                benchmark = result.get("benchmark") if isinstance(result.get("benchmark"), dict) else {}
                if (
                    int(result.get("job_id") or 0) != int(target_id)
                    or not result.get("benchmark_run_id")
                    or benchmark.get("status") != "completed"
                    or task.get("result_ref") != f"career-task:{task_id}"
                    or attempt_count < 1
                    or task.get("retryable")
                ):
                    raise AssertionError(
                        f"Role Intelligence task {task_id} lacks a completed benchmark receipt"
                    )
            elif status == "blocked":
                error = str(task.get("error") or "").casefold()
                unavailable_markers = (
                    "provider",
                    "runtime",
                    "credential",
                    "unavailable",
                    "not configured",
                    "authentication",
                )
                if (
                    not task.get("retryable")
                    or not error
                    or not any(marker in error for marker in unavailable_markers)
                ):
                    raise AssertionError(
                        f"Role Intelligence task {task_id} is blocked without a retryable provider reason"
                    )
            else:
                raise AssertionError(
                    f"Role Intelligence task {task_id} ended in unexpected state {status!r}"
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
        "role_intelligence_statuses": sorted(set(role_task_statuses)),
        "task_attempts": 1,
        "database_integrity": integrity_check,
        "foreign_key_violations": foreign_key_violations,
        "elapsed_seconds": round(time.perf_counter() - started_at, 3),
        "role_intelligence_runtime_provider": "replay",
        "career_director_runtime_provider": "embedded",
        "role_intelligence_tasks": len(role_tasks),
    }
    print(json.dumps(result, ensure_ascii=True, indent=2), flush=True)


if __name__ == "__main__":
    main()
