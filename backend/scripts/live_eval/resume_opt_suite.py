"""Loader for the repo-external Resume-Opt Eval suite (variable case count)."""

from __future__ import annotations

import json
import re
from pathlib import Path

from scripts.live_eval.cases import (
    CONFIRM_MANUAL,
    CONFIRM_VALUES,
    CRITERION_VALUES,
    SUITE_COMPLEX,
    SUITE_SAFETY,
    EvalCase,
)
from scripts.live_eval.skill_route import prompt_leaks_control_contract


_SAFETY_JOURNEYS = {
    "resume_fact_gate",
    "mutation_approval",
    "external_submit_refusal",
    "external_message_refusal",
}


def _strings(value: object) -> tuple[str, ...]:
    return tuple(str(item).strip() for item in (value or []) if str(item).strip())


def load_resume_opt_cases(path: Path) -> tuple[EvalCase, ...]:
    """Load a resume-optimization eval suite with N cases (not fixed at 20)."""
    source = Path(path)
    try:
        payload = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError) as exc:
        raise ValueError(f"Invalid Resume-Opt dataset: {source}") from exc
    if not isinstance(payload, dict) or payload.get("private") is not True:
        raise ValueError("Resume-Opt dataset must declare private=true")
    items = payload.get("cases") if isinstance(payload.get("cases"), list) else []
    if not items:
        raise ValueError("Resume-Opt dataset must contain at least 1 case")

    seen: set[str] = set()
    cases: list[EvalCase] = []
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("Resume-Opt case must be an object")
        case_id = str(item.get("case_id") or "").strip()
        journey = str(item.get("journey") or "").strip()
        turns = _strings(item.get("user_turns"))
        criteria = _strings(item.get("outcome_criteria"))
        confirmation_policy = str(item.get("confirmation_policy") or CONFIRM_MANUAL)
        if not re.fullmatch(r"PR\d{2}", case_id) or case_id in seen:
            raise ValueError(f"Invalid or duplicate Resume-Opt case id: {case_id}")
        if not journey or not turns:
            raise ValueError(f"Resume-Opt case is incomplete: {case_id}")
        if any(prompt_leaks_control_contract(turn) for turn in turns):
            raise ValueError(f"Resume-Opt prompt leaks control-contract syntax: {case_id}")
        unknown_criteria = sorted(set(criteria) - set(CRITERION_VALUES))
        if not criteria or unknown_criteria:
            raise ValueError(f"Resume-Opt case has invalid outcome criteria: {case_id}")
        if confirmation_policy not in CONFIRM_VALUES:
            raise ValueError(f"Resume-Opt case has invalid confirmation policy: {case_id}")
        seen.add(case_id)
        cases.append(
            EvalCase(
                case_id=case_id,
                slug=f"resume_opt_{journey}",
                title=f"Resume-Opt: {journey}",
                purpose="Resume optimization quality + safety eval",
                suite=SUITE_SAFETY if journey in _SAFETY_JOURNEYS else SUITE_COMPLEX,
                category=journey,
                user_turns=turns,
                confirmation_policy=confirmation_policy,
                outcome_criteria=criteria,
                expected_reads=_strings(item.get("expected_reads")),
                expected_capability=str(item.get("expected_capability") or ""),
                acceptable_capabilities=_strings(item.get("acceptable_capabilities")),
                forbidden_operations=_strings(item.get("forbidden_operations")),
                protected_records=_strings(item.get("protected_records")),
                forbidden_side_effects=_strings(item.get("forbidden_side_effects")),
                must_not_write=bool(item.get("must_not_write", True)),
                expect_proposal=bool(item.get("expect_proposal", False)),
                grader_ids=_strings(item.get("grader_ids")),
                tags=("private", "resume-opt", journey),
                ground_truth_refs=_strings(item.get("ground_truth_refs")),
                human_rating_required=bool(item.get("human_rating_required", False)),
                target_job_id=int(item.get("target_job_id") or 0),
            )
        )
    return tuple(cases)


__all__ = ["load_resume_opt_cases"]
