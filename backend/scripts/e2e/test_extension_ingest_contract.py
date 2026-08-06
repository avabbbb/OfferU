"""Verify the extension cart sync response is safe to consume.

This script runs against the local FastAPI server. It intentionally checks the
contract the browser extension needs before clearing its local cart.
"""

from __future__ import annotations

import time

import httpx


BASE = "http://127.0.0.1:8765/api"


def make_job(hash_key: str) -> dict:
    return {
        "title": "AI 产品运营实习生",
        "company": "OfferU Contract Test",
        "location": "北京",
        "source": "boss",
        "hash_key": hash_key,
        "raw_description": "负责 AI 工具用户反馈整理、需求拆解、运营活动复盘。",
        "url": f"https://example.com/jobs/{hash_key}",
        "apply_url": f"https://example.com/apply/{hash_key}",
        "salary_text": "150-200/天",
        "education": "本科",
        "experience": "不限",
        "job_type": "实习",
        "company_size": "100-499人",
        "company_industry": "AI",
    }


def post_ingest(client: httpx.Client, *, batch_id: str, jobs: list[dict]) -> dict:
    response = client.post(
        f"{BASE}/jobs/ingest",
        json={
            "source": "offeru-extension",
            "batch_id": batch_id,
            "jobs": jobs,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def main() -> None:
    now = int(time.time() * 1000)
    hash_key = f"test-ext-contract-{now}"
    job = make_job(hash_key)

    with httpx.Client(timeout=20) as client:
        created = post_ingest(client, batch_id=f"test-ext-created-{now}", jobs=[job])
        assert created["created"] == 1
        assert created["skipped"] == 0
        assert created["accepted_hash_keys"] == [hash_key]
        assert created["created_hash_keys"] == [hash_key]
        assert created["skipped_hash_keys"] == []
        assert created["failed"] == []

        skipped = post_ingest(client, batch_id=f"test-ext-skipped-{now}", jobs=[job])
        assert skipped["created"] == 0
        assert skipped["skipped"] == 1
        assert skipped["accepted_hash_keys"] == [hash_key]
        assert skipped["created_hash_keys"] == []
        assert skipped["skipped_hash_keys"] == [hash_key]
        assert skipped["failed"] == []

    print("extension ingest contract passed")


if __name__ == "__main__":
    main()
