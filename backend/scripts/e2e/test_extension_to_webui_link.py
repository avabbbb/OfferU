"""Verify plugin cart data can become WebUI application records.

The test uses the same local HTTP surface a real browser extension and WebUI use:
1. ingest jobs as an extension shopping cart batch;
2. import that batch into the current application tracking table;
3. import it again and ensure existing rows are skipped, not duplicated.
"""

from __future__ import annotations

import time

import httpx


BASE = "http://127.0.0.1:8765/api"


def make_job(index: int, batch_key: str) -> dict:
    return {
        "title": f"AI 内容运营实习生 {index}",
        "company": f"OfferU Link Test {index}",
        "location": "上海",
        "source": "zhaopin",
        "hash_key": f"{batch_key}-{index}",
        "raw_description": "负责内容选题、用户调研、数据复盘，支持 AI 产品增长。",
        "url": f"https://example.com/jobs/{batch_key}-{index}",
        "apply_url": f"https://example.com/apply/{batch_key}-{index}",
        "salary_text": "180-220/天",
        "education": "本科",
        "experience": "不限",
        "job_type": "实习",
        "company_size": "500-999人",
        "company_industry": "互联网",
    }


def main() -> None:
    now = int(time.time() * 1000)
    batch_id = f"test-ext-webui-{now}"
    batch_key = f"test-ext-webui-hash-{now}"
    jobs = [make_job(1, batch_key), make_job(2, batch_key)]

    with httpx.Client(timeout=30) as client:
        ingest = client.post(
            f"{BASE}/jobs/ingest",
            json={
                "source": "offeru-extension",
                "batch_id": batch_id,
                "jobs": jobs,
            },
        )
        assert ingest.status_code == 200, ingest.text
        ingest_data = ingest.json()
        assert ingest_data["accepted_hash_keys"] == [job["hash_key"] for job in jobs]

        workspace = client.get(f"{BASE}/applications/workspace")
        assert workspace.status_code == 200, workspace.text
        table_id = workspace.json()["current_table_id"]

        imported = client.post(
            f"{BASE}/applications/tables/{table_id}/import-latest-extension-batch",
            json={"batch_id": batch_id},
        )
        assert imported.status_code == 200, imported.text
        imported_data = imported.json()
        assert imported_data["batch_id"] == batch_id
        assert imported_data["total_jobs"] == 2
        assert imported_data["created"] == 2
        assert imported_data["skipped_existing"] == 0

        records = client.get(f"{BASE}/applications/tables/{table_id}/records")
        assert records.status_code == 200, records.text
        values = [item["values"] for item in records.json()["records"]]
        assert any(
            item["company_name"] == "OfferU Link Test 1"
            and item["job_title"] == "AI 内容运营实习生 1"
            and item["location"] == "上海"
            and item["salary_text"] == "180-220/天"
            and item["source"] == "zhaopin"
            for item in values
        )

        imported_again = client.post(
            f"{BASE}/applications/tables/{table_id}/import-latest-extension-batch",
            json={"batch_id": batch_id},
        )
        assert imported_again.status_code == 200, imported_again.text
        imported_again_data = imported_again.json()
        assert imported_again_data["created"] == 0
        assert imported_again_data["skipped_existing"] == 2

    print("extension to webui link passed")


if __name__ == "__main__":
    main()
