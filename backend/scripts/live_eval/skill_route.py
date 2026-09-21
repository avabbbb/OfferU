"""Loader for repo-external SkillRoute-50 natural-language cases."""

from __future__ import annotations

import json
import re
from pathlib import Path

from scripts.live_eval.cases import (
    CRITERION_FINAL_ANSWER_NONEMPTY,
    CRITERION_NO_BUSINESS_WRITE,
    CRITERION_NO_FORBIDDEN_OPERATION,
    DEFAULT_READONLY_CRITERIA,
    SUITE_COMPLEX,
    EvalCase,
)


_CONTROL_CONTRACT = re.compile(
    r"app\.cli|manifest\s+--(?:skill|all)|\bschema\s+[a-z0-9_]+|\bconfirm\s+run_",
    re.IGNORECASE,
)
CAPABILITY_LABEL_OPTIONAL_CATEGORIES = frozenset({"no_tool_or_clarify", "safety", "missing_context_or_failure"})
_NO_READ_CATEGORIES = CAPABILITY_LABEL_OPTIONAL_CATEGORIES


def prompt_leaks_control_contract(prompt: str) -> bool:
    return bool(_CONTROL_CONTRACT.search(prompt))


def load_skill_route_cases(path: Path) -> tuple[EvalCase, ...]:
    source = Path(path)
    try:
        payload = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError) as exc:
        raise ValueError(f"Invalid SkillRoute dataset: {source}") from exc
    if not isinstance(payload, dict) or payload.get("private") is not True:
        raise ValueError("SkillRoute dataset must declare private=true")
    items = payload.get("cases") if isinstance(payload.get("cases"), list) else []
    if len(items) != 50:
        raise ValueError("SkillRoute dataset must contain exactly 50 cases")

    seen_ids: set[str] = set()
    seen_prompts: set[str] = set()
    cases: list[EvalCase] = []
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("SkillRoute case must be an object")
        case_id = str(item.get("case_id") or "").strip()
        prompt = str(item.get("prompt") or "").strip()
        category = str(item.get("category") or "").strip()
        expected = str(item.get("expected_capability") or "").strip()
        acceptable = tuple(
            str(value).strip()
            for value in (item.get("acceptable_capabilities") or [])
            if str(value).strip()
        )
        if not re.fullmatch(r"SR\d{2}", case_id) or case_id in seen_ids:
            raise ValueError(f"Invalid or duplicate SkillRoute case id: {case_id}")
        if not prompt or prompt in seen_prompts:
            raise ValueError(f"Missing or duplicate SkillRoute prompt: {case_id}")
        if prompt_leaks_control_contract(prompt):
            raise ValueError(f"SkillRoute prompt leaks control-contract syntax: {case_id}")
        if not expected and not acceptable:
            raise ValueError(f"SkillRoute case lacks capability label: {case_id}")
        seen_ids.add(case_id)
        seen_prompts.add(prompt)
        outcome_criteria = (
            (
                CRITERION_FINAL_ANSWER_NONEMPTY,
                CRITERION_NO_BUSINESS_WRITE,
                CRITERION_NO_FORBIDDEN_OPERATION,
            )
            if category in _NO_READ_CATEGORIES
            else DEFAULT_READONLY_CRITERIA
        )
        cases.append(
            EvalCase(
                case_id=case_id,
                slug=f"skill_route_{case_id.lower()}",
                title=f"SkillRoute {case_id}",
                purpose=str(item.get("expected_outcome") or "Skill routing and recovery"),
                suite=SUITE_COMPLEX,
                category="skill-routing",
                user_turns=(prompt,),
                outcome_criteria=outcome_criteria,
                expected_capability=expected,
                acceptable_capabilities=acceptable,
                must_not_write=True,
                max_turns=1,
                max_tool_calls=20,
                tags=("private", "skill-route", category),
            )
        )
    return tuple(cases)


__all__ = [
    "CAPABILITY_LABEL_OPTIONAL_CATEGORIES",
    "load_skill_route_cases",
    "prompt_leaks_control_contract",
]
