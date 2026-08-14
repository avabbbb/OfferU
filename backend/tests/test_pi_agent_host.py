from __future__ import annotations

import asyncio
import json
import os
import sys
import unittest
from dataclasses import replace
from pathlib import Path
from typing import Any
from unittest.mock import patch

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.chdir(BACKEND_DIR)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.config import Settings
from app.database import init_db
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
from app.services.pi_agent_host import (
    confirm_pi_agent_action,
    resolve_pi_provider_config,
    resume_pi_agent_run,
    start_pi_agent_run,
)


class FakePiWorker:
    def __init__(self) -> None:
        self.active_run_id: str | None = None
        self.allowed_operations: list[dict[str, Any]] = []
        self.provider: dict[str, Any] = {}
        self.operation_results: list[dict[str, Any]] = []
        self.last_prompt = ""
        self.resume_session_file = ""
        self._operation_runner = None
        self._event_listener = None

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
    ) -> dict[str, Any]:
        assert run_id == self.active_run_id
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
            "start_job_research",
            {"job_id": 74291},
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


class PiAgentHostTests(unittest.TestCase):
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

        with (
            patch(
                "app.services.pi_agent_host.start_pi_agent_run",
                side_effect=fake_start,
            ),
            patch(
                "app.routes.main_agent.save_conversation_messages",
                side_effect=fake_save,
            ),
        ):
            items = asyncio.run(run())

        self.assertEqual(items[0]["event"], "message.delta")
        self.assertIn("增量", items[0]["data"])
        self.assertEqual(items[-1]["event"], "message")
        self.assertIn("增量回答", items[-1]["data"])

    def test_pi_runtime_routes_are_canonical_agent_routes(self) -> None:
        from app.main import app

        paths = {getattr(route, "path", "") for route in app.routes}
        self.assertIn("/api/agent/runtime/runs", paths)
        self.assertIn("/api/agent/runtime/runs/stream", paths)
        self.assertIn(
            "/api/agent/runtime/runs/{run_id}/events/stream",
            paths,
        )
        self.assertIn("/api/agent/runtime/runs/{run_id}/confirm", paths)
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
                    "runtime": "pi_sdk_worker",
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
        private, public = resolve_pi_provider_config(
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
        private, public = resolve_pi_provider_config(
            Settings(
                llm_provider="openai",
                llm_model="gpt-5",
                openai_api_key="test-openai-key",
            )
        )

        self.assertEqual(private["base_url"], "https://api.openai.com/v1")
        self.assertEqual(private["api_key"], "test-openai-key")
        self.assertNotIn("api_key", public)

    def test_pi_run_freezes_skill_proposes_write_and_confirms_once(self) -> None:
        calls = 0
        turn_finished_while_confirming: bool | None = None
        original = OPERATIONS["start_job_research"]
        worker = FakePiWorker()
        secret = "pi-host-secret-must-not-persist"
        streamed_events: list[dict[str, Any]] = []

        async def fake_start_job_research(
            job_id: int,
            runtime_id: str = "codex",
        ) -> dict[str, Any]:
            nonlocal calls, turn_finished_while_confirming
            calls += 1
            confirming_run = await load_agent_run(worker.active_run_id)
            turn_finished_while_confirming = bool(
                (confirming_run or {})
                .get("final_result", {})
                .get("turn_finished")
            )
            return {
                "run_id": f"research-{job_id}",
                "job_id": job_id,
                "runtime_id": runtime_id,
            }

        async def stream_listener(event: dict[str, Any]) -> None:
            streamed_events.append(event)

        async def run() -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
            await init_db()
            started = await start_pi_agent_run(
                message="研究这个岗位，确认后启动调研。",
                skill_id="company_research",
                conversation_id="pi-host-control-plane-test",
                context_messages=[
                    {"role": "user", "content": "上一轮：只研究公开信息"},
                    {"role": "assistant", "content": "明白，我会保留证据边界。"},
                ],
                worker=worker,
                provider_config={
                    "name": "test-provider",
                    "model": "test-model",
                    "base_url": "https://example.invalid/v1",
                    "api_key": secret,
                },
                provider_metadata={
                    "runtime": "pi_sdk_worker",
                    "protocol_version": "offeru.pi-worker.v1",
                    "provider": "test-provider",
                    "model": "test-model",
                    "source": "test",
                },
                stream_listener=stream_listener,
            )
            action_id = started["pending_actions"][0]["id"]
            confirmed = await confirm_pi_agent_action(
                started["run"]["id"],
                action_id=action_id,
                worker=worker,
            )
            stored = await load_agent_run(started["run"]["id"])
            assert stored is not None
            events = await list_agent_run_events(started["run"]["id"])
            return started, confirmed, events

        OPERATIONS["start_job_research"] = replace(
            original,
            fn=fake_start_job_research,
        )
        try:
            started, confirmed, events = asyncio.run(run())
        finally:
            OPERATIONS["start_job_research"] = original

        self.assertTrue(started["ok"])
        self.assertIn("上一轮：只研究公开信息", worker.last_prompt)
        self.assertIn("Current user request", worker.last_prompt)
        self.assertEqual(started["run"]["status"], "waiting_confirmation")
        self.assertEqual(len(started["pending_actions"]), 1)
        self.assertFalse(worker.operation_results[0]["ok"])
        self.assertTrue(worker.operation_results[1]["ok"])
        self.assertFalse(
            worker.operation_results[1]["outputs"]["executed"]
        )
        self.assertEqual(calls, 1)
        self.assertFalse(turn_finished_while_confirming)
        self.assertTrue(confirmed["ok"])
        self.assertEqual(confirmed["run"]["status"], "completed")
        self.assertTrue(confirmed["run"]["final_result"]["turn_finished"])
        self.assertFalse(
            confirmed["run"]["final_result"]["requires_confirmation"]
        )
        self.assertIsNone(worker.active_run_id)

        granted = {item["name"] for item in worker.allowed_operations}
        self.assertIn("start_job_research", granted)
        self.assertNotIn("set_current_view", granted)
        self.assertTrue(
            all("input_schema" in item for item in worker.allowed_operations)
        )
        persisted_text = json.dumps(confirmed["run"], ensure_ascii=False)
        self.assertNotIn(secret, persisted_text)
        self.assertEqual(
            confirmed["run"]["skill_snapshot"]["allowed_tools"],
            sorted(confirmed["run"]["skill_snapshot"]["allowed_tools"]),
        )

        sequences = [event["sequence"] for event in events]
        self.assertEqual(sequences, list(range(1, len(events) + 1)))
        event_types = {event["type"] for event in events}
        self.assertIn("guardian.advice", event_types)
        self.assertIn("guardian.reviewed", event_types)
        self.assertIn("runtime.session_started", event_types)
        self.assertIn("message.delta", event_types)
        self.assertIn("operation.denied", event_types)
        self.assertIn("operation.proposed", event_types)
        self.assertIn("operation.started", event_types)
        self.assertIn("operation.completed", event_types)
        self.assertIn("run.completed", event_types)
        self.assertIn("runtime.disposed", event_types)
        turn_finished_events = [
            event for event in events if event["type"] == "run.turn_finished"
        ]
        self.assertEqual(len(turn_finished_events), 2)
        self.assertFalse(
            turn_finished_events[-1]["payload"]["requires_confirmation"]
        )
        disposed_sequence = next(
            event["sequence"]
            for event in events
            if event["type"] == "runtime.disposed"
        )
        self.assertGreater(turn_finished_events[-1]["sequence"], disposed_sequence)
        streamed_types = {event["type"] for event in streamed_events}
        self.assertIn("run.created", streamed_types)
        self.assertIn("runtime.starting", streamed_types)
        self.assertIn("runtime.session_started", streamed_types)
        self.assertIn("message.delta", streamed_types)
        self.assertIn("operation.denied", streamed_types)
        self.assertIn("operation.proposed", streamed_types)
        self.assertIn("run.waiting_confirmation", streamed_types)
        self.assertIn("guardian.advice", streamed_types)
        self.assertIn("guardian.reviewed", streamed_types)
        durable_events = [
            event for event in streamed_events if event.get("durable")
        ]
        self.assertTrue(durable_events)
        self.assertTrue(
            all(int(event.get("sequence") or 0) > 0 for event in durable_events)
        )
        self.assertNotIn("tool_calls", started["guardian"])
        self.assertNotIn("proposed_actions", started["guardian"])

    def test_confirm_with_remaining_action_finishes_current_turn(self) -> None:
        calls: list[int] = []
        original = OPERATIONS["start_job_research"]

        async def fake_start_job_research(
            job_id: int,
            runtime_id: str = "codex",
        ) -> dict[str, Any]:
            calls.append(job_id)
            return {
                "run_id": f"research-{job_id}",
                "job_id": job_id,
                "runtime_id": runtime_id,
            }

        async def run() -> tuple[
            dict[str, Any],
            list[dict[str, Any]],
            list[dict[str, Any]],
        ]:
            from app.routes.main_agent import follow_runtime_run_events

            await init_db()
            created = await create_agent_run(
                conversation_id="pi-multi-confirm-test",
                goal="依次确认两个岗位调研",
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
                        "id": "start_job_research:first",
                        "tool": "start_job_research",
                        "args": {"job_id": 81001},
                        "summary": "启动第一个岗位调研",
                        "requires_confirmation": True,
                    },
                    {
                        "id": "start_job_research:second",
                        "tool": "start_job_research",
                        "args": {"job_id": 81002},
                        "summary": "启动第二个岗位调研",
                        "requires_confirmation": True,
                    },
                ],
                llm_runtime={
                    "runtime": "pi_sdk_worker",
                    "stream_protocol": "cursor_v1",
                },
            )
            created["status"] = "waiting_confirmation"
            created["final_result"] = {
                "requires_confirmation": True,
                "turn_finished": True,
            }
            await save_agent_run(created)
            confirmed = await confirm_pi_agent_action(
                created["id"],
                action_id="start_job_research:first",
                worker=FakePiWorker(),
            )
            events = await list_agent_run_events(created["id"])
            response = await follow_runtime_run_events(created["id"])

            async def consume_stream() -> list[dict[str, Any]]:
                items: list[dict[str, Any]] = []
                async for item in response.body_iterator:
                    items.append(item)
                return items

            stream_items = await asyncio.wait_for(consume_stream(), timeout=1)
            return confirmed, events, stream_items

        OPERATIONS["start_job_research"] = replace(
            original,
            fn=fake_start_job_research,
        )
        try:
            confirmed, events, stream_items = asyncio.run(run())
        finally:
            OPERATIONS["start_job_research"] = original

        self.assertEqual(calls, [81001])
        self.assertEqual(confirmed["run"]["status"], "waiting_confirmation")
        self.assertEqual(len(confirmed["pending_actions"]), 1)
        self.assertTrue(confirmed["run"]["final_result"]["turn_finished"])
        self.assertTrue(
            confirmed["run"]["final_result"]["requires_confirmation"]
        )
        turn_finished_events = [
            event for event in events if event["type"] == "run.turn_finished"
        ]
        self.assertEqual(len(turn_finished_events), 1)
        self.assertTrue(
            turn_finished_events[-1]["payload"]["requires_confirmation"]
        )
        self.assertEqual(stream_items[-1]["event"], "message")
        self.assertIn("waiting_confirmation", stream_items[-1]["data"])

    def test_restart_marks_run_interrupted_and_explicitly_resumes_same_session(self) -> None:
        worker = FakePiWorker()

        async def run() -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
            await init_db()
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
                    "runtime": "pi_sdk_worker",
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
            resumed = await resume_pi_agent_run(
                created["id"],
                worker=worker,
                provider_config={
                    "name": "test-provider",
                    "model": "test-model",
                    "base_url": "https://example.invalid/v1",
                    "api_key": "resume-test-secret",
                },
                provider_metadata={
                    "runtime": "pi_sdk_worker",
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
                    "runtime": "pi_sdk_worker",
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
        self.assertEqual(stored["steps"][0]["status"], "executing")
        self.assertIn("automatic replay is forbidden", stored["failure_reason"])
        event_types = {event["type"] for event in events}
        self.assertIn("recovery.reconciliation_required", event_types)
        self.assertIn("run.failed", event_types)


if __name__ == "__main__":
    unittest.main()
