from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

from app.services import agent_operations, career_delivery


class _SessionContext:
    async def __aenter__(self):
        return object()

    async def __aexit__(self, *_args):
        return False


def _artifact() -> dict:
    return {
        "id": "artifact_synthetic",
        "artifact_type": "interview_prep",
        "title": "Synthetic interview plan",
        "content_markdown": "Synthetic content",
        "related_job_id": 42,
        "metadata": {
            "director": {
                "task_id": "career-task-synthetic",
                "artifact_type": "interview_prep",
                "action_key": "interview.prepare",
            },
            "scope": {"job_id": 42, "calendar_event_id": 101},
            "provenance": {
                "evidence_refs": ["job:42.description"],
                "fingerprints": {"job:42": "job-v1"},
            },
        },
    }


def test_added_source_fingerprint_makes_existing_delivery_stale() -> None:
    artifact = _artifact()
    with (
        patch.object(career_delivery.career_artifact_store, "get", return_value=artifact),
        patch.object(career_delivery, "async_session", side_effect=lambda: _SessionContext()),
        patch.object(
            career_delivery,
            "_validate_scope",
            new=AsyncMock(return_value=(None, "", {})),
        ),
        patch.object(
            career_delivery,
            "_fingerprint_scope",
            new=AsyncMock(
                return_value=({"job:42": "job-v1", "calendar_event:101": "event-v1"}, [])
            ),
        ),
    ):
        result = asyncio.run(career_delivery.get_prepared_artifact("artifact_synthetic"))

    delivery = result["delivery"]
    assert delivery["state"] == "stale"
    assert delivery["reason_code"] == "source_changed"
    assert "calendar_event:101" in delivery["reason"]


def test_registry_artifact_read_suppresses_stale_content() -> None:
    artifact = _artifact()
    delivery = {"state": "stale", "reason": "岗位要求已变化"}
    with (
        patch(
            "app.services.career_artifacts.career_artifact_store.get",
            return_value=artifact,
        ),
        patch(
            "app.services.career_delivery.get_prepared_artifact",
            new=AsyncMock(return_value={"artifact": artifact, "delivery": delivery}),
        ),
    ):
        result = asyncio.run(agent_operations.get_career_artifact("artifact_synthetic"))

    assert result["delivery"] == delivery
    assert result["content_markdown"] == ""
