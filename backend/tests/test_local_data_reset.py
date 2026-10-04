from __future__ import annotations

import asyncio
import builtins
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy.engine import make_url

from app.services import local_data_reset
from app.services.data_safety import DataSafetyError, DataSafetyLayout


def test_reset_clears_python_agent_sessions(tmp_path: Path, monkeypatch) -> None:
    """Fresh reset must not leave an embedded Agent session recoverable."""
    offeru_root = tmp_path / "offeru-data"
    offeru_root.mkdir()
    data_root = offeru_root / "data"
    sessions = data_root / "python_agent_sessions"
    sessions.mkdir(parents=True)
    canary = sessions / "run_oldcareer12345678.json"
    canary.write_text(json.dumps({"profile": "old synthetic profile"}), encoding="utf-8")
    (offeru_root / "uploads").mkdir()
    config = offeru_root / "config.json"
    config.write_text('{"credential_ref":"synthetic-ref"}', encoding="utf-8")
    external_root = tmp_path / "external-canaries"
    external_root.mkdir()
    external_resume = external_root / "source-resume.txt"
    external_resume.write_text("synthetic external resume", encoding="utf-8")
    external_memory = external_root / "external-agent-memory.md"
    external_memory.write_text("synthetic external memory", encoding="utf-8")
    monkeypatch.setenv("OFFERU_DATA_DIR", str(offeru_root))
    assert local_data_reset._managed_root() == offeru_root.resolve()

    result = local_data_reset._reset_runtime_files()

    assert list(sessions.iterdir()) == []
    assert result["directories"]["data/python_agent_sessions"] == 1
    assert config.read_text(encoding="utf-8") == '{"credential_ref":"synthetic-ref"}'
    assert external_resume.read_text(encoding="utf-8") == "synthetic external resume"
    assert external_memory.read_text(encoding="utf-8") == "synthetic external memory"

    repeated = local_data_reset._reset_runtime_files()
    assert repeated["deleted_files"] == 0
    assert list(sessions.iterdir()) == []


def test_reset_database_must_match_the_selected_offeru_data_root(tmp_path: Path, monkeypatch) -> None:
    import app.database
    import app.services.data_safety as data_safety

    root_a = tmp_path / "instance-a"
    root_b = tmp_path / "instance-b"
    root_a.mkdir()
    root_b.mkdir()
    database_path = root_a / "djm.db"
    database_path.touch()
    database_url = make_url(f"sqlite+aiosqlite:///{database_path.as_posix()}")
    monkeypatch.setattr(app.database, "engine", SimpleNamespace(url=database_url))
    monkeypatch.setattr(
        data_safety,
        "_runtime_layout",
        lambda: DataSafetyLayout(backend_dir=root_a, database_path=database_path),
    )

    assert local_data_reset._assert_reset_database_root(root_a) == database_path
    with pytest.raises(DataSafetyError, match="不在 OfferU 运行目录内|数据根不一致"):
        local_data_reset._assert_reset_database_root(root_b)


def test_reset_service_rejects_calls_without_persisted_registry_authorization() -> None:
    with pytest.raises(DataSafetyError, match="Operation Registry 提案"):
        asyncio.run(local_data_reset.reset_local_business_data())


def test_approved_reset_run_drops_python_session_and_never_continues(monkeypatch) -> None:
    import app.services.career_tasks as career_tasks
    import app.services.embedded_agent_host as embedded_host
    from app.services.embedded_agent_worker import EmbeddedAgentWorker

    run_id = "run_0123456789abcdef"
    task_id = "task_resetreceipt1234"
    run = {
        "id": run_id,
        "task_id": task_id,
        "status": "completed",
        "goal": "old synthetic profile goal",
        "steps": [{
            "id": "reset_local_business_data:1",
            "tool": "reset_local_business_data",
            "status": "completed",
        }],
        "llm_runtime": {"runtime": "python_agent"},
        "final_result": {"assistant_message": "old context", "turn_finished": False},
    }

    class Worker(EmbeddedAgentWorker):
        def __init__(self) -> None:
            super().__init__()
            self.active_run_id = run_id
            self._messages = [object()]
            self._system_prompt = "old synthetic profile context"
            self._operations = [{"name": "old_tool"}]
            self._session_path = Path("H:/tmp/offeru/synthetic-session.json")

    worker = Worker()
    continuation = []

    async def confirm_proposal(*args, **kwargs):
        return {
            "ok": True,
            "run": run,
            "tool_calls": [{"tool": "reset_local_business_data", "result": {"ok": True}}],
        }

    async def load_run(value):
        return run

    async def save_run(value, **kwargs):
        return value

    async def stop_task(value):
        return True

    async def forbidden_continuation(*args, **kwargs):
        continuation.append(True)
        raise AssertionError("fresh reset must never continue the old model turn")

    monkeypatch.setattr(embedded_host, "confirm_operation_proposal", confirm_proposal)
    monkeypatch.setattr(embedded_host, "load_agent_run", load_run)
    monkeypatch.setattr(embedded_host, "save_agent_run", save_run)
    monkeypatch.setattr(embedded_host, "pending_actions_for_run", lambda value: [])
    monkeypatch.setattr(embedded_host, "get_embedded_agent_worker", lambda: worker)
    monkeypatch.setattr(embedded_host, "start_embedded_agent_run", forbidden_continuation)
    monkeypatch.setattr(career_tasks, "stop_live_career_task_after_fresh_reset", stop_task)

    result = asyncio.run(
        embedded_host.confirm_embedded_agent_action(
            run_id,
            action_id="reset_local_business_data:1",
            worker=worker,
        )
    )

    assert result["ok"] is True
    assert "continuation" not in result
    assert continuation == []
    assert worker.active_run_id is None
    assert worker._messages == []
    assert worker._system_prompt == ""
    assert worker._operations == []
    assert worker._session_path is None


@pytest.mark.parametrize(
    ("qdrant_host", "expected_state"),
    [("", "not_applicable"), ("configured-qdrant", "blocked")],
)
def test_missing_index_dependency_is_only_allowed_when_qdrant_is_not_configured(
    monkeypatch,
    qdrant_host: str,
    expected_state: str,
) -> None:
    import app.config

    real_import = builtins.__import__

    def without_qdrant(name, globals=None, locals=None, fromlist=(), level=0):
        if name == "app.services.semantic_search":
            raise ModuleNotFoundError("qdrant client missing", name="qdrant_client")
        return real_import(name, globals, locals, fromlist, level)

    monkeypatch.setattr(builtins, "__import__", without_qdrant)
    monkeypatch.setattr(
        app.config,
        "get_settings",
        lambda: SimpleNamespace(qdrant_host=qdrant_host),
    )
    if expected_state == "blocked":
        with pytest.raises(DataSafetyError, match="搜索索引不可访问"):
            asyncio.run(local_data_reset._reset_semantic_indexes())
    else:
        result = asyncio.run(local_data_reset._reset_semantic_indexes())
        assert result["state"] == "not_applicable"


def test_registry_confirmed_reset_clears_synthetic_state_and_restores_backup(
    tmp_path: Path,
    monkeypatch,
) -> None:
    async def scenario() -> None:
        import app.config
        import app.database
        import app.ops
        import app.services.agent_run_coordinator as run_coordinator
        import app.services.agent_run_state as run_state
        import app.services.career_tasks as career_tasks
        import app.services.data_safety as data_safety
        import app.services.local_data_reset as reset_service
        from app.database import Base
        from app.models.models import (
            AgentRunEvent,
            AgentRunRecord,
            CareerTask,
            Job,
            JobSearchTask,
            MemoryProposal,
            OperationAuditLog,
            Profile,
            Resume,
        )
        from app.services.data_safety import (
            DataSafetyLayout,
            apply_pending_restore_before_database_connect,
            list_backups,
            stage_restore,
        )
        from app.services.operation_projection import (
            confirm_operation_proposal,
            execute_or_propose_operation,
        )
        from sqlalchemy import select
        from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

        root = tmp_path / "offeru-data"
        external_root = tmp_path / "external"
        root.mkdir()
        external_root.mkdir()
        uploads_root = root / "uploads"
        uploads_root.mkdir()
        uploaded_resume = uploads_root / "synthetic-resume.txt"
        uploaded_resume.write_text("synthetic uploaded resume", encoding="utf-8")
        database_path = root / "djm.db"
        runtime_url = f"sqlite+aiosqlite:///{database_path.as_posix()}"
        runtime_engine = create_async_engine(runtime_url)
        assert Path(runtime_engine.url.database).resolve() == database_path.resolve()
        if os.name == "nt" and Path("H:/tmp").exists():
            assert Path(runtime_engine.url.database).drive.upper() == "H:"

        def bind_engine(engine):
            factory = async_sessionmaker(engine, expire_on_commit=False)
            monkeypatch.setattr(app.database, "engine", engine)
            monkeypatch.setattr(app.database, "async_session", factory)
            for module in (app.ops, run_coordinator, run_state, career_tasks, reset_service):
                monkeypatch.setattr(module, "async_session", factory)
            return factory

        session_factory = bind_engine(runtime_engine)
        monkeypatch.setenv("OFFERU_DATA_DIR", str(root))
        monkeypatch.delenv("DATABASE_URL", raising=False)

        layout = DataSafetyLayout(backend_dir=root, database_path=database_path)

        def isolated_layout(database_url=None, backend_dir=root):
            return DataSafetyLayout(backend_dir=Path(backend_dir), database_path=database_path)

        monkeypatch.setattr(data_safety, "_runtime_layout", isolated_layout)
        monkeypatch.setattr(app.config, "get_settings", lambda: SimpleNamespace(qdrant_host=""))

        try:
            async with runtime_engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)

            external_resume = external_root / "source-resume.txt"
            external_resume.write_text("synthetic external resume", encoding="utf-8")
            external_memory = external_root / "agent-memory.md"
            external_memory.write_text("synthetic external memory", encoding="utf-8")
            config_path = root / "config.json"
            config_path.write_text('{"credential_ref":"synthetic-vault-ref"}', encoding="utf-8")
            artifact_path = root / "data" / "artifacts" / "old.json"
            artifact_path.parent.mkdir(parents=True)
            artifact_path.write_text('{"synthetic":"artifact"}', encoding="utf-8")
            session_path = root / "data" / "python_agent_sessions" / "run_synthetic12345678.json"
            session_path.parent.mkdir(parents=True)
            session_path.write_text('{"messages":["synthetic old career context"]}', encoding="utf-8")
            (root / "data" / "harness_agent_conversations.json").write_text(
                '{"schema_version":"offeru.harness_conversations.v1","conversations":[{"id":"old"}]}',
                encoding="utf-8",
            )
            (root / "data" / "harness_agent_memory.json").write_text(
                '{"facts":["synthetic old career fact"]}',
                encoding="utf-8",
            )

            async with session_factory() as db:
                profile = Profile(name="Synthetic Candidate", email="synthetic@example.test")
                db.add(profile)
                await db.flush()
                job = Job(
                    title="Synthetic Analyst",
                    company="Synthetic Co",
                    hash_key="a" * 64,
                )
                db.add(job)
                await db.flush()
                resume = Resume(
                    user_name="Synthetic Candidate",
                    source_profile_id=profile.id,
                    target_job_id=job.id,
                )
                proposal_row = MemoryProposal(
                    proposal_key="synthetic-reset-proposal",
                    target_tier="verified_fact",
                    section_type="skill",
                    title="Synthetic skill",
                    before_json={},
                    after_json={"statement": "synthetic"},
                    reason="synthetic fixture",
                    impact_json=[],
                    status="pending",
                )
                active_task = CareerTask(
                    task_id="synthetic-active-task",
                    task_type="career_director",
                    source="test_fixture",
                    target_type="job",
                    target_id=str(job.id),
                    input_json={"synthetic_context": "old job"},
                    output_contract_json={},
                    status="running",
                    idempotency_key="synthetic-active-task-key",
                )
                unregistered_task = CareerTask(
                    task_id="synthetic-unregistered-task",
                    task_type="career_director",
                    source="test_fixture",
                    target_type="job",
                    target_id=str(job.id),
                    input_json={"synthetic_context": "unregistered old job"},
                    output_contract_json={},
                    status="running",
                    idempotency_key="synthetic-unregistered-task-key",
                )
                db.add_all((resume, proposal_row, active_task, unregistered_task))
                await db.commit()
                profile_id = profile.id
                job_id = job.id

            async def stale_worker() -> None:
                try:
                    await asyncio.Future()
                except asyncio.CancelledError:
                    # Model a worker that has one final awaited materialization
                    # after cancellation is requested; reset must await it, then
                    # clear the resulting row before returning.
                    while True:
                        try:
                            await asyncio.sleep(0.01)
                            break
                        except asyncio.CancelledError:
                            continue
                    async with session_factory() as db:
                        db.add(
                            Job(
                                title="Synthetic resurrected job",
                                company="Synthetic Co",
                                hash_key="c" * 64,
                            )
                        )
                        await db.commit()

            worker = asyncio.create_task(stale_worker())
            career_tasks._LIVE_TASKS["synthetic-active-task"] = worker

            proposal = await execute_or_propose_operation(
                "reset_local_business_data",
                {},
                surface="agent_runtime_ui",
            )
            assert proposal["ok"] is True
            assert proposal["outputs"]["requires_confirmation"] is True
            assert proposal["outputs"]["executed"] is False
            run_id = proposal["outputs"]["proposal"]["run_id"]
            action_id = proposal["outputs"]["proposal"]["action_id"]

            before_counts = {}
            async with session_factory() as db:
                for label, model in (
                    ("jobs", Job),
                    ("resumes", Resume),
                    ("memory_proposals", MemoryProposal),
                ):
                    before_counts[label] = len((await db.execute(select(model))).scalars().all())
            assert before_counts == {"jobs": 1, "resumes": 1, "memory_proposals": 1}

            receipt = await confirm_operation_proposal(
                run_id,
                surface="agent_runtime_ui",
                action_id=action_id,
            )
            assert receipt["ok"] is True
            assert len(receipt["tool_calls"]) == 1
            backup_id = receipt["run"]["steps"][0]["result"]["outputs"]["backup"]["backup_id"]
            assert receipt["run"]["steps"][0]["result"]["outputs"]["quiesced"]["career_tasks"] == 2
            backups = list_backups(layout)
            assert len(backups["items"]) == 1
            assert backups["items"][0]["backup_id"] == backup_id
            assert backups["items"][0]["reason"] == "pre_reset"

            async with session_factory() as db:
                assert len((await db.execute(select(Job))).scalars().all()) == 0
                assert len((await db.execute(select(Resume))).scalars().all()) == 0
                assert len((await db.execute(select(MemoryProposal))).scalars().all()) == 0
                assert len((await db.execute(select(CareerTask))).scalars().all()) == 0
                profiles = (await db.execute(select(Profile))).scalars().all()
                assert len(profiles) == 1
                assert profiles[0].name == "默认档案"
                assert profiles[0].email == ""
                current_run = await db.get(AgentRunRecord, run_id)
                assert current_run is not None
                assert current_run.goal == "Owner Fresh Reset"
                assert current_run.conversation_id == ""
                assert current_run.llm_runtime_json == {
                    "runtime": "none",
                    "reason": "fresh_reset_context_closed",
                }
                assert current_run.skill_snapshot_json == {}
                assert "synthetic" not in str(current_run.final_result_json).lower()
                assert [step["tool"] for step in current_run.steps_json] == ["reset_local_business_data"]
                current_tasks = (await db.execute(select(JobSearchTask))).scalars().all()
                assert len(current_tasks) == 1
                assert current_tasks[0].conversation_id == ""
                assert current_tasks[0].goal == "OfferU local career data reset"
                events = (
                    await db.execute(
                        select(AgentRunEvent).where(AgentRunEvent.run_id == run_id)
                    )
                ).scalars().all()
                assert all(
                    event.event_type.startswith("operation.")
                    or event.event_type in {"run.completed", "run.turn_finished"}
                    for event in events
                )
                audit_rows = (
                    await db.execute(
                        select(OperationAuditLog).where(
                            OperationAuditLog.operation == "reset_local_business_data"
                        )
                    )
                ).scalars().all()
                assert any(row.status == "completed" for row in audit_rows)

            assert list((root / "data" / "python_agent_sessions").iterdir()) == []
            assert not artifact_path.exists()
            assert not uploaded_resume.exists()
            assert json.loads((root / "data" / "harness_agent_memory.json").read_text(encoding="utf-8"))["facts"] == []
            assert json.loads((root / "data" / "harness_agent_conversations.json").read_text(encoding="utf-8"))["conversations"] == []
            assert config_path.read_text(encoding="utf-8") == '{"credential_ref":"synthetic-vault-ref"}'
            assert external_resume.read_text(encoding="utf-8") == "synthetic external resume"
            assert external_memory.read_text(encoding="utf-8") == "synthetic external memory"

            # Dispose and recreate the DB engine to model a backend restart.
            await runtime_engine.dispose()
            runtime_engine = create_async_engine(runtime_url)
            session_factory = bind_engine(runtime_engine)
            async with session_factory() as db:
                assert len((await db.execute(select(Job))).scalars().all()) == 0
                assert len((await db.execute(select(Resume))).scalars().all()) == 0
                restarted_run = await db.get(AgentRunRecord, run_id)
                assert restarted_run is not None
                assert restarted_run.goal == "Owner Fresh Reset"
                assert restarted_run.conversation_id == ""
            assert list((root / "data" / "python_agent_sessions").iterdir()) == []
            assert json.loads((root / "data" / "harness_agent_memory.json").read_text(encoding="utf-8"))["facts"] == []

            # Duplicate confirmation replays the receipt and cannot create a second backup.
            duplicate = await confirm_operation_proposal(
                run_id,
                surface="agent_runtime_ui",
                action_id=action_id,
            )
            assert duplicate["ok"] is True
            assert duplicate["tool_calls"] == []
            assert len(list_backups(layout)["items"]) == 1

            await runtime_engine.dispose()
            staged = stage_restore(layout, backup_id=backup_id)
            assert staged["pending_restart"] is True
            restored = apply_pending_restore_before_database_connect(
                database_url=runtime_url,
                backend_dir=root,
            )
            assert restored["applied"] is True
            runtime_engine = create_async_engine(runtime_url)
            session_factory = bind_engine(runtime_engine)
            async with session_factory() as db:
                assert len((await db.execute(select(Job))).scalars().all()) == 1
                assert len((await db.execute(select(Resume))).scalars().all()) == 1
                assert len((await db.execute(select(MemoryProposal))).scalars().all()) == 1
                restored_profile = await db.get(Profile, profile_id)
                assert restored_profile is not None
                restored_job = await db.get(Job, job_id)
                assert restored_job is not None
            assert session_path.read_text(encoding="utf-8") == '{"messages":["synthetic old career context"]}'
            assert artifact_path.is_file()
            assert uploaded_resume.read_text(encoding="utf-8") == "synthetic uploaded resume"
            assert external_resume.read_text(encoding="utf-8") == "synthetic external resume"
            assert external_memory.read_text(encoding="utf-8") == "synthetic external memory"

            # A file cleanup failure after the database transaction must not
            # be reported as a completed Registry action. The pre-reset backup
            # remains available to recover the partially cleared workspace.
            partial_session = root / "data" / "python_agent_sessions" / "run_partial12345678.json"
            partial_session.parent.mkdir(parents=True, exist_ok=True)
            partial_session.write_text('{"messages":["synthetic partial cleanup"]}', encoding="utf-8")
            partial_proposal = await execute_or_propose_operation(
                "reset_local_business_data",
                {},
                surface="agent_runtime_ui",
            )
            assert partial_proposal["ok"] is True
            assert partial_proposal["outputs"]["requires_confirmation"] is True
            partial_run_id = partial_proposal["outputs"]["proposal"]["run_id"]
            partial_action_id = partial_proposal["outputs"]["proposal"]["action_id"]
            clear_directory_contents = reset_service._clear_directory_contents

            def clear_then_fail(directory: Path, *, boundary: Path) -> int:
                cleared = clear_directory_contents(directory, boundary=boundary)
                if directory.name == "python_agent_sessions":
                    raise OSError("synthetic partial file cleanup failure")
                return cleared

            with monkeypatch.context() as failure_patch:
                failure_patch.setattr(
                    reset_service,
                    "_clear_directory_contents",
                    clear_then_fail,
                )
                partial_receipt = await confirm_operation_proposal(
                    partial_run_id,
                    surface="agent_runtime_ui",
                    action_id=partial_action_id,
                )

            assert partial_receipt["ok"] is False
            assert partial_receipt["run"]["status"] == "failed"
            assert partial_receipt["run"]["steps"][0]["status"] == "failed"
            assert partial_receipt["run"]["steps"][0]["error"]
            assert not partial_session.exists()
            assert list_backups(layout)["items"][0]["reason"] == "pre_reset"
            async with session_factory() as db:
                assert len((await db.execute(select(Job))).scalars().all()) == 0
                assert len((await db.execute(select(Resume))).scalars().all()) == 0
                failed_audits = (
                    await db.execute(
                        select(OperationAuditLog)
                        .where(OperationAuditLog.operation == "reset_local_business_data")
                        .order_by(OperationAuditLog.id.desc())
                    )
                ).scalars().all()
                assert failed_audits[0].status == "failed"
                assert failed_audits[0].ok is False
        finally:
            career_tasks._LIVE_TASKS.pop("synthetic-active-task", None)
            await runtime_engine.dispose()

    asyncio.run(scenario())


def test_semantic_reset_drops_only_offeru_career_collections_and_cache() -> None:
    pytest.importorskip("qdrant_client")
    from app.services.semantic_search import (
        COLLECTION_JOB_DESCRIPTIONS,
        COLLECTION_MEMORY_OBSERVATIONS,
        COLLECTION_PROFILE_BULLETS,
        SemanticSearchService,
        _LRUCache,
    )

    class FakeQdrant:
        def __init__(self) -> None:
            self.collections = {
                COLLECTION_PROFILE_BULLETS,
                COLLECTION_JOB_DESCRIPTIONS,
                COLLECTION_MEMORY_OBSERVATIONS,
            }
            self.deleted: list[str] = []

        async def get_collections(self):
            return SimpleNamespace(
                collections=[SimpleNamespace(name=name) for name in self.collections]
            )

        async def delete_collection(self, *, collection_name: str) -> None:
            self.deleted.append(collection_name)
            self.collections.discard(collection_name)

        async def create_collection(self, *, collection_name: str, vectors_config) -> None:
            self.collections.add(collection_name)

    service = object.__new__(SemanticSearchService)
    client = FakeQdrant()
    service.client = client
    service._client_lock = asyncio.Lock()
    service._embedding_cache = _LRUCache()
    service._embedding_cache["synthetic-profile"] = [0.1]

    result = asyncio.run(service.reset_career_indexes())

    assert set(result["collections_cleared"]) == set(client.deleted)
    assert client.collections == {
        COLLECTION_PROFILE_BULLETS,
        COLLECTION_JOB_DESCRIPTIONS,
        COLLECTION_MEMORY_OBSERVATIONS,
    }
    assert len(service._embedding_cache) == 0
