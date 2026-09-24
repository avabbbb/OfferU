from __future__ import annotations

import asyncio
import uuid

import httpx
from fastapi import FastAPI

from app.routes import main_agent
from app.services import ui_approval_capability


def test_runtime_confirm_and_reject_require_desktop_capability(monkeypatch) -> None:
    monkeypatch.setattr(
        ui_approval_capability,
        "_APPROVAL_TOKEN",
        "runtime-test-capability",
    )
    calls: list[tuple[str, str, str]] = []

    class Provider:
        async def confirm_run(self, run_id: str, *, action_id: str) -> dict:
            calls.append(("confirm", run_id, action_id))
            return {"ok": True, "decision": "confirmed"}

        async def reject_run(self, run_id: str, *, action_id: str) -> dict:
            calls.append(("reject", run_id, action_id))
            return {"ok": True, "decision": "rejected"}

    async def provider_for_run(_run_id: str) -> Provider:
        return Provider()

    monkeypatch.setattr(main_agent, "_provider_for_run", provider_for_run)
    test_app = FastAPI()
    test_app.include_router(main_agent.runtime_router, prefix="/api/agent")
    run_id = str(uuid.uuid4())

    async def run() -> tuple[list[int], list[dict]]:
        statuses = []
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=test_app),
            base_url="http://127.0.0.1:8766",
        ) as client:
            for decision in ("confirm", "reject"):
                path = f"/api/agent/runtime/runs/{run_id}/{decision}"
                missing = await client.post(path, json={"action_id": "update:1"})
                guessed = await client.post(
                    path,
                    headers={"Authorization": "Bearer guessed-token"},
                    json={"action_id": "update:1"},
                )
                accepted = await client.post(
                    path,
                    headers={"Authorization": "Bearer runtime-test-capability"},
                    json={"action_id": "update:1"},
                )
                statuses.extend([missing.status_code, guessed.status_code, accepted.status_code])
        return statuses, calls.copy()

    statuses, provider_calls = asyncio.run(run())

    assert statuses == [422, 403, 200, 422, 403, 200]
    assert provider_calls == [
        ("confirm", run_id, "update:1"),
        ("reject", run_id, "update:1"),
    ]
