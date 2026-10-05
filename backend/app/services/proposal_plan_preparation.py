"""L1 control-plane preparation bound to the original Run and Skill scope."""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

from app.services.proposal_plan_builder import PlanValidationError, build_plan, canonical_digest, _normalize

_RUN_CONTEXT: ContextVar[tuple[str, frozenset[str]] | None] = ContextVar("offeru_plan_preparation", default=None)


@contextmanager
def plan_preparation_context(run_id: str, allowed_operations: set[str] | frozenset[str]):
    token = _RUN_CONTEXT.set((run_id, frozenset(allowed_operations)))
    try:
        yield
    finally:
        _RUN_CONTEXT.reset(token)


async def prepare_proposal_plan(*, title: str, intents: list[dict[str, Any]],
                                groups: list[dict[str, Any]] | None = None, run_id: str | None = None) -> dict[str, Any]:
    from app.services.agent_run_state import load_agent_run
    from app.services.proposal_plan_sources import capture_sources
    from app.services.proposal_plan_store import create_plan, list_plans
    context = _RUN_CONTEXT.get()
    if context is not None:
        bound_run, allowed = context
        if run_id is not None and run_id != bound_run:
            raise PlanValidationError("Plan Run differs from the active Agent Run")
        run_id = bound_run
    else:
        if not run_id:
            raise PlanValidationError("Plan preparation needs an existing Run")
        run = await load_agent_run(run_id)
        if run is None:
            raise PlanValidationError("Agent Run does not exist")
        allowed = frozenset((run.get("skill_snapshot") or {}).get("allowed_tools") or [])
        if not allowed:
            raise PlanValidationError("Run has no verified Skill tool scope")
    if any(intent.get("operation") not in allowed for intent in intents):
        raise PlanValidationError("Plan intent is outside the active Skill allowlist")
    if any(intent.get("operation") in {"prepare_proposal_plan", "confirm_group", "reject_group", "confirm_operation_proposal"} for intent in intents):
        raise PlanValidationError("Plans cannot stage approval or recursive planning")
    # Dedupe the same prepared request before assigning new immutable IDs.
    prepared = await capture_sources(intents)
    signatures = [canonical_digest({"operation": intent["operation"], "args": intent["args"], "source_versions": intent["source_versions"]}) for intent in prepared]
    if len(set(signatures)) != len(signatures):
        raise PlanValidationError("Duplicate operation intents must use one node; do not prepare the same write twice")
    request_digest = canonical_digest({"title": title, "intents": prepared, "groups": groups or []})
    for previous in await list_plans(run_id=run_id):
        pending = [node for group in previous.get("groups") or [] if group.get("status") in {"pending", "approved", "executing"}
                   for node in group["nodes"] if node["status"] in {"pending", "executing"}]
        existing = {canonical_digest({"operation": node["operation"], "args": node["args"], "source_versions": node["source_versions"]}) for node in pending}
        if existing.intersection(signatures):
            if existing == set(signatures) and all(group["status"] == "pending" for group in previous["groups"]):
                return {"plan_id": previous["id"], "plan": previous, "executed": False, "requires_confirmation": True, "duplicate": True}
            raise PlanValidationError("Some intents already have pending authorization; read the existing Plan instead of duplicating writes")
        for previous_group in previous.get("groups") or []:
            if previous_group.get("status") != "needs_reconciliation":
                continue
            for node in previous_group.get("nodes") or []:
                for intent in prepared:
                    if node.get("operation") == intent.get("operation"):
                        _, normalized = _normalize(str(intent["operation"]), intent.get("args") or {})
                        if node.get("args") == normalized:
                            raise PlanValidationError("The same operation has an unresolved effect; reconcile it before preparing another write")
        if previous.get("request_digest") == request_digest and previous.get("status") not in {"replaced", "rejected", "blocked"}:
            completed = previous.get("status") == "completed"
            return {"plan_id": previous["id"], "plan": previous, "executed": completed,
                    "requires_confirmation": not completed, "duplicate": True}
    plan = build_plan(prepared, run_id=run_id, title=title, groups=groups)
    plan["request_digest"] = request_digest
    stored = await create_plan(plan)
    return {"plan_id": stored["id"], "plan": stored, "executed": False, "requires_confirmation": True}


async def get_proposal_plan(*, plan_id: str) -> dict[str, Any]:
    from app.services.proposal_plan_store import get_plan
    plan = await get_plan(plan_id)
    if plan is None:
        raise PlanValidationError("Proposal Plan does not exist")
    return plan


async def list_proposal_plans(*, run_id: str | None = None) -> dict[str, Any]:
    from app.services.proposal_plan_store import list_plans
    plans = await list_plans(run_id=run_id)
    return {"items": plans, "total": len(plans)}
