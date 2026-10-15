"""Project the Operation Registry into a run-scoped Bridge grant.

Reads execute inline. Writes go through the ActionGate: ordinary writes run
and land on the timeline, irreversible ones are queued for the user to confirm
in the OfferU UI. The Agent can never confirm its own queued action.
"""

from __future__ import annotations

from typing import Any

from app.ops import OPERATIONS, execute_operation, get_operation_schema
from app.services.agent_bridge.errors import BridgeProtocolError
from app.services.action_gate import list_actions, run_gated_operation

# Read-only career context grant. Plan readback is scoped by the attached Run.
GRANTED_READ_OPERATIONS: frozenset[str] = frozenset(
    {
        "agent_playbook",
        "get_pre_application_state",
        "get_job",
        "list_jobs",
        "get_profile",
        "list_resumes",
        "list_profile_evidence",
        "list_application_progress_candidates",
        "list_learning_observations",
        "list_memory_inbox",
        "get_profile_evolution_report",
        "get_current_view",
        "list_email_accounts",
        "list_email_sync_runs",
    }
)

GRANTED_MUTATION_OPERATIONS: frozenset[str] = frozenset({"triage_job"})

BRIDGE_SURFACE = "bridge"


def _deny(code: str, message: str, details: dict[str, Any] | None = None) -> BridgeProtocolError:
    return BridgeProtocolError(code, message, details=details)


def granted_operations() -> list[dict[str, Any]]:
    """Registry schemas for read grants and preparation-only writes."""
    schemas = []
    names = set(GRANTED_READ_OPERATIONS) | {
        name for name in GRANTED_MUTATION_OPERATIONS
        if OPERATIONS.get(name) is not None and OPERATIONS[name].preparation_only
    }
    for name in sorted(names):
        operation = OPERATIONS.get(name)
        schema = get_operation_schema(name)
        if (
            operation is not None
            and (operation.side_effects == ("read",) or operation.preparation_only)
            and schema is not None
        ):
            schemas.append(schema)
    return schemas


def _gated_reply(result: dict[str, Any], operation: str) -> dict[str, Any]:
    if not result.get("ok"):
        errors = [str(item) for item in result.get("errors") or []]
        raise _deny(
            "schema_invalid"
            if any("缺少必填参数" in e or "未知参数" in e for e in errors)
            else "internal_error",
            "; ".join(errors) or f"{operation} failed",
            {"operation": operation},
        )
    outputs = result.get("outputs") if isinstance(result.get("outputs"), dict) else {}
    if outputs.get("executed") is False and outputs.get("pending_action"):
        return {
            "completed": False,
            "requiresConfirmation": True,
            "pendingAction": outputs["pending_action"],
            "message": outputs.get("message") or "",
            "warnings": list(result.get("warnings") or []),
        }
    return {
        "completed": True,
        "value": outputs,
        "operationVersion": result.get("operation_version"),
        "warnings": list(result.get("warnings") or []),
    }


async def invoke_operation(
    *,
    operation: str,
    arguments: dict[str, Any],
    run_id: str = "",
) -> dict[str, Any]:
    """Execute one granted Operation through the Registry.

    Reads execute inline; writes go through the ActionGate.
    """
    op = OPERATIONS.get(operation)
    if operation not in GRANTED_READ_OPERATIONS | GRANTED_MUTATION_OPERATIONS or op is None:
        raise _deny(
            "grant_denied",
            "Operation is not granted for this Run",
            {"operation": operation},
        )
    if operation in GRANTED_READ_OPERATIONS:
        if op.side_effects != ("read",):
            raise _deny(
                "grant_denied",
                "Operation Registry no longer classifies this grant as read-only",
                {"operation": operation, "sideEffects": list(op.side_effects)},
            )
    elif not op.is_mutation or operation not in GRANTED_MUTATION_OPERATIONS:
        raise _deny(
            "grant_denied",
            "Side-effect operation is not granted for this Run",
            {"operation": operation},
        )
    if not run_id:
        raise _deny("pairing_required", "Operation invocation needs the attached Agent Run")
    from app.services.agent_run_state import load_agent_run

    run = await load_agent_run(run_id)
    if run is None:
        raise _deny("run_not_found", "Attached Agent Run does not exist", {"runId": run_id})
    allowed_tools = set((run.get("skill_snapshot") or {}).get("allowed_tools") or [])
    if operation not in allowed_tools:
        raise _deny("grant_denied", "Operation is outside the attached Run Skill scope", {"operation": operation})
    if operation in GRANTED_MUTATION_OPERATIONS:
        return _gated_reply(
            await run_gated_operation(operation, arguments, surface=BRIDGE_SURFACE, run_id=run_id),
            operation,
        )
    envelope = await execute_operation(
        operation,
        arguments,
        surface=BRIDGE_SURFACE,
    )
    if not envelope.get("ok"):
        errors = [str(item) for item in envelope.get("errors") or []]
        raise _deny(
            "schema_invalid" if any("缺少必填参数" in e or "未知参数" in e for e in errors) else "internal_error",
            "; ".join(errors) or f"{operation} failed",
            {"operation": operation},
        )
    return {
        "completed": True,
        "value": envelope.get("outputs"),
        "operationVersion": envelope.get("operation_version"),
        "warnings": list(envelope.get("warnings") or []),
    }


async def invoke_workspace_delegate(
    *,
    arguments: dict[str, Any],
    run_id: str = "",
) -> dict[str, Any]:
    """Create a reviewed CareerTask for ``workspace.delegate``.

    This is intentionally a separate Bridge seam: the generic Slice-1 grant
    remains read-only, while the workspace message is projected as an
    Operation proposal and can only run after the normal confirmation path.
    """

    operation = "delegate_career_task"
    if OPERATIONS.get(operation) is None:
        raise _deny("internal_error", "delegate_career_task is not registered")
    return _gated_reply(
        await run_gated_operation(operation, arguments, surface=BRIDGE_SURFACE, run_id=run_id),
        operation,
    )


async def load_proposal_state(*, run_id: str) -> dict[str, Any]:
    """The attached Run's status and its timeline / pending actions."""
    from app.services.agent_run_state import load_agent_run

    run = await load_agent_run(run_id)
    if run is None:
        raise _deny("run_not_found", f"Agent Run {run_id} does not exist", {"runId": run_id})
    actions = await list_actions(run_id=run_id)
    return {
        "runId": str(run.get("id") or run_id),
        "status": str(run.get("status") or ""),
        "goal": str(run.get("goal") or ""),
        "pending": [item for item in actions if item["status"] == "pending"],
        "actions": actions,
    }


async def confirm_proposal(
    *,
    run_id: str,
    action_id: str = "",
    surface: str = BRIDGE_SURFACE,
) -> dict[str, Any]:
    """Agents have no approval capability; only the native UI route can decide."""
    del run_id, action_id, surface
    raise _deny(
        "human_approval_required",
        "Proposal decisions require the independent OfferU UI approval capability",
    )


# Backwards-compatible alias for Slice-1 callers.
invoke_read_operation = invoke_operation


__all__ = [
    "BRIDGE_SURFACE",
    "GRANTED_MUTATION_OPERATIONS",
    "GRANTED_READ_OPERATIONS",
    "confirm_proposal",
    "granted_operations",
    "invoke_operation",
    "invoke_workspace_delegate",
    "invoke_read_operation",
    "load_proposal_state",
]
