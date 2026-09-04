from __future__ import annotations

import asyncio
import json
import inspect
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = BACKEND_DIR.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.database import Base  # noqa: E402
from app.models.models import Job  # noqa: E402
import app.ops as operation_registry  # noqa: E402
from app.ops import OPERATIONS, execute_operation, get_operation_schema  # noqa: E402
from app.services import automation, capability_plugins, career_tasks, role_intelligence  # noqa: E402
from app.services.agent_bridge.server import BridgeSession  # noqa: E402
from app.services.agent_runtime import (  # noqa: E402
    CANONICAL_AGENT_RUN_EVENT_TYPES,
    PiAgentRuntimeProvider,
    ReplayAgentRunProvider,
    ReplayAgentRuntimeProvider,
    canonical_agent_run_event,
)
from app.services.agent_run_state import create_agent_run, save_agent_run  # noqa: E402
from app.services.harness_operations import save_harness_conversation  # noqa: E402

FIXTURE_PATH = BACKEND_DIR / "tests" / "fixtures" / "role_intelligence_v0" / "corpus.json"


class AgentRuntimeConvergenceTests(unittest.TestCase):
    def test_builtin_provider_status_exposes_live_web_capability_boundary(self) -> None:
        async def flow() -> tuple[dict, dict]:
            pi = await PiAgentRuntimeProvider().status()
            replay = await ReplayAgentRunProvider().status()
            return pi, replay

        with patch(
            "app.services.pi_agent_worker.get_pi_agent_worker",
            return_value=type(
                "ProbeWorker",
                (),
                {"probe": AsyncMock(return_value={"available": True})},
            )(),
        ):
            pi, replay = asyncio.run(flow())

        self.assertFalse(pi["capabilities"]["live_web_search"])
        self.assertFalse(replay["capabilities"]["live_web_search"])

    def test_new_agent_turn_can_create_a_conversation_without_an_id(self) -> None:
        with patch(
            "app.services.harness_operations.save_conversation_messages",
            return_value={"id": "conv_fixture", "messages": []},
        ) as save:
            result = save_harness_conversation(messages=[])

        self.assertEqual(result["id"], "conv_fixture")
        save.assert_called_once_with(conversation_id=None, messages=[])

    def test_registry_executes_sync_operations_without_awaiting_a_dict(self) -> None:
        with patch(
            "app.services.harness_operations.save_conversation_messages",
            return_value={"id": "conv_fixture", "messages": []},
        ) as save:
            result = asyncio.run(
                execute_operation(
                    "save_harness_conversation",
                    {"messages": []},
                    audit=False,
                )
            )

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["outputs"]["id"], "conv_fixture")
        save.assert_called_once_with(conversation_id=None, messages=[])

    def test_main_agent_provider_seam_delegates_to_pi_adapter(self) -> None:
        async def flow() -> dict:
            result = {
                "ok": True,
                "run": {"id": "run_1234567890abcdef", "status": "completed"},
                "assistant_message": "fixture reply",
            }
            with patch(
                "app.services.pi_agent_host.start_pi_agent_run",
                new=AsyncMock(return_value=result),
            ) as start:
                provider = PiAgentRuntimeProvider()
                actual = await provider.start_run(
                    message="hello",
                    skill_id="discovery",
                    conversation_id="conversation-1",
                    task_id="task-1",
                    context_messages=[],
                    requested_run_id="run_1234567890abcdef",
                )
            return {"actual": actual, "call": start.call_args.kwargs}

        result = asyncio.run(flow())
        self.assertEqual(result["actual"]["assistant_message"], "fixture reply")
        self.assertEqual(result["call"]["requested_run_id"], "run_1234567890abcdef")
        self.assertEqual(result["call"]["skill_id"], "discovery")

    def test_provider_events_are_mapped_to_stable_ui_protocol(self) -> None:
        cases = {
            "run.created": "run.started",
            "message.delta": "assistant.delta",
            "runtime.session_started": "reasoning.status",
            "runtime.tool_started": "tool.started",
            "operation.failed": "tool.failed",
            "operation.proposed": "approval.requested",
            "run.turn_finished": "run.completed",
        }
        for raw, expected in cases.items():
            event = canonical_agent_run_event(
                {"type": raw, "payload": {"status": "completed"}}
            )
            self.assertEqual(event["type"], expected, raw)
            self.assertEqual(event["provider_event"], raw)

    def test_replay_main_agent_provider_persists_run_and_streams_result(self) -> None:
        async def flow(database_path: Path) -> tuple[dict, list[dict], list[dict]]:
            engine = create_async_engine(f"sqlite+aiosqlite:///{database_path.as_posix()}")
            session = async_sessionmaker(engine, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                import app.services.agent_run_state as run_state

                streamed: list[dict] = []

                async def listener(event: dict) -> None:
                    streamed.append(event)

                with patch.object(run_state, "async_session", session):
                    provider = ReplayAgentRunProvider()
                    result = await provider.start_run(
                        message="读取我的岗位",
                        skill_id="discovery",
                        conversation_id="replay-conversation",
                        task_id="",
                        context_messages=[],
                        requested_run_id="run_abcdef1234567890",
                        stream_listener=listener,
                    )
                    persisted = await run_state.list_agent_run_events(result["run"]["id"])
                return result, streamed, persisted
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            result, streamed, persisted = asyncio.run(
                flow(Path(directory) / "replay-main-agent.db")
            )
        self.assertTrue(result["ok"])
        self.assertEqual(result["run"]["status"], "completed")
        self.assertIn("Replay Agent", result["assistant_message"])
        self.assertEqual(
            {canonical_agent_run_event(event)["type"] for event in streamed},
            {"run.started", "reasoning.status", "assistant.delta", "run.completed"},
        )
        self.assertTrue(any(event["type"] == "assistant.delta" for event in persisted))

    def test_replay_main_agent_resume_completes_the_same_persisted_run(self) -> None:
        async def flow(database_path: Path) -> tuple[dict, dict, list[dict]]:
            engine = create_async_engine(f"sqlite+aiosqlite:///{database_path.as_posix()}")
            session = async_sessionmaker(engine, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                import app.services.agent_run_state as run_state

                with patch.object(run_state, "async_session", session):
                    created = await create_agent_run(
                        conversation_id="resume-conversation",
                        goal="恢复一个持久化任务",
                        mode="general",
                        skill_id="discovery",
                        actions=[],
                        llm_runtime={
                            "runtime": "offeru_replay",
                            "provider_id": "replay",
                            "stream_protocol": "cursor_v1",
                            "status": "running",
                        },
                        run_id="run_1234567890abcdef",
                    )
                    created["status"] = "interrupted"
                    interrupted = await save_agent_run(created)
                    resumed = await ReplayAgentRunProvider().resume_run(interrupted["id"])
                    events = await run_state.list_agent_run_events(interrupted["id"])
                return interrupted, resumed, events
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            interrupted, resumed, events = asyncio.run(
                flow(Path(directory) / "resume-main-agent.db")
            )
        self.assertEqual(interrupted["id"], resumed["run"]["id"])
        self.assertEqual(resumed["run"]["status"], "completed")
        self.assertIn("从持久化 Run 恢复", resumed["assistant_message"])
        self.assertEqual(
            [event["type"] for event in events][-3:],
            ["executor.resumed", "assistant.delta", "run.completed"],
        )

    def test_replay_runtime_exposes_thread_turn_event_contract(self) -> None:
        async def flow() -> dict:
            provider = ReplayAgentRuntimeProvider(output={"answer": "fixture"})
            started = await provider.start()
            thread = await provider.create_thread(cwd="", tool_descriptions=["offeru"])
            turn = await provider.start_turn(prompt="run fixture", cwd="")
            events = await provider.events()
            result = await provider.result()
            stopped = await provider.shutdown()
            restarted = await provider.restart()
            lifecycle = await provider.events()
            return {
                "started": started,
                "thread": thread,
                "turn": turn,
                "result": result,
                "events": events,
                "stopped": stopped,
                "restarted": restarted,
                "lifecycle": lifecycle,
            }

        result = asyncio.run(flow())
        self.assertEqual(result["started"]["status"], "ready")
        self.assertTrue(result["thread"]["thread_id"].startswith("replay_thread_"))
        self.assertTrue(result["turn"]["turn_id"].startswith("replay_turn_"))
        self.assertEqual(result["turn"]["structured"], {"answer": "fixture"})
        self.assertEqual(result["result"]["structured"], {"answer": "fixture"})
        self.assertEqual(result["events"]["next"], 4)
        self.assertEqual(result["stopped"]["status"], "stopped")
        self.assertEqual(result["restarted"]["status"], "ready")
        self.assertEqual(result["lifecycle"]["next"], 7)

    def test_replay_runtime_covers_stream_tool_approval_cancel_failure_and_resume_contract(self) -> None:
        async def flow() -> dict:
            provider = ReplayAgentRuntimeProvider(output={"answer": "fixture"})
            started = await provider.start()
            thread = await provider.create_thread(cwd="", tool_descriptions=["get_job"])
            turn = await provider.start_turn(prompt="run fixture", cwd="")
            streamed = await provider.events(after=0)
            incremental = await provider.events(after=1)
            approved = await provider.approve(action_id="fixture-action")
            rejected = await provider.reject(action_id="fixture-action")
            cancelled = await provider.cancel()
            resumed = await provider.resume_turn(prompt="resume fixture", cwd="")
            result = await provider.result()
            stopped = await provider.shutdown()
            restarted = await provider.restart()
            return {
                "started": started,
                "thread": thread,
                "turn": turn,
                "streamed": streamed,
                "incremental": incremental,
                "approved": approved,
                "rejected": rejected,
                "cancelled": cancelled,
                "resumed": resumed,
                "result": result,
                "stopped": stopped,
                "restarted": restarted,
            }

        result = asyncio.run(flow())
        self.assertEqual(result["started"]["status"], "ready")
        self.assertTrue(result["thread"]["thread_id"].startswith("replay_thread_"))
        self.assertEqual(result["turn"]["structured"], {"answer": "fixture"})
        self.assertGreaterEqual(result["streamed"]["next"], 4)
        self.assertLessEqual(result["incremental"]["next"], result["streamed"]["next"])
        self.assertFalse(result["approved"]["approved"])
        self.assertTrue(result["rejected"]["rejected"])
        self.assertTrue(result["cancelled"]["cancelled"])
        self.assertEqual(result["resumed"]["structured"], {"answer": "fixture"})
        self.assertEqual(result["result"]["structured"], {"answer": "fixture"})
        self.assertEqual(result["stopped"]["status"], "stopped")
        self.assertEqual(result["restarted"]["status"], "ready")

        for event_type in CANONICAL_AGENT_RUN_EVENT_TYPES:
            canonical = canonical_agent_run_event({"type": event_type, "payload": {}})
            self.assertEqual(canonical["type"], event_type)
        self.assertEqual(
            canonical_agent_run_event({"type": "run.turn_finished", "payload": {"status": "failed"}})["type"],
            "run.failed",
        )
        self.assertEqual(
            canonical_agent_run_event({"type": "runtime.blocked", "payload": {}})["type"],
            "run.blocked",
        )
        self.assertEqual(
            canonical_agent_run_event({"type": "unknown.provider.event", "payload": {}})["type"],
            "reasoning.status",
        )

    def test_career_task_persists_and_reuses_idempotent_replay(self) -> None:
        async def flow(database_path: Path) -> tuple[dict, dict, dict]:
            engine = create_async_engine(f"sqlite+aiosqlite:///{database_path.as_posix()}")
            session = async_sessionmaker(engine, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                with (
                    patch.object(career_tasks, "async_session", session),
                    patch.object(operation_registry, "async_session", session),
                ):
                    first_envelope = await operation_registry.execute_operation(
                        "start_career_task",
                        {
                            "task_type": "agent_turn",
                            "source": "test",
                            "runtime_provider": "replay",
                            "input": {"prompt": "fixture task"},
                            "idempotency_key": "test:career-task:1",
                        },
                        surface="career_task_runtime",
                    )
                    self.assertTrue(first_envelope["ok"], first_envelope)
                    first = first_envelope["outputs"]
                    worker = career_tasks._LIVE_TASKS.get(first["task_id"])
                    if worker is not None:
                        await worker
                    else:
                        # Replay tasks can finish between the operation
                        # response and this inspection.  The durable row is
                        # the lifecycle contract; do not make the test depend
                        # on the private in-memory handle still being present.
                        for _ in range(20):
                            current = await career_tasks.get_career_task(first["task_id"])
                            if current["status"] in career_tasks.TERMINAL_STATUSES:
                                break
                            await asyncio.sleep(0)
                    loaded = await career_tasks.get_career_task(first["task_id"])
                    replay_envelope = await operation_registry.execute_operation(
                        "start_career_task",
                        {
                            "task_type": "agent_turn",
                            "source": "test",
                            "runtime_provider": "replay",
                            "input": {"prompt": "fixture task"},
                            "idempotency_key": "test:career-task:1",
                        },
                        surface="career_task_runtime",
                    )
                    self.assertTrue(replay_envelope["ok"], replay_envelope)
                    replay = replay_envelope["outputs"]
                    events = await career_tasks.list_career_task_events(first["task_id"])
                    return first, loaded, {"replay": replay, "events": events}
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            first, loaded, extra = asyncio.run(flow(Path(directory) / "career-task.db"))
        self.assertTrue(first["scheduled"])
        self.assertEqual(loaded["status"], "completed")
        self.assertEqual(loaded["result"]["structured"], {"response": "fixture task"})
        self.assertTrue(extra["replay"]["reused"])
        self.assertGreaterEqual(len(extra["events"]["events"]), 4)

    def test_fixture_plugin_install_discover_invoke_uninstall(self) -> None:
        async def invoke(state_path: Path) -> dict:
            return await capability_plugins.invoke_plugin_capability(
                "boss-fixture",
                "jobs.search",
                {"target_job_id": 50},
                root=PROJECT_ROOT / "plugins",
                state_path=state_path,
            )

        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "installed.json"
            before = capability_plugins.discover_plugins(
                root=PROJECT_ROOT / "plugins", state_path=state_path
            )
            self.assertFalse(before["installed"])
            installed = capability_plugins.install_plugin(
                "boss-fixture",
                root=PROJECT_ROOT / "plugins",
                state_path=state_path,
            )
            self.assertTrue(installed["installed"])
            after = capability_plugins.discover_plugins(
                root=PROJECT_ROOT / "plugins", state_path=state_path
            )
            self.assertEqual(after["installed"], ["boss-fixture"])
            result = asyncio.run(invoke(state_path))
            self.assertEqual(result["capability"], "jobs.search")
            self.assertEqual(len(result["output"]["comparators"]), 20)
            skills = capability_plugins.plugin_skill_catalog(
                root=PROJECT_ROOT / "plugins", state_path=state_path
            )
            self.assertEqual(len(skills), 1)
            self.assertIn("invoke_plugin_capability", skills[0].allowed_tools)
            manifest = after["plugins"][0]
            self.assertEqual(manifest["skill_entry"], "skills")
            self.assertEqual(manifest["executable"]["command"], "python")
            self.assertEqual(manifest["health_check"]["capability"], "jobs.search")
            self.assertEqual(
                manifest["capabilities"][0]["input_contract"]["type"],
                "object",
            )
            removed = capability_plugins.uninstall_plugin("boss-fixture", state_path=state_path)
            self.assertFalse(removed["files_deleted"])
            self.assertEqual(
                capability_plugins.discover_plugins(
                    root=PROJECT_ROOT / "plugins", state_path=state_path
                )["installed"],
                [],
            )

    def test_role_provider_calls_plugin_through_operation_registry(self) -> None:
        async def flow(database_path: Path, state_path: Path) -> dict:
            engine = create_async_engine(f"sqlite+aiosqlite:///{database_path.as_posix()}")
            session = async_sessionmaker(engine, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                job = Job(id=50, title="AIGC Product Manager", company="Fixture Co", hash_key="role-plugin-job")
                request = role_intelligence.RoleCollectionRequest(
                    job=job,
                    cohort={},
                    run_id="plugin-role-test",
                    runtime_id="boss-fixture",
                    cwd=Path(directory_placeholder),
                )
                with (
                    patch.object(capability_plugins, "PLUGIN_STATE_PATH", state_path),
                    patch.object(operation_registry, "async_session", session),
                ):
                    return await role_intelligence.PluginRoleCollectionProvider("boss-fixture").collect(request)
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "installed.json"
            capability_plugins.install_plugin(
                "boss-fixture",
                root=PROJECT_ROOT / "plugins",
                state_path=state_path,
            )
            directory_placeholder = directory
            result = asyncio.run(flow(Path(directory) / "role-plugin.db", state_path))
        self.assertEqual(result["trace"]["operation"], "invoke_plugin_capability")
        self.assertEqual(len(result["structured"]["comparators"]), 20)

    def test_role_benchmark_persists_plugin_corpus_and_runtime_delta(self) -> None:
        async def flow(database_path: Path, state_path: Path) -> dict:
            engine = create_async_engine(f"sqlite+aiosqlite:///{database_path.as_posix()}")
            session = async_sessionmaker(engine, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
                target = fixture["target"]
                async with session() as db:
                    job = Job(
                        title=target["title"],
                        company=target["company"],
                        location=target.get("location", ""),
                        url=target.get("url", ""),
                        source="boss-fixture",
                        raw_description=target["raw_description"],
                        hash_key="boss-fixture-role-target",
                    )
                    db.add(job)
                    await db.commit()
                    await db.refresh(job)
                with (
                    patch.object(capability_plugins, "PLUGIN_STATE_PATH", state_path),
                    patch.object(role_intelligence, "async_session", session),
                    patch.object(operation_registry, "async_session", session),
                ):
                    build = await role_intelligence.build_role_benchmark(
                        job_id=job.id,
                        runtime_id="boss-fixture",
                    )
                    worker = role_intelligence._LIVE_TASKS.get(build["run_id"])
                    self.assertIsNotNone(worker)
                    assert worker is not None
                    await worker
                    return await role_intelligence.get_role_benchmark(run_id=build["run_id"])
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "installed.json"
            capability_plugins.install_plugin(
                "boss-fixture",
                root=PROJECT_ROOT / "plugins",
                state_path=state_path,
            )
            result = asyncio.run(flow(Path(directory) / "role-plugin-benchmark.db", state_path))
        self.assertEqual(result["status"], "completed", result)
        self.assertEqual(result["data_mode"], "fixture_plugin")
        self.assertEqual(result["valid_sample_count"], 20)
        self.assertEqual(len(result["signals"]), 5)

    def test_runtime_and_plugin_operations_are_registered(self) -> None:
        expected = {
            "start_career_task",
            "get_career_task",
            "list_career_tasks",
            "list_career_task_events",
            "get_career_task_result",
            "delegate_career_task",
            "list_agent_provider_health",
            "list_capability_plugins",
            "install_capability_plugin",
            "invoke_plugin_capability",
            "uninstall_capability_plugin",
            "delete_jobs_batch",
            "record_automation_event",
            "list_automation_events",
            "list_automation_inbox",
            "list_automation_rules",
            "resolve_automation_inbox_item",
        }
        self.assertTrue(expected.issubset(OPERATIONS))
        self.assertFalse(get_operation_schema("invoke_plugin_capability")["requires_confirmation"])
        self.assertTrue(get_operation_schema("delegate_career_task")["requires_confirmation"])
        self.assertNotIn("execute_deep_task", inspect.getsource(BridgeSession._workspace_delegate))

    def test_batch_job_delete_uses_registry_and_protects_non_ignored_jobs(self) -> None:
        async def flow(database_path: Path) -> tuple[dict, dict, int | None, int | None]:
            engine = create_async_engine(f"sqlite+aiosqlite:///{database_path.as_posix()}")
            session = async_sessionmaker(engine, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                with patch.object(operation_registry, "async_session", session):
                    async with session() as db:
                        ignored = Job(
                            title="Ignored job",
                            company="Fixture Co",
                            hash_key="batch-delete-ignored",
                            triage_status="ignored",
                        )
                        inbox = Job(
                            title="Inbox job",
                            company="Fixture Co",
                            hash_key="batch-delete-inbox",
                            triage_status="inbox",
                        )
                        db.add_all([ignored, inbox])
                        await db.commit()
                        await db.refresh(ignored)
                        await db.refresh(inbox)
                        ignored_id, inbox_id = ignored.id, inbox.id

                    deleted = await operation_registry.execute_operation(
                        "delete_jobs_batch",
                        {"job_ids": [ignored_id]},
                        surface="ui",
                    )
                    protected = await operation_registry.execute_operation(
                        "delete_jobs_batch",
                        {"job_ids": [inbox_id]},
                        surface="ui",
                    )
                    async with session() as db:
                        deleted_row = await db.get(Job, ignored_id)
                        protected_row = await db.get(Job, inbox_id)
                    return deleted, protected, deleted_row.id if deleted_row else None, protected_row.id if protected_row else None
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            deleted, protected, deleted_id, protected_id = asyncio.run(
                flow(Path(directory) / "batch-delete.db")
            )
        self.assertTrue(deleted["ok"], deleted)
        self.assertEqual(deleted["outputs"]["deleted"], 1)
        self.assertFalse(protected["ok"], protected)
        self.assertIn("only ignored jobs", protected["errors"][0])
        self.assertIsNone(deleted_id)
        self.assertEqual(protected_id, protected["inputs"]["job_ids"][0])

    def test_job_saved_automation_creates_task_and_focus_inbox(self) -> None:
        async def flow(database_path: Path, state_path: Path) -> dict:
            engine = create_async_engine(f"sqlite+aiosqlite:///{database_path.as_posix()}")
            session = async_sessionmaker(engine, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
                target = fixture["target"]
                async with session() as db:
                    job = Job(
                        title=target["title"],
                        company=target["company"],
                        location=target.get("location", ""),
                        url=target.get("url", ""),
                        source="boss-fixture",
                        raw_description=target["raw_description"],
                        hash_key="automation-role-target",
                    )
                    db.add(job)
                    await db.commit()
                    await db.refresh(job)
                with (
                    patch.object(capability_plugins, "PLUGIN_STATE_PATH", state_path),
                    patch.object(automation, "async_session", session),
                    patch.object(career_tasks, "async_session", session),
                    patch.object(role_intelligence, "async_session", session),
                    patch.object(operation_registry, "async_session", session),
                ):
                    envelope = await operation_registry.execute_operation(
                        "record_automation_event",
                        {
                            "event_type": "JOB_SAVED",
                            "source": "test",
                            "target_type": "job",
                            "target_id": str(job.id),
                            "payload": {"job_id": job.id, "runtime_provider": "boss-fixture"},
                            "dedupe_key": "automation:test:job-saved:1",
                        },
                        surface="automation",
                    )
                    self.assertTrue(envelope["ok"], envelope)
                    event = envelope["outputs"]
                    task_id = event["result"]["task"]["task_id"]
                    worker = career_tasks._LIVE_TASKS.get(task_id)
                    self.assertIsNotNone(worker)
                    assert worker is not None
                    await worker
                    task = await career_tasks.get_career_task(task_id)
                    inbox = await automation.list_automation_inbox()
                    events = await automation.list_automation_events()
                    return {"task": task, "inbox": inbox, "events": events}
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "installed.json"
            capability_plugins.install_plugin(
                "boss-fixture",
                root=PROJECT_ROOT / "plugins",
                state_path=state_path,
            )
            result = asyncio.run(flow(Path(directory) / "automation.db", state_path))
        self.assertEqual(result["task"]["status"], "completed", result)
        self.assertEqual(result["inbox"]["items"][0]["category"], "needs_review")
        payload = result["inbox"]["items"][0]["payload"]
        self.assertNotIn("preview", payload)
        self.assertTrue(
            payload["interview_focus_plan"]["focuses"]
        )
        packet = payload["application_packet"]
        self.assertEqual(packet["status"], "partial")
        self.assertEqual(packet["resume_candidate"]["status"], "blocked")
        self.assertEqual(result["events"]["events"][0]["status"], "completed")


if __name__ == "__main__":
    unittest.main()
