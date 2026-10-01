from __future__ import annotations

import asyncio
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.database import Base
from app.models.models import CareerTask, JobSearchTask
from app.services import agent_run_state, codex_run, pi_agent_host
from app.routes import main_agent


def test_canonical_task_binding_keeps_one_identity() -> None:
    async def flow(path: Path):
        engine = create_async_engine(f"sqlite+aiosqlite:///{path.as_posix()}")
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with engine.begin() as db:
                await db.run_sync(Base.metadata.create_all)
            async with sessions() as db:
                db.add(CareerTask(task_id="career_existing", task_type="agent_turn", source="ui", runtime_provider="codex", idempotency_key="existing", status="running"))
                await db.commit()
            with patch.object(agent_run_state, "async_session", sessions):
                run = await agent_run_state.create_agent_run(conversation_id="conv", task_id="career_existing", goal="read current job", mode="general", actions=[], llm_runtime={"provider_id": "codex"})
                assert run["task_id"] == "career_existing"
                content = "Evidence and unknowns\n" * 100 + "Contact: review@example.org"
                await agent_run_state.propose_agent_run_action(run["id"], operation="save_career_artifact",
                    args={"content_markdown": content, "related_job_id": 9001, "api_key": "never-store-this"}, summary="review full draft")
                loaded = await agent_run_state.load_agent_run(run["id"])
                await agent_run_state.save_agent_run(loaded)
                loaded = await agent_run_state.load_agent_run(run["id"])
                assert loaded["steps"][0]["args"]["content_markdown"] == content
                assert loaded["steps"][0]["args"]["api_key"] == "[redacted]"
                again = await agent_run_state.create_agent_run(conversation_id="conv", task_id="career_existing", goal="read current job", mode="general", actions=[])
                assert again["task_id"] == run["task_id"]
            async with sessions() as db:
                assert len((await db.execute(select(CareerTask))).scalars().all()) == 1
                mirrors = (await db.execute(select(JobSearchTask))).scalars().all()
                assert len(mirrors) == 1 and mirrors[0].task_id == "career_existing"
        finally:
            await engine.dispose()
    with TemporaryDirectory() as directory:
        asyncio.run(flow(Path(directory) / "canonical.db"))


def test_stale_page_is_rejected_before_executor_start() -> None:
    async def flow():
        request = main_agent.PiAgentRunRequest(message="prepare", skill_id="evaluate_job", runtime_provider="codex", context_version=1)
        with patch.object(main_agent, "_ui_operation_outputs", AsyncMock(return_value={"version": 2, "entity_id": "new-job"})), \
             patch.object(main_agent, "_main_agent_provider") as provider:
            with pytest.raises(HTTPException) as exc:
                await main_agent.start_runtime_run(request)
            assert exc.value.status_code == 409
            provider.assert_not_called()
    asyncio.run(flow())


@pytest.mark.parametrize("cancel_confirmed", [True, False])
def test_disconnected_native_turn_preserves_recovery_boundary(cancel_confirmed) -> None:
    async def flow(path):
        engine = create_async_engine(f"sqlite+aiosqlite:///{path.as_posix()}")
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        worker = AsyncMock()
        worker.active_run_id = ""
        async def start(**kwargs):
            worker.active_run_id = kwargs["run_id"]
            return {"session_id": "native", "session_file": "native"}
        worker.start_run.side_effect = start
        worker.prompt.side_effect = asyncio.CancelledError()
        if not cancel_confirmed:
            worker.abort_run.side_effect = RuntimeError("cancel acknowledgement missing")
        try:
            async with engine.begin() as db:
                await db.run_sync(Base.metadata.create_all)
            with patch.object(agent_run_state, "async_session", sessions), \
                 patch.object(pi_agent_host, "_prepare_guardian_advice", AsyncMock(return_value=({}, None))):
                with pytest.raises(asyncio.CancelledError):
                    await pi_agent_host.start_pi_agent_run(message="read current job", conversation_id="cancel", skill_id="evaluate_job",
                        requested_run_id="run_aaaaaaaaaaaaaaaa", worker=worker, provider_config={},
                        provider_metadata={"provider_id": "codex", "runtime": "codex_app_server"})
                run = await agent_run_state.load_agent_run("run_aaaaaaaaaaaaaaaa")
                assert run["status"] == ("interrupted" if cancel_confirmed else "needs_reconciliation")
                assert run["llm_runtime"]["session_file"] == "native"
                assert not run["steps"]
                worker.abort_run.assert_awaited_once()
                worker.dispose_run.assert_awaited_once()
        finally:
            await engine.dispose()
    with TemporaryDirectory() as directory:
        asyncio.run(flow(Path(directory) / "cancel.db"))


def test_native_worker_cannot_self_confirm_or_switch_thread_on_resume() -> None:
    async def flow():
        adapter = AsyncMock()
        adapter.events = lambda: []
        adapter.thread_params = {"config": {}}
        adapter.server_info = {}
        adapter.create_thread.return_value = {"threadId": "native-thread", "model": "native-model"}
        worker = codex_run.CodexOperationWorker()
        with TemporaryDirectory() as directory, patch.object(codex_run, "CodexMainLoopAdapter", return_value=adapter):
            worker.workspace = Path(directory)
            operation = AsyncMock(return_value={"executed": False, "requires_confirmation": True})
            await worker.start_run(run_id="run", system_prompt="test", allowed_operations=[{"name": "save_career_artifact"}], operation_runner=operation)
            with pytest.raises(ValueError):
                await adapter.on_operation("offeru_operation", {"operation": "confirm_operation_proposal", "arguments": {}})
            operation.assert_not_awaited()
            proposed = await adapter.on_operation("offeru_operation", {"operation": "save_career_artifact", "arguments": {"title": "draft"}})
            assert proposed["executed"] is False
            await worker.dispose_run("run")
            adapter._request.return_value = {"thread": {"id": "different-thread"}}
            adapter.create_thread.reset_mock()
            with pytest.raises(ValueError):
                await worker.start_run(run_id="run", system_prompt="test", allowed_operations=[{"name": "save_career_artifact"}], operation_runner=operation, session_file="native-thread")
            adapter.create_thread.assert_not_awaited()
            assert worker.active_run_id is None
    asyncio.run(flow())
