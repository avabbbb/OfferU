"""Deterministic contract for Resume candidate review state projection."""

from app.services.profile_operations import _resume_candidate_state


def test_resume_candidate_state_preserves_reviewable_memory_statuses() -> None:
    assert _resume_candidate_state({"status": "pending"}) == "pending"
    assert _resume_candidate_state({"status": "deferred"}) == "deferred"
    assert _resume_candidate_state({"status": "accepted"}) == "accepted"
    assert _resume_candidate_state({"status": "rejected"}) == "rejected"


def test_resume_candidate_state_hides_non_reviewable_transitions() -> None:
    assert _resume_candidate_state({"status": "applying"}) == "pending_review"
    assert _resume_candidate_state({}) == "pending"
