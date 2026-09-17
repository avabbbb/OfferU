"""Fail-closed readiness validation for repo-external Private Eval data."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from app.services.security_redaction import redact_secret_value


def _read_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError) as exc:
        raise ValueError(f"Invalid Private Eval file: {path.name}") from exc
    if not isinstance(payload, dict) or payload.get("private") is not True:
        raise ValueError(f"Private Eval file is missing private=true: {path.name}")
    return payload


def _seed_health(seed_path: Path) -> dict[str, Any]:
    connection = sqlite3.connect(f"{seed_path.resolve().as_uri()}?mode=ro", uri=True)
    try:
        integrity = str(connection.execute("PRAGMA integrity_check").fetchone()[0])
        foreign_keys = len(connection.execute("PRAGMA foreign_key_check").fetchall())
        return {"integrity_check": integrity, "foreign_key_violations": foreign_keys}
    finally:
        connection.close()


def validate_private_dataset(workspace: Path, seed_path: Path) -> dict[str, Any]:
    root = Path(workspace).resolve()
    seed = Path(seed_path).resolve()
    if not seed.is_file():
        raise FileNotFoundError(f"Private Eval seed not found: {seed}")

    skill_route = _read_json(root / "skill_route_50.template.json")
    route_cases = skill_route.get("cases") if isinstance(skill_route.get("cases"), list) else []
    prompts = [str(case.get("prompt") or "").strip() for case in route_cases if isinstance(case, dict)]
    populated_prompts = [prompt for prompt in prompts if prompt]
    expected = [
        bool(str(case.get("expected_capability") or "").strip() or case.get("acceptable_capabilities"))
        for case in route_cases
        if isinstance(case, dict)
    ]

    private_suite = _read_json(root / "private_real_user_20.template.json")
    private_cases = (
        private_suite.get("cases") if isinstance(private_suite.get("cases"), list) else []
    )
    user_turns = [
        case.get("user_turns") if isinstance(case, dict) and isinstance(case.get("user_turns"), list) else []
        for case in private_cases
    ]
    criteria = [
        case.get("outcome_criteria")
        if isinstance(case, dict) and isinstance(case.get("outcome_criteria"), list)
        else []
        for case in private_cases
    ]

    ground_truth = _read_json(root / "ground_truth.template.json")
    resume = ground_truth.get("resume") if isinstance(ground_truth.get("resume"), dict) else {}
    ground_truth_ready = all((
        bool(ground_truth.get("jobs")),
        bool(resume.get("supported_facts")),
        bool(ground_truth.get("applications")),
        bool(ground_truth.get("preferences")),
    ))
    secret_pattern_detected = any(
        redact_secret_value(payload) != payload
        for payload in (skill_route, private_suite, ground_truth)
    )
    health = _seed_health(seed)
    route_ready = (
        len(route_cases) == 50
        and all(prompts)
        and len(set(prompts)) == 50
        and len(expected) == 50
        and all(expected)
    )
    private_suite_ready = (
        len(private_cases) == 20
        and all(user_turns)
        and all(criteria)
    )
    baseline_allowed = all((
        route_ready,
        private_suite_ready,
        ground_truth_ready,
        not secret_pattern_detected,
        health["integrity_check"] == "ok",
        health["foreign_key_violations"] == 0,
    ))
    return {
        "status": "READY_FOR_PRIVATE_EVAL" if baseline_allowed else "NEEDS_USER_INPUT",
        "baseline_allowed": baseline_allowed,
        "seed": health,
        "skill_route": {
            "case_count": len(route_cases),
            "missing_prompts": sum(not prompt for prompt in prompts) + max(0, 50 - len(prompts)),
            "duplicate_prompts": len(populated_prompts) - len(set(populated_prompts)),
            "missing_capability_labels": sum(not value for value in expected) + max(0, 50 - len(expected)),
        },
        "private_real_user": {
            "case_count": len(private_cases),
            "missing_user_turns": sum(not turns for turns in user_turns) + max(0, 20 - len(user_turns)),
            "missing_outcome_criteria": sum(not item for item in criteria) + max(0, 20 - len(criteria)),
        },
        "ground_truth": {
            "ready": ground_truth_ready,
            "job_labels": len(ground_truth.get("jobs") or []),
            "supported_resume_facts": len(resume.get("supported_facts") or []),
            "application_labels": len(ground_truth.get("applications") or []),
            "preferences_present": bool(ground_truth.get("preferences")),
        },
        "secret_pattern_detected": secret_pattern_detected,
    }


__all__ = ["validate_private_dataset"]
