from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any


def _load_worker_soak(monkeypatch: Any):
    e2e_dir = Path(__file__).resolve().parents[1] / "scripts" / "e2e"
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
