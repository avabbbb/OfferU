"""Regression coverage for the read-only longitudinal Profile projection."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

from app.services.career_evolution import (
    _observation_stage,
    get_profile_evolution_report,
)


def test_observation_stage_reads_email_classification_and_canonical_fields() -> None:
    assert _observation_stage(
        {"classification": {"suggested_stage": "interview_1"}}
    ) == ("interview_1", "")
    assert _observation_stage(
        {"stage": "offer", "previous_stage": "interview_2"}
    ) == ("offer", "interview_2")


def test_evolution_report_exposes_email_stage_and_chronological_timeline() -> None:
    async def run() -> dict:
        with (
            patch(
                "app.services.career_memory.derive_career_model",
                new=AsyncMock(return_value={"profile_id": 7, "entries": []}),
            ),
            patch(
                "app.services.career_memory.list_career_ledger",
                new=AsyncMock(
                    return_value={
                        "entries": [
                            {
                                "id": 10,
                                "status": "pending",
                                "target_tier": "verified_fact",
                                "created_at": "2026-09-09 10:00:00",
                                "before": {},
                                "after": {"bullet": "候选事实"},
                            }
                        ]
                    }
                ),
            ),
            patch(
                "app.services.career_memory.list_learning_observations",
                new=AsyncMock(
                    return_value={
                        "items": [
                            {
                                "id": 1,
                                "observation_type": "email_career_observation",
                                "observed_at": "2026-09-10 08:00:00",
                                "content": {
                                    "classification": {"suggested_stage": "interview_1"},
                                    "candidate_id": "candidate-1",
                                },
                                "source": {"source_type": "email"},
                            }
                        ]
                    }
                ),
            ),
        ):
            return await get_profile_evolution_report()

    report = asyncio.run(run())
    assert report["application_status_changes"] == [
        {
            "observation_id": 1,
            "source_type": "email",
            "stage": "interview_1",
            "previous_stage": None,
            "observation_type": "email_career_observation",
            "confirmed": False,
            "candidate_id": "candidate-1",
            "observed_at": "2026-09-10 08:00:00",
        }
    ]
    assert [item["period"] for item in report["timeline"]] == [
        "2026-09-10",
        "2026-09-09",
    ]
    assert report["timeline"][0]["source_types"] == ["email"]
    assert report["timeline"][1]["proposal_count"] == 1
