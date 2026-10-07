from __future__ import annotations

import asyncio
import sys
import types
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from app.ops import OPERATIONS, OperationAuthorization, _validate_authorization
from app.services.proposal_plan_builder import build_plan


def _authorized_binding() -> tuple[dict, OperationAuthorization]:
    run_id = f"run_{uuid4().hex[:16]}"
    plan = build_plan(
        [
            {
                "id": "only-node",
                "operation": "create_resume_section",
                "args": {
                    "resume_id": 1,
                    "section_type": "project",
                    "title": "Reviewed work",
                    "sort_order": 1,
                    "visible": True,
                    "content_json": [{"name": "Evidence", "description": "Verified"}],
                },
                "summary": "Add one reviewed section",
            }
        ],
        run_id=run_id,
        title="Resume update",
    )
    group = plan["groups"][0]
    node = group["nodes"][0]
    claim_id = f"claim_{uuid4().hex}"
    decision_id = f"decision_{uuid4().hex}"
    plan["status"] = "executing"
    group["status"] = "approved"
    node.update(
        status="executing",
        claim_id=claim_id,
        attempt_count=1,
        lease_until=(datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat(),
    )
    binding = {
        "plan": plan,
        "group": group,
        "node": node,
        "decision": {
            "id": decision_id,
            "event_id": decision_id,
            "decision": "approve",
            "plan_digest": plan["digest"],
            "group_digest": group["digest"],
            "authorization_source": "desktop-ui",
        },
    }
    authorization = OperationAuthorization(
        operation=node["operation"],
        run_id=run_id,
        action_id=node["id"],
        idempotency_key=node["idempotency_key"],
        plan_id=plan["id"],
        group_id=group["id"],
        node_id=node["id"],
        claim_id=claim_id,
        plan_digest=plan["digest"],
        group_digest=group["digest"],
        decision_id=decision_id,
        operation_version=node["operation_version"],
        schema_digest=node["schema_digest"],
        scope=node["scope"],
        surface="agent_runtime_ui",
        authorization_source="desktop-ui",
        source_versions=node["source_versions"],
        audit_attempt_key=node["idempotency_key"],
    )
    return binding, authorization


def _patch_authorization_reads(monkeypatch, binding: dict, run_status: str = "executing"):
    store = types.ModuleType("app.services.proposal_plan_store")

    async def get_node_authorization(_node_id: str):
        return binding

    store.get_node_authorization = get_node_authorization
    monkeypatch.setitem(sys.modules, "app.services.proposal_plan_store", store)

    async def load_run(_run_id: str):
        return {"id": binding["plan"]["run_id"], "status": run_status}

    monkeypatch.setattr("app.services.agent_run_state.load_agent_run", load_run)


def test_registry_authorization_requires_persisted_plan_node_and_exact_clean_args(monkeypatch):
    binding, authorization = _authorized_binding()
    _patch_authorization_reads(monkeypatch, binding)
    operation = OPERATIONS[authorization.operation]

    valid = asyncio.run(
        _validate_authorization(
            operation,
            authorization,
            binding["node"]["args"],
            surface="agent_runtime_ui",
        )
    )
    assert valid is None

    changed = {**binding["node"]["args"], "title": "Unreviewed title"}
    invalid = asyncio.run(
        _validate_authorization(
            operation, authorization, changed, surface="agent_runtime_ui"
        )
    )
    assert invalid and "实际清洗参数" in invalid


def test_legacy_step_fields_cannot_authorize_a_registry_write(monkeypatch):
    binding, authorization = _authorized_binding()
    _patch_authorization_reads(monkeypatch, binding)
    legacy = OperationAuthorization(
        operation=authorization.operation,
        run_id=authorization.run_id,
        action_id=authorization.action_id,
        idempotency_key=authorization.idempotency_key,
    )

    error = asyncio.run(
        _validate_authorization(
            OPERATIONS[authorization.operation],
            legacy,
            binding["node"]["args"],
            surface="agent_runtime_ui",
        )
    )
    assert error and ("持久化计划、组、节点" in error or "持久化 Agent Run 动作不存在" in error)


def test_cancelled_run_invalidates_a_previously_bound_node_claim(monkeypatch):
    binding, authorization = _authorized_binding()
    _patch_authorization_reads(monkeypatch, binding, run_status="cancelled")

    error = asyncio.run(
        _validate_authorization(
            OPERATIONS[authorization.operation],
            authorization,
            binding["node"]["args"],
            surface="agent_runtime_ui",
        )
    )
    assert error and "Run 已取消" in error
