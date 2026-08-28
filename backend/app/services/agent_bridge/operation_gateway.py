"""Agent Bridge OperationGateway (Slice 1 + Slice 3).

Maps Bridge `operation.*` requests onto the existing Operation Registry.
Read Operations execute directly. The Slice-3 mutation grant routes
side-effect invocations through `execute_or_propose_operation`: the call
persists a proposal (`requires_confirmation`) and never executes inline —
the final result arrives only after an independent approval via
`confirm_operation_proposal`. No second write path: everything funnels
through `execute_operation` so audit stays in one place.
"""

from __future__ import annotations

from typing import Any

from app.ops import OPERATIONS, execute_operation, get_operation_schema
from app.services.agent_bridge.errors import BridgeProtocolError
from app.services.operation_projection import (
    confirm_operation_proposal,
    execute_or_propose_operation,
)

# Slice 1 read-only grant: the pre-application tracer Operation plus the two
# catalog reads every adapter needs to render its tool list.
GRANTED_READ_OPERATIONS: frozenset[str] = frozenset(
    {
        "get_pre_application_state",
        "get_job",
        "list_jobs",
        "get_profile",
    }
)

# Slice 3 mutation grant: one reversible, clearly-scoped internal write for
# the approval tracer (migration roadmap "首选验收 Operation"). Approval goes
# through the OfferU workbench overlay; the Bridge never self-approves.
GRANTED_MUTATION_OPERATIONS: frozenset[str] = frozenset({"triage_job"})

BRIDGE_SURFACE = "bridge"


def _deny(code: str, message: str, details: dict[str, Any] | None = None) -> BridgeProtocolError:
    return BridgeProtocolError(code, message, details=details)


def granted_operations() -> list[dict[str, Any]]:
    """Registry schemas for the active Slice-1/2 read-only grant."""
    schemas = []
    for name in sorted(GRANTED_READ_OPERATIONS):
        operation = OPERATIONS.get(name)
        schema = get_operation_schema(name)
        if (
            operation is not None
            and operation.side_effects == ("read",)
            and schema is not None
        ):
            schemas.append(schema)
    return schemas


async def invoke_operation(
    *,
    operation: str,
    arguments: dict[str, Any],
) -> dict[str, Any]:
    """Execute one granted Operation through the Registry.

    Reads execute inline; granted mutations persist a proposal
    (`requires_confirmation`) and return its identity — the side effect has
    NOT run yet. The final result arrives only after an independent approval.
    """
    op = OPERATIONS.get(operation)
    if operation not in GRANTED_READ_OPERATIONS or op is None:
        raise _deny(
            "grant_denied",
            "Operation is not granted for this Run",
            {"operation": operation},
        )
    if op.side_effects != ("read",):
        raise _deny(
            "grant_denied",
            "Operation Registry no longer classifies this grant as read-only",
            {"operation": operation, "sideEffects": list(op.side_effects)},
        )
    if op.is_mutation:
        if operation not in GRANTED_MUTATION_OPERATIONS:
            raise _deny(
                "grant_denied",
                "Side-effect operation is not granted for this Run",
                {"operation": operation},
            )
        projection = await execute_or_propose_operation(
            operation,
            arguments,
            surface=BRIDGE_SURFACE,
        )
        if not projection.get("ok"):
            errors = [str(item) for item in projection.get("errors") or []]
            raise _deny(
                "schema_invalid"
                if any("缺少必填参数" in e or "未知参数" in e for e in errors)
                else "internal_error",
                "; ".join(errors) or f"{operation} failed",
                {"operation": operation},
            )
        proposal = (projection.get("outputs") or {}).get("proposal") or {}
        return {
            "completed": False,
            "requiresConfirmation": True,
            "proposal": {
                "runId": str(proposal.get("run_id") or ""),
                "actionId": str(proposal.get("action_id") or ""),
                "idempotencyKey": str(proposal.get("idempotency_key") or ""),
                "operation": str(proposal.get("operation") or operation),
                "args": proposal.get("args") or {},
                "status": str(proposal.get("status") or ""),
            },
            "warnings": list(projection.get("warnings") or []),
        }
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
) -> dict[str, Any]:
    """Create a reviewed CareerTask for ``workspace.delegate``.

    This is intentionally a separate Bridge seam: the generic Slice-1 grant
    remains read-only, while the workspace message is projected as an
    Operation proposal and can only run after the normal confirmation path.
    """

    operation = "delegate_career_task"
    if OPERATIONS.get(operation) is None:
        raise _deny("internal_error", "delegate_career_task is not registered")
    projection = await execute_or_propose_operation(
        operation,
        arguments,
        surface=BRIDGE_SURFACE,
    )
    if not projection.get("ok"):
        errors = [str(item) for item in projection.get("errors") or []]
        raise _deny(
            "schema_invalid"
            if any("缺少必填参数" in error or "未知参数" in error for error in errors)
            else "internal_error",
            "; ".join(errors) or "workspace delegation failed",
            {"operation": operation},
        )
    outputs = projection.get("outputs") if isinstance(projection.get("outputs"), dict) else {}
    proposal = outputs.get("proposal") if isinstance(outputs.get("proposal"), dict) else {}
    if proposal:
        return {
            "completed": False,
            "requiresConfirmation": True,
            "proposal": {
                "runId": str(proposal.get("run_id") or ""),
                "actionId": str(proposal.get("action_id") or ""),
                "idempotencyKey": str(proposal.get("idempotency_key") or ""),
                "operation": str(proposal.get("operation") or operation),
                "args": proposal.get("args") or {},
                "status": str(proposal.get("status") or ""),
            },
            "warnings": list(projection.get("warnings") or []),
        }
    return {
        "completed": True,
        "value": projection.get("outputs"),
        "operationVersion": projection.get("operation_version"),
        "warnings": list(projection.get("warnings") or []),
    }


async def load_proposal_state(*, run_id: str) -> dict[str, Any]:
    """Project one proposal Run's confirmation state for the overlay."""
    from app.services.agent_run_state import load_agent_run

    run = await load_agent_run(run_id)
    if run is None:
        raise _deny("run_not_found", f"Agent Run {run_id} does not exist", {"runId": run_id})
    steps = [
        {
            "actionId": str(step.get("id") or ""),
            "operation": str(step.get("tool") or ""),
            "args": step.get("args") or {},
            "status": str(step.get("status") or ""),
            "summary": str(step.get("summary") or ""),
        }
        for step in (run.get("steps") or [])
        if isinstance(step, dict)
    ]
    pending = [s for s in steps if s["status"] == "waiting_confirmation"]
    return {
        "runId": str(run.get("id") or run_id),
        "status": str(run.get("status") or ""),
        "goal": str(run.get("goal") or ""),
        "pending": pending,
        "steps": steps,
    }


async def confirm_proposal(
    *,
    run_id: str,
    action_id: str = "",
) -> dict[str, Any]:
    """Confirm one persisted proposal; idempotent — replay never re-executes."""
    result = await confirm_operation_proposal(run_id, surface=BRIDGE_SURFACE)
    if not result.get("ok"):
        raise _deny(
            "reconciliation_required",
            "; ".join(str(e) for e in result.get("errors") or []) or "confirm failed",
            {"runId": run_id},
        )
    calls = [
        call for call in (result.get("tool_calls") or []) if isinstance(call, dict)
    ]
    return {
        "completed": True,
        "runStatus": str((result.get("run") or {}).get("status") or ""),
        "toolCalls": [
            {"tool": c.get("tool"), "result": c.get("result")} for c in calls
        ],
        "warnings": list(result.get("warnings") or []),
    }


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
