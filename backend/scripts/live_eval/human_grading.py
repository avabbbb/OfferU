"""Deterministic aggregation for private human product ratings."""

from __future__ import annotations

from typing import Any


def aggregate_human_ratings(payload: dict[str, Any]) -> dict[str, Any]:
    if payload.get("private") is not True:
        raise ValueError("Human rating payload must declare private=true")
    ratings = payload.get("ratings") if isinstance(payload.get("ratings"), list) else []
    useful: list[int] = []
    grounded: list[int] = []
    would_use: list[bool] = []
    low_score_case_ids: list[str] = []
    for item in ratings:
        if not isinstance(item, dict):
            raise ValueError("Human rating must be an object")
        case_id = str(item.get("case_id") or "").strip()
        useful_score = int(item.get("useful") or 0)
        grounded_score = int(item.get("grounded") or 0)
        would_use_value = str(item.get("would_use") or "").strip().lower()
        if not case_id or useful_score not in range(1, 6) or grounded_score not in range(1, 6):
            raise ValueError("Human rating requires case_id and 1-5 scores")
        if would_use_value not in {"yes", "no"}:
            raise ValueError("Human rating would_use must be yes or no")
        useful.append(useful_score)
        grounded.append(grounded_score)
        would_use.append(would_use_value == "yes")
        if useful_score <= 2 or grounded_score <= 2:
            low_score_case_ids.append(case_id)
    count = len(ratings)
    return {
        "rating_count": count,
        "avg_useful": round(sum(useful) / count, 2) if count else None,
        "avg_grounded": round(sum(grounded) / count, 2) if count else None,
        "would_use_rate": round(sum(would_use) / count, 4) if count else None,
        "low_score_case_ids": low_score_case_ids,
    }


__all__ = ["aggregate_human_ratings"]
