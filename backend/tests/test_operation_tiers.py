"""Interaction tiers (docs/02 §4): the user decides only real decisions.

Guards both directions: everyday Agent work must not interrupt the user, and
destructive / private / credential boundaries must never become automatic.
"""

from __future__ import annotations

import pytest

from app.ops import OPERATIONS
from app.services.operation_tiers import (
    AUTHORIZE_OPERATIONS,
    INTERACTION_TIERS,
    REVIEW_OPERATIONS,
    SENSITIVE_PERMISSIONS,
)

AUTO = [
    "set_current_view", "import_jd", "triage_job", "batch_triage",
    "start_job_research", "sync_email_notifications", "update_application_status",
    "record_learning_observation", "create_memory_proposal", "save_career_artifact",
    "generate_cover_letter", "search_jobs", "export_resume_pdf",
    "prepare_resume_optimization", "submit_interview_debrief",
]
REVIEW = [
    "update_resume_section", "apply_resume_suggestions_batch", "review_resume_optimization",
    "update_profile", "add_profile_evidence", "review_memory_proposal",
]
AUTHORIZE = [
    "reset_local_business_data", "delete_jobs_batch", "connect_imap_account",
    "preview_local_memory_source", "inspect_resume_document", "start_work_source_sync",
    "delegate_career_task", "sync_boss_application_status", "create_resume_share_record",
    "start_authorized_research_session", "install_capability_plugin",
]


@pytest.mark.parametrize("name", AUTO)
def test_everyday_agent_work_runs_without_asking(name):
    assert OPERATIONS[name].tier == "auto"
    assert OPERATIONS[name].requires_confirmation is False


@pytest.mark.parametrize("name", REVIEW)
def test_resume_and_profile_truth_changes_are_reviewed(name):
    assert OPERATIONS[name].tier == "review"
    assert OPERATIONS[name].requires_confirmation is True


@pytest.mark.parametrize("name", AUTHORIZE)
def test_destructive_private_and_credential_actions_need_authorization(name):
    assert OPERATIONS[name].tier == "authorize"
    assert OPERATIONS[name].requires_confirmation is True
    assert OPERATIONS[name].schema()["autonomy_level"] == "L3_authorize"


def test_every_operation_has_a_valid_tier_and_lists_only_name_real_operations():
    assert all(op.tier in INTERACTION_TIERS for op in OPERATIONS.values())
    assert (AUTHORIZE_OPERATIONS | REVIEW_OPERATIONS) <= set(OPERATIONS)


def test_irreversible_names_and_sensitive_permissions_are_never_auto():
    for name, op in OPERATIONS.items():
        if not op.is_mutation:
            continue
        if name.startswith(("delete_", "reset_", "purge_", "revoke_", "uninstall_")):
            assert op.tier == "authorize", name
    for name, op in OPERATIONS.items():
        if SENSITIVE_PERMISSIONS.intersection(op.permissions):
            assert op.tier == "authorize", name


def test_plain_reads_never_interrupt():
    for name, op in OPERATIONS.items():
        if not op.is_mutation and not SENSITIVE_PERMISSIONS.intersection(op.permissions):
            assert op.tier == "auto", name


def test_confirmation_budget_does_not_creep_back():
    # Was 179/283 (63%) under the blanket "any write needs a human" rule.
    gated = sum(op.requires_confirmation for op in OPERATIONS.values())
    assert gated / len(OPERATIONS) < 0.25, gated
