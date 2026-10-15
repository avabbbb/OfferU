"""Which Agent writes must be confirmed by the user first.

Everything else runs directly and lands on the timeline; resume writes are
snapshotted so they can be undone with one click. Only actions the user cannot
take back are queued for one confirmation (see services/action_gate.py):

* sending / publishing / connecting to the outside (accounts, browser
  sessions, scrapers, share links, external executors);
* wiping or restoring local data;
* marking something as applied or changing an application's status;
* deleting a resume, job, profile entry or other record.

UI surfaces are unaffected: a human clicking a button already decided.
"""

from __future__ import annotations

from typing import Any, Literal, Mapping

InteractionTier = Literal["auto", "confirm"]
INTERACTION_TIERS: tuple[InteractionTier, ...] = ("auto", "confirm")

# Reading private material or touching credentials/platform accounts.
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

_CONFIRM_PREFIXES = ("delete_", "reset_", "purge_", "revoke_", "uninstall_")

CONFIRM_OPERATIONS = frozenset({
    # Credentials and new connections.
    "begin_gmail_oauth",
    "complete_gmail_oauth",
    "connect_imap_account",
    "connect_agent_integration",
    "install_capability_plugin",
    "register_work_source",
    "delegate_career_task",
    # Logged-in browser session / bulk external collection.
    "start_authorized_research_session",
    "activate_authorized_research_read_only",
    "start_scraper_batch",
    # Publishing personal data.
    "create_resume_share_record",
    "toggle_resume_share_record",
    # Data restore / scrubbing.
    "stage_data_restore",
    "scrub_legacy_email_notification_bodies",
    # Application status: the user insists on being asked.
    "create_application_attempt",
    "update_application_status",
    "sync_boss_application_status",
})

# Generic record updates only need a confirmation when they change a status.
_STATUS_FIELD_OPERATIONS = frozenset({
    "update_application_record",
    "update_application_table_record",
    "update_legacy_application",
    "move_application_records",
})


def classify_operation(
    name: str,
    *,
    is_mutation: bool,
    preparation_only: bool = False,
    permissions: tuple[str, ...] | list[str] = (),
) -> InteractionTier:
    if SENSITIVE_PERMISSIONS.intersection(permissions):
        return "confirm"
    if not is_mutation or preparation_only:
        return "auto"
    if name in CONFIRM_OPERATIONS or name.startswith(_CONFIRM_PREFIXES):
        return "confirm"
    return "auto"


def _mentions_status(value: Any) -> bool:
    if isinstance(value, Mapping):
        return any(str(key) == "status" or _mentions_status(item) for key, item in value.items())
    if isinstance(value, list):
        return any(_mentions_status(item) for item in value)
    return False


def needs_confirmation(name: str, tier: str, args: Mapping[str, Any]) -> bool:
    if tier == "confirm":
        return True
    return name in _STATUS_FIELD_OPERATIONS and _mentions_status(args)
