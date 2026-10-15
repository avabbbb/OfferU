"""Interaction tiers for Agent-initiated Operations (docs/02 §4).

Replaces the old blanket rule "every write/llm/external Operation needs a
human" that made 179 of 283 Operations interrupt the user. The user decides
only where a decision is genuinely theirs:

* ``auto``      — reads, drafts, research, bookkeeping, job capture, progress
                  tracking. Executed directly, always audited and visible in
                  the timeline; reversible or inbox-bound.
* ``review``    — changes to the resume content or to the long-term Profile
                  (career truth). Shown as one before/after diff, like a PR.
* ``authorize`` — destructive, credential/connection, publishing or external
                  collection actions. Explicit confirmation with consequences.

UI surfaces are unaffected: a human clicking a button already decided. The
tier only governs what an Agent may do without asking.
"""

from __future__ import annotations

from typing import Literal

InteractionTier = Literal["auto", "review", "authorize"]
INTERACTION_TIERS: tuple[InteractionTier, ...] = ("auto", "review", "authorize")

# Reading private material or touching credentials/platform accounts is never
# an Agent-only decision, whatever the Operation is called.
SENSITIVE_PERMISSIONS = frozenset({
    "local_file:read",
    "local_memory:read",
    "work_source_content:model",
    "credential:keychain",
    "privacy:maintenance",
    "agent:integration",
    "authenticated_browser:manual_login",
    "job_source:boss:read",
})

# Irreversible or high-consequence by name: never left to an Agent alone.
_AUTHORIZE_PREFIXES = ("delete_", "reset_", "purge_", "revoke_", "uninstall_")

AUTHORIZE_OPERATIONS = frozenset({
    # Credentials and new connections.
    "begin_gmail_oauth",
    "complete_gmail_oauth",
    "connect_imap_account",
    "connect_agent_integration",
    "install_capability_plugin",
    "register_work_source",
    # Hands a task plus workspace access to an external executor Agent.
    "delegate_career_task",
    # Using the user's logged-in browser session or bulk external collection.
    "start_authorized_research_session",
    "activate_authorized_research_read_only",
    "start_scraper_batch",
    # Publishing personal data.
    "create_resume_share_record",
    "toggle_resume_share_record",
    # Data restore / scrubbing.
    "stage_data_restore",
    "scrub_legacy_email_notification_bodies",
})

REVIEW_OPERATIONS = frozenset({
    # Resume content — the "Git PR" moment the product is built around.
    "apply_resume_suggestion",
    "apply_resume_suggestions_batch",
    "review_resume_proposal_item",
    "review_resume_proposal_items",
    "review_resume_optimization",
    "update_resume_record",
    "update_resume_section",
    "create_resume_section",
    "reorder_resume_sections",
    "restore_resume_version_record",
    "batch_optimize_resume_records",
    # Snapshot taken inside the same tailoring decision group; never asked alone.
    "create_resume_version_record",
    # Long-term Profile (career truth). Learning first lands in the
    # 「待确认」inbox automatically; promoting it is the reviewed step.
    "update_profile",
    "create_profile_section",
    "update_profile_section",
    "add_profile_evidence",
    "confirm_profile_bullet",
    "apply_profile_agent_patch",
    "save_profile_resume_import",
    "generate_profile_narrative",
    "create_target_role",
    "correct_career_stage",
    "review_memory_proposal",
    "promote_session_memory",
    "promote_harness_memory",
    "invalidate_memory_source",
    "invalidate_work_source",
    # Bulk overwrite of every application row.
    "apply_application_template_to_all",
    # Gate before an application is sent.
    "review_pre_application_decision",
})

_OVERLAP = AUTHORIZE_OPERATIONS & REVIEW_OPERATIONS
assert not _OVERLAP, f"operation listed in two tiers: {sorted(_OVERLAP)}"


def classify_operation(
    name: str,
    *,
    is_mutation: bool,
    preparation_only: bool = False,
    permissions: tuple[str, ...] | list[str] = (),
) -> InteractionTier:
    """Return the tier for one Operation; deterministic and side-effect free."""

    if SENSITIVE_PERMISSIONS.intersection(permissions):
        return "authorize"
    if not is_mutation or preparation_only:
        return "auto"
    if name in AUTHORIZE_OPERATIONS or name.startswith(_AUTHORIZE_PREFIXES):
        return "authorize"
    if name in REVIEW_OPERATIONS:
        return "review"
    return "auto"


AUTONOMY_LEVELS: dict[InteractionTier, str] = {
    "auto": "L1_auto",
    "review": "L2_review",
    "authorize": "L3_authorize",
}
