from __future__ import annotations

import asyncio
import uuid

import httpx
from fastapi import FastAPI

from app.routes import main_agent
from app.services import agent_run_coordinator, proposal_plan_continuation, proposal_plan_store
from app.services import ui_approval_capability


def test_plan_group_decisions_require_desktop_capability_and_both_digests(monkeypatch) -> None:
    token = "runtime-test-capability"
    header = f"Bearer {token}"
    accepts_fixture_token = lambda value: value == header
    monkeypatch.setattr(ui_approval_capability, "accepts_authorization", accepts_fixture_token)
    # main_agent imports the verifier as a module-level alias; keep both aliases
    # on one test-only capability, including when another test reloaded the module.
    monkeypatch.setattr(main_agent, "accepts_authorization", accepts_fixture_token)

    calls: list[tuple[str, str, str, dict]] = []

    class Coordinator:
        async def confirm_group(self, plan_id: str, group_id: str, **kwargs) -> dict:
            calls.append(("approve", plan_id, group_id, kwargs))
            return {"ok": True, "plan": None, "group": None, "receipts": [], "errors": [], "duplicate": False}

        async def reject_group(self, plan_id: str, group_id: str, **kwargs) -> dict:
            calls.append(("reject", plan_id, group_id, kwargs))
            return {"ok": True, "plan": None, "group": None, "receipts": [], "errors": [], "duplicate": False}

    async def no_continuations(*, run_id: str) -> list[dict]:
        return []

    async def no_plan(_plan_id: str) -> None:
        return None

    async def no_delivery(_run_id: str) -> dict:
        return {"continuations": [], "run": None}

    monkeypatch.setattr(agent_run_coordinator, "AgentRunCoordinator", Coordinator)
    monkeypatch.setattr(proposal_plan_store, "get_plan", no_plan)
    monkeypatch.setattr(proposal_plan_store, "list_continuations", no_continuations)
    monkeypatch.setattr(proposal_plan_continuation, "deliver_continuations", no_delivery)

    test_app = FastAPI()
    test_app.include_router(main_agent.runtime_router, prefix="/api/agent")
    plan_id = f"plan_{uuid.uuid4().hex}"
    group_id = f"group_{uuid.uuid4().hex}"

    async def run() -> tuple[list[int], list[dict]]:
        statuses = []
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=test_app),
            base_url="http://127.0.0.1:8766",
        ) as client:
            for approve in (True, False):
                path = f"/api/agent/plans/{plan_id}/groups/{group_id}/decision"
                valid_body = {
                    "approve": approve,
                    "plan_digest": "a" * 64,
                    "group_digest": "b" * 64,
                    "decision_id": f"decision_{uuid.uuid4().hex}",
                }
                missing = await client.post(path, json=valid_body)
                guessed = await client.post(
                    path,
                    headers={"Authorization": "Bearer guessed-token"},
                    json=valid_body,
                )
                digestless = await client.post(
                    path,
                    headers={"Authorization": header},
                    json={"approve": approve, "decision_id": f"decision_{uuid.uuid4().hex}"},
                )
                accepted = await client.post(
                    path,
                    headers={"Authorization": header},
                    json=valid_body,
                )
                statuses.extend(
                    [missing.status_code, guessed.status_code, digestless.status_code, accepted.status_code]
                )
        return statuses, calls.copy()

    statuses, coordinator_calls = asyncio.run(run())

    assert statuses == [422, 403, 422, 200, 422, 403, 422, 200]
    assert [call[0] for call in coordinator_calls] == ["approve", "reject"]
    assert all(call[1] == plan_id and call[2] == group_id for call in coordinator_calls)
    for _, _, _, kwargs in coordinator_calls:
        assert kwargs["plan_digest"] == "a" * 64
        assert kwargs["group_digest"] == "b" * 64
        assert kwargs["decision_id"].startswith("decision_")
        assert kwargs["authorization_source"] == header
        assert kwargs["surface"] == "agent_runtime_ui"
