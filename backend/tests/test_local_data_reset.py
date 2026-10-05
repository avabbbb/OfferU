from __future__ import annotations

import asyncio
import builtins
import json
import os
from uuid import uuid4
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
    from app.services import ui_approval_capability
    monkeypatch.setattr(ui_approval_capability, "accepts_authorization", lambda value: value == "Bearer synthetic-reset-ui")
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
            from app.services import proposal_plan_store, proposal_plan_sources, proposal_plan_execution
            for module in (app.ops, run_coordinator, run_state, career_tasks, reset_service, proposal_plan_store, proposal_plan_sources, proposal_plan_execution):
                if hasattr(module, "async_session"):
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
        # Never inherit the machine's Qdrant singleton or remote settings.
        from qdrant_client import AsyncQdrantClient
        from app.services import semantic_search
        semantic = object.__new__(semantic_search.SemanticSearchService)
        semantic.client = AsyncQdrantClient(":memory:")
        semantic._client_lock = asyncio.Lock()
        semantic._embedding_cache = semantic_search._LRUCache()
        monkeypatch.setattr(semantic_search, "get_semantic_search", lambda: semantic)

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
            plan = proposal["outputs"]["plan"]
            run_id = plan["run_id"]
            group = plan["groups"][0]
            action_id = group["nodes"][0]["id"]

            before_counts = {}
            async with session_factory() as db:
                for label, model in (
                    ("jobs", Job),
                    ("resumes", Resume),
                    ("memory_proposals", MemoryProposal),
                ):
                    before_counts[label] = len((await db.execute(select(model))).scalars().all())
            assert before_counts == {"jobs": 1, "resumes": 1, "memory_proposals": 1}

            reset_decision_id = "decision_" + uuid4().hex
            receipt = await confirm_operation_proposal(
                run_id,
                surface="agent_runtime_ui",
                action_id=action_id,
                authorization_source="Bearer synthetic-reset-ui",
                plan_digest=plan["digest"], group_digest=group["digest"],
                decision_id=reset_decision_id,
            )
            assert receipt["ok"] is True
            assert len(receipt["receipts"]) == 1
            assert receipt["receipts"][0]["effect_state"] == "committed"
            node_result = receipt["group"]["nodes"][0]["result"]["operation_result"]["outputs"]
            backup_id = node_result["backup"]["backup_id"]
            assert node_result["quiesced"]["career_tasks"] == 2
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
                assert current_run.steps_json == []
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
                    or event.event_type in {"run.completed", "run.turn_finished", "proposal.group_decided"}
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
                authorization_source="Bearer synthetic-reset-ui",
                plan_digest=plan["digest"], group_digest=group["digest"],
                decision_id=reset_decision_id,
            )
            assert duplicate["ok"] is True
            assert duplicate["duplicate"]
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
            partial_plan = partial_proposal["outputs"]["plan"]
            partial_run_id = partial_plan["run_id"]
            partial_group = partial_plan["groups"][0]
            partial_action_id = partial_group["nodes"][0]["id"]
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
                    authorization_source="Bearer synthetic-reset-ui",
                    plan_digest=partial_plan["digest"], group_digest=partial_group["digest"],
                    decision_id="decision_" + uuid4().hex,
                )

            assert partial_receipt["ok"] is False
            partial_run = await run_state.load_agent_run(partial_run_id)
            assert partial_run["status"] == "needs_reconciliation"
            assert partial_receipt["group"]["nodes"][0]["status"] == "uncertain"
            assert partial_receipt["group"]["nodes"][0]["error"]
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
            await semantic.client.close()
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


def test_real_local_vector_reset_preserves_other_products_and_verifies_empty_indexes() -> None:
    pytest.importorskip("qdrant_client")
    from qdrant_client import AsyncQdrantClient
    from qdrant_client.models import Distance, PointStruct, VectorParams
    from app.services.semantic_search import (
        COLLECTION_PROFILE_BULLETS, EMBEDDING_DIMENSION, SemanticSearchService, _LRUCache,
    )

    async def scenario():
        client = AsyncQdrantClient(":memory:")
        service = object.__new__(SemanticSearchService)
        service.client = client
        service._client_lock = asyncio.Lock()
        service._embedding_cache = _LRUCache()
        try:
            await service._ensure_collections()
            await client.upsert(collection_name=COLLECTION_PROFILE_BULLETS, points=[
                PointStruct(id=1, vector=[0.1] * EMBEDDING_DIMENSION, payload={"fixture": "old career"}),
            ])
            await client.create_collection(collection_name="other-product-fixture", vectors_config=VectorParams(size=2, distance=Distance.COSINE))
            await client.upsert(collection_name="other-product-fixture", points=[PointStruct(id=1, vector=[0.1, 0.2])])
            assert not await service.career_indexes_empty()
            await service.reset_career_indexes()
            assert await service.career_indexes_empty()
            assert (await client.count(collection_name="other-product-fixture", exact=True)).count == 1
        finally:
            await client.close()
    asyncio.run(scenario())
