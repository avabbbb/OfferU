"""Generated Agent Skills must match the live Registry and ActionGate rules."""

from __future__ import annotations

import re
from pathlib import Path

from app.ops import list_operations
from app.services.agent_methodology import METHOD_SKILL_IDS, get_agent_methodology
from app.services.agent_skill_projections import projection_drift, render_skill_projections

REPO_ROOT = Path(__file__).resolve().parents[2]

# Identifiers shaped like Operation names, backticked or not: agent prompt projections
# drop Markdown backticks, and those references must stay registered too.
_OPERATION_REF = re.compile(
    r"\b((?:get|list|create|import|draft|review|undo|add|inspect|persist|ensure|prepare|start|resume|cancel|update|save|record|build|refresh|invoke|consolidate|invalidate|resolve)_[a-z0-9_]+)\b"
)

# Code-formatted domain terms that share an Operation verb prefix but are not Operations.
_NOT_OPERATIONS = frozenset({"resume_pattern"})

# Proposal v2 vocabulary removed by the ActionGate change.
_REMOVED_RULES = (
    "get_proposal_plan",
    "list_proposal_plans",
    "ConfirmationGroup",
    "v2 plan",
    "requires_confirmation tools persist",
    "Operations with requires_confirmation persist a proposal",
)


def _sources() -> dict[str, str]:
    texts = {path.as_posix(): text for path, text in render_skill_projections().items()}
    for skill_id in sorted(METHOD_SKILL_IDS):
        ref = get_agent_methodology(skill_id)["source_ref"]
        texts[ref] = (REPO_ROOT / ref).read_text(encoding="utf-8")
    return texts


def test_checked_in_projections_match_generator() -> None:
    assert projection_drift(REPO_ROOT) == []


def test_projections_drop_proposal_v2_rules() -> None:
    for path, text in render_skill_projections().items():
        for token in _REMOVED_RULES:
            assert token not in text, f"{path} still mentions {token!r}"


def test_referenced_operations_are_registered() -> None:
    registered = {operation["name"] for operation in list_operations()}
    missing = {
        path: sorted(set(_OPERATION_REF.findall(text)) - registered - _NOT_OPERATIONS)
        for path, text in _sources().items()
    }
    assert {path: names for path, names in missing.items() if names} == {}
