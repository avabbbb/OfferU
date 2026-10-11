from __future__ import annotations

import importlib.util
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _load_worker_soak(monkeypatch: Any):
    backend_dir = Path(__file__).resolve().parents[1]
    e2e_dir = backend_dir / "scripts" / "e2e"
    monkeypatch.syspath_prepend(str(backend_dir))
    monkeypatch.syspath_prepend(str(e2e_dir))
    script_path = e2e_dir / "test_public_release_worker_soak.py"
    spec = importlib.util.spec_from_file_location("offeru_worker_soak_script", script_path)
    if spec is None or spec.loader is None:
        raise AssertionError(f"could not load worker soak script: {script_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_worker_job_listing_filters_this_run_and_reads_every_page(monkeypatch: Any) -> None:
    worker_soak = _load_worker_soak(monkeypatch)
    run_key = "1791512369920"
    expected_items = [{"id": index, "company": f"Worker Orbit {run_key}-{index:03d}"} for index in range(1, 102)]
    requests: list[dict[str, Any]] = []

    def fake_request(_client: Any, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        params = kwargs["params"]
        requests.append({"method": method, "path": path, "params": params})
        start = (params["page"] - 1) * params["page_size"]
        return {"total": len(expected_items), "items": expected_items[start : start + params["page_size"]]}

    monkeypatch.setattr(worker_soak, "_request", fake_request)

    jobs = worker_soak._list_jobs_for_run(object(), run_key)

    assert [job["id"] for job in jobs] == list(range(1, 102))
    assert [request["params"]["page"] for request in requests] == [1, 2]
    assert all(request["method"] == "GET" and request["path"] == "/api/jobs/" for request in requests)
    assert all(request["params"]["keyword"] == f"Worker Orbit {run_key}-" for request in requests)


def test_job_saved_event_serializer_exposes_terminal_task_receipt(
    monkeypatch: Any,
) -> None:
    worker_soak = _load_worker_soak(monkeypatch)
    from app.models.models import AutomationEvent, CareerTask
    from app.services.automation import _event_view
    from app.services.career_tasks import _task_view

    event_id = "automation_evt_release_test"
    director_task_id = "career_task_release_director"
    role_task_id = "career_task_release_role"
    finished_at = datetime.now(timezone.utc).replace(tzinfo=None)
    event = _event_view(
        AutomationEvent(
            event_id=event_id,
            event_type="JOB_SAVED",
            source="manual",
            target_type="job",
            target_id="101",
            payload_json={"job_id": 101, "runtime_provider": "auto"},
            dedupe_key="job-saved:job:101",
            status="blocked",
            result_json={
                "task_id": director_task_id,
                "inbox_item_id": f"automation_task_{director_task_id}",
                "role_intelligence_task_id": None,
            },
            error="",
            created_at=finished_at,
            processed_at=finished_at,
        )
    )
    director_task = _task_view(
        CareerTask(
            task_id=director_task_id,
            task_type="career_director",
            source="automation",
            target_type="job",
            target_id="101",
            runtime_provider="embedded",
            input_json={
                "automation_event_id": event_id,
                "event_type": "JOB_SAVED",
                "job_id": 101,
            },
            output_contract_json={},
            status="blocked",
            progress_json={"stage": "blocked", "error_id": "err_director"},
            result_json={},
            checkpoint_json={},
            error="没有可用 Career Director Provider。",
            retryable=True,
            attempt_count=1,
            max_attempts=3,
            created_at=finished_at,
            finished_at=finished_at,
        )
    )
    role_task = _task_view(
        CareerTask(
            task_id=role_task_id,
            task_type="role_intelligence",
            source="automation",
            target_type="job",
            target_id="101",
            runtime_provider="auto",
            input_json={"automation_event_id": event_id, "job_id": 101},
            output_contract_json={},
            status="blocked",
            progress_json={"stage": "blocked", "error_id": "err_role"},
            result_json={},
            checkpoint_json={},
            error="岗位情报 Provider 暂不可用，请配置后重试。",
            retryable=True,
            attempt_count=1,
            max_attempts=3,
            created_at=finished_at,
            finished_at=finished_at,
        )
    )

    worker_soak._assert_job_saved_receipt(event, director_task, role_task)
    worker_soak._assert_role_task_terminal(role_task, "101")
