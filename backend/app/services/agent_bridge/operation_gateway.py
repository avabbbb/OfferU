"""Project the Operation Registry into a run-scoped Bridge grant.

Reads execute inline. Protected operations stage an exact singleton Plan, and
the active Agent may read receipts but never approve its own Plan. Native UI
approval remains the only decision source.
"""

from __future__ import annotations

from typing import Any

from app.ops import OPERATIONS, execute_operation, get_operation_schema
from app.services.agent_bridge.errors import BridgeProtocolError
from app.services.operation_projection import (
    execute_or_propose_operation,
)

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
        "get_proposal_plan",
        "list_proposal_plans",
        "list_email_accounts",
        "list_email_sync_runs",
    }
)

# The Bridge may stage only the Plan tool and the legacy approval tracer.
# Every protected effect remains blocked until the native UI decides its group.
GRANTED_MUTATION_OPERATIONS: frozenset[str] = frozenset({"triage_job", "prepare_proposal_plan"})

BRIDGE_SURFACE = "bridge"


def _deny(code: str, message: str, details: dict[str, Any] | None = None) -> BridgeProtocolError:
    return BridgeProtocolError(code, message, details=details)


def granted_operations() -> list[dict[str, Any]]:
    """Registry schemas for read grants and L1 Plan preparation."""
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


async def invoke_operation(
    *,
    operation: str,
    arguments: dict[str, Any],
    run_id: str = "",
) -> dict[str, Any]:
    """Execute one granted Operation through the Registry.

    Reads execute inline; granted mutations persist a proposal
    (`requires_confirmation`) and return its identity — the side effect has
    NOT run yet. The final result arrives only after an independent approval.
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
    from app.services.agent_skill_registry import run_allowed_tools

    allowed_tools = set(run_allowed_tools(run))
    if operation not in allowed_tools:
        raise _deny("grant_denied", "Operation is outside the attached Run Skill scope", {"operation": operation})
    if operation == "get_proposal_plan":
        from app.services.proposal_plan_store import get_plan

        plan = await get_plan(str(arguments.get("plan_id") or ""))
        if plan is None or str(plan.get("run_id") or "") != run_id:
            raise _deny("grant_denied", "Plan readback is limited to the attached Run", {"operation": operation})
    elif operation == "list_proposal_plans":
        requested_run_id = str(arguments.get("run_id") or "")
        if requested_run_id and requested_run_id != run_id:
            raise _deny("grant_denied", "Plan readback is limited to the attached Run", {"operation": operation})
        arguments = {**arguments, "run_id": run_id}
    if operation in GRANTED_MUTATION_OPERATIONS:
        projection = await execute_or_propose_operation(
            operation,
            arguments,
            surface=BRIDGE_SURFACE,
            run_id=run_id,
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
        outputs = projection.get("outputs") if isinstance(projection.get("outputs"), dict) else {}
        proposal = outputs.get("proposal") if isinstance(outputs.get("proposal"), dict) else {}
        plan = outputs.get("plan") if isinstance(outputs.get("plan"), dict) else {}
        return {
            "completed": False,
            "requiresConfirmation": True,
            "plan": plan,
            "planId": str(outputs.get("plan_id") or plan.get("id") or proposal.get("plan_id") or ""),
            "proposal": proposal or None,
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
    projection = await execute_or_propose_operation(
        operation,
        arguments,
        surface=BRIDGE_SURFACE,
        run_id=run_id,
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
    plan = outputs.get("plan") if isinstance(outputs.get("plan"), dict) else {}
    if proposal or plan:
        return {
            "completed": False,
            "requiresConfirmation": True,
            "plan": plan,
            "planId": str(outputs.get("plan_id") or plan.get("id") or proposal.get("plan_id") or ""),
            "proposal": proposal or None,
            "warnings": list(projection.get("warnings") or []),
        }
    return {
        "completed": True,
        "value": outputs,
        "operationVersion": projection.get("operation_version"),
        "warnings": list(projection.get("warnings") or []),
    }


async def load_proposal_state(*, run_id: str) -> dict[str, Any]:
    """Read Plan receipts for an attached Run or one of its Plan IDs."""
    from app.services.agent_run_state import load_agent_run
    from app.services.proposal_plan_continuation import continuation_view, plan_review_view
    from app.services.agentic_interaction_policy import project_current_sources
    from app.services.proposal_plan_store import get_plan, list_continuations, list_plans

    selected_plan = await get_plan(run_id) if str(run_id).startswith("plan_") else None
    canonical_run_id = str(selected_plan.get("run_id") or "") if selected_plan else run_id
    run = await load_agent_run(canonical_run_id)
    if run is None:
        raise _deny("run_not_found", f"Agent Run {run_id} does not exist", {"runId": run_id})
    plans = [selected_plan] if selected_plan else await list_plans(run_id=canonical_run_id)
    continuations = await list_continuations(run_id=canonical_run_id)
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
        "proposalAuthority": str(run.get("proposal_authority") or ""),
        "legacyReviewRequired": bool(run.get("legacy_review_required")),
        "plans": [await project_current_sources(plan_review_view(plan, continuations=continuations))
                  for plan in plans],
        "continuations": [continuation_view(item) for item in continuations],
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
