"""Execute approved Proposal Plan groups through the existing Operation Registry."""
from __future__ import annotations

import asyncio
import uuid
from typing import Any

from sqlalchemy import select

from app.database import async_session
from app.models.models import OperationAuditLog
from app.ops import OPERATIONS, confirmed_operation, execute_operation
from app.services.agent_run_state import safe_result_preview
from app.services.proposal_plan_builder import (
    PlanValidationError,
    verify_plan_snapshot,
)
from app.services.proposal_plan_source_guard import observe_node_sources
from app.services.proposal_plan_store import (
    ProposalStaleSnapshotError,
    claim_node,
    checkpoint_node,
    create_continuation,
    get_node_authorization,
    get_plan,
    list_continuations,
    pause_group,
    record_decision,
    recover_executing_nodes,
    resolve_node_reconciliation,
    renew_node_claim,
)

_UI_AUTHORIZATION_SOURCE = "desktop-ui"
_UI_SURFACE = "agent_runtime_ui"
_LEASE_SECONDS = 60
_HEARTBEAT_SECONDS = 15
_MAX_PREFLIGHT_RETRIES = 1


def _group(plan: dict[str, Any], group_id: str) -> dict[str, Any] | None:
    return next(
        (item for item in plan.get("groups") or [] if item.get("id") == group_id),
        None,
    )


def _group_source_versions(group: dict[str, Any]) -> dict[str, str]:
    versions: dict[str, str] = {}
    sources = [group.get("source_versions") or {}]
    sources.extend(node.get("source_versions") or {} for node in group.get("nodes") or [])
    for source_map in sources:
        if not isinstance(source_map, dict):
            raise PlanValidationError("Invalid source-version snapshot")
        for reference, digest in source_map.items():
            previous = versions.get(str(reference))
            if previous is not None and previous != str(digest):
                raise PlanValidationError("Group nodes bind conflicting source versions")
            versions[str(reference)] = str(digest)
    return versions


def _ordered_nodes(group: dict[str, Any]) -> list[dict[str, Any]]:
    nodes = sorted(group.get("nodes") or [], key=lambda item: int(item.get("ordinal") or 0))
    by_id = {str(node.get("id") or ""): node for node in nodes}
    seen: set[str] = set()
    for node in nodes:
        node_id = str(node.get("id") or "")
        local_dependencies = {
            str(dependency)
            for dependency in node.get("dependency_node_ids") or []
            if str(dependency) in by_id
        }
        if not local_dependencies.issubset(seen):
            raise PlanValidationError(
                "Node dependencies must follow the displayed group order"
            )
        seen.add(node_id)
    return nodes


def _persistable_source_evidence(evidence: dict[str, Any]) -> dict[str, Any]:
    source = evidence.get("source_evidence")
    if not isinstance(source, dict):
        return {"verified": False, "complete": False}
    # The ORM observer may retain row images while it verifies a transition.
    # Receipts store only hashes and row identities, never resume content.
    effects = []
    for effect in source.get("effects") or []:
        if not isinstance(effect, dict):
            continue
        after = effect.get("after")
        effects.append(
            {
                "source": effect.get("source"),
                "collection": effect.get("collection"),
                "action": effect.get("action"),
                "row_id": after.get("id") if isinstance(after, dict) else effect.get("row_id"),
            }
        )
    return {
        "before_versions": dict(source.get("before_versions") or {}),
        "after_versions": dict(source.get("after_versions") or {}),
        "effects": effects,
        "verified": source.get("verified") is True,
        "complete": source.get("complete") is True,
        **({"adapter": source["adapter"], "workspace_effect": source["workspace_effect"]}
           if source.get("adapter") == "proposal-plan.ensure-resume-workspace.v1" and isinstance(source.get("workspace_effect"), dict) else {}),
        **({"adapter": source["adapter"], "reset_effect": source["reset_effect"]}
           if source.get("adapter") == "proposal-plan.clean-reset.v1" and isinstance(source.get("reset_effect"), dict) else {}),
    }


async def _audit_for_node(
    node: dict[str, Any], audit_attempt_key: str
) -> dict[str, Any] | None:
    async with async_session() as db:
        row = (
            await db.execute(
                select(OperationAuditLog).where(
                    OperationAuditLog.idempotency_key
                    == str(audit_attempt_key or "")[:180]
                )
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        return {
            "id": row.id,
            "status": str(row.status or ""),
            "ok": bool(row.ok),
            "operation": str(row.operation or ""),
            "idempotency_key": str(row.idempotency_key or ""),
        }


async def _current_binding(node_id: str) -> dict[str, Any] | None:
    binding = await get_node_authorization(node_id)
    return binding if isinstance(binding, dict) else None


async def _run_cancellation_error(run_id: str) -> str:
    from app.services.agent_run_state import load_agent_run

    run = await load_agent_run(run_id)
    if run is None:
        return "Agent Run 不存在；计划不能执行。"
    if str(run.get("status") or "") == "cancelled":
        return "Agent Run 已取消；计划不能继续执行。"
    return ""


async def _continuation_for_group(
    plan: dict[str, Any], group: dict[str, Any]
) -> dict[str, Any] | None:
    run_id = str(plan.get("run_id") or "")
    group_id = str(group.get("id") or "")
    for item in await list_continuations(run_id=run_id):
        if isinstance(item, dict) and str(item.get("group_id") or "") == group_id:
            return item
    receipt_ids = []
    for node in group.get("nodes") or []:
        receipt = node.get("receipt") if isinstance(node.get("receipt"), dict) else {}
        receipt_id = node.get("receipt_id") or node.get("receipt_ref") or receipt.get("id")
        if receipt_id and str(receipt_id) not in receipt_ids:
            receipt_ids.append(str(receipt_id))
    result = await create_continuation(
        {
            "id": f"continuation_{uuid.uuid4().hex}",
            "idempotency_key": f"proposal-v2:{run_id}:{group_id}:continuation",
            "run_id": run_id,
            "group_id": group_id,
            "receipt_ids": receipt_ids,
            "status": "pending",
        }
    )
    continuation = result.get("continuation") if isinstance(result, dict) else None
    return continuation if isinstance(continuation, dict) else None


async def _group_receipts(group: dict[str, Any]) -> list[dict[str, Any]]:
    receipts: list[dict[str, Any]] = []
    for node in group.get("nodes") or []:
        binding = await _current_binding(str(node.get("id") or ""))
        stored = binding.get("node") if binding and isinstance(binding.get("node"), dict) else {}
        history = stored.get("receipts") or (binding or {}).get("receipts") or node.get("receipts") or []
        if isinstance(history, list) and history:
            receipts.extend(item for item in history if isinstance(item, dict))
            continue
        durable = stored.get("receipt") or (binding or {}).get("receipt") or node.get("receipt")
        if isinstance(durable, dict):
            receipts.append(durable)
            continue
        receipt = node.get("receipt")
        if isinstance(receipt, dict):
            receipts.append(receipt)
            continue
        receipt_id = node.get("receipt_id") or node.get("receipt_ref")
        if receipt_id:
            receipts.append(
                {
                    "id": str(receipt_id),
                    "node_id": str(node.get("id") or ""),
                    "status": str(node.get("status") or ""),
                    "effect_state": str(node.get("effect_state") or "unknown"),
                    "result": node.get("result"),
                }
            )
    return receipts


async def _heartbeat(node_id: str, claim_id: str) -> None:
    while True:
        await asyncio.sleep(_HEARTBEAT_SECONDS)
        renewed = await renew_node_claim(
            node_id, claim_id=claim_id, lease_seconds=_LEASE_SECONDS
        )
        if not renewed:
            return


def _transient_failure(result: Any, evidence: dict[str, Any], audit: Any, audit_key: str, node: dict[str, Any]) -> bool:
    registry_evidence = result.get("execution_evidence") if isinstance(result, dict) else None
    if not (
        evidence.get("proven_no_effect") is True
        and evidence.get("effect_state") == "no_effect"
        and isinstance(registry_evidence, dict)
        and registry_evidence.get("transient") is True
        and registry_evidence.get("stage") in {"audit_claim", "operation"}
    ):
        return False
    return bool(
        registry_evidence.get("stage") == "operation"
        and registry_evidence.get("business_operation_started") is True
        and audit
        and audit.get("status") == "failed"
        and audit.get("operation") == node.get("operation")
        and audit.get("idempotency_key") == audit_key
    )


def _transient_audit_claim_failure(
    result: Any, evidence: dict[str, Any], audit: Any
) -> bool:
    registry_evidence = result.get("execution_evidence") if isinstance(result, dict) else None
    return bool(
        audit is None
        and evidence.get("proven_no_effect") is True
        and evidence.get("effect_state") == "no_effect"
        and isinstance(registry_evidence, dict)
        and registry_evidence.get("stage") == "audit_claim"
        and registry_evidence.get("effect_state") == "no_effect"
        and registry_evidence.get("transient") is True
        and registry_evidence.get("business_operation_started") is False
    )


async def _execute_claimed_node(
    plan: dict[str, Any],
    group: dict[str, Any],
    node: dict[str, Any],
    *,
    claim_id: str,
    surface: str,
) -> dict[str, Any]:
    node_id = str(node.get("id") or "")
    try:
        binding = await _current_binding(node_id)
        if not binding:
            raise PlanValidationError("Claimed node lost its persisted authorization binding")
        current_plan = binding.get("plan") if isinstance(binding.get("plan"), dict) else {}
        current_group = binding.get("group") if isinstance(binding.get("group"), dict) else {}
        current_node = binding.get("node") if isinstance(binding.get("node"), dict) else {}
        decision = binding.get("decision") if isinstance(binding.get("decision"), dict) else {}
        verify_plan_snapshot(current_plan)
        if (
            current_plan.get("digest") != plan.get("digest")
            or current_group.get("digest") != group.get("digest")
            or current_node.get("claim_id") != claim_id
            or decision.get("decision") != "approve"
        ):
            raise PlanValidationError("Claimed node no longer matches the approved snapshot")

        from app.services.proposal_plan_source_guard import verified_group_source_overlay

        expected_versions = await verified_group_source_overlay(
            current_plan, current_group, current_node
        )
        op = OPERATIONS.get(str(current_node.get("operation") or ""))
        if op is None:
            raise PlanValidationError("The approved Registry Operation no longer exists")
    except PlanValidationError as exc:
        checkpoint = await checkpoint_node(
            node_id,
            claim_id=claim_id,
            status="failed",
            effect_state="no_effect",
            result={
                "error": str(exc),
                "source_evidence": {"verified": False, "complete": False},
            },
            error=str(exc),
        )
        await pause_group(
            str(group.get("id") or ""), status="stale", reason=str(exc)
        )
        return {
            "node": checkpoint.get("node") if isinstance(checkpoint, dict) else node,
            "receipt": checkpoint.get("receipt") if isinstance(checkpoint, dict) else None,
            "result": {"ok": False, "errors": [str(exc)]},
            "status": "failed",
            "effect_state": "no_effect",
            "error": str(exc),
        }
    authorization = {
        "operation": op.name,
        "run_id": str(current_plan.get("run_id") or ""),
        "action_id": node_id,
        "idempotency_key": str(current_node.get("idempotency_key") or ""),
        "plan_id": str(current_plan.get("id") or ""),
        "group_id": str(current_group.get("id") or ""),
        "node_id": node_id,
        "claim_id": claim_id,
        "plan_digest": str(current_plan.get("digest") or ""),
        "group_digest": str(current_group.get("digest") or ""),
        "decision_id": str(decision.get("id") or decision.get("event_id") or ""),
        "operation_version": str(current_node.get("operation_version") or ""),
        "schema_digest": str(current_node.get("schema_digest") or ""),
        "scope": str(current_node.get("scope") or ""),
        "surface": surface,
        "authorization_source": _UI_AUTHORIZATION_SOURCE,
        "source_versions": expected_versions,
        "audit_attempt_key": (
            str(current_node.get("idempotency_key") or "")
            if int(current_node.get("attempt_count") or 0) <= 1
            else f"{current_node.get('idempotency_key')}:attempt:{claim_id}"
        ),
    }

    result: Any = None
    source_effect: dict[str, Any] = {"effect_state": "unknown"}
    source_error = ""
    stale_source = False
    retry_count = 0
    heartbeat = asyncio.create_task(_heartbeat(node_id, claim_id))
    try:
        for retry_index in range(_MAX_PREFLIGHT_RETRIES + 1):
            execution_started = False
            try:
                async with observe_node_sources(
                    current_node, expected_versions=expected_versions
                ) as guard:
                    with confirmed_operation(**authorization):
                        execution_started = True
                        result = await execute_operation(
                            op.name,
                            current_node.get("args")
                            if isinstance(current_node.get("args"), dict)
                            else {},
                            surface=surface,
                        )
                    source_effect = await guard.finish(
                        result if isinstance(result, dict) else {"ok": False}
                    )
                    if current_node["operation"] == "reset_local_business_data" and isinstance(result, dict) and result.get("ok"):
                        from app.services.proposal_plan_reset_effects import verify_reset_effect
                        source_effect = await verify_reset_effect(current_node, result)
                    if current_node["operation"] == "ensure_resume_workspace" and isinstance(result, dict) and result.get("ok"):
                        from app.services.proposal_plan_workspace_effects import verify_workspace_effect
                        workspace_proof = await verify_workspace_effect(current_node, result, source_effect, expected_versions=expected_versions)
                        if workspace_proof.get("verified"):
                            source_effect = {"effect_state": "committed", "proven_no_effect": False,
                                             "source_evidence": workspace_proof["source_evidence"]}
                        else:
                            source_error = str(workspace_proof.get("reason") or "Workspace effect could not be verified")
            except Exception as exc:
                # A guard-start failure occurs before Registry execution. It is
                # retryable only for a recognized database transient and only
                # once; all failures after entering execute_operation remain
                # unknown unless its durable audit and source witness prove more.
                from sqlalchemy.exc import OperationalError

                if isinstance(exc, PlanValidationError):
                    stale_source = True
                if (
                    not execution_started
                    and isinstance(exc, OperationalError)
                    and retry_index < _MAX_PREFLIGHT_RETRIES
                ):
                    retry_count += 1
                    continue
                source_error = str(exc)[:500]
                result = {"ok": False, "errors": [source_error]}
                source_effect = (
                    {
                        "effect_state": "no_effect",
                        "proven_no_effect": True,
                        "source_evidence": {
                            "before_versions": expected_versions,
                            "after_versions": expected_versions,
                            "verified": False,
                            "complete": False,
                        },
                    }
                    if not execution_started
                    else {"effect_state": "unknown"}
                )
                break

            audit = await _audit_for_node(
                current_node, str(authorization["audit_attempt_key"])
            )
            if retry_index < _MAX_PREFLIGHT_RETRIES and _transient_audit_claim_failure(
                result, source_effect, audit
            ):
                retry_count += 1
                continue
            break
    finally:
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)

    audit = await _audit_for_node(current_node, str(authorization["audit_attempt_key"]))
    source_evidence = _persistable_source_evidence(source_effect)
    source_ok = source_evidence.get("verified") is True and source_evidence.get("complete") is True
    result_ok = isinstance(result, dict) and result.get("ok") is True
    audit_ok = bool(audit and audit.get("status") == "completed" and audit.get("ok"))
    error_items = (
        [str(item)[:500] for item in result.get("errors") or []]
        if isinstance(result, dict)
        else []
    )
    error = "; ".join(error_items) or source_error
    if not error and not (result_ok and audit_ok and source_ok):
        error = "Operation 状态、审计或来源回执无法证明已完整提交。"

    if result_ok and audit_ok and source_ok:
        status, effect_state = "completed", "committed"
    elif source_effect.get("proven_no_effect") is True and source_effect.get("effect_state") == "no_effect":
        status, effect_state = "failed", "no_effect"
    elif source_effect.get("effect_state") == "partial":
        status, effect_state = "uncertain", "partial"
    else:
        status, effect_state = "uncertain", "unknown"

    # A business commit without a verified after-image is preserved as partial
    # and blocks the rest of the group for reconciliation.
    if result_ok and audit_ok and not source_ok:
        status, effect_state = "uncertain", "partial"
        error = "Operation 已审计，但来源变更无法与组内授权效果精确对应。"

    receipt_result = {
        "operation_result": safe_result_preview(result),
        "source_evidence": source_evidence,
        "retry_count": retry_count,
        "audit_attempt_key": str(authorization["audit_attempt_key"]),
    }
    checkpoint = await checkpoint_node(
        node_id,
        claim_id=claim_id,
        status=status,
        effect_state=effect_state,
        result=receipt_result,
        audit_ref=str(audit["id"]) if audit else None,
        error=error or None,
    )
    if stale_source:
        await pause_group(
            str(group.get("id") or ""), status="stale", reason=error
        )
    receipt = checkpoint.get("receipt") if isinstance(checkpoint, dict) else None
    return {
        "node": checkpoint.get("node") if isinstance(checkpoint, dict) else current_node,
        "receipt": receipt if isinstance(receipt, dict) else None,
        "result": result,
        "status": status,
        "effect_state": effect_state,
        "error": error,
        "retryable": _transient_failure(
            result, source_effect, audit, str(authorization["audit_attempt_key"]), current_node
        ),
        "source_evidence": source_evidence,
        "audit_ref": str(audit["id"]) if audit else None,
        "audit_attempt_key": str(authorization["audit_attempt_key"]),
        "decision_id": str(decision.get("id") or decision.get("event_id") or ""),
    }


async def dispatch_approved_group(
    plan_id: str, group_id: str, *, surface: str = _UI_SURFACE
) -> dict[str, Any]:
    plan = await get_plan(plan_id)
    if not isinstance(plan, dict):
        return {"ok": False, "plan": None, "group": None, "receipts": [], "errors": ["Proposal Plan 不存在。"], "duplicate": False}
    try:
        verify_plan_snapshot(plan)
        group = _group(plan, group_id)
        if group is None:
            raise PlanValidationError("Confirmation Group 不存在")
        nodes = _ordered_nodes(group)
    except PlanValidationError as exc:
        return {"ok": False, "plan": plan, "group": _group(plan, group_id), "receipts": [], "errors": [str(exc)], "duplicate": False}

    status = str(group.get("status") or "")
    if status == "completed":
        return {"ok": True, "plan": plan, "group": group, "receipts": await _group_receipts(group), "errors": [], "duplicate": False}
    if status in {"paused", "blocked", "needs_reconciliation", "stale", "rejected"}:
        return {"ok": False, "plan": plan, "group": group, "receipts": await _group_receipts(group), "errors": [f"确认组当前状态为 {status}，不能继续执行。"], "duplicate": False}
    if status not in {"approved", "executing"}:
        return {"ok": False, "plan": plan, "group": group, "receipts": [], "errors": ["确认组尚未获得持久化批准。"], "duplicate": False}
    cancelled = await _run_cancellation_error(str(plan.get("run_id") or ""))
    if cancelled:
        return {"ok": False, "plan": plan, "group": group, "receipts": await _group_receipts(group), "errors": [cancelled], "duplicate": False}

    # Expired leases become unknown/reconciliation. This never replays them.
    await recover_executing_nodes(run_id=str(plan.get("run_id") or ""))
    calls: list[dict[str, Any]] = []
    errors: list[str] = []
    in_progress = False
    for planned_node in nodes:
        cancelled = await _run_cancellation_error(str(plan.get("run_id") or ""))
        if cancelled:
            errors.append(cancelled)
            break
        current_plan = await get_plan(plan_id)
        current_group = _group(current_plan or {}, group_id)
        if not isinstance(current_plan, dict) or current_group is None:
            errors.append("确认组在执行期间不再存在。")
            break
        if str(current_group.get("status") or "") not in {"approved", "executing"}:
            errors.append(f"确认组在执行期间进入 {current_group.get('status')}，剩余节点已停止。")
            break

        current_node = next(
            (item for item in current_group.get("nodes") or [] if item.get("id") == planned_node.get("id")),
            None,
        )
        if current_node is None:
            errors.append("确认节点已从持久化计划中移除。")
            break
        node_status = str(current_node.get("status") or "")
        if node_status == "completed":
            continue
        if node_status in {"uncertain", "failed", "blocked", "rejected"}:
            errors.append(f"节点 {current_node.get('id')} 已进入 {node_status}；不会自动重放。")
            break
        if node_status != "pending":
            if node_status == "executing":
                in_progress = True
                break
            errors.append(f"节点 {current_node.get('id')} 当前状态为 {node_status}。")
            break

        claim_id = f"claim_{uuid.uuid4().hex}"
        try:
            claimed = await claim_node(
                str(current_node.get("id") or ""),
                claim_id=claim_id,
                lease_seconds=_LEASE_SECONDS,
            )
        except ProposalStaleSnapshotError as exc:
            await pause_group(group_id, status="stale", reason=str(exc))
            errors.append(str(exc))
            break
        if claimed is None:
            binding = await _current_binding(str(current_node.get("id") or ""))
            persisted = binding.get("node") if binding and isinstance(binding.get("node"), dict) else {}
            if str(persisted.get("status") or "") == "completed":
                continue
            if str(persisted.get("status") or "") == "executing":
                in_progress = True
            else:
                errors.append("节点 claim 被持久化状态或依赖条件拒绝。")
            break

        try:
            executed = await _execute_claimed_node(
                current_plan,
                current_group,
                claimed,
                claim_id=claim_id,
                surface=surface,
            )
        except Exception:
            # A failure after claim may have crossed the business commit
            # boundary. Leave the lease/claim for recovery to mark unknown.
            raise
        attempt_node = claimed
        while True:
            calls.append(
                {
                    "node_id": str(current_node.get("id") or ""),
                    "operation": str(current_node.get("operation") or ""),
                    "result": safe_result_preview(executed.get("result")),
                    "receipt": executed.get("receipt"),
                }
            )
            attempt_count = int(attempt_node.get("attempt_count") or 1)
            receipt = executed.get("receipt") if isinstance(executed.get("receipt"), dict) else {}
            if not (
                executed.get("status") == "failed"
                and executed.get("effect_state") == "no_effect"
                and executed.get("retryable") is True
                and attempt_count <= 1
                and receipt.get("id")
            ):
                break
            cancelled = await _run_cancellation_error(str(plan.get("run_id") or ""))
            if cancelled:
                errors.append(cancelled)
                break
            try:
                await resolve_node_reconciliation(
                    str(current_node.get("id") or ""),
                    effect_state="no_effect",
                    evidence={
                        "receipt_id": str(receipt["id"]),
                        "audit_ref": executed.get("audit_ref"),
                        "audit_attempt_key": executed.get("audit_attempt_key"),
                        "source_evidence": executed.get("source_evidence") or {},
                        "registry_failure": (
                            executed.get("result", {}).get("execution_evidence")
                            if isinstance(executed.get("result"), dict)
                            else None
                        ),
                        "decision_id": executed.get("decision_id"),
                    },
                )
                next_claim_id = f"claim_{uuid.uuid4().hex}"
                next_claim = await claim_node(
                    str(current_node.get("id") or ""),
                    claim_id=next_claim_id,
                    lease_seconds=_LEASE_SECONDS,
                )
            except Exception as exc:
                executed["error"] = str(exc)[:500]
                errors.append(executed["error"])
                break
            if next_claim is None:
                errors.append("安全重试的节点 claim 未能取得；确认组保持暂停。")
                break
            attempt_node = next_claim
            try:
                executed = await _execute_claimed_node(
                    current_plan,
                    current_group,
                    attempt_node,
                    claim_id=next_claim_id,
                    surface=surface,
                )
            except Exception:
                raise
        if executed.get("status") != "completed":
            if not errors:
                errors.append(str(executed.get("error") or "节点执行失败；其余节点已暂停。"))
            break

    final_plan = await get_plan(plan_id)
    final_group = _group(final_plan or {}, group_id)
    receipts = await _group_receipts(final_group or {})
    continuation = None
    final_status = str((final_group or {}).get("status") or "")
    if final_plan and final_group and final_status in {
        "completed", "paused", "blocked", "needs_reconciliation", "rejected", "stale"
    }:
        continuation = await _continuation_for_group(final_plan, final_group)
    warnings = ["组内各 Registry Operation 独立审计，跨 Operation 不具备原子性。"]
    successor = None
    refresh_error = None
    if final_status == "completed":
        try:
            from app.services.proposal_plan_refresh import refresh_unexecuted_groups
            successor = await refresh_unexecuted_groups(plan_id)
            final_plan = await get_plan(plan_id)
            final_group = _group(final_plan or {}, group_id)
        except Exception as exc:
            # A refresh failure never changes a committed operation into a
            # failed effect or reuses old approval for a new snapshot.
            from app.services.security_redaction import safe_error_message
            refresh_error = safe_error_message(str(exc))
            warnings.append("已执行结果保留；剩余组的新版快照未能生成：" + refresh_error)
    if in_progress:
        warnings.append("另一请求持有有效节点租约；本次没有重复执行。")
    return {
        "ok": final_status == "completed" or in_progress,
        "plan": final_plan,
        "group": final_group,
        "receipts": receipts,
        "errors": errors,
        "duplicate": False,
        "tool_calls": calls,
        "continuation": continuation,
        "in_progress": in_progress,
        "warnings": warnings,
        "successor_plan_id": successor["id"] if successor else None,
        "successor_plan": successor,
        "refresh_error": refresh_error,
    }


async def _existing_decision(group: dict[str, Any]) -> dict[str, Any] | None:
    nodes = group.get("nodes") or []
    if not nodes:
        return None
    binding = await _current_binding(str(nodes[0].get("id") or ""))
    decision = binding.get("decision") if binding and isinstance(binding.get("decision"), dict) else None
    return decision


async def _decide_group(
    plan_id: str,
    group_id: str,
    *,
    plan_digest: str,
    group_digest: str,
    decision_id: str,
    decision: str,
    authorization_source: str,
    surface: str,
) -> dict[str, Any]:
    from app.services.proposal_plan_store import (
        ProposalDecisionConflictError,
        ProposalPlanNotFoundError,
        ProposalPlanNotReadyError,
        ProposalStaleSnapshotError,
    )
    from app.services.ui_approval_capability import accepts_authorization

    plan = await get_plan(plan_id)
    group = _group(plan or {}, group_id) if isinstance(plan, dict) else None
    empty = {"ok": False, "plan": plan, "group": group, "receipts": [], "errors": [], "duplicate": False}
    if not isinstance(authorization_source, str) or not accepts_authorization(authorization_source):
        return {**empty, "errors": ["该决定只能由通过 OfferU 桌面能力验证的审核界面提交。"]}
    if surface != _UI_SURFACE:
        return {**empty, "errors": ["计划组决定必须来自 OfferU 桌面审核界面。"]}
    if not isinstance(plan, dict) or group is None:
        return {**empty, "errors": ["Proposal Plan 或 Confirmation Group 不存在。"]}
    if decision == "approve":
        cancelled = await _run_cancellation_error(str(plan.get("run_id") or ""))
        if cancelled:
            return {**empty, "errors": [cancelled]}

    from app.services.proposal_plan_builder import verify_plan_snapshot

    try:
        verify_plan_snapshot(plan)
        if plan.get("digest") != plan_digest or group.get("digest") != group_digest:
            raise PlanValidationError("Plan 或 Group 摘要已变化，请重新审核当前内容。")
        if len(group.get("nodes") or []) == 0:
            raise PlanValidationError("不能决定没有节点的确认组。")
        if not decision_id.startswith("decision_") or len(decision_id) != 41:
            raise PlanValidationError("decision_id 格式无效。")
    except PlanValidationError as exc:
        return {**empty, "errors": [str(exc)]}

    event = {
        "id": decision_id,
        "event_id": decision_id,
        "plan_id": plan_id,
        "group_id": group_id,
        "plan_digest": plan_digest,
        "group_digest": group_digest,
        "decision": decision,
        # Only this stable reference is persisted; the capability bearer is
        # checked above and never reaches a durable row or an Agent Run.
        "authorization_source": _UI_AUTHORIZATION_SOURCE,
        "surface": surface,
    }
    try:
        if await _existing_decision(group) is None:
            from app.services.proposal_plan_sources import validate_source_versions

            await validate_source_versions(_group_source_versions(group))
        recorded = await record_decision(event)
    except (
        ProposalDecisionConflictError,
        ProposalPlanNotFoundError,
        ProposalPlanNotReadyError,
        ProposalStaleSnapshotError,
        PlanValidationError,
    ) as exc:
        latest = await get_plan(plan_id)
        return {
            **empty,
            "plan": latest,
            "group": _group(latest or {}, group_id),
            "errors": [str(exc)],
        }

    duplicate = bool(recorded.get("duplicate"))
    current_plan = await get_plan(plan_id)
    current_group = _group(current_plan or {}, group_id)
    if current_plan is None or current_group is None:
        return {**empty, "errors": ["持久化决定已记录，但无法读取其确认组。"], "duplicate": duplicate}
    if decision == "reject":
        continuation = await _continuation_for_group(current_plan, current_group)
        return {
            "ok": str(current_group.get("status") or "") == "rejected",
            "plan": current_plan,
            "group": current_group,
            "receipts": await _group_receipts(current_group),
            "errors": [],
            "duplicate": duplicate,
            "continuation": continuation,
            "tool_calls": [],
        }
    dispatched = await dispatch_approved_group(plan_id, group_id, surface=surface)
    return {**dispatched, "duplicate": duplicate}


async def confirm_group(
    plan_id: str,
    group_id: str,
    *,
    plan_digest: str,
    group_digest: str,
    decision_id: str,
    authorization_source: str,
    surface: str,
) -> dict[str, Any]:
    return await _decide_group(
        plan_id,
        group_id,
        plan_digest=plan_digest,
        group_digest=group_digest,
        decision_id=decision_id,
        decision="approve",
        authorization_source=authorization_source,
        surface=surface,
    )


async def reject_group(
    plan_id: str,
    group_id: str,
    *,
    plan_digest: str,
    group_digest: str,
    decision_id: str,
    authorization_source: str,
    surface: str,
) -> dict[str, Any]:
    return await _decide_group(
        plan_id,
        group_id,
        plan_digest=plan_digest,
        group_digest=group_digest,
        decision_id=decision_id,
        decision="reject",
        authorization_source=authorization_source,
        surface=surface,
    )
