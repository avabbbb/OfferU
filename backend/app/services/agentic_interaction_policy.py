"""Project Plan execution facts into the user's interaction states.

This module does not authorize or execute Operations. Review-card quality is
advisory: missing Before/After/Why/evidence/source metadata is shown as a
warning but does not deadlock an otherwise valid decision. Hard blocking is
reserved for stale snapshots, unknown execution state, explicit policy blocks
and the existing destructive/external authorization boundary.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

INTERACTION_STATES = frozenset({
    "none", "needs_user_input", "needs_user_review", "needs_user_authorization",
    "system_recovering", "system_blocked",
})
REVIEWABILITY_STATES = frozenset({"ready", "needs_preparation", "needs_reconciliation", "archived"})

_ARCHIVED_GROUP_STATES = {"completed", "rejected", "replaced"}
_UNCERTAIN_NODE_STATES = {"executing", "uncertain", "failed"}
_DESTRUCTIVE_OPERATIONS = {"reset_local_business_data", "delete_target_role"}


def _present(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    return bool(value)


def _source_versions(group: Mapping[str, Any]) -> dict[str, str]:
    versions = dict(group.get("source_versions") or {})
    for node in group.get("nodes") or []:
        if not isinstance(node, Mapping):
            continue
        for key, value in (node.get("source_versions") or {}).items():
            if key in versions and versions[key] != value:
                return {}
            versions[str(key)] = str(value)
    return versions


def _display_sources(display: Mapping[str, Any]) -> bool:
    if any(_present(display.get(key)) for key in ("evidence", "evidence_refs", "source_refs", "citations")):
        return True
    changes = display.get("changes")
    if isinstance(changes, list) and changes:
        return all(
            isinstance(change, Mapping)
            and any(_present(change.get(key)) for key in ("evidence", "evidence_refs", "source_refs", "source_section_ids"))
            for change in changes
        )
    return False


def _review_packet_reasons(group: Mapping[str, Any]) -> list[str]:
    display = group.get("display") if isinstance(group.get("display"), Mapping) else {}
    nodes = [node for node in group.get("nodes") or [] if isinstance(node, Mapping)]
    displays = [display, *(node.get("display") for node in nodes if isinstance(node.get("display"), Mapping))]
    # The review material lives on node displays too: the plan source
    # enrichment projects change rows onto the executing node, not the group.
    changes = [
        item
        for shown in displays
        for item in (shown.get("changes") or [])
        if isinstance(item, Mapping)
    ]
    reasons: list[str] = []
    has_before = any("before" in item and _present(item.get("before")) for item in displays)
    has_after = any("after" in item and _present(item.get("after")) for item in displays)
    if changes:
        has_before = has_before or all("before" in item and _present(item.get("before")) for item in changes if isinstance(item, Mapping))
        has_after = has_after or all("after" in item and _present(item.get("after")) for item in changes if isinstance(item, Mapping))
    if not has_before:
        reasons.append("missing_before")
    if not has_after:
        reasons.append("missing_after")
    if not any(_present(item.get(key)) for item in displays for key in ("why", "rationale")):
        if not any(isinstance(change, Mapping) and any(_present(change.get(key)) for key in ("why", "rationale")) for change in changes):
            reasons.append("missing_why")
    if not any(_display_sources(item) for item in displays):
        reasons.append("missing_evidence")
    if not _source_versions(group):
        reasons.append("missing_current_source")
    if not _present(group.get("scope")):
        reasons.append("missing_scope")
    return reasons


def _requested_outcome(group: Mapping[str, Any]) -> str:
    display = group.get("display") if isinstance(group.get("display"), Mapping) else {}
    outcome = str(display.get("interaction_outcome") or "").strip().upper()
    if outcome:
        return outcome
    # L1/prepare used to default to AUTO, but there is no universal executor
    # consuming those groups. Surface them as ordinary review decisions so the
    # user always has an exit instead of leaving a durable Run parked forever.
    return "REVIEW"


def assess_group(group: Mapping[str, Any], *, source_current: bool | None = True) -> dict[str, Any]:
    """Return the frozen reviewability and interaction projection for a group."""
    status = str(group.get("status") or "pending")
    nodes = [node for node in group.get("nodes") or [] if isinstance(node, Mapping)]
    if status in _ARCHIVED_GROUP_STATES:
        return {"reviewability": {"status": "archived", "reason_codes": [], "counts_as_user_decision": False},
                "interaction_state": "none"}
    if status == "needs_reconciliation" or any(str(node.get("status") or "") in _UNCERTAIN_NODE_STATES for node in nodes):
        return {"reviewability": {"status": "needs_reconciliation", "reason_codes": ["effect_or_execution_state_unknown"], "counts_as_user_decision": False},
                "interaction_state": "system_recovering"}
    if status in {"blocked", "stale"}:
        reason = "operation_blocked" if status == "blocked" else "source_stale"
        return {"reviewability": {"status": "needs_preparation", "reason_codes": [reason], "counts_as_user_decision": False},
                "interaction_state": "system_blocked" if status == "blocked" else "system_recovering"}
    if status != "pending":
        return {"reviewability": {"status": "needs_preparation", "reason_codes": ["group_not_pending"], "counts_as_user_decision": False},
                "interaction_state": "system_recovering"}

    warnings = _review_packet_reasons(group)

    operations = {str(node.get("operation") or "") for node in nodes}
    risk = str(group.get("risk") or "")
    outcome = _requested_outcome(group)
    if outcome not in {"AUTO", "ASK", "REVIEW", "AUTHORIZE", "BLOCK"}:
        return {"reviewability": {"status": "needs_preparation", "reason_codes": ["invalid_interaction_outcome"], "counts_as_user_decision": False},
                "interaction_state": "system_blocked"}

    # Canonical source freshness is a real safety invariant. Metadata being
    # absent is only a quality warning; a source that was captured and then
    # changed is a stale-snapshot blocker and must be regenerated.
    if source_current is False:
        return {"reviewability": {"status": "needs_preparation", "reason_codes": ["source_changed_or_unavailable"], "counts_as_user_decision": False},
                "interaction_state": "system_recovering"}

    destructive = bool(operations & _DESTRUCTIVE_OPERATIONS)
    if risk == "external" or destructive:
        outcome = "AUTHORIZE"

    # A destructive action must still identify its affected scope before the
    # user can authorize it. Other review-card omissions are warnings only.
    if destructive and "missing_scope" in warnings:
        return {"reviewability": {"status": "needs_preparation", "reason_codes": ["missing_scope"], "counts_as_user_decision": False},
                "interaction_state": "system_blocked"}

    if outcome == "BLOCK":
        return {"reviewability": {"status": "needs_preparation", "reason_codes": ["policy_blocked"], "counts_as_user_decision": False},
                "interaction_state": "system_blocked"}

    warning_codes = sorted(set(warnings))
    if outcome == "ASK":
        # If the caller forgot to persist a dedicated AgentInputRequest, keep
        # the group actionable instead of parking the Run forever. Approval is
        # explicit and still binds the exact immutable Plan/Group digests.
        warning_codes = sorted(set([*warning_codes, "input_request_not_bound_to_group"]))
        outcome = "REVIEW"

    if outcome == "AUTHORIZE":
        return {"reviewability": {"status": "ready", "reason_codes": warning_codes, "counts_as_user_decision": True},
                "interaction_state": "needs_user_authorization"}
    if outcome in {"REVIEW", "AUTO"}:
        # AUTO is also reviewable as a fallback. A missing autonomous executor
        # must never make a durable operation unreachable from the UI.
        if outcome == "AUTO":
            warning_codes = sorted(set([*warning_codes, "auto_fallback_requires_confirmation"]))
        return {"reviewability": {"status": "ready", "reason_codes": warning_codes, "counts_as_user_decision": True},
                "interaction_state": "needs_user_review"}
    return {"reviewability": {"status": "ready", "reason_codes": warning_codes, "counts_as_user_decision": True},
            "interaction_state": "needs_user_review"}


def run_interaction_state(run: Mapping[str, Any]) -> str:
    status = str(run.get("status") or "")
    if status in {"waiting_input", "waiting_user_input"}:
        return "needs_user_input"
    plans = [plan for plan in run.get("proposal_plans") or [] if isinstance(plan, Mapping)]
    states = [str(group.get("interaction_state") or "none")
              for plan in plans for group in plan.get("groups") or [] if isinstance(group, Mapping)]
    if not states and status in {"waiting_confirmation", "waiting_decision"}:
        return "needs_user_review"
    for value in ("needs_user_authorization", "needs_user_review", "needs_user_input"):
        if value in states:
            return value
    if "system_blocked" in states or status in {"failed", "needs_reconciliation"}:
        return "system_blocked"
    if "system_recovering" in states or status in {"planning", "executing", "interrupted"}:
        return "system_recovering"
    return "none"


async def project_current_sources(plan: dict[str, Any]) -> dict[str, Any]:
    """Downgrade stale packets to system repair before projecting the Inbox."""
    from app.services.proposal_plan_sources import validate_source_versions

    for group in plan.get("groups") or []:
        if not isinstance(group, dict):
            continue
        initial = assess_group(group)
        if initial["reviewability"]["status"] != "ready":
            group.update(initial)
            continue
        try:
            await validate_source_versions(_source_versions(group))
            group.update(initial)
        except Exception:
            group.update(assess_group(group, source_current=False))
    plan["interaction_state"] = run_interaction_state({"proposal_plans": [plan]})
    return plan
