"""Seal Agent-supplied semantic groups using the existing Operation Registry.

Only preparation lives here. No authorization, business execution or career
judgment is inferred from keywords. Runtime fields never alter a sealed digest.
"""
from __future__ import annotations

import copy
import hashlib
import json
import uuid
from collections.abc import Mapping, Sequence
from graphlib import CycleError, TopologicalSorter
from typing import Any

VERSION = "offeru.proposal-plan.v2"
PLAN_STATES = frozenset({"sealed", "executing", "paused", "completed", "rejected", "blocked", "needs_reconciliation", "replaced"})
GROUP_STATES = frozenset({"pending", "approved", "executing", "paused", "completed", "rejected", "blocked", "needs_reconciliation", "stale", "replaced"})
NODE_STATES = frozenset({"pending", "executing", "completed", "failed", "rejected", "blocked", "uncertain"})
EFFECT_STATES = frozenset({"no_effect", "committed", "partial", "unknown"})
CONTINUATION_STATES = frozenset({"pending", "delivering", "delivered", "failed"})


class PlanValidationError(ValueError):
    pass


def canonical_json_bytes(value: Any) -> bytes:
    def check(item: Any, seen: set[int]) -> None:
        if type(item) in (str, int, float, bool, type(None)):
            return
        if type(item) not in (dict, list):
            raise PlanValidationError("Plan snapshots contain only JSON values")
        if id(item) in seen:
            raise PlanValidationError("Cyclic snapshot")
        seen.add(id(item))
        if isinstance(item, dict) and any(type(key) is not str for key in item):
            raise PlanValidationError("Snapshot object keys must be strings")
        for child in item.values() if isinstance(item, dict) else item:
            check(child, seen)
        seen.remove(id(item))
    try:
        check(value, set())
        return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, RecursionError) as exc:
        raise PlanValidationError(str(exc)) from exc


def canonical_digest(value: Any) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def _fields(value: Mapping[str, Any], names: str) -> dict[str, Any]:
    try:
        return {key: copy.deepcopy(value[key]) for key in names.split()}
    except KeyError as exc:
        raise PlanValidationError(f"Missing snapshot field: {exc.args[0]}") from exc


def node_material(node: Mapping[str, Any]) -> dict[str, Any]:
    return _fields(node, "id group_id ordinal operation operation_version input_schema schema_digest args summary affected_entities source_versions display dependency_node_ids risk scope")


def group_material(group: Mapping[str, Any]) -> dict[str, Any]:
    material = _fields(group, "id plan_id ordinal title rationale summary affected_entities risk scope dependency_group_ids source_versions display")
    material["nodes"] = [node_material(node) for node in group["nodes"]]
    return material


def plan_material(plan: Mapping[str, Any]) -> dict[str, Any]:
    material = _fields(plan, "version id run_id revision lineage_id parent_plan_id title")
    material["groups"] = [group_material(group) for group in plan["groups"]]
    if "refresh_from" in plan:
        material["refresh_from"] = copy.deepcopy(plan["refresh_from"])
    return material


def _dag(items: Mapping[str, Sequence[str]]) -> None:
    if any(dependency not in items for dependencies in items.values() for dependency in dependencies):
        raise PlanValidationError("Unknown dependency")
    try:
        tuple(TopologicalSorter(items).static_order())
    except CycleError as exc:
        raise PlanValidationError("Dependency cycle") from exc


def operation_scope(op: Any) -> str:
    # Registry policy owns classification. Caller-supplied risk is not authority.
    if "external" in op.side_effects:
        return "external"
    if op.group in {"profile", "memory"}:
        return "career_truth"
    return str(op.group or "core")


def _normalize(operation: str, args: Mapping[str, Any]) -> tuple[Any, dict[str, Any]]:
    from app.ops import OPERATIONS, _validated_args
    op = OPERATIONS.get(operation)
    if op is None:
        raise PlanValidationError(f"Unknown Registry Operation: {operation}")
    if not isinstance(args, dict):
        raise PlanValidationError("Operation args must be a JSON object")
    canonical_json_bytes(args)
    from app.services.security_redaction import redact_secret_value
    if canonical_json_bytes(redact_secret_value(args, max_length=10_000_000)) != canonical_json_bytes(args):
        raise PlanValidationError("Secrets cannot be persisted in Plan inputs; use the existing vault/reference boundary")
    clean, error = _validated_args(op, args)
    if error:
        raise PlanValidationError(error)
    canonical_json_bytes(clean)
    return op, copy.deepcopy(clean)


def verify_plan_snapshot(plan: Mapping[str, Any], *, check_registry: bool = True) -> None:
    if plan.get("version") != VERSION:
        raise PlanValidationError("Unsupported plan snapshot version")
    if canonical_digest(plan_material(plan)) != plan.get("digest"):
        raise PlanValidationError("Plan digest changed")
    groups = plan["groups"]
    ids = [group["id"] for group in groups]
    if not ids or len(ids) != len(set(ids)):
        raise PlanValidationError("Invalid group membership")
    _dag({group["id"]: group["dependency_group_ids"] for group in groups})
    nodes = [node for group in groups for node in group["nodes"]]
    node_ids = [node["id"] for node in nodes]
    if not nodes or len(node_ids) != len(set(node_ids)):
        raise PlanValidationError("Invalid node membership")
    _dag({node["id"]: node["dependency_node_ids"] for node in nodes})
    node_groups = {node["id"]: node["group_id"] for node in nodes}
    for group in groups:
        if group["plan_id"] != plan["id"] or canonical_digest(group_material(group)) != group.get("digest"):
            raise PlanValidationError("Group binding changed")
        if not group["nodes"]:
            raise PlanValidationError("Empty confirmation group")
        scopes = {node["scope"] for node in group["nodes"]}
        if len(scopes) != 1 or group["scope"] not in scopes:
            raise PlanValidationError("Mixed authorization scopes")
        expected_risk = "external" if any(node["risk"] == "external" for node in group["nodes"]) else "protected" if any(node["risk"] == "protected" for node in group["nodes"]) else "prepare"
        if group["risk"] != expected_risk:
            raise PlanValidationError("Group risk does not match its nodes")
        for node in group["nodes"]:
            if node["group_id"] != group["id"] or canonical_digest(node_material(node)) != node.get("digest"):
                raise PlanValidationError("Node binding changed")
            if node["idempotency_key"] != f"proposal-v2:{node['id']}:{node['digest']}":
                raise PlanValidationError("Business effect identity changed")
            foreign = {node_groups[dep] for dep in node["dependency_node_ids"]} - {group["id"]}
            if not foreign.issubset(set(group["dependency_group_ids"])):
                raise PlanValidationError("Cross-group node dependency must bind a group dependency")
            if check_registry:
                op, clean = _normalize(node["operation"], node["args"])
                schema = op.schema()["input_schema"]
                if clean != node["args"] or op.version != node["operation_version"] or canonical_digest(schema) != node["schema_digest"] or schema != node["input_schema"]:
                    raise PlanValidationError("Registry contract changed")
                risk = "external" if "external" in op.side_effects else "protected" if op.requires_confirmation else "prepare"
                if node["risk"] != risk or node["scope"] != operation_scope(op):
                    raise PlanValidationError("Registry risk scope changed")


def build_plan(intents: Sequence[Mapping[str, Any]], *, run_id: str, title: str,
               groups: Sequence[Mapping[str, Any]] | None = None) -> dict[str, Any]:
    if not run_id or not title.strip() or not 1 <= len(intents) <= 200:
        raise PlanValidationError("Plan requires a Run, title and 1–200 intents")
    if any(intent.get("operation") == "reset_local_business_data" for intent in intents) and len(intents) != 1:
        raise PlanValidationError("Clean Reset requires a dedicated single-operation Plan")
    plan_id = f"plan_{uuid.uuid4().hex}"
    plan: dict[str, Any] = {"version": VERSION, "id": plan_id, "run_id": run_id, "revision": 1,
                            "lineage_id": plan_id, "parent_plan_id": None, "title": title.strip(), "status": "sealed"}
    labels = [str(intent.get("id") or index) for index, intent in enumerate(intents)]
    if len(labels) != len(set(labels)):
        raise PlanValidationError("Duplicate intent identity")
    group_specs = list(groups or [])
    if not group_specs:
        # Exact singleton is the compatibility default; semantic grouping must
        # be supplied by the active Agent rather than inferred by this module.
        group_specs = [{"id": label, "title": str(intent.get("summary") or intent.get("operation") or "Change"),
                        "node_ids": [label]} for label, intent in zip(labels, intents)]
    group_labels = [str(spec.get("id") or index) for index, spec in enumerate(group_specs)]
    if len(group_labels) != len(set(group_labels)):
        raise PlanValidationError("Duplicate group identity")
    group_ids = {label: f"group_{uuid.uuid4().hex}" for label in group_labels}
    node_ids = {label: f"node_{uuid.uuid4().hex}" for label in labels}
    grouped: list[dict[str, Any]] = []
    assigned: set[str] = set()
    by_label = dict(zip(labels, intents))
    for ordinal, (label, spec) in enumerate(zip(group_labels, group_specs)):
        members = [str(value) for value in spec.get("node_ids", [])]
        if not members or len(members) != len(set(members)) or any(member not in by_label or member in assigned for member in members):
            raise PlanValidationError("Group must reference a distinct, exact intent set")
        assigned.update(members)
        try:
            dependencies = [group_ids[str(dep)] for dep in spec.get("dependency_group_ids", [])]
        except KeyError as exc:
            raise PlanValidationError("Unknown group dependency") from exc
        group = {"id": group_ids[label], "plan_id": plan_id, "ordinal": ordinal, "title": str(spec.get("title") or "").strip(),
                 "rationale": str(spec.get("rationale") or ""), "summary": str(spec.get("summary") or spec.get("title") or ""),
                 "affected_entities": [], "dependency_group_ids": dependencies,
                 "source_versions": copy.deepcopy(spec.get("source_versions") or {}), "display": copy.deepcopy(spec.get("display") or {}),
                 "status": "pending", "nodes": []}
        if not group["title"]:
            raise PlanValidationError("Semantic group requires a visible title")
        for position, member in enumerate(members):
            intent = by_label[member]
            op, args = _normalize(str(intent.get("operation") or ""), intent.get("args") or {})
            try:
                node_dependencies = [node_ids[str(dep)] for dep in intent.get("dependency_node_ids", [])]
            except KeyError as exc:
                raise PlanValidationError("Unknown node dependency") from exc
            schema = op.schema()["input_schema"]
            affected = copy.deepcopy(intent.get("affected_entities") or [{"kind": key.removesuffix("_id"), "id": value} for key, value in args.items() if key.endswith("_id")])
            node = {"id": node_ids[member], "group_id": group["id"], "ordinal": position, "operation": op.name,
                    "operation_version": op.version, "input_schema": schema, "schema_digest": canonical_digest(schema), "args": args,
                    "summary": str(intent.get("summary") or op.description), "affected_entities": affected,
                    "source_versions": copy.deepcopy(intent.get("source_versions") or group["source_versions"]),
                    "display": copy.deepcopy(intent.get("display") or {}), "dependency_node_ids": node_dependencies,
                    "scope": operation_scope(op), "risk": "external" if "external" in op.side_effects else "protected" if op.requires_confirmation else "prepare",
                    "status": "pending"}
            node["digest"] = canonical_digest(node_material(node))
            node["idempotency_key"] = f"proposal-v2:{node['id']}:{node['digest']}"
            group["nodes"].append(node)
            for entity in affected:
                if entity not in group["affected_entities"]:
                    group["affected_entities"].append(entity)
        scopes = {node["scope"] for node in group["nodes"]}
        if len(scopes) != 1:
            raise PlanValidationError("Separate resume, Career Truth and external authorization scopes")
        group["scope"] = scopes.pop()
        group["risk"] = "external" if any(node["risk"] == "external" for node in group["nodes"]) else "protected" if any(node["risk"] == "protected" for node in group["nodes"]) else "prepare"
        group["digest"] = canonical_digest(group_material(group))
        grouped.append(group)
    if assigned != set(labels):
        raise PlanValidationError("Every intent must belong to exactly one group")
    plan["groups"] = grouped
    plan["digest"] = canonical_digest(plan_material(plan))
    verify_plan_snapshot(plan)
    return plan


def revise_plan(old: Mapping[str, Any], intents: Sequence[Mapping[str, Any]], *, title: str,
                groups: Sequence[Mapping[str, Any]] | None = None) -> dict[str, Any]:
    if old.get("status") != "sealed" or any(group.get("status") != "pending" for group in old["groups"]) or any(node.get("status") != "pending" for group in old["groups"] for node in group["nodes"]):
        raise PlanValidationError("Executed history cannot be replaced")
    revised = build_plan(intents, run_id=old["run_id"], title=title, groups=groups)
    revised.update(revision=old["revision"] + 1, lineage_id=old["lineage_id"], parent_plan_id=old["id"])
    revised["digest"] = canonical_digest(plan_material(revised))
    return revised
