from __future__ import annotations

import asyncio
import sys
import types
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.agent.proposal_hook import ProposalHook, canonical_tool_signature
from app.agent.types import TextContent, ToolResultMessage
from app.services.proposal_plan_builder import PlanValidationError
from app.services import proposal_plan_continuation
from app.services.proposal_plan_continuation import _delivery_id, plan_review_view
from app.services.operation_projection import (
    confirm_operation_proposal,
    execute_or_propose_operation,
)
from app.services.agent_bridge import operation_gateway
from app.services.agent_bridge.errors import BridgeProtocolError
from app.services import agent_run_state


def test_plan_hook_stops_the_model_and_blocks_the_same_protected_scope() -> None:
    operation_args = {"resume_id": 7, "update_data": {"title": "Product Manager"}}
    plan = {
        "id": "plan_" + "a" * 32,
        "digest": "b" * 64,
        "status": "sealed",
        "groups": [
            {
                "id": "group_" + "c" * 32,
                "status": "pending",
                "nodes": [
                    {
                        "id": "node_" + "d" * 32,
                        "operation": "update_resume_record",
                        "args": operation_args,
                    }
                ],
            }
        ],
    }
    result = ToolResultMessage(
        tool_call_id="call-1",
        tool_name="prepare_proposal_plan",
        content=[TextContent(text="Plan staged")],
        details={
            "ok": True,
            "outputs": {
                "executed": False,
                "requires_confirmation": True,
                "plan_id": plan["id"],
                "plan": plan,
            },
        },
    )
    hook = ProposalHook()

    finalized = asyncio.run(
        hook.after_tool_call(
            {
                "tool_call": SimpleNamespace(name="prepare_proposal_plan", arguments={}),
                "args": {},
                "result": result,
            }
        )
    )

    assert finalized is not None
    assert finalized["terminate"] is True
    assert finalized["details"]["plan_id"] == plan["id"]

    blocked = asyncio.run(
        hook.before_tool_call(
            {
                "tool_call": SimpleNamespace(name="update_resume_record", arguments=operation_args),
                "args": operation_args,
            }
        )
    )
    assert blocked is not None and blocked["block"] is True


def test_plan_stage_cannot_share_a_model_tool_batch_with_another_call() -> None:
    assistant_message = SimpleNamespace(
        content=[
            SimpleNamespace(type="toolCall", name="prepare_proposal_plan"),
            SimpleNamespace(type="toolCall", name="get_profile"),
        ]
    )
    result = asyncio.run(
        ProposalHook().before_tool_call(
            {
                "assistant_message": assistant_message,
                "tool_call": SimpleNamespace(name="prepare_proposal_plan", arguments={}),
                "args": {},
            }
        )
    )
    assert result is not None and result["block"] is True


def test_completed_duplicate_plan_does_not_terminate_or_ask_for_review() -> None:
    result = ToolResultMessage(
        tool_call_id="call-2",
        tool_name="prepare_proposal_plan",
        content=[TextContent(text="Already complete")],
        details={
            "ok": True,
            "outputs": {
                "executed": True,
                "requires_confirmation": False,
                "duplicate": True,
                "plan_id": "plan_" + "a" * 32,
                "plan": {"id": "plan_" + "a" * 32, "status": "completed", "groups": []},
            },
        },
    )
    finalized = asyncio.run(
        ProposalHook().after_tool_call(
            {
                "tool_call": SimpleNamespace(name="prepare_proposal_plan", arguments={}),
                "args": {},
                "result": result,
            }
        )
    )
    assert finalized is None


def test_hook_signature_rejects_non_json_values() -> None:
    with pytest.raises(PlanValidationError):
        canonical_tool_signature("update_resume_record", {"resume_id": object()})


def test_legacy_action_adapter_cannot_approve_without_ui_capability() -> None:
    result = asyncio.run(
        confirm_operation_proposal(
            "run_" + "a" * 16,
            action_id="node_" + "b" * 32,
            surface="mcp",
        )
    )
    assert result["ok"] is False
    assert result["errors"] == ["Independent OfferU UI authorization is required."]


def test_legacy_action_id_without_displayed_digests_is_refused() -> None:
    result = asyncio.run(
        confirm_operation_proposal(
            "run_" + "a" * 16,
            action_id="node_" + "b" * 32,
            surface="agent_runtime_ui",
            authorization_source="Bearer route-validated",
        )
    )
    assert result["ok"] is False
    assert "Reopen PlanReview" in result["errors"][0]


def test_external_protected_call_without_run_fails_without_creating_hidden_state() -> None:
    result = asyncio.run(
        execute_or_propose_operation(
            "update_resume_record",
            {"resume_id": 7, "update_data": {"title": "Product Manager"}},
            surface="cli",
        )
    )
    assert result["ok"] is False
    assert "existing Agent Run" in result["errors"][0]


def test_bridge_plan_staging_requires_the_attached_run_skill_grant(monkeypatch: pytest.MonkeyPatch) -> None:
    async def load_run(_run_id: str) -> dict[str, object]:
        return {"id": "run_" + "a" * 16, "skill_snapshot": {"allowed_tools": ["get_profile"]}}

    monkeypatch.setattr(agent_run_state, "load_agent_run", load_run)
    with pytest.raises(BridgeProtocolError, match="outside the attached Run Skill scope"):
        asyncio.run(
            operation_gateway.invoke_operation(
                operation="prepare_proposal_plan",
                arguments={"title": "Review", "intents": []},
                run_id="run_" + "a" * 16,
            )
        )


def test_plan_review_projection_hides_raw_args_but_keeps_full_display() -> None:
    full_text = "Before/after evidence " + ("x" * 2500)
    plan = {
        "id": "plan_" + "a" * 32,
        "snapshot": {"args": {"secret": "must-not-escape"}},
        "groups": [
            {
                "id": "group_" + "b" * 32,
                "snapshot": {"args": {"secret": "must-not-escape"}},
                "nodes": [
                    {
                        "id": "node_" + "c" * 32,
                        "args": {"api_key": "secret-value", "email": "ava@example.com"},
                        "snapshot": {"args": {"secret": "must-not-escape"}},
                        "input_schema": {"type": "object"},
                        "display": {"changes": [{"before": "old", "after": full_text}]},
                    }
                ],
            }
        ],
    }

    view = plan_review_view(plan)
    node = view["groups"][0]["nodes"][0]

    assert "snapshot" not in view
    assert "snapshot" not in view["groups"][0]
    assert "snapshot" not in node and "args" not in node and "input_schema" not in node
    assert node["redactedArgs"]["api_key"] == "[redacted]"
    assert node["redactedArgs"]["email"] == "ava@example.com"
    assert node["display"]["changes"][0]["after"] == full_text


def test_continuation_delivery_id_is_bound_to_the_receipt_set() -> None:
    first = _delivery_id("continuation_" + "a" * 32, ["receipt-b", "receipt-a"])
    reordered = _delivery_id("continuation_" + "a" * 32, ["receipt-a", "receipt-b"])
    changed = _delivery_id("continuation_" + "a" * 32, ["receipt-a", "receipt-c"])

    assert first == reordered
    assert first != changed


def test_continuation_heartbeat_renews_live_claim_at_the_short_interval(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, str, int]] = []

    async def renew(continuation_id: str, *, claim_id: str, lease_seconds: int) -> bool:
        calls.append((continuation_id, claim_id, lease_seconds))
        return True

    store = types.ModuleType("app.services.proposal_plan_store")
    store.renew_continuation_claim = renew
    monkeypatch.setitem(sys.modules, "app.services.proposal_plan_store", store)
    monkeypatch.setattr(proposal_plan_continuation, "_CONTINUATION_HEARTBEAT_SECONDS", 0.005)
    stop = asyncio.Event()
    lost = asyncio.Event()

    async def run() -> None:
        task = asyncio.create_task(
            proposal_plan_continuation._renew_claim_until_stopped(
                "continuation_" + "a" * 32,
                "claim_" + "b" * 32,
                stop,
                lost,
            )
        )
        while len(calls) < 2:
            await asyncio.sleep(0.002)
        stop.set()
        await task

    asyncio.run(run())
    assert len(calls) >= 2
    assert all(call == ("continuation_" + "a" * 32, "claim_" + "b" * 32, 60) for call in calls)
    assert not lost.is_set()


def test_continuation_waits_for_the_live_same_run_prompt_instead_of_disposing_it(monkeypatch: pytest.MonkeyPatch) -> None:
    run_id = "run_" + "a" * 16
    worker = SimpleNamespace(active_run_id=run_id, prompt_active=True, dispose_run=AsyncMock())
    monkeypatch.setattr("app.services.agent_run_state.load_agent_run", AsyncMock(return_value={"id": run_id, "status": "waiting_confirmation"}))

    async def run() -> None:
        task = asyncio.create_task(proposal_plan_continuation._wait_for_embedded_run_idle(run_id, worker, timeout=1))
        await asyncio.sleep(0.025)
        worker.dispose_run.assert_not_awaited()
        worker.prompt_active = False
        await task

    asyncio.run(run())
    worker.dispose_run.assert_awaited_once_with(run_id)
