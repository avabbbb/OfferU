from __future__ import annotations

import asyncio
import os
import sys
import unittest
import uuid
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.chdir(BACKEND_DIR)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import func, select

from app.database import async_session, init_db
from app.mcp_server import operation_schema
from app.models.models import OperationAuditLog
from app.ops import OPERATIONS, execute_operation, get_operation_schema
import app.services.agent_run_state as agent_run_state
import app.services.operation_projection as operation_projection
from app.services.agent_run_state import (
    create_agent_run,
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
                surface="agent_runtime_ui",
            )
            second = await confirm_operation_proposal(
                item["run_id"],
                action_id=item["action_id"],
                surface="agent_runtime_ui",
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
                surface="agent_runtime_ui",
            )
            events = await list_agent_run_events(item["run_id"])
            return result, events

        result, events = asyncio.run(run())

        self.assertFalse(result["ok"])
        self.assertTrue(result["uncertain"])
        self.assertEqual(result["run"]["status"], "needs_reconciliation")
        self.assertIn("operation.failed", {event["type"] for event in events})
        self.assertIn("run.failed", {event["type"] for event in events})

    def test_reject_one_action_preserves_siblings_and_audits_decision(self) -> None:
        async def run() -> tuple[dict, dict, list[dict], list[OperationAuditLog]]:
            await init_db()
            created = await create_agent_run(
                conversation_id=f"reject-{uuid.uuid4().hex}",
                goal="Prepare two independent proposals",
                mode="general",
                actions=[
                    {
                        "id": "action-one",
                        "tool": "set_current_view",
                        "args": {"scope": "reject-one", "route": "/jobs/1"},
                    },
                    {
                        "id": "action-two",
                        "tool": "set_current_view",
                        "args": {"scope": "reject-two", "route": "/jobs/2"},
                    },
                ],
            )
            stale = await load_agent_run(created["id"])
            assert stale is not None
            ambiguous = await execute_operation(
                "reject_agent_run",
                {"run_id": created["id"]},
                surface="agent_runtime_ui",
            )
            result = await execute_operation(
                "reject_agent_run",
                {"run_id": created["id"], "action_id": "action-one"},
                surface="agent_runtime_ui",
            )
            single = await create_agent_run(
                conversation_id=f"reject-single-{uuid.uuid4().hex}",
                goal="Reject one proposal through the legacy call shape",
                mode="general",
                actions=[
                    {
                        "id": "single-action",
                        "tool": "set_current_view",
                        "args": {"scope": "reject-single", "route": "/jobs/4"},
                    }
                ],
            )
            fallback = await execute_operation(
                "reject_agent_run",
                {"run_id": single["id"]},
                surface="agent_runtime_ui",
            )
            single_run = await load_agent_run(single["id"])
            assert single_run is not None
            single_events = await list_agent_run_events(single["id"])
            stale["final_result"] = {"assistant_message": "stale provider save"}
            await save_agent_run(stale)
            persisted = await load_agent_run(created["id"])
            assert persisted is not None
            events = await list_agent_run_events(created["id"])
            async with async_session() as db:
                audits = (
                    await db.execute(
                        select(OperationAuditLog)
                        .where(
                            OperationAuditLog.operation == "reject_agent_run",
                            OperationAuditLog.surface == "agent_runtime_ui",
                        )
                        .order_by(OperationAuditLog.id.asc())
                    )
                ).scalars().all()
            rejected_run = dict(persisted)
            persisted["status"] = "failed"
            persisted["failure_reason"] = "durable provider failure"
            await save_agent_run(persisted)
            await save_agent_run(stale)
            protected = await load_agent_run(created["id"])
            assert protected is not None
            return (
                ambiguous,
                {
                    "result": result,
                    "run": rejected_run,
                    "protected": protected,
                    "fallback": fallback,
                    "single_run": single_run,
                    "single_events": single_events,
                },
                events,
                audits,
            )

        ambiguous, payload, events, audits = asyncio.run(run())
        result = payload["result"]
        run = payload["run"]
        protected = payload["protected"]
        fallback = payload["fallback"]
        single_run = payload["single_run"]
        self.assertFalse(ambiguous["ok"])
        self.assertIn("action_id", " ".join(ambiguous["errors"]))
        self.assertTrue(result["ok"])
        self.assertEqual(result["outputs"]["action_status"], "rejected")
        self.assertEqual(result["outputs"]["run"]["id"], run["id"])
        self.assertEqual(run["status"], "waiting_confirmation")
        self.assertEqual(
            {step["id"]: step["status"] for step in run["steps"]},
            {"action-one": "rejected", "action-two": "waiting_confirmation"},
        )
        self.assertTrue(run["steps"][0]["rejected_at"])
        self.assertEqual(
            sum(event["type"] == "operation.rejected" for event in events), 1
        )
        self.assertEqual(
            [event["sequence"] for event in events],
            list(range(1, len(events) + 1)),
        )
        matching_audits = [
            row
            for row in audits
            if (row.inputs_json or {}).get("run_id") == run["id"]
            and (row.inputs_json or {}).get("action_id") == "action-one"
        ]
        self.assertEqual(len(matching_audits), 1)
        self.assertEqual(matching_audits[0].status, "completed")
        self.assertEqual(protected["status"], "failed")
        self.assertEqual(protected["failure_reason"], "durable provider failure")
        self.assertEqual(
            {step["id"]: step["status"] for step in protected["steps"]},
            {"action-one": "rejected", "action-two": "waiting_confirmation"},
        )
        self.assertTrue(fallback["ok"])
        self.assertEqual(fallback["outputs"]["action_id"], "single-action")
        self.assertEqual(single_run["status"], "completed")
        self.assertEqual(single_run["steps"][0]["status"], "rejected")
        self.assertEqual(
            [event["type"] for event in payload["single_events"]][-2:],
            ["operation.rejected", "run.completed"],
        )

    def test_confirming_one_action_leaves_sibling_proposal_pending(self) -> None:
        calls: list[dict] = []
        original = OPERATIONS["start_job_research"]

        async def fake_start_job_research(job_id: int, runtime_id: str = "codex") -> dict:
            calls.append({"job_id": job_id, "runtime_id": runtime_id})
            return {"run_id": f"research-{job_id}", "job_id": job_id, "runtime_id": runtime_id}

        async def run() -> tuple[dict, dict]:
            await init_db()
            created = await create_agent_run(
                conversation_id=f"confirm-one-{uuid.uuid4().hex}",
                goal="Prepare two independent proposals",
                mode="general",
                actions=[
                    {
                        "id": "action-one",
                        "tool": "start_job_research",
                        "args": {"job_id": 1},
                    },
                    {
                        "id": "action-two",
                        "tool": "start_job_research",
                        "args": {"job_id": 2},
                    },
                ],
            )
            result = await confirm_operation_proposal(
                created["id"], action_id="action-one", surface="agent_runtime_ui"
            )
            persisted = await load_agent_run(created["id"])
            assert persisted is not None
            return result, persisted

        OPERATIONS["start_job_research"] = replace(original, fn=fake_start_job_research)
        try:
            result, persisted = asyncio.run(run())
        finally:
            OPERATIONS["start_job_research"] = original

        self.assertTrue(result["ok"])
        self.assertEqual(len(result["tool_calls"]), 1)
        self.assertEqual(calls, [{"job_id": 1, "runtime_id": "codex"}])
        self.assertEqual(persisted["status"], "waiting_confirmation")
        self.assertEqual(
            {step["id"]: step["status"] for step in persisted["steps"]},
            {"action-one": "completed", "action-two": "waiting_confirmation"},
        )

    def test_confirm_and_reject_race_has_one_action_transition_winner(self) -> None:
        calls = 0
        original = OPERATIONS["set_current_view"]

        async def fake_set_current_view(scope: str, route: str) -> dict:
            nonlocal calls
            calls += 1
            return {"scope": scope, "route": route}

        async def run() -> tuple[dict, dict, dict]:
            await init_db()
            created = await create_agent_run(
                conversation_id=f"decision-race-{uuid.uuid4().hex}",
                goal="Race confirm against reject",
                mode="general",
                actions=[
                    {
                        "id": "action-race",
                        "tool": "set_current_view",
                        "args": {"scope": "decision-race", "route": "/jobs/3"},
                    }
                ],
            )
            initial_loads = 0
            both_loaded = asyncio.Event()
            projection_load = operation_projection.load_agent_run
            state_load = agent_run_state.load_agent_run

            async def synchronized_load(loader, run_id: str):
                nonlocal initial_loads
                value = await loader(run_id)
                if run_id == created["id"] and value is not None:
                    initial_loads += 1
                    if initial_loads == 2:
                        both_loaded.set()
                    await both_loaded.wait()
                return value

            async def projection_barrier_load(run_id: str):
                return await synchronized_load(projection_load, run_id)

            async def state_barrier_load(run_id: str | None):
                return await synchronized_load(state_load, run_id)

            with (
                patch.object(operation_projection, "load_agent_run", projection_barrier_load),
                patch.object(agent_run_state, "load_agent_run", state_barrier_load),
            ):
                confirmed, rejected = await asyncio.gather(
                    confirm_operation_proposal(
                        created["id"], action_id="action-race", surface="agent_runtime_ui"
                    ),
                    execute_operation(
                        "reject_agent_run",
                        {"run_id": created["id"], "action_id": "action-race"},
                        surface="agent_runtime_ui",
                    ),
                )
            persisted = await load_agent_run(created["id"])
            assert persisted is not None
            return confirmed, rejected, persisted

        OPERATIONS["set_current_view"] = replace(original, fn=fake_set_current_view)
        try:
            confirmed, rejected, persisted = asyncio.run(run())
        finally:
            OPERATIONS["set_current_view"] = original

        step = persisted["steps"][0]
        if step["status"] == "rejected":
            self.assertEqual(calls, 0)
            self.assertTrue(rejected["ok"])
            self.assertFalse(confirmed["ok"])
        else:
            self.assertEqual(step["status"], "completed")
            self.assertEqual(calls, 1)
            self.assertTrue(confirmed["ok"])
            self.assertFalse(rejected["ok"])


if __name__ == "__main__":
    unittest.main()
