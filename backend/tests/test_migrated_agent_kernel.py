"""Contract tests for the actual migrated loop; scripted streams are fixtures, not live Agent evidence."""
from __future__ import annotations

import asyncio
import json
import sys
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent.provider import LlmStreamProvider, ScriptedStreamProvider
from app.agent.types import TextContent, ToolCallContent
from app.agent.messages import create_text_message
from app.database import init_db
from app.ops import OPERATIONS
from app.services import embedded_agent_host as host
from app.services.agent_run_state import create_agent_run, list_agent_run_events, load_agent_run, save_agent_run
from app.services.embedded_agent_worker import EmbeddedAgentWorker, EmbeddedAgentWorkerError

RUN_ID = "run_0123456789abcdef"


def test_provider_masks_remote_pii_and_restores_local_tool_arguments():
    async def flow():
        async def create(**kwargs):
            encoded = json.dumps(kwargs["messages"])
            assert "13912345678" not in encoded
            assert "fixture@example.test" not in encoded
            import re
            placeholder = re.search(r"\[__PII_EMAIL_[^\]]+\]", encoded)[0]
            async def chunks():
                yield {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_pii", "function": {
                    "name": "read_contact", "arguments": json.dumps({"email": placeholder})}}]}}]}
            return chunks()
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=AsyncMock(side_effect=create))), close=AsyncMock())
        provider = LlmStreamProvider(client_factory=lambda: (client, "fixture-model"))
        with patch("app.agent.provider.resolve_llm_client_config", return_value={"provider": "fixture", "api_format": "openai"}), patch("app.agent.provider.configured_model_for_tier", return_value="fixture-model"):
            events = [event async for event in provider.stream("", [create_text_message("13912345678 fixture@example.test")], [])]
        call = next(block for block in events[-1].message.content if isinstance(block, ToolCallContent))
        assert call.arguments == {"email": "fixture@example.test"}
        assert "fixture@example.test" not in json.dumps([event.delta for event in events])
        await provider.close()
        client.close.assert_awaited_once()
    asyncio.run(flow())


def test_native_anthropic_fragments_and_provider_error_fail_closed():
    async def flow():
        class Stream:
            def __init__(self, events): self.events, self.closed = events, False
            async def __aiter__(self):
                for event in self.events: yield event
            async def close(self): self.closed = True
        stream = Stream([
            {"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "native_call", "name": "read_job"}},
            {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": '{"job_id":'}},
            {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": '7}'}},
            {"type": "message_delta", "delta": {"stop_reason": "tool_use"}},
        ])
        client = SimpleNamespace(messages=SimpleNamespace(create=AsyncMock(return_value=stream)))
        provider = LlmStreamProvider()
        events = [event async for event in provider.stream_chunks(provider._anthropic_chunks(client, "fixture", [{"role": "user", "content": "Read job"}], []), "fixture", "fixture")]
        assert stream.closed
        assert events[-1].message.stop_reason == "tool_calls"
        call = next(block for block in events[-1].message.content if isinstance(block, ToolCallContent))
        assert call.id == "native_call" and call.arguments == {"job_id": 7}
        failed = Stream([{"type": "error", "error": {"message": "provider failed sk-fixture123456789"}}])
        client.messages.create.return_value = failed
        events = [event async for event in provider.stream_chunks(provider._anthropic_chunks(client, "fixture", [], []), "fixture", "fixture")]
        assert failed.closed and events[-1].type == "error"
        assert "sk-fixture123456789" not in events[-1].message.error_message
    asyncio.run(flow())


class SequenceProvider:
    def __init__(self, scripts):
        self.scripts = scripts
        self.calls = 0

    async def stream(self, system_prompt, messages, tools, cancel=None):
        self.calls += 1
        script = self.scripts.pop(0)
        async for event in ScriptedStreamProvider(script).stream(system_prompt, messages, tools, cancel=cancel):
            yield event

    async def close(self):
        pass


def start(worker, directory, runner, **kwargs):
    return worker.start_run(run_id=RUN_ID, system_prompt="Only Registry tools may be used.", provider={},
        session_directory=str(directory), operation_runner=runner, allowed_operations=[
            {"name": "read_job", "input_schema": {"type": "object", "properties": {"job_id": {"type": "integer"}}}}
        ], **kwargs)


def test_source_loop_selects_registry_tools_and_persists_session(tmp_path):
    async def flow():
        provider = SequenceProvider([[{"type": "tool_call", "name": "read_job", "arguments": {"job_id": 7}}],
                                     [{"type": "text", "text": "Job 7 verified."}]])
        worker = EmbeddedAgentWorker(provider_factory=lambda: provider)
        runner = AsyncMock(return_value={"ok": True, "outputs": {"id": 7}})
        events = []
        async def emit(event): events.append(event)
        await start(worker, tmp_path, runner, event_listener=emit)
        result = await worker.prompt(run_id=RUN_ID, message="Read job 7")
        assert result["assistant_message"] == "Job 7 verified."
        runner.assert_awaited_once_with("read_job", {"job_id": 7})
        assert any(event["event"] == "tool.started" for event in events)
        stored = json.loads((tmp_path / f"{RUN_ID}.json").read_text())
        assert stored["messages"][-1]["content"][0]["text"] == "Job 7 verified."
        assert "api_key" not in stored
        await worker.dispose_run(RUN_ID)
        resumed = EmbeddedAgentWorker(provider_factory=lambda: SequenceProvider([[{"type": "text", "text": "Resumed."}]]))
        await start(resumed, tmp_path, runner, session_file=str(tmp_path / f"{RUN_ID}.json"))
        assert (await resumed.prompt(run_id=RUN_ID, message="Continue"))["assistant_message"] == "Resumed."
        await resumed.close()
    asyncio.run(flow())


def test_unknown_model_tool_cannot_reach_registry(tmp_path):
    async def flow():
        provider = SequenceProvider([[{"type": "tool_call", "name": "hidden_shell", "arguments": {}}],
                                     [{"type": "text", "text": "Unavailable."}]])
        worker = EmbeddedAgentWorker(provider_factory=lambda: provider)
        runner = AsyncMock()
        await start(worker, tmp_path, runner)
        await worker.prompt(run_id=RUN_ID, message="Do something")
        runner.assert_not_awaited()
        await worker.close()
    asyncio.run(flow())


def test_session_path_and_version_fail_closed(tmp_path):
    async def flow():
        worker = EmbeddedAgentWorker()
        with pytest.raises(EmbeddedAgentWorkerError, match="runtime directory"):
            await start(worker, tmp_path, AsyncMock(), session_file=str(tmp_path.parent / f"{RUN_ID}.json"))
        path = tmp_path / f"{RUN_ID}.json"
        path.write_text(json.dumps({"version": 999, "run_id": RUN_ID, "messages": []}))
        with pytest.raises(EmbeddedAgentWorkerError, match="version/identity"):
            await start(worker, tmp_path, AsyncMock(), session_file=str(path))
        assert worker.active_run_id is None
    asyncio.run(flow())


def test_legacy_pi_run_is_preserved_and_cannot_be_replayed(tmp_path):
    async def flow():
        await init_db()
        legacy = tmp_path / "old-pi-session.jsonl"
        legacy.write_text('{"legacy":true}\n', encoding="utf-8")
        run = await create_agent_run(conversation_id="legacy-fixture", goal="Read jobs", mode="general", actions=[],
            llm_runtime={"runtime": "pi_sdk_worker", "session_file": str(legacy)})
        run["status"] = "interrupted"
        await save_agent_run(run)
        worker = EmbeddedAgentWorker()
        with pytest.raises(ValueError, match="旧 Pi 会话"):
            await host.resume_embedded_agent_run(run["id"], worker=worker)
        assert legacy.read_text(encoding="utf-8") == '{"legacy":true}\n'
        assert (await load_agent_run(run["id"]))["status"] == "interrupted"
        assert worker.active_run_id is None
    asyncio.run(flow())


def test_cancel_interrupts_a_stalled_provider(tmp_path):
    async def flow():
        ready = asyncio.Event()
        class StalledProvider:
            async def stream(self, *args, **kwargs):
                ready.set()
                await asyncio.Future()
                yield
        worker = EmbeddedAgentWorker(provider_factory=StalledProvider)
        await start(worker, tmp_path, AsyncMock())
        task = asyncio.create_task(worker.prompt(run_id=RUN_ID, message="Wait"))
        await ready.wait()
        await worker.abort_run(RUN_ID)
        assert task.cancelled()
        await worker.dispose_run(RUN_ID)
        assert worker.active_run_id is None
    asyncio.run(flow())


def test_provider_assembles_fragmented_calls_and_reports_stream_failure():
    async def flow():
        chunks = [{"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call-1", "function": {"name": "read_job", "arguments": '{"job_'}}]}}]},
                  {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": 'id":7}'}}]}, "finish_reason": "tool_calls"}]}]
        events = [event async for event in LlmStreamProvider().stream_chunks(chunks, provider="fixture", model="fixture")]
        call = next(block for block in events[-1].message.content if isinstance(block, ToolCallContent))
        assert call.arguments == {"job_id": 7}
        async def failed():
            yield {"choices": [{"delta": {"content": "partial"}}]}
            raise RuntimeError("api_key=canary-secret-value")
        errors = [event async for event in LlmStreamProvider().stream_chunks(failed(), provider="fixture", model="fixture")]
        assert errors[-1].type == "error"
        assert "canary-secret-value" not in errors[-1].message.error_message
    asyncio.run(flow())


@pytest.mark.parametrize("continuation_start_fails", [False, True])
def test_source_kernel_proposes_then_continues_in_same_run_after_independent_confirmation(tmp_path, continuation_start_fails):
    async def flow():
        await init_db()
        scripts = [[{"type": "tool_call", "name": "start_job_research", "arguments": {"job_id": 7}}],
                   [{"type": "text", "text": "Prepared. Awaiting independent confirmation."}],
                   [{"type": "text", "text": "The approved research receipt was verified."}]]
        provider = SequenceProvider(scripts)
        worker = EmbeddedAgentWorker(provider_factory=lambda: provider)
        execute = AsyncMock(return_value={"job_id": 7, "run_id": "fixture-research"})
        config = ({"name": "fixture", "model": "fixture"}, {"runtime": "python_agent", "provider_id": "embedded"})
        with patch.object(host, "_SESSION_DIRECTORY", tmp_path), patch.object(host, "_prepare_guardian_advice",
                new=AsyncMock(return_value=({}, None))), patch.object(host, "resolve_embedded_provider_config",
                return_value=config, side_effect=ValueError("Model configuration unavailable") if continuation_start_fails else None), patch.dict(OPERATIONS, {"start_job_research": replace(OPERATIONS["start_job_research"], fn=execute)}):
            initial = await host.start_embedded_agent_run(message="Research job 7", skill_id="company_research", worker=worker,
                provider_config={"name": "fixture", "model": "fixture"})
            assert initial["ok"], initial
            assert initial["run"]["status"] == "waiting_confirmation"
            execute.assert_not_awaited()
            action = initial["pending_actions"][0]["id"]
            confirmed = await host.confirm_embedded_agent_action(initial["run"]["id"], action_id=action, worker=worker)
            assert confirmed["ok"], confirmed
            assert confirmed["continuation"]["ok"] is not continuation_start_fails
            assert confirmed["run"]["id"] == initial["run"]["id"]
            if continuation_start_fails:
                assert confirmed["warnings"]
            else:
                assert confirmed["continuation"]["assistant_message"] == "The approved research receipt was verified."
            duplicate = await host.confirm_embedded_agent_action(initial["run"]["id"], action_id=action, worker=worker)
            assert duplicate["ok"] is not continuation_start_fails
            execute.assert_awaited_once()
            assert provider.calls == (2 if continuation_start_fails else 3)
            events = await list_agent_run_events(initial["run"]["id"])
            assert any(event["type"] == "continuation.requested" for event in events)
            assert (await load_agent_run(initial["run"]["id"]))["status"] == ("failed" if continuation_start_fails else "completed")
        await worker.close()
    asyncio.run(flow())
