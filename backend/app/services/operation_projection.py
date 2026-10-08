from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from app.ops import OPERATIONS, execute_operation


def _error(operation: str, message: str) -> dict[str, Any]:
    return {"ok": False, "operation": operation, "errors": [message], "outputs": {}}


async def _run_scope(
    run_id: str,
    *,
    allowed_operations: Iterable[str] | None = None,
) -> tuple[dict[str, Any] | None, frozenset[str]]:
    from app.services.agent_run_state import load_agent_run

    run = await load_agent_run(run_id)
    if run is None:
        return None, frozenset()
    from app.services.agent_skill_registry import run_allowed_tools

    saved = run_allowed_tools(run)
    if allowed_operations is None:
        return run, saved
    requested = frozenset(str(name) for name in allowed_operations if str(name))
    if not requested.issubset(saved):
        return None, frozenset()
    return run, requested


def _affected_entities(args: dict[str, Any]) -> list[dict[str, str]]:
    entities: list[dict[str, str]] = []
    for key, kind in (
        ("job_id", "job"),
        ("profile_id", "profile"),
        ("resume_id", "resume"),
        ("proposal_id", "resume_proposal"),
        ("application_id", "application"),
        ("interview_id", "interview"),
        ("task_id", "career_task"),
    ):
        value = args.get(key)
        if value is not None and str(value).strip():
            entities.append({"kind": kind, "id": str(value)})
    target_type = str(args.get("target_type") or "").strip()
    target_id = str(args.get("target_id") or "").strip()
    if target_type and target_id:
        entities.append({"kind": target_type, "id": target_id})
    return entities


async def _create_visible_ui_run(
    operation: str,
    args: dict[str, Any],
    *,
    conversation_id: str,
    summary: str,
) -> dict[str, Any]:
    """Bind an explicit UI request to a visible deterministic audit Run."""

    from app.services.agent_run_state import create_agent_run

    existing_task_id = (
        str(args.get("task_id") or "")
        if operation in {"cancel_career_task", "retry_career_task", "resume_career_task"}
        else ""
    )
    allowed = sorted({operation, "prepare_proposal_plan", "get_proposal_plan", "list_proposal_plans"})
    entities = _affected_entities(args)
    return await create_agent_run(
        conversation_id=conversation_id,
        goal=f"OfferU UI request: {summary}",
        mode="ui_operation_request",
        skill_id="operation_registry",
        skill_version="proposal-plan-v2",
        skill_snapshot={
            "version": "ui-operation-request.v1",
            "allowed_tools": allowed,
            "domain_refs": entities,
        },
        task_id=existing_task_id,
        actions=[],
        exit_criteria=["the exact user-requested Registry operation is reviewed and completed or visibly blocked"],
        llm_runtime={"runtime": "none", "reason": "explicit_ui_operation_request"},
    )


async def _execute_plan_preparation(
    args: dict[str, Any],
    *,
    surface: str,
    run_id: str = "",
    allowed_operations: Iterable[str] | None = None,
) -> dict[str, Any]:
    bound_run_id = str(run_id or args.get("run_id") or "").strip()
    if not bound_run_id:
        return _error(
            "prepare_proposal_plan",
            "Plan preparation requires an existing Agent Run; no hidden Run is created.",
        )
    supplied_run_id = str(args.get("run_id") or "").strip()
    if supplied_run_id and supplied_run_id != bound_run_id:
        return _error("prepare_proposal_plan", "Plan Run differs from the attached Agent Run.")
    run, allowed = await _run_scope(
        bound_run_id,
        allowed_operations=allowed_operations,
    )
    if run is None:
        return _error("prepare_proposal_plan", "Agent Run or Skill scope is unavailable.")
    if "prepare_proposal_plan" not in allowed:
        return _error("prepare_proposal_plan", "Plan staging is outside the persisted Run Skill scope.")
    from app.services.proposal_plan_preparation import plan_preparation_context

    try:
        with plan_preparation_context(bound_run_id, set(allowed)):
            result = await execute_operation(
                "prepare_proposal_plan",
                {**args, "run_id": bound_run_id},
                surface=surface,
            )
        outputs = result.get("outputs") if isinstance(result.get("outputs"), dict) else {}
        plan = outputs.get("plan") if isinstance(outputs.get("plan"), dict) else {}
        plan_id = str(outputs.get("plan_id") or plan.get("id") or "")
        if (
            result.get("ok")
            and outputs.get("executed") is False
            and outputs.get("requires_confirmation") is True
            and plan_id
        ):
            from app.services.agent_run_state import sync_proposal_plan_state

            await sync_proposal_plan_state(
                bound_run_id,
                event_type="proposal.plan_ready",
                payload={"plan_id": plan_id, "plan_digest": plan.get("digest") or outputs.get("plan_digest")},
            )
        return result
    except Exception as exc:
        from app.services.security_redaction import safe_error_message

        return _error("prepare_proposal_plan", safe_error_message(exc))


async def execute_or_propose_operation(
    name: str,
    args: dict[str, Any] | None = None,
    *,
    surface: str,
    dry_run: bool = False,
    conversation_id: str = "",
    run_id: str = "",
    allowed_operations: Iterable[str] | None = None,
) -> dict[str, Any]:
    """Execute a safe Registry operation or stage a protected write as a Plan.

    A protected single-operation compatibility call becomes one exact
    singleton group in the current Run. Multi-operation semantic grouping is
    supplied explicitly through ``prepare_proposal_plan`` by the active Agent.
    """

    inputs = args if isinstance(args, dict) else {}
    operation = OPERATIONS.get(name)
    if name == "prepare_proposal_plan":
        return await _execute_plan_preparation(
            inputs,
            surface=surface,
            run_id=run_id,
            allowed_operations=allowed_operations,
        )
    if operation is None or not operation.requires_confirmation or dry_run:
        return await execute_operation(name, inputs, dry_run=dry_run, surface=surface)

    bound_run_id = str(run_id or "").strip()
    if not bound_run_id and surface == "agent_runtime_ui":
        preview = await execute_operation(name, inputs, dry_run=True, surface=surface)
        if not preview.get("ok"):
            return preview
        visible_run = await _create_visible_ui_run(
            name,
            inputs,
            conversation_id=conversation_id,
            summary=operation.description or name,
        )
        bound_run_id = str(visible_run.get("id") or "")
    if not bound_run_id:
        return _error(
            name,
            "Protected operations require an existing Agent Run; no hidden Run is created.",
        )
    run, allowed = await _run_scope(
        bound_run_id,
        allowed_operations=allowed_operations,
    )
    if run is None:
        return _error(name, "Agent Run or Skill scope is unavailable.")
    if name not in allowed or "prepare_proposal_plan" not in allowed:
        return _error(name, "Operation is outside the persisted Run Skill scope.")

    preview = await execute_operation(name, inputs, dry_run=True, surface=surface)
    if not preview.get("ok"):
        return preview

    intent_id = "legacy_singleton"
    summary = operation.description or name
    plan_args = {
        "run_id": bound_run_id,
        "title": summary[:500],
        "intents": [
            {
                "id": intent_id,
                "operation": name,
                "args": inputs,
                "summary": summary,
                "affected_entities": _affected_entities(inputs),
            }
        ],
        "groups": [
            {
                "id": "legacy_singleton_group",
                "title": summary[:500],
                "rationale": "Compatibility request for this exact Registry operation and input.",
                "summary": summary,
                "node_ids": [intent_id],
            }
        ],
    }
    return await _execute_plan_preparation(
        plan_args,
        surface=surface,
        run_id=bound_run_id,
        allowed_operations=allowed,
    )


async def confirm_operation_proposal(
    run_id: str,
    *,
    surface: str,
    action_id: str = "",
    authorization_source: str | None = None,
    plan_digest: str = "",
    group_digest: str = "",
    decision_id: str = "",
) -> dict[str, Any]:
    """Compatibility adapter for an old action button, limited to one node.

    New review surfaces use the plan/group endpoint and submit both displayed
    digests. This adapter cannot approve a multi-node group or an old step that
    has no equivalent immutable Plan.
    """

    if not authorization_source:
        return _error("confirm_proposal", "Independent OfferU UI authorization is required.")
    if not plan_digest or not group_digest:
        return _error(
            "confirm_proposal",
            "This action-only confirmation has no displayed Plan snapshot. Reopen PlanReview and decide the group using both displayed digests.",
        )
    from app.services.agent_run_state import sync_proposal_plan_state
    from app.services.proposal_plan_builder import PlanValidationError, canonical_digest, verify_plan_snapshot
    from app.services.proposal_plan_store import list_plans
    from app.services.agent_run_coordinator import AgentRunCoordinator

    clean_action_id = str(action_id or "").strip()
    if not clean_action_id:
        return _error("confirm_proposal", "An exact action_id is required.")
    plans = await list_plans(run_id=run_id)
    matches: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for plan in plans:
        if plan.get("status") == "replaced":
            continue
        try:
            verify_plan_snapshot(plan)
        except PlanValidationError:
            return _error("confirm_proposal", "The stored Plan no longer verifies; reopen PlanReview before deciding.")
        for group in plan.get("groups") or []:
            if any(str(node.get("id") or "") == clean_action_id for node in group.get("nodes") or []):
                matches.append((plan, group))
    if len(matches) != 1:
        return _error("confirm_proposal", "No exact current Plan node matches this action_id.")
    plan, group = matches[0]
    if len(group.get("nodes") or []) != 1:
        return _error(
            "confirm_proposal",
            "This legacy action belongs to a multi-node group; use the displayed group decision.",
        )
    if plan.get("digest") != plan_digest or group.get("digest") != group_digest:
        return _error("confirm_proposal", "The displayed Plan snapshot changed; reload PlanReview before deciding.")
    decision_id = decision_id or "decision_" + canonical_digest(
        {"run_id": run_id, "action_id": clean_action_id, "plan_digest": plan_digest,
         "group_digest": group_digest, "decision": "approve"}
    )[:32]
    result = await AgentRunCoordinator().confirm_group(
        plan["id"],
        group["id"],
        plan_digest=plan["digest"],
        group_digest=group["digest"],
        decision_id=decision_id,
        authorization_source=authorization_source,
        surface=surface,
    )
    if result.get("ok"):
        await sync_proposal_plan_state(
            run_id,
            event_type="proposal.group_decided",
            payload={"plan_id": plan["id"], "group_id": group["id"], "decision": "approve"},
        )
    return result


async def reject_operation_proposal(
    run_id: str,
    *,
    surface: str,
    action_id: str = "",
    authorization_source: str | None = None,
    plan_digest: str = "",
    group_digest: str = "",
    decision_id: str = "",
) -> dict[str, Any]:
    """Compatibility rejection with the same exact-singleton bound as approve."""

    if not authorization_source:
        return _error("reject_proposal", "Independent OfferU UI authorization is required.")
    if not plan_digest or not group_digest:
        return _error(
            "reject_proposal",
            "This action-only decision has no displayed Plan snapshot. Reopen PlanReview and decide the group using both displayed digests.",
        )
    from app.services.agent_run_state import sync_proposal_plan_state
    from app.services.proposal_plan_builder import PlanValidationError, canonical_digest, verify_plan_snapshot
    from app.services.proposal_plan_store import list_plans
    from app.services.agent_run_coordinator import AgentRunCoordinator

    clean_action_id = str(action_id or "").strip()
    if not clean_action_id:
        return _error("reject_proposal", "An exact action_id is required.")
    plans = await list_plans(run_id=run_id)
    matches: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for plan in plans:
        if plan.get("status") == "replaced":
            continue
        try:
            verify_plan_snapshot(plan)
        except PlanValidationError:
            return _error("reject_proposal", "The stored Plan no longer verifies; reopen PlanReview before deciding.")
        for group in plan.get("groups") or []:
            if any(str(node.get("id") or "") == clean_action_id for node in group.get("nodes") or []):
                matches.append((plan, group))
    if len(matches) != 1:
        return _error("reject_proposal", "No exact current Plan node matches this action_id.")
    plan, group = matches[0]
    if len(group.get("nodes") or []) != 1:
        return _error(
            "reject_proposal",
            "This legacy action belongs to a multi-node group; use the displayed group decision.",
        )
    if plan.get("digest") != plan_digest or group.get("digest") != group_digest:
        return _error("reject_proposal", "The displayed Plan snapshot changed; reload PlanReview before deciding.")
    decision_id = decision_id or "decision_" + canonical_digest(
        {"run_id": run_id, "action_id": clean_action_id, "plan_digest": plan_digest,
         "group_digest": group_digest, "decision": "reject"}
    )[:32]
    result = await AgentRunCoordinator().reject_group(
        plan["id"],
        group["id"],
        plan_digest=plan["digest"],
        group_digest=group["digest"],
        decision_id=decision_id,
        authorization_source=authorization_source,
        surface=surface,
    )
    if result.get("ok"):
        await sync_proposal_plan_state(
            run_id,
            event_type="proposal.group_decided",
            payload={"plan_id": plan["id"], "group_id": group["id"], "decision": "reject"},
        )
    return result
