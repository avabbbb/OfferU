"""Decision-level approval execution for Proposal v2.

The user approves a persisted ``DecisionGroup``; this module records the
decision through the Domain service, atomically claims the group, plan and
each ``OperationNode`` with SQLite-safe conditional UPDATEs, then executes
nodes sequentially through the existing ``execute_operation`` Registry
boundary under a ``decision_node`` authorization context.

Every executed node persists an ``ExecutionReceipt``. The first failure
pauses the remaining nodes of the group (they become ``blocked``); a crash
leaving nodes ``executing`` is classified by ``recover_decision_execution``
as ``uncertain``/``needs_reconciliation`` and is never replayed. There is no
compensation or rollback: committed receipts stand.

This engine is internal-only. Agent/CLI/MCP/Bridge surfaces can never reach
a node in ``executing`` status, so the ``decision_node`` protected surface
fails closed for them; the HTTP route calls ``decide_group`` only after
verifying the desktop approval capability.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select, update

from app.database import async_session
from app.models.models import (
    DecisionGroup,
    ExecutionReceipt,
    OperationAuditLog,
    OperationNode,
    ProposalPlan,
)
from app.services.decision_plans import (
    GROUP_STATUS_APPROVED,
    GROUP_STATUS_COMPLETED,
    GROUP_STATUS_EXECUTING,
    GROUP_STATUS_FAILED,
    GROUP_STATUS_NEEDS_RECONCILIATION,
    GROUP_STATUS_PENDING,
    GROUP_STATUS_REJECTED,
    GROUP_TERMINAL_STATUSES,
    NODE_STATUS_AUTHORIZED,
    NODE_STATUS_BLOCKED,
    NODE_STATUS_COMPLETED,
    NODE_STATUS_EXECUTING,
    NODE_STATUS_FAILED,
    NODE_STATUS_PENDING,
    NODE_STATUS_UNCERTAIN,
    NODE_TERMINAL_STATUSES,
    PLAN_STATUS_EXECUTING,
    PLAN_STATUS_NEEDS_RECONCILIATION,
    PLAN_STATUS_PENDING,
    compute_plan_status,
    get_decision_plan,
    record_group_decision,
)
from app.services.security_redaction import (
    redact_sensitive_value,
    safe_error_message,
)

DECISION_NODE_SURFACE = "decision_node"

# Groups and nodes this process owns mid-execution. Recovery only touches
# leftovers nobody owns, so an in-flight execution is never misclassified
# as a crashed remnant.
_INFLIGHT_GROUPS: set[str] = set()
_INFLIGHT_NODES: set[str] = set()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _failure(reason: str, **extra: Any) -> dict[str, Any]:
    return {
        "ok": False,
        "executed": False,
        "error": reason,
        "receipts": [],
        **extra,
    }


async def decide_group(
    *,
    run_id: str,
    plan_id: str,
    group_id: str,
    decision_id: str,
    decision: str,
    plan_digest: str,
    group_digest: str,
    surface: str,
) -> dict[str, Any]:
    """Record one user decision for a DecisionGroup and execute it when approved.

    Decision recording (digest binding, ``decision_id`` dedupe, dependent
    blocking on rejection) belongs to the Domain service. Execution claims
    are atomic conditional updates, so a duplicate or concurrent approval
    cannot execute the same node twice; the Registry idempotent audit key
    remains the last line of defense.
    """
    normalized = str(decision or "").strip().lower()
    if normalized not in ("approve", "reject"):
        return _failure(
            "decision 必须是 approve 或 reject。",
            decision=normalized or None,
            plan_id=plan_id,
            group_id=group_id,
        )

    try:
        recorded = await record_group_decision(
            plan_id=str(plan_id or ""),
            group_id=str(group_id or ""),
            decision_id=str(decision_id or ""),
            decision=normalized,
            plan_digest=str(plan_digest or ""),
            group_digest=str(group_digest or ""),
            surface=str(surface or ""),
        )
    except Exception as exc:
        return _failure(
            safe_error_message(exc, fallback="决策记录失败"),
            decision=normalized,
            plan_id=plan_id,
            group_id=group_id,
        )

    recorded_decision = str(recorded.get("decision") or normalized)
    if normalized == "reject" or recorded_decision == "reject":
        return {
            "ok": True,
            "executed": False,
            "decision": recorded_decision,
            "plan_id": plan_id,
            "group_id": group_id,
            "group_status": recorded.get("group_status") or GROUP_STATUS_REJECTED,
            "plan_status": recorded.get("plan_status"),
            "replayed": bool(recorded.get("replayed")),
            "blocked_group_ids": recorded.get("blocked_group_ids") or [],
            "blocked_node_ids": recorded.get("blocked_node_ids") or [],
            "receipts": recorded.get("receipts") or [],
        }

    return await _claim_and_execute_group(
        run_id=str(run_id or ""),
        plan_id=str(plan_id or ""),
        group_id=str(group_id or ""),
        recorded=recorded,
    )


async def _claim_and_execute_group(
    *, run_id: str, plan_id: str, group_id: str, recorded: dict[str, Any]
) -> dict[str, Any]:
    async with async_session() as db:
        plan = await db.get(ProposalPlan, str(plan_id))
        group = await db.get(DecisionGroup, str(group_id))

    if plan is None or group is None:
        return _failure(
            "决策计划或决策组不存在。",
            decision="approve",
            plan_id=plan_id,
            group_id=group_id,
        )
    if str(group.plan_id) != str(plan_id) or str(plan.run_id) != str(run_id):
        return _failure(
            "决策组不属于该计划的该 Agent Run。",
            decision="approve",
            plan_id=plan_id,
            group_id=group_id,
        )
    if str(group.status) in GROUP_TERMINAL_STATUSES:
        # Identical decision replay: return persisted receipts, never replay.
        return await _result_payload(
            recorded=recorded,
            plan_id=plan_id,
            group_id=group_id,
            already_final=True,
        )
    if str(group.status) == GROUP_STATUS_EXECUTING:
        # Another in-flight executor owns the lease; its receipts will persist.
        return await _in_progress_payload(
            recorded=recorded,
            plan_id=plan_id,
            group_id=group_id,
            plan_status=str(plan.status),
        )
    if str(group.status) != GROUP_STATUS_APPROVED or str(plan.status) not in (
        PLAN_STATUS_PENDING,
        PLAN_STATUS_EXECUTING,
    ):
        return _failure(
            "决策组或计划不在可执行状态。",
            decision="approve",
            plan_id=plan_id,
            group_id=group_id,
            group_status=str(group.status),
            plan_status=str(plan.status),
        )

    claimed = await _claim_group(plan_id=plan_id, group_id=group_id)
    if not claimed:
        # A concurrent approval claimed the group between our read and write;
        # it owns execution, so this call only reports state.
        return await _in_progress_payload(
            recorded=recorded,
            plan_id=plan_id,
            group_id=group_id,
            plan_status=PLAN_STATUS_EXECUTING,
        )

    _INFLIGHT_GROUPS.add(group_id)
    try:
        await _execute_group_nodes(
            run_id=run_id, plan_id=plan_id, group_id=group_id
        )
        await _pause_remaining_nodes(group_id=group_id)
        await _settle_group_and_plan(plan_id=plan_id, group_id=group_id)
    finally:
        _INFLIGHT_GROUPS.discard(group_id)

    return await _result_payload(
        recorded=recorded, plan_id=plan_id, group_id=group_id
    )


async def _in_progress_payload(
    *, recorded: dict[str, Any], plan_id: str, group_id: str, plan_status: str
) -> dict[str, Any]:
    return {
        "ok": True,
        "executed": False,
        "in_progress": True,
        "decision": "approve",
        "plan_id": plan_id,
        "group_id": group_id,
        "group_status": GROUP_STATUS_EXECUTING,
        "plan_status": plan_status,
        "receipts": await _receipts_for_group(group_id),
        "replayed": bool(recorded.get("replayed")),
    }


async def _claim_group(*, plan_id: str, group_id: str) -> bool:
    """approved -> executing lease plus plan pending -> executing.

    Both writes commit in one transaction; the group UPDATE's WHERE clause
    is the lease — a losing concurrent claimant updates 0 rows.
    """
    async with async_session() as db:
        group_claim = await db.execute(
            update(DecisionGroup)
            .where(DecisionGroup.group_id == group_id)
            .where(DecisionGroup.status == GROUP_STATUS_APPROVED)
            .values(status=GROUP_STATUS_EXECUTING)
        )
        if int(group_claim.rowcount or 0) != 1:
            await db.rollback()
            return False
        await db.execute(
            update(ProposalPlan)
            .where(ProposalPlan.plan_id == plan_id)
            .where(ProposalPlan.status == PLAN_STATUS_PENDING)
            .values(status=PLAN_STATUS_EXECUTING, updated_at=_now())
        )
        # Nodes still pending (e.g. an approval recorded before the Domain
        # cascade ran) become authorized under the same lease.
        await db.execute(
            update(OperationNode)
            .where(OperationNode.group_id == group_id)
            .where(OperationNode.status == NODE_STATUS_PENDING)
            .values(status=NODE_STATUS_AUTHORIZED)
        )
        await db.commit()
        return True


async def _execute_group_nodes(
    *, run_id: str, plan_id: str, group_id: str
) -> None:
    del plan_id  # nodes carry their own plan_id; kept in signature for clarity
    async with async_session() as db:
        nodes = (
            (
                await db.execute(
                    select(OperationNode)
                    .where(OperationNode.group_id == group_id)
                    .order_by(OperationNode.sequence)
                )
            )
            .scalars()
            .all()
        )

    for node in nodes:
        node_id = str(node.node_id)
        status = str(node.status)
        if status in NODE_TERMINAL_STATUSES:
            continue
        if status == NODE_STATUS_EXECUTING:
            if node_id in _INFLIGHT_NODES:
                # Owned by this process under a different caller; leave it for
                # its owner and stop walking this group.
                break
            # Crash leftover that slipped past recovery: fail closed.
            await _persist_node_outcome(
                node=node,
                envelope={
                    "ok": False,
                    "errors": ["该节点上次在执行中断开，系统没有自动重放。"],
                },
                effect_state="unknown",
                audit_id=None,
            )
            break
        if status != NODE_STATUS_AUTHORIZED:
            await _persist_node_outcome(
                node=node,
                envelope={
                    "ok": False,
                    "errors": [f"决策节点处于不可执行状态: {status}"],
                },
                effect_state="no_effect",
                audit_id=None,
            )
            break

        claimed = await _claim_node(node)
        if not claimed:
            # Concurrent executor claimed it first; its receipt decides.
            continue

        _INFLIGHT_NODES.add(node_id)
        try:
            envelope, effect_state = await _invoke_node(node, run_id=run_id)
        finally:
            _INFLIGHT_NODES.discard(node_id)
        audit_id = await _audit_id_for_key(str(node.idempotency_key))
        await _persist_node_outcome(
            node=node,
            envelope=envelope,
            effect_state=effect_state,
            audit_id=audit_id,
        )
        if not envelope.get("ok"):
            # First failure pauses all remaining nodes of the group.
            break


async def _claim_node(node: OperationNode) -> bool:
    """authorized -> executing lease for exactly one node."""
    async with async_session() as db:
        result = await db.execute(
            update(OperationNode)
            .where(OperationNode.node_id == node.node_id)
            .where(OperationNode.status == NODE_STATUS_AUTHORIZED)
            .values(
                status=NODE_STATUS_EXECUTING,
                attempt_count=OperationNode.attempt_count + 1,
                started_at=_now(),
            )
        )
        claimed = int(result.rowcount or 0) == 1
        await db.commit()
        return claimed


async def _invoke_node(
    node: OperationNode, *, run_id: str
) -> tuple[dict[str, Any], str]:
    from app.ops import confirmed_decision_node, execute_operation

    try:
        with confirmed_decision_node(
            operation=str(node.operation),
            run_id=run_id,
            node_id=str(node.node_id),
            group_id=str(node.group_id),
            plan_id=str(node.plan_id),
            args_digest=str(node.args_digest or ""),
            idempotency_key=str(node.idempotency_key or ""),
        ):
            envelope = await execute_operation(
                str(node.operation),
                dict(node.args_json or {}),
                surface=DECISION_NODE_SURFACE,
            )
    except Exception as exc:
        # Anything raised around the boundary (claim/audit) cannot prove the
        # operation did not run; classify as unknown rather than no_effect.
        return (
            {
                "ok": False,
                "operation": str(node.operation),
                "errors": [safe_error_message(exc)],
                "warnings": [],
            },
            "unknown",
        )
    effect_state = str(
        envelope.get("effect_state")
        or ("committed" if envelope.get("ok") else "unknown")
    )
    return envelope, effect_state


async def _audit_id_for_key(idempotency_key: str) -> int | None:
    if not idempotency_key:
        return None
    try:
        async with async_session() as db:
            row = (
                await db.execute(
                    select(OperationAuditLog.id).where(
                        OperationAuditLog.idempotency_key == idempotency_key[:180]
                    )
                )
            ).scalar_one_or_none()
    except Exception:
        return None
    return int(row) if row is not None else None


async def _persist_node_outcome(
    *,
    node: OperationNode,
    envelope: dict[str, Any],
    effect_state: str,
    audit_id: int | None,
) -> None:
    """Persist the node's terminal status and its ExecutionReceipt together.

    A pre-invocation failure is ``no_effect`` -> node ``failed``; anything
    post-invocation without a reliable no-effect contract is ``unknown`` ->
    node ``uncertain``. Receipt insert races resolve to the existing row,
    which is the authoritative outcome (never re-executed).
    """
    if envelope.get("ok"):
        node_status = NODE_STATUS_COMPLETED
    elif effect_state == "unknown":
        node_status = NODE_STATUS_UNCERTAIN
    else:
        node_status = NODE_STATUS_FAILED

    now = _now()
    result_payload = redact_sensitive_value(envelope.get("outputs"))
    errors = redact_sensitive_value(envelope.get("errors") or [])
    warnings = redact_sensitive_value(envelope.get("warnings") or [])

    from app.services.decision_plans import canonical_digest

    async with async_session() as db:
        await db.execute(
            update(OperationNode)
            .where(OperationNode.node_id == node.node_id)
            .values(status=node_status, completed_at=now)
        )
        try:
            db.add(
                ExecutionReceipt(
                    receipt_id=f"receipt_{uuid.uuid4().hex}",
                    node_id=str(node.node_id),
                    plan_id=str(node.plan_id),
                    group_id=str(node.group_id),
                    operation=str(node.operation),
                    idempotency_key=str(node.idempotency_key or ""),
                    audit_id=audit_id,
                    status=node_status,
                    effect_state=effect_state,
                    before_json=_json_object(node.target_json),
                    after_json=_json_object(result_payload),
                    result_json=_json_object(result_payload),
                    errors_json=errors if isinstance(errors, list) else [str(errors)],
                    warnings_json=(
                        warnings if isinstance(warnings, list) else [str(warnings)]
                    ),
                    result_digest=canonical_digest(result_payload),
                    created_at=now,
                    completed_at=now,
                )
            )
            await db.commit()
        except Exception:
            await db.rollback()
            # A receipt for this node_id already exists (unique constraint):
            # the persisted row is authoritative and execution was not replayed.


async def _pause_remaining_nodes(*, group_id: str) -> None:
    """Pause nodes the group never reached: pending/authorized -> blocked.

    Nodes that already ran keep their persisted terminal status; nodes still
    executing belong to another in-flight owner and are left alone for it.
    """
    async with async_session() as db:
        await db.execute(
            update(OperationNode)
            .where(OperationNode.group_id == group_id)
            .where(
                OperationNode.status.in_([NODE_STATUS_PENDING, NODE_STATUS_AUTHORIZED])
            )
            .values(status=NODE_STATUS_BLOCKED)
        )
        await db.commit()


async def _settle_group_and_plan(*, plan_id: str, group_id: str) -> None:
    """Converge group status from node outcomes, then the plan from groups.

    Undecided sibling groups keep the plan open (Domain's compute rule);
    there is no rollback and no automatic re-plan of paused nodes.
    """
    async with async_session() as db:
        node_statuses = {
            str(status)
            for status in (
                (
                    await db.execute(
                        select(OperationNode.status).where(
                            OperationNode.group_id == group_id
                        )
                    )
                )
                .scalars()
                .all()
            )
        }
        if NODE_STATUS_UNCERTAIN in node_statuses or not node_statuses:
            group_status = GROUP_STATUS_NEEDS_RECONCILIATION
        elif NODE_STATUS_FAILED in node_statuses:
            group_status = GROUP_STATUS_FAILED
        elif node_statuses <= NODE_TERMINAL_STATUSES:
            group_status = GROUP_STATUS_COMPLETED
        else:
            # Some node is still mid-flight under another owner.
            group_status = GROUP_STATUS_EXECUTING
        await db.execute(
            update(DecisionGroup)
            .where(DecisionGroup.group_id == group_id)
            .values(status=group_status)
        )

        group_statuses = [
            str(status)
            for status in (
                (
                    await db.execute(
                        select(DecisionGroup.status).where(
                            DecisionGroup.plan_id == plan_id
                        )
                    )
                )
                .scalars()
                .all()
            )
        ]
        plan_status = compute_plan_status(group_statuses)
        await db.execute(
            update(ProposalPlan)
            .where(ProposalPlan.plan_id == plan_id)
            .values(status=plan_status, updated_at=_now())
        )
        await db.commit()


async def _receipts_for_group(group_id: str) -> list[dict[str, Any]]:
    async with async_session() as db:
        rows = (
            (
                await db.execute(
                    select(ExecutionReceipt).where(
                        ExecutionReceipt.group_id == group_id
                    )
                )
            )
            .scalars()
            .all()
        )
        return [_receipt_view(row) for row in rows]


def _receipt_view(row: ExecutionReceipt) -> dict[str, Any]:
    return {
        "receipt_id": row.receipt_id,
        "node_id": row.node_id,
        "plan_id": row.plan_id,
        "group_id": row.group_id,
        "operation": row.operation,
        "idempotency_key": row.idempotency_key,
        "audit_id": row.audit_id,
        "status": row.status,
        "effect_state": row.effect_state,
        "result": row.result_json,
        "errors": row.errors_json,
        "warnings": row.warnings_json,
        "result_digest": row.result_digest,
        "created_at": str(row.created_at or ""),
        "completed_at": str(row.completed_at or ""),
    }


async def _result_payload(
    *,
    recorded: dict[str, Any],
    plan_id: str,
    group_id: str,
    already_final: bool = False,
) -> dict[str, Any]:
    try:
        plan = await get_decision_plan(plan_id)
    except Exception:
        plan = {}
    groups = {str(g.get("group_id")): g for g in (plan.get("groups") or [])}
    group_view = groups.get(str(group_id)) or {}
    return {
        "ok": True,
        "executed": not already_final,
        "already_final": already_final,
        "decision": "approve",
        "plan_id": plan_id,
        "group_id": group_id,
        "group_status": str(group_view.get("status") or ""),
        "plan_status": str(plan.get("status") or ""),
        "plan": plan,
        "receipts": await _receipts_for_group(group_id),
        "replayed": bool(recorded.get("replayed")),
    }


async def recover_decision_execution() -> dict[str, int]:
    """Classify crash leftovers after restart; never replay side effects.

    Any node still ``executing`` that no live executor owns becomes
    ``uncertain`` (its side effect, if it landed, is unknowable); groups and
    plans left mid-flight become ``needs_reconciliation``.
    """
    uncertain_nodes = 0
    reconciled_groups: set[str] = set()
    reconciled_plans: set[str] = set()
    now = _now()

    async with async_session() as db:
        executing_nodes = (
            (
                await db.execute(
                    select(OperationNode).where(
                        OperationNode.status == NODE_STATUS_EXECUTING
                    )
                )
            )
            .scalars()
            .all()
        )
        for node in executing_nodes:
            node_id = str(node.node_id)
            if node_id in _INFLIGHT_NODES:
                continue
            node.status = NODE_STATUS_UNCERTAIN
            node.completed_at = now
            uncertain_nodes += 1
            reconciled_groups.add(str(node.group_id))
            reconciled_plans.add(str(node.plan_id))
        await db.commit()

        # Groups still marked executing whose execution lease died with the
        # process (crash between group claim and first node claim) also need
        # reconciliation; their authorized nodes are never auto-replayed.
        executing_groups = (
            (
                await db.execute(
                    select(DecisionGroup).where(
                        DecisionGroup.status == GROUP_STATUS_EXECUTING
                    )
                )
            )
            .scalars()
            .all()
        )
        for group in executing_groups:
            group_id = str(group.group_id)
            if group_id in _INFLIGHT_GROUPS:
                continue
            group.status = GROUP_STATUS_NEEDS_RECONCILIATION
            reconciled_groups.add(group_id)
            reconciled_plans.add(str(group.plan_id))
        await db.commit()

        executing_plans = (
            (
                await db.execute(
                    select(ProposalPlan).where(
                        ProposalPlan.status.in_(
                            [PLAN_STATUS_EXECUTING, PLAN_STATUS_NEEDS_RECONCILIATION]
                        )
                    )
                )
            )
            .scalars()
            .all()
        )
        for plan in executing_plans:
            if str(plan.plan_id) in reconciled_plans:
                plan.status = PLAN_STATUS_NEEDS_RECONCILIATION
                plan.updated_at = now
        await db.commit()

    return {
        "uncertain_nodes": uncertain_nodes,
        "needs_reconciliation_groups": len(reconciled_groups),
        "needs_reconciliation_plans": len(reconciled_plans),
    }


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if value is None:
        return {}
    return {"value": value}
