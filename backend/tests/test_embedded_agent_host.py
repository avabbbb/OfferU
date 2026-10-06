from __future__ import annotations

import asyncio
import json
import os
import sys
import unittest
from dataclasses import replace
from pathlib import Path
from typing import Any
from uuid import uuid4
from unittest.mock import AsyncMock, patch

from sqlalchemy import select

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.chdir(BACKEND_DIR)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.config import Settings
from app.database import async_session, init_db
from app.models.models import OperationAuditLog
from app.ops import OPERATIONS
from app.services.agent_run_state import (
    append_agent_run_event,
    create_agent_run,
    list_agent_run_events,
    load_agent_run,
    recover_interrupted_agent_runs,
    save_agent_run,
)
from app.services.agent_skill_registry import resolve_skill
from app.services.embedded_agent_host import (
    confirm_embedded_agent_action,
    resolve_embedded_provider_config,
    resume_embedded_agent_run,
    start_embedded_agent_run,
)


class FakeEmbeddedWorker:
    def __init__(self) -> None:
        self.active_run_id: str | None = None
        self.allowed_operations: list[dict[str, Any]] = []
        self.provider: dict[str, Any] = {}
        self.operation_results: list[dict[str, Any]] = []
        self.last_prompt = ""
        self.resume_session_file = ""
        self._operation_runner = None
        self._event_listener = None
        self.mutation_name = "start_job_research"
        self.mutation_args = {"job_id": 74291}
        self.prompt_active = False

    async def start_run(
        self,
        *,
        run_id: str,
        system_prompt: str,
        provider: dict[str, Any],
        allowed_operations: list[dict[str, Any]],
        operation_runner,
        event_listener,
        session_directory: str = "",
        session_file: str = "",
        pending_proposals: list[dict[str, Any]] | None = None,
        host_tools: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        self.active_run_id = run_id
        self.allowed_operations = allowed_operations
        self.provider = provider
        self.resume_session_file = session_file
        self._operation_runner = operation_runner
        self._event_listener = event_listener
        await event_listener(
            {
                "type": "event",
                "event": "run.started",
                "run_id": run_id,
                "payload": {
                    "session_id": "pi-session-test",
                    "sdk_version": "0.82.1",
                    "active_tools": ["offeru_operation"],
                },
            }
        )
        return {
            "run_id": run_id,
            "session_id": "pi-session-test",
            "sdk_version": "0.82.1",
            "session_file": session_file
            or str(Path(session_directory) / f"{run_id}.jsonl"),
            "active_tools": ["offeru_operation"],
        }

    async def prompt(
        self,
        *,
        run_id: str,
        message: str,
        timeout: float = 180,
        delivery_id: str = "",
    ) -> dict[str, Any]:
        assert run_id == self.active_run_id
        if "Outbox ID:" in message and "Receipts:" in message:
            return {"assistant_message": "已核对经过用户确认的执行结果。"}
        self.last_prompt = message
        await self._event_listener(
            {
                "type": "event",
                "event": "message.delta",
                "run_id": run_id,
                "payload": {"delta": "需要确认"},
            }
        )
        denied = await self._operation_runner(
            "set_current_view",
            {"scope": "pi-test"},
        )
        proposal = await self._operation_runner(
            self.mutation_name,
            self.mutation_args,
        )
        self.operation_results = [denied, proposal]
        return {
            "run_id": run_id,
            "session_id": "pi-session-test",
            "assistant_message": "岗位调研已形成提案，请确认后执行。",
        }

    async def abort_run(self, run_id: str) -> dict[str, Any]:
        return {"run_id": run_id}

    async def dispose_run(self, run_id: str) -> dict[str, Any]:
        assert run_id == self.active_run_id
        self.active_run_id = None
        if self._event_listener is not None:
            await self._event_listener(
                {
                    "type": "event",
                    "event": "run.disposed",
                    "run_id": run_id,
                    "payload": {},
                }
            )
        return {"run_id": run_id}


class AutoEvaluateWorker(FakeEmbeddedWorker):
    """Fake kernel that exercises list_jobs then proposes a JD import."""

    def __init__(self) -> None:
        super().__init__()
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def prompt(
        self,
        *,
        run_id: str,
        message: str,
        timeout: float = 180,
        delivery_id: str = "",
    ) -> dict[str, Any]:
        assert run_id == self.active_run_id
        self.last_prompt = message
        listed = await self._operation_runner("list_jobs", {})
        imported = await self._operation_runner(
            "import_jd",
            {
                "title": "测试后端工程师",
                "company": "测试公司",
                "jd_text": "负责后端服务开发与维护。",
            },
        )
        self.calls = [("list_jobs", listed), ("import_jd", imported)]
        return {
            "run_id": run_id,
            "session_id": "pi-session-test",
            "assistant_message": "已读取岗位；导入 JD 需要确认。",
        }


class EmbeddedAgentHostTests(unittest.TestCase):
    def test_busy_worker_failure_keeps_existing_run_and_reports_terminal_runtime(self) -> None:
        async def run() -> tuple[dict, dict, str | None]:
            await init_db()
            existing = await create_agent_run(
                conversation_id="synthetic-busy-existing",
                goal="Synthetic running task",
                mode="general",
                skill_id="discovery",
                skill_version="synthetic",
                skill_snapshot={},
                actions=[],
                llm_runtime={"runtime": "python_agent", "status": "active"},
            )
            existing["status"] = "executing"
            await save_agent_run(existing)

            class BusyWorker(FakeEmbeddedWorker):
                async def start_run(self, **kwargs) -> dict:
                    raise RuntimeError(f"An Agent Run is already active: {self.active_run_id}")

            worker = BusyWorker()
            worker.active_run_id = existing["id"]
            failed = await start_embedded_agent_run(
                message="Synthetic competing task",
                skill_id="discovery",
                worker=worker,
                provider_config={"name": "synthetic", "model": "synthetic-busy-model"},
                provider_metadata={"provider": "synthetic", "model": "synthetic-busy-model"},
            )
            stored_existing = await load_agent_run(existing["id"])
            assert stored_existing is not None
            return failed, stored_existing, worker.active_run_id

        failed, existing, active_run_id = asyncio.run(run())
        self.assertFalse(failed["ok"])
        self.assertEqual(failed["run"]["status"], "failed")
        self.assertEqual(failed["run"]["llm_runtime"]["status"], "failed")
        self.assertEqual(failed["run"]["llm_runtime"]["model"], "synthetic-busy-model")
        self.assertEqual(existing["status"], "executing")
        self.assertEqual(existing["llm_runtime"]["status"], "active")
        self.assertEqual(active_run_id, existing["id"])

    def test_stream_route_forwards_real_delta_before_final_response(self) -> None:
        from app.routes.main_agent import PiAgentRunRequest, stream_runtime_run

        async def fake_start(**kwargs) -> dict[str, Any]:
            await kwargs["stream_listener"](
                {
                    "run_id": "run_stream_test",
                    "type": "message.delta",
                    "payload": {"delta": "增量"},
                }
            )
            return {
                "ok": True,
                "run": {
                    "id": "run_stream_test",
                    "conversation_id": "conv_stream_test",
                    "status": "completed",
                },
                "assistant_message": "增量回答",
                "pending_actions": [],
                "active_skill": {"id": "discovery", "name": "技能中心"},
            }

        def fake_save(*, conversation_id, messages):
            return {
                "id": conversation_id or "conv_stream_test",
                "title": "流式测试",
                "messages": messages,
            }

        async def run() -> list[dict[str, Any]]:
            response = await stream_runtime_run(
                PiAgentRunRequest(
                    message="测试真实流式",
                    skill_id="discovery",
                )
            )
            items: list[dict[str, Any]] = []
            async for item in response.body_iterator:
                items.append(item)
            return items

        async def fake_operation(operation: str, args: dict[str, Any]) -> dict[str, Any]:
            self.assertEqual(operation, "save_harness_conversation")
            return fake_save(
                conversation_id=args.get("conversation_id"),
                messages=args.get("messages") or [],
            )

        with (
            patch(
                "app.services.embedded_agent_host.start_embedded_agent_run",
                side_effect=fake_start,
            ),
            patch(
                "app.routes.main_agent._ui_operation_outputs",
                side_effect=fake_operation,
            ),
        ):
            items = asyncio.run(run())

        self.assertEqual(items[0]["event"], "assistant.delta")
        self.assertIn("增量", items[0]["data"])
        self.assertEqual(items[-1]["event"], "message")
        self.assertIn("增量回答", items[-1]["data"])

    def test_stream_route_emits_redacted_error_id_when_provider_fails(self) -> None:
        from app.routes.main_agent import PiAgentRunRequest, stream_runtime_run

        class FailingProvider:
            async def start_run(self, **kwargs: Any) -> dict[str, Any]:
                raise RuntimeError("provider token=OFFERU_RELEASE_CANARY_SECRET_123")

        def fake_save(*, conversation_id, messages):
            return {
                "id": conversation_id or "conv_stream_failure_test",
                "title": "流式失败测试",
                "messages": messages,
            }

        async def fake_operation(operation: str, args: dict[str, Any]) -> dict[str, Any]:
            self.assertEqual(operation, "save_harness_conversation")
            return fake_save(
                conversation_id=args.get("conversation_id"),
                messages=args.get("messages") or [],
            )

        async def run() -> list[dict[str, Any]]:
            response = await stream_runtime_run(
                PiAgentRunRequest(
                    message="测试流式失败",
                    skill_id="discovery",
                    task_id="task_stream_failure",
                    runtime_provider="pi",
                )
            )
            items: list[dict[str, Any]] = []
            async for item in response.body_iterator:
                items.append(item)
            return items

        with (
            patch(
                "app.routes.main_agent._main_agent_provider",
                return_value=FailingProvider(),
            ),
            patch(
                "app.routes.main_agent._ui_operation_outputs",
                side_effect=fake_operation,
            ),
        ):
            items = asyncio.run(run())

        self.assertEqual(items[-1]["event"], "error")
        payload = json.loads(items[-1]["data"])
        self.assertRegex(payload["error_id"], r"^err_[a-f0-9]{16}$")
        self.assertEqual(payload["task_id"], "task_stream_failure")
        self.assertEqual(payload["provider_id"], "pi")
        self.assertNotIn("OFFERU_RELEASE_CANARY_SECRET_123", items[-1]["data"])
        from app.services.diagnostics import recent_errors

        record = next(
            item for item in recent_errors() if item["error_id"] == payload["error_id"]
        )
        self.assertEqual(record["task_id"], "task_stream_failure")
        self.assertEqual(record["provider_id"], "pi")
        self.assertNotIn("OFFERU_RELEASE_CANARY_SECRET_123", str(record))

    def test_cursor_stream_emits_error_id_when_run_disappears(self) -> None:
        from app.routes.main_agent import follow_runtime_run_events

        async def run() -> list[dict[str, Any]]:
            response = await follow_runtime_run_events("run_disappeared_test")
            items: list[dict[str, Any]] = []
            async for item in response.body_iterator:
                items.append(item)
            return items

        with (
            patch(
                "app.services.agent_run_state.load_agent_run",
                new=AsyncMock(side_effect=[{"id": "run_disappeared_test"}, None]),
            ),
            patch(
                "app.services.agent_run_state.list_agent_run_events",
                new=AsyncMock(return_value=[]),
            ),
        ):
            items = asyncio.run(run())

        self.assertEqual(items[-1]["event"], "error")
        payload = json.loads(items[-1]["data"])
        self.assertRegex(payload["error_id"], r"^err_[a-f0-9]{16}$")
        self.assertEqual(payload["run_id"], "run_disappeared_test")

    def test_pi_runtime_routes_are_canonical_agent_routes(self) -> None:
        from app.main import app

        # FastAPI 0.137+ keeps included routers as lazy ``_IncludedRouter``
        # entries in ``app.routes`` instead of flattening every child route.
        # OpenAPI is the public, version-stable view of registered HTTP paths.
        paths = set(app.openapi()["paths"])
        self.assertIn("/api/agent/runtime/runs", paths)
        self.assertIn("/api/agent/runtime/runs/stream", paths)
        self.assertIn(
            "/api/agent/runtime/runs/{run_id}/events/stream",
            paths,
        )
        self.assertIn("/api/agent/runtime/runs/{run_id}/confirm", paths)
        self.assertIn("/api/agent/runtime/runs/{run_id}/reject", paths)
        self.assertIn("/api/agent/runtime/runs/{run_id}/resume", paths)
        self.assertFalse(
            any(path.startswith("/api/harness-agent") for path in paths)
        )

    def test_cursor_stream_replays_only_events_after_sequence_then_finishes(self) -> None:
        from app.routes.main_agent import follow_runtime_run_events

        async def run() -> list[dict[str, Any]]:
            await init_db()
            created = await create_agent_run(
                conversation_id="pi-cursor-replay-test",
                goal="验证游标补播",
                mode="general",
                skill_id="discovery",
                skill_version="2026-07-29.1",
                skill_snapshot={"id": "discovery", "name": "技能中心"},
                actions=[],
                llm_runtime={
                    "runtime": "python_agent",
                    "stream_protocol": "cursor_v1",
                },
            )
            await append_agent_run_event(
                created["id"],
                event_type="runtime.session_started",
                payload={"session_id": "cursor-test"},
            )
            current = await load_agent_run(created["id"])
            assert current is not None
            current["status"] = "completed"
            current["final_result"] = {
                "assistant_message": "游标补播完成",
                "requires_confirmation": False,
                "turn_finished": True,
            }
            await save_agent_run(current)

            response = await follow_runtime_run_events(
                created["id"],
                after_sequence=2,
            )
            items: list[dict[str, Any]] = []
            async for item in response.body_iterator:
                items.append(item)
            return items

        items = asyncio.run(run())

        replayed = [item for item in items if item["event"] != "message"]
        self.assertTrue(replayed)
        self.assertEqual(replayed[0]["id"], "3")
        self.assertTrue(all(int(item["id"]) > 2 for item in replayed))
        self.assertEqual(items[-1]["event"], "message")
        self.assertIn("游标补播完成", items[-1]["data"])

    def test_ollama_provider_config_never_exposes_private_value_in_metadata(self) -> None:
        private, public = resolve_embedded_provider_config(
            Settings(
                llm_provider="ollama",
                llm_model="qwen3:8b",
                ollama_base_url="http://localhost:11434",
            )
        )

        self.assertEqual(private["api_key"], "ollama")
        self.assertEqual(private["base_url"], "http://localhost:11434/v1")
        self.assertNotIn("api_key", public)
        self.assertEqual(public["provider"], "ollama")
        self.assertEqual(public["model"], "qwen3:8b")

    def test_openai_legacy_config_uses_official_compatible_base_url(self) -> None:
        private, public = resolve_embedded_provider_config(
            Settings(
                llm_provider="openai",
                llm_model="gpt-5",
                openai_api_key="test-openai-key",
            )
        )

        self.assertEqual(private["base_url"], "https://api.openai.com/v1")
        self.assertEqual(private["api_key"], "test-openai-key")
        self.assertNotIn("api_key", public)

    def test_embedded_run_freezes_skill_and_adopts_one_reviewed_registry_node(self) -> None:
        """Fake host orchestration; live-model evidence is tracked separately."""
        from app.models.models import ResumeSection
        from test_migrated_agent_kernel import _seed_reviewable_resume
        from uuid import uuid4
        from app.services import embedded_agent_host, embedded_agent_worker, ui_approval_capability
        from app.services.proposal_plan_store import list_plans
        worker = FakeEmbeddedWorker()
        worker.mutation_name = "review_resume_proposal_items"
        secret = "host-private-fixture-do-not-persist"
        streamed_events = []
        async def listener(event):
            streamed_events.append(event)
        async def run():
            await init_db()
            seed = await _seed_reviewable_resume(uuid4().hex)
            worker.mutation_args = {"proposal_id": seed["proposal_id"], "resume_id": seed["resume_id"],
                "change_ids": seed["change_ids"], "action": "accept"}
            started = await start_embedded_agent_run(message="Prepare a reviewed resume addition.",
                skill_id="tailor_resume", conversation_id="host-plan-fixture",
                context_messages=[{"role": "user", "content": "Prior user context"}], worker=worker,
                provider_config={"name": "fixture", "model": "fixture", "api_key": secret},
                provider_metadata={"runtime": "python_agent", "provider_id": "embedded"},
                stream_listener=listener)
            self.assertTrue(started["ok"], started)
            self.assertEqual(started["run"]["status"], "waiting_confirmation")
            self.assertIn("Prior user context", worker.last_prompt)
            plan = (await list_plans(run_id=started["run"]["id"]))[0]
            group = plan["groups"][0]
            node = group["nodes"][0]
            self.assertEqual(len(group["nodes"]), 1)
            decision = {"action_id": node["id"], "authorization_source": "Bearer synthetic-host-native",
                "plan_digest": plan["digest"], "group_digest": group["digest"]}
            with patch.object(ui_approval_capability, "accepts_authorization", side_effect=lambda value: value == decision["authorization_source"]), patch.object(embedded_agent_worker, "get_embedded_agent_worker", return_value=worker), patch.object(embedded_agent_host, "resolve_embedded_provider_config", return_value=({"name": "fixture", "model": "fixture"}, {"runtime": "python_agent", "provider_id": "embedded"})):
                confirmed = await confirm_embedded_agent_action(started["run"]["id"], **decision)
                replay = await confirm_embedded_agent_action(started["run"]["id"], **decision)
            self.assertTrue(confirmed["ok"], confirmed)
            self.assertTrue(replay["ok"] and replay["duplicate"], replay)
            stored = await load_agent_run(started["run"]["id"])
            self.assertEqual(stored["status"], "completed")
            self.assertEqual(confirmed["continuation"]["status"], "delivered")
            async with async_session() as db:
                audits = (await db.execute(select(OperationAuditLog).where(OperationAuditLog.idempotency_key == node["idempotency_key"]))).scalars().all()
                sections = (await db.execute(select(ResumeSection).where(ResumeSection.resume_id == seed["resume_id"]).order_by(ResumeSection.sort_order))).scalars().all()
            self.assertEqual(len(audits), 1)
            self.assertTrue(audits[0].ok)
            self.assertEqual(audits[0].surface, "agent_runtime_ui")
            self.assertEqual([section.content_json[0]["description"] for section in sections], seed["expected_after"])
            events = await list_agent_run_events(stored["id"])
            self.assertEqual([event["sequence"] for event in events], list(range(1, len(events) + 1)))
            self.assertEqual(len([event for event in events if event["type"] == "continuation.accepted"]), 1)
            self.assertIn("proposal.plan_ready", {event["type"] for event in streamed_events})
            self.assertNotIn(secret, json.dumps(stored))
            self.assertFalse(worker.operation_results[0]["ok"])
            self.assertFalse(worker.operation_results[1]["outputs"]["executed"])
            self.assertIn("review_resume_proposal_items", {item["name"] for item in worker.allowed_operations})
            self.assertNotIn("set_current_view", {item["name"] for item in worker.allowed_operations})
        asyncio.run(run())

    def test_auto_skill_id_routes_new_run_and_freezes_tools(self) -> None:
        from sqlalchemy import func

        from app.models.models import AgentRunRecord, Job

        worker = AutoEvaluateWorker()
        conversation_id = f"auto-route-{uuid4().hex}"

        async def run() -> tuple[dict[str, Any], int, int]:
            await init_db()
            started = await start_embedded_agent_run(
                message="读取我的岗位列表",
                skill_id="auto",
                conversation_id=conversation_id,
                context_messages=[{"role": "user", "content": "我在看后端岗位"}],
                worker=worker,
                provider_config={
                    "name": "test-provider",
                    "model": "test-model",
                    "base_url": "https://example.invalid/v1",
                    "api_key": "auto-test-secret",
                },
                provider_metadata={
                    "runtime": "python_agent",
                    "protocol_version": "offeru.pi-worker.v1",
                    "provider": "test-provider",
                    "model": "test-model",
                    "source": "test",
                },
            )
            async with async_session() as db:
                job_count = int(
                    (
                        await db.execute(
                            select(func.count(Job.id)).where(
                                Job.title == "测试后端工程师"
                            )
                        )
                    ).scalar_one()
                )
                run_count = int(
                    (
                        await db.execute(
                            select(func.count(AgentRunRecord.run_id)).where(
                                AgentRunRecord.conversation_id
                                == conversation_id
                            )
                        )
                    ).scalar_one()
                )
            return started, job_count, run_count

        with patch(
            "app.agents.llm.chat_completion",
            new=AsyncMock(return_value='{"skill_id":"evaluate_job","reason":"岗位相关"}'),
        ) as router:
            started, job_count, run_count = asyncio.run(run())

        # One bounded router call selected a business Skill; the Run froze the
        # resolved tools plus route provenance.
        router.assert_awaited_once()
        self.assertTrue(started["ok"])
        self.assertEqual(started["run"]["skill_id"], "evaluate_job")
        self.assertEqual(started["active_skill"]["id"], "evaluate_job")
        self.assertEqual(
            started["active_skill"]["routing"],
            {"via": "auto", "requested": "auto", "reason": "岗位相关"},
        )
        snapshot = started["run"]["skill_snapshot"]
        self.assertEqual(snapshot["routing"]["via"], "auto")
        self.assertEqual(snapshot["allowed_tools"], sorted(snapshot["allowed_tools"]))
        self.assertIn("import_jd", snapshot["allowed_tools"])
        granted = {item["name"] for item in worker.allowed_operations}
        self.assertIn("list_jobs", granted)
        self.assertIn("import_jd", granted)
        self.assertNotIn("start_job_research", granted)
        self.assertNotIn("set_current_view", granted)

        # Read Operations execute directly; the pasted-JD import stays a
        # proposal and never writes a Job before confirmation.
        self.assertEqual(worker.calls[0][0], "list_jobs")
        self.assertTrue(worker.calls[0][1]["ok"])
        self.assertEqual(worker.calls[1][0], "import_jd")
        self.assertTrue(worker.calls[1][1]["ok"])
        plan = worker.calls[1][1]["outputs"]["plan"]
        self.assertFalse(worker.calls[1][1]["outputs"]["executed"])
        self.assertEqual(plan["status"], "sealed")
        self.assertEqual(plan["groups"][0]["status"], "pending")
        self.assertEqual(started["run"]["status"], "waiting_confirmation")
        self.assertEqual(len(started["pending_actions"]), 1)
        self.assertEqual(job_count, 0)
        self.assertEqual(run_count, 1)

    def test_auto_router_failure_creates_no_phantom_run(self) -> None:
        from sqlalchemy import func

        from app.models.models import AgentRunRecord
        from app.services.agent_skill_registry import SkillRoutingError

        worker = AutoEvaluateWorker()

        async def run() -> int:
            await init_db()
            try:
                await start_embedded_agent_run(
                    message="读取我的岗位列表",
                    skill_id="auto",
                    conversation_id="pi-auto-routing-failure-test",
                    worker=worker,
                    provider_config={"name": "test-provider", "model": "test-model"},
                )
            except SkillRoutingError:
                pass
            else:
                raise AssertionError("auto routing failure must be raised")
            async with async_session() as db:
                return int(
                    (
                        await db.execute(
                            select(func.count(AgentRunRecord.run_id)).where(
                                AgentRunRecord.conversation_id
                                == "pi-auto-routing-failure-test"
                            )
                        )
                    ).scalar_one()
                )

        with patch(
            "app.agents.llm.chat_completion",
            new=AsyncMock(return_value=None),
        ):
            run_count = asyncio.run(run())

        # Router failure surfaces before business execution: no Run row, no
        # tool call, no worker session.
        self.assertEqual(run_count, 0)
        self.assertEqual(worker.calls, [])
        self.assertIsNone(worker.active_run_id)

    def test_legacy_action_only_confirmation_never_executes_a_sibling(self) -> None:
        from app.models.models import AgentRunRecord, ProposalConfirmationDecision, ProposalExecutionPlan
        from app.services import ui_approval_capability
        calls = []
        async def fake_write(**kwargs):
            calls.append(kwargs)
            return {"ok": True}
        async def run():
            await init_db()
            created = await create_agent_run(conversation_id="legacy-sibling-denial", goal="Preserve old proposals",
                mode="skill_assistant", skill_id="company_research", actions=[
                    {"id": "research:first", "tool": "start_job_research", "args": {"job_id": 81001}},
                    {"id": "research:second", "tool": "start_job_research", "args": {"job_id": 81002}},
                ], skill_snapshot={"allowed_tools": ["start_job_research"]}, llm_runtime={"runtime": "python_agent"})
            with patch.object(ui_approval_capability, "accepts_authorization", return_value=True), patch.dict(OPERATIONS, {"start_job_research": replace(OPERATIONS["start_job_research"], fn=fake_write)}):
                result = await confirm_embedded_agent_action(created["id"], action_id="research:first", authorization_source="Bearer synthetic-native")
            self.assertFalse(result["ok"])
            self.assertEqual(calls, [])
            async with async_session() as db:
                row = (await db.execute(select(AgentRunRecord).where(AgentRunRecord.run_id == created["id"]))).scalar_one()
                self.assertEqual([step["status"] for step in row.steps_json], ["waiting_confirmation", "waiting_confirmation"])
                decisions = (await db.execute(select(ProposalConfirmationDecision).join(ProposalExecutionPlan,
                    ProposalConfirmationDecision.plan_id == ProposalExecutionPlan.id).where(ProposalExecutionPlan.run_id == created["id"]))).scalars().all()
                self.assertEqual(decisions, [])
            events = await list_agent_run_events(created["id"])
            self.assertNotIn("operation.started", {event["type"] for event in events})
        asyncio.run(run())

    def test_restart_marks_run_interrupted_and_explicitly_resumes_same_session(self) -> None:
        worker = FakeEmbeddedWorker()

        async def run() -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
            await init_db()
            from app.models.models import Job
            async with async_session() as db:
                if await db.get(Job, 74291) is None:
                    db.add(Job(id=74291, title="Synthetic recovery role", company="Fixture", raw_description="Public synthetic JD", hash_key="host-recovery-job"))
                    await db.commit()
            skill = resolve_skill("company_research")
            assert skill is not None
            created = await create_agent_run(
                conversation_id="pi-recovery-test",
                goal="恢复中断的岗位调研",
                mode=skill.mode,
                skill_id=skill.id,
                skill_version=skill.version,
                skill_snapshot={
                    "id": skill.id,
                    "version": skill.version,
                    "allowed_tools": sorted(skill.allowed_tools),
                },
                actions=[],
                llm_runtime={
                    "runtime": "python_agent",
                    "protocol_version": "offeru.pi-worker.v1",
                    "session_id": created_session_id,
                    "session_file": "H:/temporary/pi-recovery-session.jsonl",
                    "status": "active",
                },
            )
            created["status"] = "executing"
            await save_agent_run(created)
            await recover_interrupted_agent_runs()
            interrupted = await load_agent_run(created["id"])
            assert interrupted is not None
            resumed = await resume_embedded_agent_run(
                created["id"],
                worker=worker,
                provider_config={
                    "name": "test-provider",
                    "model": "test-model",
                    "base_url": "https://example.invalid/v1",
                    "api_key": "resume-test-secret",
                },
                provider_metadata={
                    "runtime": "python_agent",
                    "protocol_version": "offeru.pi-worker.v1",
                    "provider": "test-provider",
                    "model": "test-model",
                    "source": "test",
                },
            )
            events = await list_agent_run_events(created["id"])
            return interrupted, resumed, events

        created_session_id = "pi-session-before-restart"
        interrupted, resumed, events = asyncio.run(run())

        self.assertEqual(interrupted["status"], "interrupted")
        self.assertEqual(resumed["run"]["id"], interrupted["id"])
        self.assertEqual(resumed["run"]["status"], "waiting_confirmation")
        self.assertEqual(
            worker.resume_session_file,
            "H:/temporary/pi-recovery-session.jsonl",
        )
        self.assertIn("Resume this interrupted OfferU Agent Run", worker.last_prompt)
        event_types = {event["type"] for event in events}
        self.assertIn("recovery.interrupted", event_types)
        self.assertIn("recovery.started", event_types)

    def test_restart_never_replays_an_executing_write(self) -> None:
        async def run() -> tuple[dict[str, Any], list[dict[str, Any]]]:
            await init_db()
            created = await create_agent_run(
                conversation_id="pi-reconciliation-test",
                goal="不要重复写入",
                mode="skill_assistant",
                skill_id="company_research",
                skill_version="2026-07-29.1",
                skill_snapshot={
                    "id": "company_research",
                    "version": "2026-07-29.1",
                    "allowed_tools": ["start_job_research"],
                },
                actions=[
                    {
                        "id": "start_job_research:1",
                        "tool": "start_job_research",
                        "args": {"job_id": 99221},
                        "summary": "启动岗位调研",
                        "requires_confirmation": True,
                    }
                ],
                llm_runtime={
                    "runtime": "python_agent",
                    "session_file": "H:/temporary/uncertain-session.jsonl",
                },
            )
            created["status"] = "executing"
            created["steps"][0]["status"] = "executing"
            await save_agent_run(created)
            await recover_interrupted_agent_runs()
            stored = await load_agent_run(created["id"])
            assert stored is not None
            events = await list_agent_run_events(created["id"])
            return stored, events

        stored, events = asyncio.run(run())

        self.assertEqual(stored["status"], "needs_reconciliation")
        self.assertEqual(stored["steps"][0]["status"], "uncertain")
        self.assertTrue(stored["steps"][0]["projection_only"])
        self.assertIn("automatic replay is forbidden", stored["failure_reason"])
        event_types = {event["type"] for event in events}
        self.assertIn("recovery.reconciliation_required", event_types)
        self.assertIn("run.failed", event_types)


if __name__ == "__main__":
    unittest.main()
