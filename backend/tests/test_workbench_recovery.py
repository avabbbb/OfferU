import asyncio
from dataclasses import replace
from unittest.mock import AsyncMock, patch

from app.database import init_db
from app.ops import OPERATIONS
from app.routes.bridge import list_pending_proposals
from app.services.agent_run_state import create_agent_run, load_agent_run
from app.services.operation_projection import confirm_operation_proposal
from app.database import async_session
from app.models.models import CareerTask, AutomationInboxItem
from app.services.agent_run_state import save_agent_run
from app.services.career_tasks import get_career_task
from app.services.automation import list_automation_inbox
import uuid


def test_old_pi_proposals_remain_history_and_cannot_execute():
    async def flow():
        await init_db()
        run = await create_agent_run(conversation_id="fixture", goal="历史请求", mode="general", actions=[
            {"id": "research:1", "tool": "start_job_research", "args": {"job_id": 74291}},
        ], llm_runtime={"runtime": "pi_sdk_worker"})
        pending = await list_pending_proposals()
        assert run["id"] not in [item["runId"] for item in pending["items"]]
        assert run["id"] in [item["runId"] for item in pending["unavailable"]]
        original = OPERATIONS["start_job_research"]
        execute = AsyncMock(return_value={"run_id": "unexpected", "job_id": 74291})
        OPERATIONS["start_job_research"] = replace(original, fn=execute)
        try:
            result = await confirm_operation_proposal(
                run["id"],
                action_id="research:1",
                surface="agent_runtime_ui",
                authorization_source="Bearer legacy-test-ui",
                plan_digest="0" * 64,
                group_digest="0" * 64,
            )
        finally:
            OPERATIONS["start_job_research"] = original
        assert not result["ok"]
        execute.assert_not_awaited()
        recovered = await load_agent_run(run["id"])
        assert recovered["status"] == "waiting_confirmation"
        assert recovered["steps"][0]["id"] == "research:1"
        assert recovered["steps"][0]["status"] == "waiting_confirmation"
    asyncio.run(flow())


def test_persisted_director_failure_projects_actual_model_error_without_mutating_history():
    async def flow():
        await init_db()
        task_id = "career_task_" + uuid.uuid4().hex
        item_id = "inbox_" + uuid.uuid4().hex
        async with async_session() as db:
            db.add(CareerTask(task_id=task_id, task_type="career_director", source="automation", status="failed",
                              error="missing get_daily_career_context", runtime_provider="embedded", idempotency_key=task_id))
            db.add(AutomationInboxItem(item_id=item_id, category="career_brief", task_id=task_id,
                                       status="pending", title="Fixture", body="missing get_daily_career_context"))
            await db.commit()
        run = await create_agent_run(conversation_id="fixture", goal="Fixture", task_id=task_id, mode="career_director", actions=[])
        run.update(status="failed", failure_reason="Provider 401: Invalid API key")
        await save_agent_run(run)
        view = await get_career_task(task_id)
        assert "401" in view["error"]
        assert "get_daily_career_context" not in view["error"]
        assert view["run_id"] == run["id"]
        inbox = await list_automation_inbox()
        projected = next(item for item in inbox["items"] if item["item_id"] == item_id)
        assert projected["task_error"] == view["error"]
        assert "get_daily_career_context" not in projected["body"]
        async with async_session() as db:
            original = await db.get(CareerTask, task_id)
            assert original.error == "missing get_daily_career_context"
    asyncio.run(flow())
