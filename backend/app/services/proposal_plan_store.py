"""Transactional storage for sealed Proposal v2 plans and their execution evidence."""
from __future__ import annotations

import copy
import json
import re
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, AsyncIterator, Mapping, Sequence

from sqlalchemy import select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session
from app.models.models import (
    AgentRunRecord,
    OperationAuditLog,
    ProposalConfirmationDecision,
    ProposalConfirmationGroup,
    ProposalContinuation,
    ProposalExecutionReceipt,
    ProposalOperationNode,
    ProposalExecutionPlan,
)
from app.services.security_redaction import safe_error_message


class ProposalStoreError(RuntimeError):
    """Base error for a rejected Proposal v2 transition."""


class ProposalPlanNotFoundError(ProposalStoreError):
    pass


class ProposalPlanConflictError(ProposalStoreError):
    pass


class ProposalDecisionConflictError(ProposalStoreError):
    pass


class ProposalStaleSnapshotError(ProposalStoreError):
    pass


class ProposalNodeClaimConflictError(ProposalStoreError):
    pass


class ProposalPlanNotReadyError(ProposalStoreError):
    pass


_PLAN_STATES = {"sealed", "executing", "paused", "completed", "rejected", "blocked", "needs_reconciliation", "replaced"}
_GROUP_STATES = {"pending", "approved", "executing", "paused", "completed", "rejected", "blocked", "needs_reconciliation", "stale", "replaced"}
_NODE_STATES = {"pending", "executing", "completed", "failed", "rejected", "blocked", "uncertain"}
_EFFECT_STATES = {"no_effect", "committed", "partial", "unknown"}
_CONTINUATION_STATES = {"pending", "delivering", "delivered", "failed"}
_ID_RE = re.compile(r"^(?:plan|group|node|decision|receipt|continuation)_[0-9a-f]{32}$")
_REF_RE = re.compile(r"^[a-z][a-z0-9._:-]{0,63}$")


def _builder():
    from app.services import proposal_plan_builder

    return proposal_plan_builder


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _iso(value: datetime | None) -> str | None:
    return value.replace(tzinfo=timezone.utc).isoformat() if value else None


def _canonical(value: Any) -> str:
    return _builder().canonical_json_bytes(value).decode("utf-8")


def _snapshot(plan: Mapping[str, Any]) -> dict[str, Any]:
    builder = _builder()
    result = builder.plan_material(plan)
    result["digest"] = plan["digest"]
    if "request_digest" in plan:
        result["request_digest"] = copy.deepcopy(plan["request_digest"])
    groups = []
    for group in plan["groups"]:
        item = builder.group_material(group)
        item["digest"] = group["digest"]
        item["nodes"] = []
        for node in group["nodes"]:
            child = builder.node_material(node)
            child["digest"] = node["digest"]
            child["idempotency_key"] = node["idempotency_key"]
            item["nodes"].append(child)
        groups.append(item)
    result["groups"] = groups
    return result


def _validate_plan(plan: Mapping[str, Any]) -> tuple[dict[str, Any], str]:
    if not isinstance(plan, Mapping) or not _ID_RE.fullmatch(str(plan.get("id") or "")):
        raise ProposalPlanConflictError("Plan must use the frozen UUID identity format")
    if not _ID_RE.fullmatch(str(plan.get("lineage_id") or "")):
        raise ProposalPlanConflictError("Plan lineage must use the frozen UUID identity format")
    if not plan.get("run_id") or int(plan.get("revision") or 0) < 1 or plan.get("status") != "sealed":
        raise ProposalPlanConflictError("A new Plan requires a Run, positive revision and sealed status")
    try:
        _builder().verify_plan_snapshot(plan)
        snapshot = _snapshot(plan)
        encoded = _canonical(snapshot)
    except Exception as exc:
        raise ProposalStaleSnapshotError("Plan snapshot failed canonical/Registry verification") from exc
    return snapshot, encoded


def _verify_snapshot(snapshot: Mapping[str, Any], *, check_registry: bool = False) -> None:
    material = copy.deepcopy(dict(snapshot))
    material["status"] = "sealed"
    for group in material.get("groups") or []:
        group["status"] = "pending"
        for node in group.get("nodes") or []:
            node["status"] = "pending"
    try:
        _builder().verify_plan_snapshot(material, check_registry=check_registry)
    except Exception as exc:
        raise ProposalStaleSnapshotError("Persisted proposal snapshot no longer verifies") from exc


def _json_object(raw: str | None, label: str) -> dict[str, Any]:
    try:
        value = json.loads(raw or "{}")
    except (TypeError, ValueError) as exc:
        raise ProposalStaleSnapshotError(f"Stored {label} snapshot is not valid JSON") from exc
    if not isinstance(value, dict):
        raise ProposalStaleSnapshotError(f"Stored {label} snapshot is not an object")
    return value


@asynccontextmanager
async def _write() -> AsyncIterator[AsyncSession]:
    async with async_session() as db:
        async with db.begin():
            if db.get_bind().dialect.name == "sqlite":
                await db.execute(text("BEGIN IMMEDIATE"))
            yield db


def _check_id(value: Any, prefix: str, label: str) -> str:
    value = str(value or "")
    if not _ID_RE.fullmatch(value) or not value.startswith(prefix + "_"):
        raise ProposalPlanConflictError(f"{label} ID must use its prefixed UUID format")
    return value


def _effect_identity(node: Mapping[str, Any]) -> str:
    return f"proposal-v2:effect:{node['id']}:{node['digest']}"


async def _insert_plan(
    db: AsyncSession,
    plan: Mapping[str, Any],
    *,
    plan_status: str = "sealed",
    group_status: str = "pending",
    node_status: str = "pending",
    legacy_action_id: str | None = None,
) -> None:
    _, encoded = _validate_plan(plan)
    if plan_status not in _PLAN_STATES or group_status not in _GROUP_STATES or node_status not in _NODE_STATES:
        raise ProposalPlanConflictError("Invalid initial Proposal state")
    existing = await db.get(ProposalExecutionPlan, str(plan["id"]))
    if existing:
        if existing.snapshot_json == encoded and existing.run_id == str(plan["run_id"]):
            return
        raise ProposalPlanConflictError("Plan ID already has different content")
    if await db.get(AgentRunRecord, str(plan["run_id"])) is None:
        raise ProposalPlanNotFoundError(f"Agent Run {plan['run_id']} does not exist")
    db.add(ProposalExecutionPlan(
        id=plan["id"], run_id=plan["run_id"], revision=int(plan["revision"]),
        lineage_id=plan["lineage_id"], parent_plan_id=plan.get("parent_plan_id"),
        status=plan_status, snapshot_json=encoded, legacy_action_id=legacy_action_id,
    ))
    await db.flush()
    for group in plan["groups"]:
        group_id = _check_id(group.get("id"), "group", "Group")
        group_snapshot = _builder().group_material(group)
        group_snapshot["digest"] = group["digest"]
        group_snapshot["nodes"] = []
        for node in group["nodes"]:
            node_snapshot = _builder().node_material(node)
            node_snapshot["digest"] = node["digest"]
            node_snapshot["idempotency_key"] = node["idempotency_key"]
            group_snapshot["nodes"].append(node_snapshot)
        db.add(ProposalConfirmationGroup(
            id=group_id, plan_id=plan["id"], ordinal=int(group["ordinal"]),
            status=group_status, snapshot_json=_canonical(group_snapshot),
        ))
        await db.flush()
        for node in group["nodes"]:
            node_id = _check_id(node.get("id"), "node", "Node")
            node_snapshot = _builder().node_material(node)
            node_snapshot["digest"] = node["digest"]
            node_snapshot["idempotency_key"] = node["idempotency_key"]
            db.add(ProposalOperationNode(
                id=node_id, group_id=group_id, ordinal=int(node["ordinal"]),
                status=node_status, snapshot_json=_canonical(node_snapshot),
                idempotency_key=node["idempotency_key"], effect_identity=_effect_identity(node),
                result_json={}, error_json={},
            ))
    await db.flush()


def _decision_dto(row: ProposalConfirmationDecision) -> dict[str, Any]:
    return {"id": row.id, "event_id": row.event_id, "plan_id": row.plan_id,
            "group_id": row.group_id, "plan_digest": row.plan_digest,
            "group_digest": row.group_digest, "decision": row.decision,
            "authorization_source": row.authorization_source, "surface": row.surface,
            "created_at": _iso(row.created_at)}


def _receipt_dto(row: ProposalExecutionReceipt) -> dict[str, Any]:
    return {"id": row.id, "node_id": row.node_id, "attempt_id": row.attempt_id,
            "effect_identity": row.effect_identity, "status": row.status,
            "effect_state": row.effect_state, "result": copy.deepcopy(row.result_json or {}),
            "audit_ref": row.audit_ref, "error": copy.deepcopy(row.error_json or {}),
            "created_at": _iso(row.created_at), "completed_at": _iso(row.completed_at)}


def _continuation_dto(row: ProposalContinuation) -> dict[str, Any]:
    receipts = list(row.receipt_ids_json or [])
    delivered = list(row.delivered_receipt_ids_json or [])
    claimed = list(row.claimed_receipt_ids_json or [])
    return {"id": row.id, "idempotency_key": row.idempotency_key, "run_id": row.run_id,
            "group_id": row.group_id, "receipt_ids": receipts,
            "delivered_receipt_ids": delivered, "claimed_receipt_ids": claimed,
            "delivery_receipt_ids": claimed or [x for x in receipts if x not in set(delivered)],
            "delivery_key": row.claim_payload_digest or "", "status": row.status,
            "claim_id": row.claim_id, "lease_until": _iso(row.lease_until),
            "attempt_count": int(row.attempt_count or 0), "error": row.error,
            "created_at": _iso(row.created_at), "delivered_at": _iso(row.delivered_at)}


def _node_dto(row: ProposalOperationNode, receipt_ids: list[str]) -> dict[str, Any]:
    data = _json_object(row.snapshot_json, "node")
    data.update(status=row.status, idempotency_key=row.idempotency_key,
                effect_identity=row.effect_identity, claim_id=row.claim_id,
                lease_until=_iso(row.lease_until), attempt_count=int(row.attempt_count or 0),
                result=copy.deepcopy(row.result_json or {}), error=copy.deepcopy(row.error_json or {}),
                receipt_id=row.receipt_id, receipt_ids=receipt_ids,
                receipt=None, receipts=[], audit_ref="")
    return data


async def _get_plan(db: AsyncSession, plan_id: str) -> dict[str, Any] | None:
    row = await db.get(ProposalExecutionPlan, plan_id)
    if row is None:
        return None
    snapshot = _json_object(row.snapshot_json, "plan")
    _verify_snapshot(snapshot)
    group_rows = (await db.execute(
        select(ProposalConfirmationGroup).where(ProposalConfirmationGroup.plan_id == row.id)
        .order_by(ProposalConfirmationGroup.ordinal)
    )).scalars().all()
    groups = []
    for group in group_rows:
        gs = _json_object(group.snapshot_json, "group")
        nodes = (await db.execute(
            select(ProposalOperationNode).where(ProposalOperationNode.group_id == group.id)
            .order_by(ProposalOperationNode.ordinal)
        )).scalars().all()
        receipts = (await db.execute(
            select(ProposalExecutionReceipt).where(
                ProposalExecutionReceipt.node_id.in_([n.id for n in nodes] or [""])
            ).order_by(ProposalExecutionReceipt.completed_at,
                       ProposalExecutionReceipt.created_at, ProposalExecutionReceipt.id)
        )).scalars().all()
        receipt_map: dict[str, list[dict[str, Any]]] = {}
        for receipt in receipts:
            receipt_map.setdefault(receipt.node_id, []).append(_receipt_dto(receipt))
        node_dtos = []
        for node in nodes:
            history = receipt_map.get(node.id, [])
            current = next((item for item in history if item["id"] == node.receipt_id), None)
            node_dto = _node_dto(node, [item["id"] for item in history])
            if (node.status == "completed" and current is not None
                    and (current.get("result") or {}).get("source_evidence")
                    != (node_dto.get("result") or {}).get("source_evidence")):
                raise ProposalStaleSnapshotError("Node source witness differs from its immutable receipt")
            node_dto.update(receipts=history, receipt=current,
                            audit_ref=str((current or {}).get("audit_ref") or ""))
            node_dtos.append(node_dto)
        group_data = copy.deepcopy(gs)
        group_data.update(status=group.status, decision_id=group.decision_id,
                          decision_plan_digest=group.decision_plan_digest,
                          decision_group_digest=group.decision_group_digest,
                          active_node_id=group.active_node_id, active_claim_id=group.active_claim_id,
                          lease_until=_iso(group.lease_until), pause_reason=group.pause_reason or "",
                          nodes=node_dtos)
        groups.append(group_data)
    data = copy.deepcopy(snapshot)
    data.update(status=row.status, snapshot=copy.deepcopy(snapshot),
                parent_plan_id=row.parent_plan_id, legacy_action_id=row.legacy_action_id,
                created_at=_iso(row.created_at), updated_at=_iso(row.updated_at), groups=groups)
    return data


async def create_plan(plan: Mapping[str, Any]) -> dict[str, Any]:
    _, encoded = _validate_plan(plan)
    try:
        async with _write() as db:
            existing = await db.get(ProposalExecutionPlan, plan["id"])
            if existing:
                if existing.snapshot_json != encoded or existing.run_id != plan["run_id"]:
                    raise ProposalPlanConflictError("Plan ID already has different content")
            else:
                await _insert_plan(db, plan)
    except IntegrityError as exc:
        raise ProposalPlanConflictError("Plan identity or node effect key already exists") from exc
    result = await get_plan(plan["id"])
    if result is None:
        raise ProposalPlanNotFoundError("Plan was not stored")
    return result


async def get_plan(plan_id: str) -> dict[str, Any] | None:
    async with async_session() as db:
        return await _get_plan(db, str(plan_id))


async def list_plans(run_id: str | None = None, pending_only: bool = False) -> list[dict[str, Any]]:
    async with async_session() as db:
        query = select(ProposalExecutionPlan)
        if run_id:
            query = query.where(ProposalExecutionPlan.run_id == str(run_id))
        if pending_only:
            query = query.where(ProposalExecutionPlan.status.notin_({"completed", "rejected", "blocked", "replaced"}))
        rows = (await db.execute(query.order_by(ProposalExecutionPlan.created_at, ProposalExecutionPlan.id))).scalars().all()
        return [dto for row in rows if (dto := await _get_plan(db, row.id)) is not None]


async def replace_plan(plan_id: str, replacement: Mapping[str, Any]) -> dict[str, Any]:
    _validate_plan(replacement)
    try:
        async with _write() as db:
            old = await db.get(ProposalExecutionPlan, plan_id)
            if old is None:
                raise ProposalPlanNotFoundError("Plan does not exist")
            if (old.status != "sealed" or replacement.get("id") == old.id
                    or replacement.get("run_id") != old.run_id
                    or replacement.get("lineage_id") != old.lineage_id
                    or replacement.get("parent_plan_id") != old.id
                    or int(replacement.get("revision") or 0) != old.revision + 1):
                raise ProposalPlanConflictError("Replacement must preserve Run/lineage and increment revision")
            group_ids = (await db.execute(
                select(ProposalConfirmationGroup.id).where(ProposalConfirmationGroup.plan_id == old.id)
            )).scalars().all()
            nodes = (await db.execute(
                select(ProposalOperationNode).where(ProposalOperationNode.group_id.in_(group_ids or [""]))
            )).scalars().all()
            has_decision = await db.scalar(select(ProposalConfirmationDecision.id).where(
                ProposalConfirmationDecision.plan_id == old.id).limit(1))
            has_receipt = await db.scalar(select(ProposalExecutionReceipt.id).where(
                ProposalExecutionReceipt.node_id.in_([n.id for n in nodes] or [""])).limit(1))
            groups = (await db.execute(select(ProposalConfirmationGroup).where(
                ProposalConfirmationGroup.plan_id == old.id))).scalars().all()
            if has_decision or has_receipt or any(g.status != "pending" for g in groups) or any(n.status != "pending" for n in nodes):
                raise ProposalPlanConflictError("Plan with a decision or execution history cannot be replaced")
            old.status = "replaced"
            await _insert_plan(db, replacement)
    except IntegrityError as exc:
        raise ProposalPlanConflictError("Replacement lineage revision already exists") from exc
    result = await get_plan(replacement["id"])
    if result is None:
        raise ProposalPlanNotFoundError("Replacement plan was not stored")
    return result


async def _read_current_sources(db: AsyncSession, expected: Mapping[str, str]) -> dict[str, str]:
    from app.services import proposal_plan_sources

    checked: dict[str, str] = {}
    for reference, expected_digest in expected.items():
        kind, separator, identity = str(reference).partition(":")
        digest = str(expected_digest)
        if not separator or not kind or not identity or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ProposalPlanConflictError("expected_sources must map source_ref to SHA-256 digest")
        try:
            value = await proposal_plan_sources._source(db, kind, identity)
        except Exception as exc:
            raise ProposalStaleSnapshotError(f"Expected source {reference} is unavailable") from exc
        actual = _builder().canonical_digest(value)
        if actual != digest:
            raise ProposalStaleSnapshotError(f"Expected source {reference} changed")
        checked[str(reference)] = digest
    return checked


async def _completed_receipt_evidence(
    db: AsyncSession,
    plan: ProposalExecutionPlan,
    receipt_ids: Sequence[str],
) -> tuple[dict[str, dict[str, Any]], dict[str, ProposalConfirmationGroup], dict[str, ProposalOperationNode]]:
    receipt_map: dict[str, dict[str, Any]] = {}
    groups: dict[str, ProposalConfirmationGroup] = {}
    nodes: dict[str, ProposalOperationNode] = {}
    for receipt_id in receipt_ids:
        receipt = await db.get(ProposalExecutionReceipt, str(receipt_id))
        if receipt is None:
            raise ProposalPlanConflictError(f"Completed receipt {receipt_id} does not exist")
        node = await db.get(ProposalOperationNode, receipt.node_id)
        group = await db.get(ProposalConfirmationGroup, node.group_id) if node else None
        if (node is None or group is None or group.plan_id != plan.id
                or group.status != "completed" or node.status != "completed"
                or node.receipt_id != receipt.id or receipt.status != "completed"
                or receipt.effect_state != "committed" or receipt.effect_identity != node.effect_identity):
            raise ProposalPlanConflictError("refresh_from receipt is not a committed node in a completed old group")
        decision = await _decision_row(db, group)
        group_snapshot = _json_object(group.snapshot_json, "group")
        plan_snapshot = _json_object(plan.snapshot_json, "plan")
        if (decision is None or decision.decision != "approve"
                or decision.plan_digest != plan_snapshot.get("digest")
                or decision.group_digest != group_snapshot.get("digest")):
            raise ProposalPlanConflictError("Completed receipt has no matching durable approval")
        try:
            audit_id = int(receipt.audit_ref)
        except (TypeError, ValueError) as exc:
            raise ProposalPlanConflictError("Completed receipt lacks a canonical OperationAuditLog id") from exc
        audit = await db.get(OperationAuditLog, audit_id)
        node_snapshot = _json_object(node.snapshot_json, "node")
        accepted_audit_keys = {
            node_snapshot.get("idempotency_key"),
            f"{node_snapshot.get('idempotency_key', '')}:attempt:{receipt.attempt_id}",
        }
        confirmation_ref = f"proposal-v2:{decision.id}:{node.id}:{receipt.attempt_id}"
        if (audit is None or audit.status != "completed" or audit.ok is not True
                or audit.operation != node_snapshot.get("operation")
                or audit.operation_version != node_snapshot.get("operation_version")
                or audit.idempotency_key not in accepted_audit_keys
                or audit.confirmation_ref != confirmation_ref):
            raise ProposalPlanConflictError("Completed receipt has no successful matching Registry audit")
        receipt_result = receipt.result_json if isinstance(receipt.result_json, dict) else {}
        node_result = node.result_json if isinstance(node.result_json, dict) else {}
        witness = receipt_result.get("source_evidence")
        if node_result.get("source_evidence") != witness:
            raise ProposalPlanConflictError("Completed node source evidence differs from its immutable receipt")
        source_versions = node_snapshot.get("source_versions") or {}
        if witness is None:
            if source_versions:
                raise ProposalPlanConflictError("Completed source-bound node lacks a durable source witness")
        elif (not isinstance(witness, dict) or witness.get("verified") is not True
              or witness.get("complete") is not True
              or not isinstance(witness.get("before_versions"), dict)
              or not isinstance(witness.get("after_versions"), dict)
              or set(witness["before_versions"]) != set(witness["after_versions"])
              or set(witness["before_versions"]) != set(source_versions)):
            raise ProposalPlanConflictError("Completed receipt source witness is incomplete")
        receipt_map[receipt.id] = {"receipt": receipt, "node": node, "group": group,
                                   "decision": decision, "witness": witness}
        groups[group.id] = group
        nodes[node.id] = node
    return receipt_map, groups, nodes


def _same_entities(old: Any, new: Any) -> bool:
    """Allow canonical names to refresh while keeping each affected identity fixed."""
    if not isinstance(old, list) or not isinstance(new, list) or len(old) != len(new):
        return old == new

    def keyed(values: list[Any]) -> dict[tuple[str, str], dict[str, Any]] | None:
        result: dict[tuple[str, str], dict[str, Any]] = {}
        for value in values:
            if not isinstance(value, Mapping) or value.get("id") is None or not value.get("kind"):
                return None
            key = (str(value["kind"]), str(value["id"]))
            if key in result:
                return None
            result[key] = {str(name): item for name, item in value.items()
                           if name not in {"kind", "id", "title", "name"}}
        return result

    old_map, new_map = keyed(old), keyed(new)
    return old_map is not None and old_map == new_map


def _compare_refreshed_groups(
    old_group_pairs: Sequence[tuple[ProposalConfirmationGroup, dict[str, Any]]],
    new_groups: Sequence[Mapping[str, Any]],
    all_old_groups: Mapping[str, ProposalConfirmationGroup],
    all_old_nodes: Mapping[str, ProposalOperationNode],
    completed_receipt_ids: set[str],
    completed_receipts: Mapping[str, dict[str, Any]],
) -> dict[str, str]:
    if len(old_group_pairs) != len(new_groups):
        raise ProposalPlanConflictError("Replacement must contain one refreshed group per selected group")
    old_to_new_group = {old.id: str(new["id"]) for (old, _), new in zip(old_group_pairs, new_groups)}
    new_group_ids = set(old_to_new_group.values())
    if any(old_id == new_id for old_id, new_id in old_to_new_group.items()):
        raise ProposalPlanConflictError("Refreshed groups need new IDs")
    if new_group_ids & set(all_old_groups):
        raise ProposalPlanConflictError("Refreshed groups cannot reuse an existing Plan group ID")

    def completed_group_receipts(group: ProposalConfirmationGroup) -> set[str]:
        snapshot = _json_object(group.snapshot_json, "group")
        result: set[str] = set()
        for node_data in snapshot.get("nodes") or []:
            node = all_old_nodes.get(str(node_data.get("id") or ""))
            if node is None or node.status != "completed" or not node.receipt_id:
                raise ProposalPlanConflictError("Completed dependency group has an incomplete node")
            result.add(node.receipt_id)
        return result

    new_node_for_old: dict[str, str] = {}
    for (old_group, old_snapshot), new_group in zip(old_group_pairs, new_groups):
        same_fields = ("title", "rationale", "summary", "risk", "scope")
        if any(old_snapshot.get(field) != new_group.get(field) for field in same_fields):
            raise ProposalPlanConflictError("Refresh changed the selected group's visible scope or rationale")
        if not _same_entities(old_snapshot.get("affected_entities"), new_group.get("affected_entities")):
            raise ProposalPlanConflictError("Refresh changed a group's affected entity identity")
        old_nodes = sorted(old_snapshot.get("nodes") or [], key=lambda item: int(item["ordinal"]))
        new_nodes = sorted(new_group.get("nodes") or [], key=lambda item: int(item["ordinal"]))
        if len(old_nodes) != len(new_nodes):
            raise ProposalPlanConflictError("Refresh changed the selected group's Registry node count")
        for old_node, new_node in zip(old_nodes, new_nodes):
            same_node_fields = ("operation", "operation_version", "input_schema", "schema_digest", "args",
                                "summary", "risk", "scope")
            if any(old_node.get(field) != new_node.get(field) for field in same_node_fields):
                raise ProposalPlanConflictError("Refresh changed a selected Registry operation or its arguments")
            if not _same_entities(old_node.get("affected_entities"), new_node.get("affected_entities")):
                raise ProposalPlanConflictError("Refresh changed a node's affected entity identity")
            new_node_for_old[str(old_node["id"])] = str(new_node["id"])
    new_node_ids = set(new_node_for_old.values())
    if new_node_ids & set(all_old_nodes):
        raise ProposalPlanConflictError("Refreshed nodes cannot reuse an existing Plan node ID")

    for (old_group, old_snapshot), new_group in zip(old_group_pairs, new_groups):
        old_group_deps = list(old_snapshot.get("dependency_group_ids") or [])
        expected_group_deps: list[str] = []
        for dep_id in old_group_deps:
            if dep_id in old_to_new_group:
                expected_group_deps.append(old_to_new_group[dep_id])
            else:
                dep = all_old_groups.get(dep_id)
                if dep is None or dep.status != "completed" or not completed_group_receipts(dep).issubset(completed_receipt_ids):
                    raise ProposalPlanConflictError("Refresh dropped a dependency that was not completed and receipt-bound")
        if list(new_group.get("dependency_group_ids") or []) != expected_group_deps:
            raise ProposalPlanConflictError("Refresh changed selected-group dependency edges")
        old_nodes = sorted(old_snapshot.get("nodes") or [], key=lambda item: int(item["ordinal"]))
        new_nodes = sorted(new_group.get("nodes") or [], key=lambda item: int(item["ordinal"]))
        for old_node, new_node in zip(old_nodes, new_nodes):
            expected_node_deps: list[str] = []
            for dep_id in old_node.get("dependency_node_ids") or []:
                if dep_id in new_node_for_old:
                    expected_node_deps.append(new_node_for_old[dep_id])
                else:
                    dep_node = all_old_nodes.get(dep_id)
                    dep_group = all_old_groups.get(dep_node.group_id) if dep_node else None
                    if (dep_node is None or dep_group is None or dep_group.status != "completed"
                            or not dep_node.receipt_id or dep_node.receipt_id not in completed_receipt_ids):
                        raise ProposalPlanConflictError("Refresh dropped an unexecuted node dependency")
            if list(new_node.get("dependency_node_ids") or []) != expected_node_deps:
                raise ProposalPlanConflictError("Refresh changed selected-node dependency edges")
    return old_to_new_group


def _verify_refresh_source_chain(
    old_snapshot: Mapping[str, Any],
    replacement: Mapping[str, Any],
    expected_sources: Mapping[str, str],
    completed_receipts: Mapping[str, dict[str, Any]],
) -> None:
    initial: dict[str, str] = {}
    old_groups = list(old_snapshot.get("groups") or [])
    static_groups = {str(group["id"]): group for group in old_groups}
    static_nodes: dict[str, dict[str, Any]] = {}
    for group in old_groups:
        for node in group.get("nodes") or []:
            node_id = str(node["id"])
            static_nodes[node_id] = node
            versions = node.get("source_versions") or {}
            if not isinstance(versions, Mapping):
                raise ProposalStaleSnapshotError("Old node source_versions are malformed")
            for reference, value in versions.items():
                reference, value = str(reference), str(value)
                if not re.fullmatch(r"[0-9a-f]{64}", value):
                    raise ProposalStaleSnapshotError(f"Old source version {reference} is not a digest")
                if reference in initial and initial[reference] != value:
                    raise ProposalPlanConflictError("Old Plan has inconsistent initial source versions")
                initial[reference] = value
    if set(expected_sources) != set(initial):
        raise ProposalPlanConflictError("expected_sources must equal the old Plan's initial source reference set")

    completed_node_ids = {str(item["node"].id) for item in completed_receipts.values()}
    completed_group_ids = {str(item["group"].id) for item in completed_receipts.values()}
    group_nodes = {
        group_id: {str(node["id"]) for node in group.get("nodes") or []}
        for group_id, group in static_groups.items()
    }
    if any(not node_id or node_id not in static_nodes for node_id in completed_node_ids):
        raise ProposalPlanConflictError("Completed receipt references a node outside the old snapshot")
    if any(not group_nodes[group_id].issubset(completed_node_ids) for group_id in completed_group_ids):
        raise ProposalPlanConflictError("Completed group refresh receipts are not a complete node set")

    refreshed: dict[str, str] = {}
    for group in replacement.get("groups") or []:
        for node in group.get("nodes") or []:
            versions = node.get("source_versions") or {}
            if not isinstance(versions, Mapping):
                raise ProposalPlanConflictError("Refreshed node source_versions must be a mapping")
            for reference, digest in versions.items():
                reference, digest = str(reference), str(digest)
                if reference in refreshed and refreshed[reference] != digest:
                    raise ProposalPlanConflictError("Refreshed nodes disagree on a source version")
                if expected_sources.get(reference) != digest:
                    raise ProposalStaleSnapshotError(f"Refreshed node source {reference} differs from expected_sources")
                refreshed[reference] = digest
    if not set(refreshed).issubset(initial):
        raise ProposalPlanConflictError("Refresh introduced a source outside the old Plan snapshot")

    overlay = dict(initial)
    remaining = set(completed_node_ids)
    processed: set[str] = set()
    processed_groups: set[str] = set()
    receipt_by_node = {str(item["node"].id): item for item in completed_receipts.values()}
    while remaining:
        ready: list[tuple[bool, int, int, str, Mapping[str, Any], dict[str, Any] | None]] = []
        for node_id in remaining:
            node_snapshot = static_nodes[node_id]
            group_id = str(node_snapshot["group_id"])
            group_snapshot = static_groups[group_id]
            node_deps = set(node_snapshot.get("dependency_node_ids") or [])
            group_deps = set(group_snapshot.get("dependency_group_ids") or [])
            if not node_deps.issubset(completed_node_ids) or not group_deps.issubset(completed_group_ids):
                raise ProposalPlanConflictError("Completed node has a dependency without a completed receipt")
            if not node_deps.issubset(processed) or not group_deps.issubset(processed_groups):
                continue
            prior_siblings = {
                sibling_id for sibling_id in group_nodes[group_id]
                if int(static_nodes[sibling_id]["ordinal"]) < int(node_snapshot["ordinal"])
            }
            if not prior_siblings.issubset(processed):
                continue
            item = receipt_by_node.get(node_id)
            witness = item.get("witness") if item else None
            if witness is not None:
                before, after = witness["before_versions"], witness["after_versions"]
                if any(reference not in overlay or overlay[reference] != digest
                       for reference, digest in before.items()):
                    continue
                unchanged = all(before[reference] == after[reference] for reference in before)
            else:
                unchanged = True
            ready.append((not unchanged, int(group_snapshot["ordinal"]),
                          int(node_snapshot["ordinal"]), node_id, node_snapshot, witness))
        if not ready:
            raise ProposalPlanConflictError("Completed receipt source witnesses do not form a before-to-after hash chain")
        # Applying no-change witnesses first avoids invalidating a sibling that
        # read the same source version; writers then advance the overlay hash.
        _unchanged, _group_order, _node_order, node_id, _node_snapshot, witness = min(ready)
        if witness is not None:
            overlay.update({str(reference): str(digest)
                            for reference, digest in witness["after_versions"].items()})
        processed.add(node_id)
        remaining.remove(node_id)
        group_id = str(static_nodes[node_id]["group_id"])
        if group_nodes[group_id].issubset(processed):
            processed_groups.add(group_id)
    if overlay != dict(expected_sources):
        raise ProposalStaleSnapshotError("expected_sources differs from the old snapshot plus committed receipt chain")


async def replace_unexecuted_groups(
    plan_id: str,
    replacement: Mapping[str, Any],
    *,
    group_ids: Sequence[str],
    completed_receipt_ids: Sequence[str],
    expected_sources: Mapping[str, str],
) -> dict[str, Any]:
    """Refresh only pending groups while preserving the original Plan history."""
    _, encoded = _validate_plan(replacement)
    selected_ids = [str(value) for value in group_ids]
    receipt_ids = [str(value) for value in completed_receipt_ids]
    if not selected_ids or len(selected_ids) != len(set(selected_ids)):
        raise ProposalPlanConflictError("group_ids must be a non-empty unique list")
    if len(receipt_ids) != len(set(receipt_ids)):
        raise ProposalPlanConflictError("completed_receipt_ids must be unique")
    for group_id in selected_ids:
        _check_id(group_id, "group", "Group")
    for receipt_id in receipt_ids:
        _check_id(receipt_id, "receipt", "Receipt")
    if not isinstance(expected_sources, Mapping):
        raise ProposalPlanConflictError("expected_sources must be a flat source_ref to digest mapping")
    expected = {str(key): str(value) for key, value in expected_sources.items()}
    refresh = replacement.get("refresh_from")
    expected_refresh = {"plan_id": str(plan_id), "group_ids": selected_ids,
                        "completed_receipt_ids": receipt_ids}
    if not isinstance(refresh, Mapping) or dict(refresh) != expected_refresh:
        raise ProposalPlanConflictError("Replacement refresh_from must exactly bind the requested Plan/groups/receipts")
    material = _builder().plan_material(replacement)
    if material.get("refresh_from") != expected_refresh:
        raise ProposalPlanConflictError("Builder digest does not bind refresh_from")
    if replacement.get("id") == str(plan_id):
        raise ProposalPlanConflictError("Refreshed Plan needs a new ID")

    try:
        async with _write() as db:
            old = await db.get(ProposalExecutionPlan, str(plan_id))
            if old is None:
                raise ProposalPlanNotFoundError("Source Plan does not exist")
            if (replacement.get("run_id") != old.run_id
                    or replacement.get("lineage_id") != old.lineage_id
                    or replacement.get("parent_plan_id") != old.id
                    or int(replacement.get("revision") or 0) != old.revision + 1):
                raise ProposalPlanConflictError("Refresh must preserve Run/lineage and use the next parent revision")
            old_snapshot = _json_object(old.snapshot_json, "plan")
            _verify_snapshot(old_snapshot, check_registry=False)

            all_groups = (await db.execute(select(ProposalConfirmationGroup).where(
                ProposalConfirmationGroup.plan_id == old.id).order_by(ProposalConfirmationGroup.ordinal))).scalars().all()
            all_group_map = {group.id: group for group in all_groups}
            if any(group_id not in all_group_map for group_id in selected_ids):
                raise ProposalPlanNotFoundError("A selected refresh group does not belong to the source Plan")
            all_nodes = (await db.execute(select(ProposalOperationNode).where(
                ProposalOperationNode.group_id.in_([group.id for group in all_groups] or [""])))).scalars().all()
            all_node_map = {node.id: node for node in all_nodes}
            for group in all_groups:
                group_nodes = [node for node in all_nodes if node.group_id == group.id]
                if group.status == "completed" and (
                    not group_nodes or any(node.status != "completed" or not node.receipt_id for node in group_nodes)
                ):
                    raise ProposalPlanConflictError("Completed group has an incomplete current receipt set")
                if any(node.status == "completed" for node in group_nodes) and group.status != "completed":
                    raise ProposalPlanConflictError("Completed node is outside a completed group")
            expected_completed_receipts = {
                str(node.receipt_id) for node in all_nodes if node.status == "completed" and node.receipt_id
            }
            if set(receipt_ids) != expected_completed_receipts:
                raise ProposalPlanConflictError("completed_receipt_ids must be the exact set of current completed-node receipts")

            # Recheck canonical inputs and all supplied parent receipts on this
            # same writer-reserved transaction before considering replay.
            await _read_current_sources(db, expected)
            completed, _, _ = await _completed_receipt_evidence(
                db, old, receipt_ids
            )
            selected_pairs = []
            for group_id in selected_ids:
                group = all_group_map[group_id]
                selected_pairs.append((group, _json_object(group.snapshot_json, "group")))
            new_groups = sorted(replacement.get("groups") or [], key=lambda item: int(item["ordinal"]))
            if len(new_groups) != len(selected_pairs):
                raise ProposalPlanConflictError("Replacement must contain exactly the selected pending groups")
            _compare_refreshed_groups(
                selected_pairs, new_groups, all_group_map, all_node_map,
                set(receipt_ids), completed,
            )
            _verify_refresh_source_chain(old_snapshot, replacement, expected, completed)

            successor = (await db.execute(select(ProposalExecutionPlan).where(
                ProposalExecutionPlan.run_id == old.run_id,
                ProposalExecutionPlan.lineage_id == old.lineage_id,
                ProposalExecutionPlan.revision == old.revision + 1,
            ))).scalar_one_or_none()
            if successor is not None:
                if successor.id == replacement.get("id") and successor.snapshot_json == encoded:
                    result = await _get_plan(db, successor.id)
                    if result is not None:
                        return result
                raise ProposalPlanConflictError("A different successor already owns this Plan revision")

            run = await db.get(AgentRunRecord, old.run_id)
            if run is None or run.status in {"cancelled", "failed", "completed", "needs_reconciliation"}:
                raise ProposalPlanConflictError("Cannot refresh a Plan whose originating Run is terminal")
            if old.status not in {"sealed", "executing", "paused"}:
                raise ProposalPlanConflictError(f"Source Plan is not active ({old.status})")
            if any(group.status in {"approved", "executing", "needs_reconciliation"}
                   or group.active_node_id is not None
                   or group.active_claim_id is not None or group.lease_until is not None
                   for group in all_groups):
                raise ProposalPlanConflictError("Source Plan has an unknown or actively leased group")
            if any(node.status in {"executing", "uncertain"} for node in all_nodes):
                raise ProposalPlanConflictError("Source Plan has an executing or unknown node")
            for group, _old_snapshot in selected_pairs:
                if group.status != "pending" or group.decision_id is not None:
                    raise ProposalPlanConflictError("Only undecided pending groups can be refreshed")
                decisions = await db.scalar(select(ProposalConfirmationDecision.id).where(
                    ProposalConfirmationDecision.plan_id == old.id,
                    ProposalConfirmationDecision.group_id == group.id).limit(1))
                if decisions:
                    raise ProposalPlanConflictError("Selected group already has a decision")
                group_nodes = [node for node in all_nodes if node.group_id == group.id]
                if not group_nodes or any(node.status != "pending" or node.attempt_count != 0
                    or node.claim_id is not None or node.lease_until is not None or node.receipt_id is not None
                    for node in group_nodes):
                    raise ProposalPlanConflictError("Selected group contains attempted or executed nodes")
                receipt = await db.scalar(select(ProposalExecutionReceipt.id).where(
                    ProposalExecutionReceipt.node_id.in_([node.id for node in group_nodes])).limit(1))
                if receipt:
                    raise ProposalPlanConflictError("Selected group has persisted execution history")
            if any(receipt.effect_state in {"partial", "unknown"}
                   for receipt in (await db.execute(select(ProposalExecutionReceipt).where(
                       ProposalExecutionReceipt.node_id.in_([node.id for node in all_nodes] or [""])))).scalars().all()):
                raise ProposalPlanConflictError("Source Plan contains an unknown/partial effect")

            await _insert_plan(db, replacement)
            for old_group, _old_group_snapshot in selected_pairs:
                old_group.status = "replaced"
                old_group.pause_reason = f"Refreshed by Plan {replacement['id']}"
                old_group.updated_at = _now()
                for node in all_nodes:
                    if node.group_id == old_group.id:
                        node.status = "blocked"
                        node.updated_at = _now()
            await _update_plan_status(db, old.id)
            await db.flush()
            result = await _get_plan(db, str(replacement["id"]))
            if result is None:
                raise ProposalPlanNotFoundError("Refreshed successor was not stored")
            return result
    except IntegrityError as exc:
        async with async_session() as db:
            successor = (await db.execute(select(ProposalExecutionPlan).where(
                ProposalExecutionPlan.run_id == str(replacement.get("run_id") or ""),
                ProposalExecutionPlan.lineage_id == str(replacement.get("lineage_id") or ""),
                ProposalExecutionPlan.revision == int(replacement.get("revision") or 0),
            ))).scalar_one_or_none()
            if successor is not None and successor.id == replacement.get("id") and successor.snapshot_json == encoded:
                result = await _get_plan(db, successor.id)
                if result is not None:
                    return result
        raise ProposalPlanConflictError("A concurrent refresh claimed this lineage revision") from exc


def _decision_input(value: Mapping[str, Any]) -> dict[str, str]:
    decision_id = str(value.get("id") or value.get("decision_id") or value.get("event_id") or "")
    event_id = str(value.get("event_id") or value.get("decision_id") or decision_id)
    _check_id(decision_id, "decision", "Decision")
    if not event_id or len(event_id) > 100:
        raise ProposalDecisionConflictError("Decision requires a stable event_id")
    action = str(value.get("decision") or "")
    if action not in {"approve", "reject"}:
        raise ProposalDecisionConflictError("Decision must be approve or reject")
    source = str(value.get("authorization_source") or "")
    surface = str(value.get("surface") or "desktop")
    if not _REF_RE.fullmatch(source) or "bearer" in source.lower():
        raise ProposalDecisionConflictError("Persist only a non-secret authorization source reference")
    if not _REF_RE.fullmatch(surface):
        raise ProposalDecisionConflictError("Decision surface must be a safe reference")
    return {"id": decision_id, "event_id": event_id, "plan_id": str(value.get("plan_id") or ""),
            "group_id": str(value.get("group_id") or ""), "plan_digest": str(value.get("plan_digest") or ""),
            "group_digest": str(value.get("group_digest") or ""), "decision": action,
            "authorization_source": source, "surface": surface}


def _decision_same(row: ProposalConfirmationDecision, value: Mapping[str, str]) -> bool:
    return all(getattr(row, key) == value[key] for key in value)


async def _plan_group(db: AsyncSession, plan_id: str, group_id: str):
    plan = await db.get(ProposalExecutionPlan, plan_id)
    group = await db.get(ProposalConfirmationGroup, group_id)
    if plan is None or group is None or group.plan_id != plan_id:
        raise ProposalPlanNotFoundError("Plan or Confirmation Group does not exist")
    ps, gs = _json_object(plan.snapshot_json, "plan"), _json_object(group.snapshot_json, "group")
    _verify_snapshot(ps, check_registry=True)
    return plan, group, ps, gs


async def _update_plan_status(db: AsyncSession, plan_id: str) -> None:
    plan = await db.get(ProposalExecutionPlan, plan_id)
    if plan is None:
        return
    states = (await db.execute(select(ProposalConfirmationGroup.status).where(
        ProposalConfirmationGroup.plan_id == plan_id))).scalars().all()
    if not states:
        return
    if all(state in {"completed", "replaced"} for state in states) and "completed" in states:
        plan.status = "completed"
    elif all(state == "replaced" for state in states):
        plan.status = "replaced"
    elif all(state in {"completed", "rejected", "blocked", "stale", "replaced"} for state in states):
        plan.status = "rejected" if "rejected" in states else "blocked" if any(
            state in {"blocked", "stale"} for state in states
        ) else "completed" if "completed" in states else "replaced"
    elif "needs_reconciliation" in states:
        plan.status = "needs_reconciliation"
    elif "paused" in states:
        plan.status = "paused"
    elif any(state in {"approved", "executing", "completed"} for state in states):
        plan.status = "executing"
    else:
        plan.status = "sealed"
    plan.updated_at = _now()


async def _decision_row(db: AsyncSession, group: ProposalConfirmationGroup):
    return await db.get(ProposalConfirmationDecision, group.decision_id) if group.decision_id else None


async def _block_descendants(db: AsyncSession, plan_id: str, rejected_group_id: str) -> None:
    groups = (await db.execute(select(ProposalConfirmationGroup).where(
        ProposalConfirmationGroup.plan_id == plan_id))).scalars().all()
    snapshots = {group.id: _json_object(group.snapshot_json, "group") for group in groups}
    blocked = {rejected_group_id}
    changed = True
    while changed:
        changed = False
        for group in groups:
            if group.id in blocked:
                continue
            if set(snapshots[group.id].get("dependency_group_ids") or []) & blocked:
                blocked.add(group.id)
                changed = True
                if group.status == "pending":
                    group.status = "blocked"
                    group.pause_reason = "A required group was rejected"
                    nodes = (await db.execute(select(ProposalOperationNode).where(
                        ProposalOperationNode.group_id == group.id))).scalars().all()
                    for node in nodes:
                        if node.status == "pending":
                            node.status = "blocked"


async def record_decision(decision: Mapping[str, Any]) -> dict[str, Any]:
    value = _decision_input(decision)
    if not re.fullmatch(r"[0-9a-f]{64}", value["plan_digest"]) or not re.fullmatch(r"[0-9a-f]{64}", value["group_digest"]):
        raise ProposalDecisionConflictError("Decision requires valid plan/group digests")
    try:
        async with _write() as db:
            existing = (await db.execute(select(ProposalConfirmationDecision).where(
                ProposalConfirmationDecision.event_id == value["event_id"]))).scalar_one_or_none()
            if existing is not None:
                if _decision_same(existing, value):
                    return {"decision": _decision_dto(existing), "duplicate": True}
                raise ProposalDecisionConflictError("Decision event_id was reused")
            plan, group, ps, gs = await _plan_group(db, value["plan_id"], value["group_id"])
            run = await db.get(AgentRunRecord, plan.run_id)
            if run is None or run.status in {"cancelled", "failed", "completed", "needs_reconciliation"}:
                raise ProposalDecisionConflictError("The originating Run is no longer active")
            if plan.status not in {"sealed", "executing"}:
                raise ProposalDecisionConflictError(f"Plan is not reviewable while {plan.status}")
            if ps.get("digest") != value["plan_digest"] or gs.get("digest") != value["group_digest"]:
                raise ProposalStaleSnapshotError("Displayed Plan/Group digest is stale")
            if group.status != "pending":
                raise ProposalDecisionConflictError(f"Group is not pending ({group.status})")
            if value["decision"] == "approve":
                dependencies = list(gs.get("dependency_group_ids") or [])
                dep = (await db.execute(select(ProposalConfirmationGroup.status).where(
                    ProposalConfirmationGroup.id.in_(dependencies or [""])))).scalars().all()
                if len(dep) != len(dependencies) or any(state != "completed" for state in dep):
                    raise ProposalPlanNotReadyError("Group dependencies must complete before approval")
            next_status = "approved" if value["decision"] == "approve" else "rejected"
            updated = await db.execute(update(ProposalConfirmationGroup).where(
                ProposalConfirmationGroup.id == group.id,
                ProposalConfirmationGroup.status == "pending",
                ProposalConfirmationGroup.decision_id.is_(None),
            ).values(status=next_status, decision_id=value["id"],
                     decision_plan_digest=value["plan_digest"], decision_group_digest=value["group_digest"],
                     pause_reason="", updated_at=_now()))
            if int(updated.rowcount or 0) != 1:
                raise ProposalDecisionConflictError("A concurrent group decision already won")
            row = ProposalConfirmationDecision(**value)
            db.add(row)
            await db.flush()
            if value["decision"] == "reject":
                nodes = (await db.execute(select(ProposalOperationNode).where(
                    ProposalOperationNode.group_id == group.id))).scalars().all()
                for node in nodes:
                    if node.status == "pending":
                        node.status = "rejected"
                await _block_descendants(db, plan.id, group.id)
                await _ensure_continuation(db, plan.run_id, group.id)
            await _update_plan_status(db, plan.id)
            return {"decision": _decision_dto(row), "duplicate": False}
    except IntegrityError as exc:
        raise ProposalDecisionConflictError("A concurrent decision with a different identity won") from exc


async def get_node_authorization(node_id: str) -> dict[str, Any] | None:
    async with async_session() as db:
        node = await db.get(ProposalOperationNode, node_id)
        if node is None:
            return None
        group = await db.get(ProposalConfirmationGroup, node.group_id)
        plan = await db.get(ProposalExecutionPlan, group.plan_id) if group else None
        if group is None or plan is None:
            return None
        plan_dto = await _get_plan(db, plan.id)
        if plan_dto is None:
            return None
        group_dto = next((item for item in plan_dto["groups"] if item["id"] == group.id), None)
        node_dto = next((item for item in (group_dto or {}).get("nodes", []) if item["id"] == node.id), None)
        decision_row = await _decision_row(db, group)
        return {"plan": plan_dto, "group": group_dto, "node": node_dto,
                "decision": _decision_dto(decision_row) if decision_row else None,
                "receipt": (node_dto or {}).get("receipt")}


def _claim(value: str) -> str:
    value = str(value or "").strip()
    if not 1 <= len(value) <= 80 or not re.fullmatch(r"[A-Za-z0-9._:-]+", value):
        raise ProposalNodeClaimConflictError("Claim ID must be a bounded opaque identifier")
    return value


def _lease(seconds: int) -> int:
    seconds = int(seconds)
    if not 1 <= seconds <= 3600:
        raise ProposalNodeClaimConflictError("Lease must be between 1 and 3600 seconds")
    return seconds


async def claim_node(node_id: str, *, claim_id: str, lease_seconds: int = 60) -> dict[str, Any] | None:
    claim_id = _claim(claim_id)
    now = _now()
    expires = now + timedelta(seconds=_lease(lease_seconds))
    try:
        async with _write() as db:
            node = await db.get(ProposalOperationNode, node_id)
            if node is None or node.status != "pending":
                return None
            group = await db.get(ProposalConfirmationGroup, node.group_id)
            plan = await db.get(ProposalExecutionPlan, group.plan_id) if group else None
            run = await db.get(AgentRunRecord, plan.run_id) if plan else None
            if (group is None or plan is None or run is None
                    or run.status in {"cancelled", "failed", "completed", "needs_reconciliation"}
                    or plan.status not in {"sealed", "executing"}):
                return None
            if group.status not in {"approved", "executing"} or group.active_node_id is not None:
                return None
            ps, gs = _json_object(plan.snapshot_json, "plan"), _json_object(group.snapshot_json, "group")
            _verify_snapshot(ps, check_registry=True)
            if (group.decision_id is None or group.decision_plan_digest != ps.get("digest")
                    or group.decision_group_digest != gs.get("digest")):
                raise ProposalStaleSnapshotError("Node approval no longer matches the sealed group")
            decision = await db.get(ProposalConfirmationDecision, group.decision_id)
            if decision is None or decision.decision != "approve" or decision.plan_digest != ps["digest"] or decision.group_digest != gs["digest"]:
                raise ProposalStaleSnapshotError("No matching persisted approve decision")
            deps = list(gs.get("dependency_group_ids") or [])
            if deps:
                states = (await db.execute(select(ProposalConfirmationGroup.id, ProposalConfirmationGroup.status)
                    .where(ProposalConfirmationGroup.id.in_(deps)))).all()
                if len(states) != len(deps) or any(state != "completed" for _, state in states):
                    return None
            ns = _json_object(node.snapshot_json, "node")
            node_deps = list(ns.get("dependency_node_ids") or [])
            if node_deps:
                states = (await db.execute(select(ProposalOperationNode.id, ProposalOperationNode.status)
                    .where(ProposalOperationNode.id.in_(node_deps)))).all()
                if len(states) != len(node_deps) or any(state != "completed" for _, state in states):
                    return None
            active_run = select(AgentRunRecord.run_id).where(
                AgentRunRecord.run_id == plan.run_id,
                AgentRunRecord.status.notin_({"cancelled", "failed", "completed", "needs_reconciliation"}),
            ).exists()
            active_plan = select(ProposalExecutionPlan.id).where(
                ProposalExecutionPlan.id == plan.id,
                ProposalExecutionPlan.status.in_({"sealed", "executing"}),
            ).exists()
            group_update = await db.execute(update(ProposalConfirmationGroup).where(
                ProposalConfirmationGroup.id == group.id,
                ProposalConfirmationGroup.status.in_({"approved", "executing"}),
                ProposalConfirmationGroup.active_node_id.is_(None),
                ProposalConfirmationGroup.decision_id == decision.id,
                ProposalConfirmationGroup.decision_plan_digest == ps["digest"],
                ProposalConfirmationGroup.decision_group_digest == gs["digest"],
                active_run, active_plan,
            ).values(status="executing", active_node_id=node.id, active_claim_id=claim_id,
                     lease_until=expires, pause_reason="", updated_at=now))
            if int(group_update.rowcount or 0) != 1:
                return None
            node_update = await db.execute(update(ProposalOperationNode).where(
                ProposalOperationNode.id == node.id, ProposalOperationNode.status == "pending",
                active_run, active_plan,
            ).values(status="executing", claim_id=claim_id, lease_until=expires,
                     attempt_count=ProposalOperationNode.attempt_count + 1, updated_at=now))
            if int(node_update.rowcount or 0) != 1:
                raise ProposalNodeClaimConflictError("Concurrent node claim already won")
            plan.status = "executing"
            await db.flush()
            node = await db.get(ProposalOperationNode, node.id)
            return _node_dto(node, []) if node else None
    except IntegrityError:
        return None


async def renew_node_claim(node_id: str, *, claim_id: str, lease_seconds: int = 60) -> bool:
    claim_id = _claim(claim_id)
    now = _now()
    expires = now + timedelta(seconds=_lease(lease_seconds))
    try:
        async with _write() as db:
            node = await db.get(ProposalOperationNode, node_id)
            if node is None or node.status != "executing" or node.claim_id != claim_id or not node.lease_until or node.lease_until <= now:
                return False
            group = await db.get(ProposalConfirmationGroup, node.group_id)
            plan = await db.get(ProposalExecutionPlan, group.plan_id) if group else None
            run = await db.get(AgentRunRecord, plan.run_id) if plan else None
            terminal_run = {"cancelled", "failed", "completed", "needs_reconciliation"}
            if (group is None or plan is None or run is None or run.status in terminal_run
                    or plan.status not in {"sealed", "executing"} or group.status != "executing"
                    or group.active_node_id != node.id or group.active_claim_id != claim_id
                    or not group.lease_until or group.lease_until <= now):
                return False
            active_run = select(AgentRunRecord.run_id).where(
                AgentRunRecord.run_id == plan.run_id,
                AgentRunRecord.status.notin_(terminal_run),
            ).exists()
            active_plan = select(ProposalExecutionPlan.id).where(
                ProposalExecutionPlan.id == plan.id,
                ProposalExecutionPlan.status.in_({"sealed", "executing"}),
            ).exists()
            a = await db.execute(update(ProposalConfirmationGroup).where(
                ProposalConfirmationGroup.id == group.id,
                ProposalConfirmationGroup.status == "executing",
                ProposalConfirmationGroup.active_node_id == node.id,
                ProposalConfirmationGroup.active_claim_id == claim_id,
                ProposalConfirmationGroup.lease_until > now,
                active_run, active_plan,
            ).values(lease_until=expires, updated_at=now))
            if int(a.rowcount or 0) != 1:
                return False
            b = await db.execute(update(ProposalOperationNode).where(
                ProposalOperationNode.id == node.id,
                ProposalOperationNode.status == "executing",
                ProposalOperationNode.claim_id == claim_id,
                ProposalOperationNode.lease_until > now,
                active_run, active_plan,
            ).values(lease_until=expires, updated_at=now))
            if int(b.rowcount or 0) != 1:
                raise ProposalNodeClaimConflictError("Node claim changed during lease renewal")
            return True
    except ProposalNodeClaimConflictError:
        return False


def _json_value(value: Any, label: str) -> Any:
    try:
        return json.loads(_canonical({} if value is None else value))
    except Exception as exc:
        raise ProposalPlanConflictError(f"{label} must be valid JSON") from exc


def _pause_message(error: Any, fallback: str) -> str:
    if isinstance(error, Mapping):
        message = error.get("message") or error.get("detail") or error.get("code")
    else:
        message = error
    return safe_error_message(str(message if message is not None else fallback))[:500]


def _receipt_id(node_id: str, claim_id: str) -> str:
    return f"receipt_{uuid.uuid5(uuid.NAMESPACE_URL, f'proposal-v2:receipt:{node_id}:{claim_id}').hex}"


async def _group_receipts(db: AsyncSession, group_id: str) -> list[str]:
    return list((await db.execute(select(ProposalExecutionReceipt.id)
        .join(ProposalOperationNode, ProposalOperationNode.id == ProposalExecutionReceipt.node_id)
        .where(ProposalOperationNode.group_id == group_id)
        .order_by(ProposalExecutionReceipt.completed_at,
                  ProposalExecutionReceipt.created_at, ProposalExecutionReceipt.id))).scalars().all())


async def checkpoint_node(node_id: str, *, claim_id: str, status: str, effect_state: str,
                          result: Any = None, audit_ref: str | None = None,
                          error: Any = None, receipt_id: str | None = None) -> dict[str, Any]:
    claim_id = _claim(claim_id)
    if status not in _NODE_STATES - {"pending", "executing", "rejected"} or effect_state not in _EFFECT_STATES:
        raise ProposalNodeClaimConflictError("Checkpoint needs a terminal node status and valid effect_state")
    if status == "failed" and effect_state != "no_effect":
        raise ProposalNodeClaimConflictError("Failed attempts require proven no_effect")
    if status == "uncertain" and effect_state not in {"partial", "unknown"}:
        raise ProposalNodeClaimConflictError("Uncertain attempts require partial/unknown effects")
    if status == "blocked" and effect_state != "no_effect":
        raise ProposalNodeClaimConflictError("Blocked attempts must prove no_effect")
    if status == "completed" and effect_state in {"partial", "unknown"}:
        raise ProposalNodeClaimConflictError("Partial/unknown effects cannot be completed")
    result_value = _json_value(result, "result")
    error_value = _json_value(error, "error")
    audit = str(audit_ref or "")[:180]
    now = _now()
    attempt_key = f"attempt:{node_id}:{claim_id}"
    async with _write() as db:
        node = await db.get(ProposalOperationNode, node_id)
        if node is None:
            raise ProposalPlanNotFoundError("Node does not exist")
        previous = (await db.execute(select(ProposalExecutionReceipt).where(
            ProposalExecutionReceipt.node_id == node_id,
            ProposalExecutionReceipt.idempotency_key == attempt_key))).scalar_one_or_none()
        requested = str(receipt_id or "") or None
        if previous:
            same = (previous.status == status and previous.effect_state == effect_state
                    and previous.result_json == result_value and previous.audit_ref == audit
                    and previous.error_json == error_value and (requested is None or requested == previous.id))
            if not same:
                raise ProposalNodeClaimConflictError("Attempt already has a different immutable receipt")
            return {"node": _node_dto(node, [previous.id]), "receipt": _receipt_dto(previous), "duplicate": True}
        group = await db.get(ProposalConfirmationGroup, node.group_id)
        plan = await db.get(ProposalExecutionPlan, group.plan_id) if group else None
        if group is None or plan is None:
            raise ProposalPlanNotFoundError("Node group or original Run does not exist")
        if (node.status != "executing" or node.claim_id != claim_id or not node.lease_until or node.lease_until <= now
                or group.active_node_id != node.id or group.active_claim_id != claim_id
                or not group.lease_until or group.lease_until <= now):
            raise ProposalNodeClaimConflictError("Claim expired or was lost; completion is fenced")
        rid = _check_id(requested or _receipt_id(node.id, claim_id), "receipt", "Receipt")
        receipt = ProposalExecutionReceipt(id=rid, node_id=node.id, attempt_id=claim_id,
            effect_identity=node.effect_identity, idempotency_key=attempt_key, status=status,
            effect_state=effect_state, result_json=result_value, audit_ref=audit,
            error_json=error_value, completed_at=now)
        db.add(receipt)
        node.status, node.result_json, node.error_json = status, result_value, error_value
        node.receipt_id, node.lease_until, node.updated_at = rid, None, now
        group.active_node_id = group.active_claim_id = None
        group.lease_until = None
        if status == "completed":
            pending = (await db.execute(select(ProposalOperationNode.id).where(
                ProposalOperationNode.group_id == group.id,
                ProposalOperationNode.id != node.id,
                ProposalOperationNode.status != "completed"))).first()
            group.status = "executing" if pending else "completed"
            group.pause_reason = ""
        elif status == "uncertain":
            group.status, group.pause_reason = "needs_reconciliation", "Execution effect requires reconciliation"
        elif status == "blocked":
            group.status, group.pause_reason = "blocked", _pause_message(error_value, "Registry blocked operation")
        else:
            group.status, group.pause_reason = "paused", _pause_message(error_value, "Node failed; group paused")
        await db.flush()
        await _update_plan_status(db, plan.id)
        await _ensure_continuation(db, plan.run_id, group.id)
        return {"node": _node_dto(node, [rid]), "receipt": _receipt_dto(receipt), "duplicate": False}


async def _ensure_continuation(db: AsyncSession, run_id: str, group_id: str):
    return await _upsert_continuation(db, run_id=run_id, group_id=group_id,
                                      receipt_ids=await _group_receipts(db, group_id))


async def _upsert_continuation(db: AsyncSession, *, run_id: str, group_id: str,
                               receipt_ids: list[str]):
    group = await db.get(ProposalConfirmationGroup, group_id)
    plan = await db.get(ProposalExecutionPlan, group.plan_id) if group else None
    if group is None or plan is None or plan.run_id != run_id:
        raise ProposalPlanNotFoundError("Continuation must bind the originating Run and Group")
    normalized = list(dict.fromkeys(str(item) for item in receipt_ids if str(item)))
    if normalized:
        rows = (await db.execute(select(ProposalExecutionReceipt.id, ProposalExecutionReceipt.node_id)
            .where(ProposalExecutionReceipt.id.in_(normalized)))).all()
        if len(rows) != len(normalized):
            raise ProposalPlanConflictError("Continuation references an unknown receipt")
        node_by_receipt = {receipt_id: node_id for receipt_id, node_id in rows}
        for receipt_id in normalized:
            node = await db.get(ProposalOperationNode, node_by_receipt[receipt_id])
            if node is None or node.group_id != group_id:
                raise ProposalPlanConflictError("Continuation receipt belongs to another Group")
    key = f"proposal-v2:{run_id}:{group_id}"
    row = (await db.execute(select(ProposalContinuation).where(
        ProposalContinuation.run_id == run_id, ProposalContinuation.group_id == group_id
    ))).scalar_one_or_none()
    if row is None:
        row = ProposalContinuation(id=f"continuation_{uuid.uuid4().hex}",
            idempotency_key=key, run_id=run_id, group_id=group_id,
            receipt_ids_json=normalized, delivered_receipt_ids_json=[],
            claimed_receipt_ids_json=[], claim_payload_digest="", status="pending")
        db.add(row)
        await db.flush()
        return row, False
    if row.idempotency_key != key:
        raise ProposalPlanConflictError("Continuation identity key changed")
    merged = list(dict.fromkeys([*(row.receipt_ids_json or []), *normalized]))
    duplicate = merged == list(row.receipt_ids_json or [])
    if not duplicate:
        row.receipt_ids_json = merged
        if row.status != "delivering":
            row.status = "pending"
            row.claim_id = None
            row.lease_until = None
            row.claimed_receipt_ids_json = []
            row.claim_payload_digest = ""
            row.delivered_at = None
            row.error = ""
    await db.flush()
    return row, duplicate


async def pause_group(group_id: str, *, status: str, reason: str) -> dict[str, Any]:
    if status not in {"paused", "needs_reconciliation", "blocked", "stale"}:
        raise ProposalPlanConflictError("pause_group accepts only gated group states")
    reason = str(reason or "").strip()
    if not reason:
        raise ProposalPlanConflictError("A visible pause reason is required")
    async with _write() as db:
        group = await db.get(ProposalConfirmationGroup, group_id)
        if group is None:
            raise ProposalPlanNotFoundError("Group does not exist")
        if group.status in {"completed", "rejected"}:
            raise ProposalPlanConflictError("A completed or rejected group is immutable")
        group.status, group.pause_reason, group.updated_at = status, reason, _now()
        plan = await db.get(ProposalExecutionPlan, group.plan_id)
        if plan:
            await _update_plan_status(db, plan.id)
            await _ensure_continuation(db, plan.run_id, group.id)
        return {"id": group.id, "plan_id": group.plan_id, "status": group.status,
                "pause_reason": group.pause_reason}


async def recover_executing_nodes(run_id: str | None = None) -> dict[str, int]:
    """Classify interrupted attempts as unknown; never replay a business Operation."""
    recovered = 0
    paused_between_nodes = 0
    async with _write() as db:
        query = (select(ProposalOperationNode, ProposalConfirmationGroup, ProposalExecutionPlan)
            .join(ProposalConfirmationGroup, ProposalConfirmationGroup.id == ProposalOperationNode.group_id)
            .join(ProposalExecutionPlan, ProposalExecutionPlan.id == ProposalConfirmationGroup.plan_id)
            .where(ProposalOperationNode.status == "executing"))
        if run_id:
            query = query.where(ProposalExecutionPlan.run_id == run_id)
        for node, group, plan in (await db.execute(query)).all():
            attempt = node.claim_id or f"missing-claim:{node.id}"
            key = f"recovery:{node.id}:{attempt}"
            receipt = (await db.execute(select(ProposalExecutionReceipt).where(
                ProposalExecutionReceipt.idempotency_key == key))).scalar_one_or_none()
            if receipt is None:
                receipt = ProposalExecutionReceipt(
                    id=f"receipt_{uuid.uuid5(uuid.NAMESPACE_URL, key).hex}", node_id=node.id,
                    attempt_id=attempt, effect_identity=node.effect_identity, idempotency_key=key,
                    status="uncertain", effect_state="unknown", result_json={}, audit_ref="",
                    error_json={"reason": "process_restart_during_execution"}, completed_at=_now())
                db.add(receipt)
            node.status, node.receipt_id, node.lease_until = "uncertain", receipt.id, None
            group.status = "needs_reconciliation"
            group.pause_reason = "Execution ended without trustworthy outcome evidence"
            group.active_node_id = group.active_claim_id = None
            group.lease_until = None
            plan.status = "needs_reconciliation"
            group.updated_at = plan.updated_at = _now()
            await db.flush()
            await _ensure_continuation(db, plan.run_id, group.id)
            recovered += 1
        groups_query = (select(ProposalConfirmationGroup, ProposalExecutionPlan)
            .join(ProposalExecutionPlan, ProposalExecutionPlan.id == ProposalConfirmationGroup.plan_id)
            .where(ProposalConfirmationGroup.status == "executing",
                   ProposalConfirmationGroup.active_node_id.is_(None),
                   ProposalConfirmationGroup.active_claim_id.is_(None)))
        if run_id:
            groups_query = groups_query.where(ProposalExecutionPlan.run_id == run_id)
        for group, plan in (await db.execute(groups_query)).all():
            states = (await db.execute(select(ProposalOperationNode.status).where(
                ProposalOperationNode.group_id == group.id))).scalars().all()
            if states and all(state == "completed" for state in states):
                group.status = "completed"
            elif (any(state == "pending" for state in states)
                  and not any(state in {"failed", "uncertain", "blocked", "rejected"} for state in states)):
                group.status = "paused"
                group.pause_reason = "Run stopped between durable node checkpoints"
                paused_between_nodes += 1
            else:
                group.status = "needs_reconciliation"
                group.pause_reason = "Group has no active claim and incomplete outcomes"
            group.active_node_id = group.active_claim_id = None
            group.lease_until = None
            group.updated_at = _now()
            await _update_plan_status(db, plan.id)
            await _ensure_continuation(db, plan.run_id, group.id)
    return {"recovered": recovered, "needs_reconciliation": recovered,
            "paused_between_nodes": paused_between_nodes}


async def resolve_node_reconciliation(node_id: str, *, effect_state: str,
                                      evidence: Mapping[str, Any]) -> dict[str, Any]:
    """Store independent evidence and rearm only a proven outcome under its original decision."""
    if effect_state not in _EFFECT_STATES or not isinstance(evidence, Mapping):
        raise ProposalNodeClaimConflictError("Reconciliation requires a valid effect state and evidence")
    evidence = _json_value(dict(evidence), "reconciliation evidence")
    source = evidence.get("source_evidence")
    audit_ref = str(evidence.get("audit_ref") or "").strip()
    if not audit_ref or not isinstance(source, dict) or source.get("verified") is not True or source.get("complete") is not True:
        raise ProposalNodeClaimConflictError("Reconciliation needs a verified, complete source and audit reference")
    if effect_state == "no_effect":
        failure = evidence.get("registry_failure")
        if (not isinstance(failure, dict) or failure.get("transient") is not True
                or not failure.get("stage") or source.get("before_versions") != source.get("after_versions")):
            raise ProposalNodeClaimConflictError("Retry needs transient failure evidence and unchanged source versions")
    async with _write() as db:
        node = await db.get(ProposalOperationNode, node_id)
        if node is None:
            raise ProposalPlanNotFoundError("Node does not exist")
        group = await db.get(ProposalConfirmationGroup, node.group_id)
        plan = await db.get(ProposalExecutionPlan, group.plan_id) if group else None
        if group is None or plan is None:
            raise ProposalPlanNotFoundError("Node has no originating Run")
        prior_id = str(evidence.get("receipt_id") or "")
        prior = await db.get(ProposalExecutionReceipt, prior_id) if prior_id else None
        if prior is None or prior.node_id != node.id:
            raise ProposalNodeClaimConflictError("Evidence is not bound to an immutable receipt")
        key = f"reconciliation:{node.id}:{prior.id}:{effect_state}:{audit_ref}"
        receipt = (await db.execute(select(ProposalExecutionReceipt).where(
            ProposalExecutionReceipt.idempotency_key == key))).scalar_one_or_none()
        if receipt is not None and node.receipt_id == receipt.id:
            return {"node": _node_dto(node, await _group_receipts(db, group.id)),
                    "receipt": _receipt_dto(receipt),
                    "group": {"id": group.id, "status": group.status}, "duplicate": True}
        if node.status not in {"failed", "uncertain"} or group.status not in {"paused", "needs_reconciliation"}:
            raise ProposalNodeClaimConflictError("Only a failed or uncertain node can be reconciled")
        if prior.id != node.receipt_id:
            raise ProposalNodeClaimConflictError("Evidence is not bound to the current immutable receipt")
        if prior.effect_state not in {"no_effect", "partial", "unknown"}:
            raise ProposalNodeClaimConflictError("Receipt already has a resolved effect state")
        ps, gs = _json_object(plan.snapshot_json, "plan"), _json_object(group.snapshot_json, "group")
        _verify_snapshot(ps, check_registry=True)
        decision = await _decision_row(db, group)
        if (decision is None or decision.decision != "approve"
                or decision.id != evidence.get("decision_id")
                or group.decision_plan_digest != ps.get("digest")
                or group.decision_group_digest != gs.get("digest")):
            raise ProposalStaleSnapshotError("Reconciliation no longer matches its original approval")
        if effect_state == "no_effect":
            if prior.status != "failed" or prior.effect_state != "no_effect" or prior.audit_ref != audit_ref:
                raise ProposalNodeClaimConflictError("Retry requires its immutable failed/no_effect audit receipt")
            try:
                audit_id = int(audit_ref)
            except ValueError as exc:
                raise ProposalNodeClaimConflictError("Retry audit_ref must identify a persisted Audit row") from exc
            audit = await db.get(OperationAuditLog, audit_id)
            node_snapshot = _json_object(node.snapshot_json, "node")
            attempt_key = str(evidence.get("audit_attempt_key") or "")
            accepted_keys = {
                str(node_snapshot.get("idempotency_key") or ""),
                f"{node_snapshot.get('idempotency_key', '')}:attempt:{prior.attempt_id}",
            }
            expected_confirmation = f"proposal-v2:{decision.id}:{node.id}:{prior.attempt_id}"
            if (audit is None or audit.status != "failed" or audit.ok is not False
                    or audit.operation != node_snapshot.get("operation")
                    or audit.operation_version != node_snapshot.get("operation_version")
                    or audit.idempotency_key != attempt_key or attempt_key not in accepted_keys
                    or audit.confirmation_ref != expected_confirmation):
                raise ProposalNodeClaimConflictError("Failed Audit row does not prove this node attempt")
        if receipt is None:
            receipt = ProposalExecutionReceipt(id=f"receipt_{uuid.uuid5(uuid.NAMESPACE_URL, key).hex}",
                node_id=node.id, attempt_id=f"reconcile:{prior.id}", effect_identity=node.effect_identity,
                idempotency_key=key, status="reconciled", effect_state=effect_state,
                result_json=evidence, audit_ref=audit_ref[:180], error_json={}, completed_at=_now())
            db.add(receipt)
        node.receipt_id = receipt.id
        node.lease_until = None
        node.result_json = copy.deepcopy(evidence)
        if effect_state == "no_effect":
            node.status, node.error_json = "pending", {}
        elif effect_state == "committed":
            node.status, node.error_json = "completed", {}
        else:
            node.status = "uncertain"
        other_states = (await db.execute(select(ProposalOperationNode.status).where(
            ProposalOperationNode.group_id == group.id, ProposalOperationNode.id != node.id))).scalars().all()
        if effect_state in {"no_effect", "committed"} and not any(
            state in {"failed", "uncertain", "blocked", "rejected"} for state in other_states
        ):
            group.status = "completed" if effect_state == "committed" and all(s == "completed" for s in other_states) else "approved"
            group.pause_reason = ""
        else:
            group.status = "needs_reconciliation"
            group.pause_reason = "Reconciliation evidence still indicates unresolved effects"
        group.active_node_id = group.active_claim_id = None
        group.lease_until = None
        await _update_plan_status(db, plan.id)
        await db.flush()
        await _ensure_continuation(db, plan.run_id, group.id)
        return {"node": _node_dto(node, await _group_receipts(db, group.id)),
                "receipt": _receipt_dto(receipt),
                "group": {"id": group.id, "status": group.status, "pause_reason": group.pause_reason},
                "duplicate": False}


async def create_continuation(continuation: Mapping[str, Any]) -> dict[str, Any]:
    run_id, group_id = str(continuation.get("run_id") or ""), str(continuation.get("group_id") or "")
    if not run_id or not group_id:
        raise ProposalPlanConflictError("Continuation must identify its original Run and Group")
    key = f"proposal-v2:{run_id}:{group_id}"
    if continuation.get("idempotency_key") and continuation["idempotency_key"] != key:
        raise ProposalPlanConflictError("Continuation idempotency key must bind Run and Group")
    receipts = continuation.get("receipt_ids") or continuation.get("receipt_refs") or []
    if not isinstance(receipts, list):
        raise ProposalPlanConflictError("Continuation receipt_ids must be a list")
    try:
        async with _write() as db:
            row, duplicate = await _upsert_continuation(
                db, run_id=run_id, group_id=group_id, receipt_ids=[str(x) for x in receipts]
            )
            return {"continuation": _continuation_dto(row), "duplicate": duplicate}
    except IntegrityError as exc:
        raise ProposalPlanConflictError("Continuation Run/Group identity conflict") from exc


async def list_continuations(run_id: str | None = None) -> list[dict[str, Any]]:
    async with async_session() as db:
        query = select(ProposalContinuation)
        if run_id:
            query = query.where(ProposalContinuation.run_id == str(run_id))
        rows = (await db.execute(query.order_by(ProposalContinuation.created_at,
                                                ProposalContinuation.id))).scalars().all()
        return [_continuation_dto(row) for row in rows]


async def claim_continuation(continuation_id: str, *, claim_id: str,
                             lease_seconds: int = 60) -> dict[str, Any] | None:
    claim_id, now = _claim(claim_id), _now()
    expires = now + timedelta(seconds=_lease(lease_seconds))
    async with _write() as db:
        row = await db.get(ProposalContinuation, continuation_id)
        if row is None or row.status == "delivered":
            return None
        group = await db.get(ProposalConfirmationGroup, row.group_id)
        if group is None or group.status not in {
            "completed", "paused", "needs_reconciliation", "rejected", "blocked", "stale",
        }:
            return None
        claimable = row.status in {"pending", "failed"} or (
            row.status == "delivering" and row.lease_until is not None and row.lease_until <= now
        )
        if not claimable:
            return None
        old_status, old_claim = row.status, row.claim_id
        updated = await db.execute(update(ProposalContinuation).where(
            ProposalContinuation.id == row.id,
            ProposalContinuation.status == old_status,
            ProposalContinuation.claim_id == old_claim,
        ).values(status="delivering", claim_id=claim_id, lease_until=expires,
                 attempt_count=ProposalContinuation.attempt_count + 1, error=""))
        if int(updated.rowcount or 0) != 1:
            return None
        delivered = set(row.delivered_receipt_ids_json or [])
        claimed = [receipt for receipt in (row.receipt_ids_json or []) if receipt not in delivered]
        row.claimed_receipt_ids_json = claimed
        row.claim_payload_digest = _builder().canonical_digest(
            {"run_id": row.run_id, "group_id": row.group_id, "receipt_ids": claimed}
        )
        await db.flush()
        return _continuation_dto(row)


async def renew_continuation_claim(continuation_id: str, *, claim_id: str,
                                  lease_seconds: int = 60) -> bool:
    """Extend only a live delivery claim whose group remains consumable."""
    claim_id, now = _claim(claim_id), _now()
    expires = now + timedelta(seconds=_lease(lease_seconds))
    consumable = {"completed", "paused", "needs_reconciliation", "rejected", "blocked", "stale"}
    async with _write() as db:
        row = await db.get(ProposalContinuation, continuation_id)
        if (row is None or row.status != "delivering" or row.claim_id != claim_id
                or row.lease_until is None or row.lease_until <= now):
            return False
        group = await db.get(ProposalConfirmationGroup, row.group_id)
        if group is None or group.status not in consumable:
            return False
        plan = await db.get(ProposalExecutionPlan, group.plan_id)
        if plan is None or plan.status == "replaced":
            return False
        claimed = list(row.claimed_receipt_ids_json or [])
        digest = _builder().canonical_digest(
            {"run_id": row.run_id, "group_id": row.group_id, "receipt_ids": claimed}
        )
        if row.claim_payload_digest != digest:
            return False
        active_group = select(ProposalConfirmationGroup.id).where(
            ProposalConfirmationGroup.id == row.group_id,
            ProposalConfirmationGroup.status.in_(consumable),
        ).exists()
        active_plan = select(ProposalExecutionPlan.id).where(
            ProposalExecutionPlan.id == plan.id,
            ProposalExecutionPlan.status != "replaced",
        ).exists()
        updated = await db.execute(update(ProposalContinuation).where(
            ProposalContinuation.id == row.id,
            ProposalContinuation.status == "delivering",
            ProposalContinuation.claim_id == claim_id,
            ProposalContinuation.lease_until > now,
            active_group,
            active_plan,
        ).values(lease_until=expires))
        return int(updated.rowcount or 0) == 1


async def finish_continuation(continuation_id: str, *, claim_id: str,
                              status: str, error: str | None = None) -> dict[str, Any]:
    if status not in {"delivered", "failed"}:
        raise ProposalPlanConflictError("Continuation status must finish as delivered or failed")
    claim_id, now = _claim(claim_id), _now()
    async with _write() as db:
        row = await db.get(ProposalContinuation, continuation_id)
        if row is None:
            raise ProposalPlanNotFoundError("Continuation does not exist")
        if (row.status != "delivering" or row.claim_id != claim_id
                or row.lease_until is None or row.lease_until <= now):
            raise ProposalNodeClaimConflictError("Continuation claim expired or was lost")
        claimed = list(row.claimed_receipt_ids_json or [])
        expected = _builder().canonical_digest(
            {"run_id": row.run_id, "group_id": row.group_id, "receipt_ids": claimed}
        )
        if row.claim_payload_digest != expected:
            raise ProposalNodeClaimConflictError("Claimed receipt-set payload changed")
        if status == "delivered":
            row.delivered_receipt_ids_json = list(dict.fromkeys(
                [*(row.delivered_receipt_ids_json or []), *claimed]))
            delivered = set(row.delivered_receipt_ids_json)
            remaining = [x for x in (row.receipt_ids_json or []) if x not in delivered]
            row.status = "pending" if remaining else "delivered"
            row.delivered_at = None if remaining else now
            row.error = ""
        else:
            row.status = "failed"
            row.error = str(error or "")[:1000]
        row.claim_id = row.lease_until = None
        row.claimed_receipt_ids_json = []
        row.claim_payload_digest = ""
        await db.flush()
        return _continuation_dto(row)


def _contains_redaction(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in {
            "[redacted]", "[redacted email]", "[redacted phone]", "bearer [redacted]",
        }
    if isinstance(value, dict):
        if value.get("redacted") is True and value.get("sha256"):
            return True
        return any(_contains_redaction(k) or _contains_redaction(v) for k, v in value.items())
    if isinstance(value, list):
        return any(_contains_redaction(item) for item in value)
    return False


def _legacy_intent(step: Mapping[str, Any]) -> tuple[dict[str, Any] | None, str]:
    operation = str(step.get("tool") or step.get("operation") or "").strip()
    if not operation:
        return None, "legacy_operation_missing"
    args = step.get("args")
    if not isinstance(args, dict):
        return None, "legacy_inputs_missing"
    if _contains_redaction(args):
        return None, "legacy_input_equivalence_unproven_after_redaction"
    return {"id": "legacy-action", "operation": operation, "args": copy.deepcopy(args),
            "summary": str(step.get("summary") or operation),
            "display": {"source": "legacy_pending_proposal"}}, ""


def _legacy_plan(run_id: str, step: Mapping[str, Any], intent: Mapping[str, Any]) -> dict[str, Any]:
    summary = str(step.get("summary") or intent.get("summary") or intent["operation"])
    return _builder().build_plan([intent], run_id=run_id,
        title=f"Review legacy proposal: {summary[:240]}", groups=[{
            "id": "legacy-singleton", "title": summary[:220] or "Legacy proposal",
            "summary": summary[:500],
            "rationale": "Imported as pending review; the legacy action grants no authorization.",
            "node_ids": ["legacy-action"], "display": {"source": "legacy_pending_proposal"},
        }])


async def _mark_legacy(run_id: str, action_id: str, classification: str, reason: str = "") -> bool:
    async with _write() as db:
        run = await db.get(AgentRunRecord, run_id)
        if run is None:
            return False
        cursor = copy.deepcopy(run.recovery_cursor_json or {})
        marker = cursor.get("proposal_v2_legacy")
        marker = marker if isinstance(marker, dict) else {}
        if action_id in marker:
            return False
        marker[action_id] = {"classification": classification, "reason": reason,
                             "recorded_at": _iso(_now())}
        cursor["proposal_v2_legacy"] = marker
        run.recovery_cursor_json = cursor
        return True


async def migrate_legacy_proposals(run_id: str | None = None) -> dict[str, int]:
    """Import safe pending singletons; preserve all other legacy history fail-safe."""
    counts = {"imported": 0, "preserved": 0, "needs_review": 0, "reconciliation": 0}
    async with async_session() as db:
        query = select(AgentRunRecord)
        if run_id:
            query = query.where(AgentRunRecord.run_id == str(run_id))
        rows = (await db.execute(query.order_by(AgentRunRecord.created_at))).scalars().all()
        old_runs = [(row.run_id, copy.deepcopy(row.steps_json or []),
                     copy.deepcopy(row.recovery_cursor_json or {})) for row in rows]
    for current_run, steps, cursor in old_runs:
        marker = cursor.get("proposal_v2_legacy") if isinstance(cursor, dict) else {}
        marker = marker if isinstance(marker, dict) else {}
        for index, step in enumerate(steps):
            if not isinstance(step, Mapping) or step.get("projection_only") or step.get("plan_id"):
                continue
            state = str(step.get("status") or "").lower()
            if state not in {"waiting_confirmation", "pending", "executing", "uncertain",
                             "needs_reconciliation", "completed", "failed", "rejected"}:
                continue
            action_id = str(step.get("id") or f"legacy-index-{index}")[:160]
            if action_id in marker:
                continue
            uncertain = state in {"executing", "uncertain", "needs_reconciliation"}
            if state in {"completed", "failed", "rejected"}:
                if await _mark_legacy(current_run, action_id, "preserved", f"legacy_{state}_history_only"):
                    counts["preserved"] += 1
                continue
            intent, reason = _legacy_intent(step)
            if intent is None:
                category = "reconciliation" if uncertain else "needs_review"
                if await _mark_legacy(current_run, action_id, category, reason):
                    counts[category] += 1
                continue
            try:
                plan = _legacy_plan(current_run, step, intent)
            except Exception:
                category = "reconciliation" if uncertain else "needs_review"
                if await _mark_legacy(current_run, action_id, category, "legacy_registry_or_snapshot_unverifiable"):
                    counts[category] += 1
                continue
            category = "reconciliation" if uncertain else "imported"
            try:
                async with _write() as db:
                    existing = (await db.execute(select(ProposalExecutionPlan).where(
                        ProposalExecutionPlan.run_id == current_run,
                        ProposalExecutionPlan.legacy_action_id == action_id))).scalar_one_or_none()
                    run = await db.get(AgentRunRecord, current_run)
                    if existing:
                        cursor_now = copy.deepcopy(run.recovery_cursor_json or {}) if run else {}
                        seen = cursor_now.get("proposal_v2_legacy")
                        seen = seen if isinstance(seen, dict) else {}
                        if action_id not in seen:
                            seen[action_id] = {"classification": category, "plan_id": existing.id,
                                               "recorded_at": _iso(_now())}
                            cursor_now["proposal_v2_legacy"] = seen
                            if run:
                                run.recovery_cursor_json = cursor_now
                            counts[category] += 1
                        continue
                    await _insert_plan(db, plan,
                        plan_status="needs_reconciliation" if uncertain else "sealed",
                        group_status="needs_reconciliation" if uncertain else "pending",
                        node_status="uncertain" if uncertain else "pending",
                        legacy_action_id=action_id)
                    cursor_now = copy.deepcopy(run.recovery_cursor_json or {}) if run else {}
                    seen = cursor_now.get("proposal_v2_legacy")
                    seen = seen if isinstance(seen, dict) else {}
                    seen[action_id] = {"classification": category,
                        "reason": "legacy_execution_outcome_unknown" if uncertain else "",
                        "plan_id": plan["id"], "recorded_at": _iso(_now())}
                    cursor_now["proposal_v2_legacy"] = seen
                    if run:
                        run.recovery_cursor_json = cursor_now
                counts[category] += 1
            except IntegrityError:
                continue
    return counts
