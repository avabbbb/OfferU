"""Re-snapshot only never-authorized groups after this Plan's proven effects.

The original Agent's exact intents survive; current before/after and source
versions form a new immutable revision that still needs independent review.
"""
from __future__ import annotations

import copy
from typing import Any

from app.services.proposal_plan_builder import PlanValidationError, build_plan, canonical_digest, plan_material, verify_plan_snapshot
from app.services.proposal_plan_source_guard import verified_node_source_witness
from app.services.proposal_plan_sources import capture_sources, validate_source_versions


async def refresh_unexecuted_groups(plan_id: str) -> dict[str, Any] | None:
    from app.services.proposal_plan_store import get_plan, list_plans, replace_unexecuted_groups
    plan = await get_plan(plan_id)
    if plan is None:
        raise PlanValidationError("Refresh Plan does not exist")
    # Replay recovers the existing child instead of generating another effect
    # identity. Follow later revisions so the UI opens the current remainder.
    successors = {item.get("parent_plan_id"): item for item in await list_plans(run_id=plan["run_id"])}
    successor = successors.get(plan_id)
    if successor:
        while successor["id"] in successors:
            successor = successors[successor["id"]]
        return successor
    verify_plan_snapshot(plan)
    if plan["status"] not in {"sealed", "executing"}:
        return None
    pending = [group for group in plan["groups"] if group["status"] == "pending"]
    completed = [group for group in plan["groups"] if group["status"] == "completed"]
    if not pending or not completed:
        return None
    if any(group["status"] not in {"pending", "completed"} for group in plan["groups"]):
        return None
    if any(node["status"] != "pending" or node.get("attempt_count") or node.get("receipt_id")
           for group in pending for node in group["nodes"]):
        return None

    initial: dict[str, str] = {}
    for group in plan["groups"]:
        for node in group["nodes"]:
            for reference, value in node.get("source_versions", {}).items():
                if reference in initial and initial[reference] != value:
                    raise PlanValidationError("Plan has conflicting initial source snapshots")
                initial[reference] = value
    # Source transitions are linked by exact hashes rather than timestamps,
    # which can tie in SQLite or reflect a different approval order.
    transitions, receipt_ids = [], []
    for group in completed:
        for node in group["nodes"]:
            witness = await verified_node_source_witness(node)
            transitions.append(witness)
            receipt_ids.append(node["receipt_id"])
    expected = dict(initial)
    while transitions:
        matched = next((item for item in transitions if all(expected.get(key) == value
                       for key, value in item["before_versions"].items())), None)
        if matched is None or set(matched["before_versions"]) != set(matched["after_versions"]):
            raise PlanValidationError("Completed receipts do not form the Plan's source chain")
        expected.update(matched["after_versions"])
        transitions.remove(matched)
    await validate_source_versions(expected)

    pending_ids = {group["id"] for group in pending}
    completed_ids = {group["id"] for group in completed}
    completed_nodes = {node["id"] for group in completed for node in group["nodes"]}
    intents, specs = [], []
    for group in pending:
        dependencies = set(group["dependency_group_ids"])
        if not dependencies.issubset(pending_ids | completed_ids):
            raise PlanValidationError("Unfulfilled dependency cannot disappear during refresh")
        specs.append({"id": group["id"], "title": group["title"], "summary": group["summary"],
                      "rationale": group["rationale"], "display": copy.deepcopy(group.get("display") or {}),
                      "node_ids": [node["id"] for node in group["nodes"]],
                      "dependency_group_ids": [item for item in group["dependency_group_ids"] if item in pending_ids]})
        for node in group["nodes"]:
            intents.append({"id": node["id"], "operation": node["operation"], "args": copy.deepcopy(node["args"]),
                            "summary": node["summary"], "display": copy.deepcopy(node["display"]),
                            "dependency_node_ids": [item for item in node["dependency_node_ids"] if item not in completed_nodes]})
    refreshed = await capture_sources(intents)
    current = {key: value for intent in refreshed for key, value in intent["source_versions"].items()}
    if any(expected.get(key) != value for key, value in current.items()):
        raise PlanValidationError("Sources changed outside this Plan's verified effects")
    replacement = build_plan(refreshed, run_id=plan["run_id"], title=plan["title"], groups=specs)
    replacement.update(revision=plan["revision"] + 1, lineage_id=plan["lineage_id"], parent_plan_id=plan["id"],
        refresh_from={"plan_id": plan["id"], "group_ids": [group["id"] for group in pending], "completed_receipt_ids": sorted(receipt_ids)})
    replacement["digest"] = canonical_digest(plan_material(replacement))
    return await replace_unexecuted_groups(plan["id"], replacement,
        group_ids=[group["id"] for group in pending], completed_receipt_ids=sorted(receipt_ids), expected_sources=expected)
