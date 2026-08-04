from __future__ import annotations

import asyncio
import os
import sys
import unittest
from dataclasses import replace
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.chdir(BACKEND_DIR)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import func, select

from app.database import async_session, init_db
from app.mcp_server import operation_schema
from app.models.models import OperationAuditLog
from app.ops import OPERATIONS, get_operation_schema
from app.services.agent_run_state import (
    list_agent_run_events,
    load_agent_run,
    save_agent_run,
)
from app.services.operation_projection import (
    confirm_operation_proposal,
    execute_or_propose_operation,
)


class AgentControlPlaneTests(unittest.TestCase):
    def test_selected_research_schema_is_shared_with_mcp(self) -> None:
        async def run() -> None:
            for name in {
                "get_job",
                "get_pre_application_state",
                "list_job_research_runs",
                "get_job_research",
                "start_job_research",
                "resume_job_research",
            }:
                registry_schema = get_operation_schema(name)
                mcp_schema = await operation_schema(name)
                self.assertEqual(mcp_schema["schema"], registry_schema)

        asyncio.run(run())

    def test_mcp_module_has_no_database_or_business_service_path(self) -> None:
        source = (BACKEND_DIR / "app" / "mcp_server.py").read_text(encoding="utf-8")

        self.assertNotIn("sqlalchemy", source)
        self.assertNotIn("async_session", source)
        self.assertNotIn("agent_operations", source)
        self.assertNotIn("app.models", source)

    def test_hosted_session_ui_is_a_thin_operation_projection(self) -> None:
        source = (BACKEND_DIR / "app" / "routes" / "main_agent.py").read_text(
            encoding="utf-8"
        )

        self.assertIn('"/runtime/hosted-sessions"', source)
        self.assertIn('"list_hosted_executor_sessions"', source)
        self.assertIn('"get_hosted_executor_session"', source)
        self.assertIn('"cancel_job_research"', source)
        self.assertIn('"resume_job_research"', source)
        self.assertIn('surface="hosted_session_ui"', source)
        self.assertNotIn("from app.services.coding_agent_runtime", source)
        self.assertNotIn("from app.services.job_research", source)

    def test_same_confirmed_research_action_executes_at_most_once(self) -> None:
        calls = 0
        original = OPERATIONS["start_job_research"]

        async def fake_start_job_research(
            job_id: int,
            runtime_id: str = "codex",
        ) -> dict:
            nonlocal calls
            calls += 1
            return {
                "run_id": f"research-{job_id}",
                "job_id": job_id,
                "runtime_id": runtime_id,
            }

        async def run() -> tuple[dict, dict, dict, int, list[dict]]:
            await init_db()
            proposal = await execute_or_propose_operation(
                "start_job_research",
                {"job_id": 42},
                surface="cli",
            )
            item = proposal["outputs"]["proposal"]
            first = await confirm_operation_proposal(
                item["run_id"],
                action_id=item["action_id"],
                surface="cli",
            )
            second = await confirm_operation_proposal(
                item["run_id"],
                action_id=item["action_id"],
                surface="cli",
            )
            async with async_session() as db:
                audit_count = (
                    await db.execute(
                        select(func.count(OperationAuditLog.id)).where(
                            OperationAuditLog.idempotency_key
                            == item["idempotency_key"]
                        )
                    )
                ).scalar_one()
            events = await list_agent_run_events(item["run_id"])
            return first, second, item, audit_count, events

        OPERATIONS["start_job_research"] = replace(
            original,
            fn=fake_start_job_research,
        )
        try:
            first, second, item, audit_count, events = asyncio.run(run())
        finally:
            OPERATIONS["start_job_research"] = original

        self.assertTrue(first["ok"])
        self.assertTrue(second["ok"])
        self.assertEqual(second["tool_calls"], [])
        self.assertEqual(calls, 1)
        self.assertEqual(audit_count, 1)
        self.assertTrue(item["idempotency_key"])
        self.assertTrue(item["task_id"].startswith("task_"))
        self.assertEqual(
            [event["sequence"] for event in events],
            list(range(1, len(events) + 1)),
        )
        self.assertIn("operation.proposed", {event["type"] for event in events})
        self.assertIn("operation.started", {event["type"] for event in events})
        self.assertIn("operation.completed", {event["type"] for event in events})
        self.assertIn("run.completed", {event["type"] for event in events})

    def test_interrupted_executing_step_requires_reconciliation(self) -> None:
        async def run() -> tuple[dict, list[dict]]:
            await init_db()
            proposal = await execute_or_propose_operation(
                "set_current_view",
                {"scope": "interrupted-run", "route": "/not-executed"},
                surface="cli",
            )
            item = proposal["outputs"]["proposal"]
            stored = await load_agent_run(item["run_id"])
            assert stored is not None
            stored["status"] = "executing"
            stored["steps"][0]["status"] = "executing"
            await save_agent_run(stored)

            result = await confirm_operation_proposal(
                item["run_id"],
                action_id=item["action_id"],
                surface="cli",
            )
            events = await list_agent_run_events(item["run_id"])
            return result, events

        result, events = asyncio.run(run())

        self.assertFalse(result["ok"])
        self.assertTrue(result["uncertain"])
        self.assertEqual(result["run"]["status"], "needs_reconciliation")
        self.assertIn("operation.failed", {event["type"] for event in events})
        self.assertIn("run.failed", {event["type"] for event in events})


if __name__ == "__main__":
    unittest.main()
