"""Verify internal test data is hidden from user-facing HTTP surfaces.

Run this against the local FastAPI server after the extension/link smoke tests.
Those smoke tests intentionally create `test-ext-*` batches; the normal UI must
not treat them as real crawled jobs.
"""

from __future__ import annotations

import json
import urllib.request


BASE = "http://127.0.0.1:8765/api"
TEST_BATCH_PREFIXES = ("test-", "test_", "ui-ext-", "mock-")


def api(path: str) -> dict | list:
    with urllib.request.urlopen(f"{BASE}{path}", timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def is_test_batch(batch_id: str) -> bool:
    normalized = (batch_id or "").strip().lower()
    return any(normalized.startswith(prefix) for prefix in TEST_BATCH_PREFIXES)


def main() -> None:
    jobs = api("/jobs/?page=1&page_size=100&period=week")
    leaked_jobs = [
        item
        for item in jobs.get("items", [])
        if is_test_batch(item.get("batch_id", ""))
        or str(item.get("company", "")).startswith("OfferU ")
        or "example.com/jobs/test-" in str(item.get("url", ""))
    ]
    assert not leaked_jobs, f"user-facing jobs leaked internal test data: {leaked_jobs[:3]}"

    batches = api("/jobs/batches?limit=100")
    leaked_batches = [item for item in batches if is_test_batch(item.get("batch_id", ""))]
    assert not leaked_batches, f"user-facing batch list leaked internal test batches: {leaked_batches[:3]}"

    workspace = api("/applications/workspace")
    table_id = workspace["current_table_id"]
    records = api(f"/applications/tables/{table_id}/records")
    leaked_records = [
        item
        for item in records.get("records", [])
        if str(item.get("values", {}).get("company_name", "")).startswith("OfferU ")
        or "example.com/jobs/test-" in str(item.get("values", {}).get("job_link", ""))
    ]
    assert not leaked_records, f"application table leaked internal test records: {leaked_records[:3]}"

    print("job test-data filter passed")


if __name__ == "__main__":
    main()
