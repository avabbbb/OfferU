from __future__ import annotations

import copy
import asyncio
import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.chdir(BACKEND_DIR)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import app.ops as operation_registry
from app.ops import OPERATIONS
from app.ops import execute_operation
from app.database import Base
from app.models.models import Job, RoleBenchmarkRun
from app.services.agent_skill_registry import resolve_skill
from app.services import role_intelligence
from app.services.role_intelligence import (
    DeepExecutorRoleCollectionProvider,
    MIN_SAMPLE_COUNT,
    ReplayRoleCollectionProvider,
    analyze_delta,
    calculate_evidence_gap,
    canonicalize_capability,
    dedupe_benchmark_documents,
    filter_comparator_cohort,
    normalize_benchmark_document,
)


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "role_intelligence_v0" / "corpus.json"


def _fixture() -> tuple[dict, list[dict]]:
    payload = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    target = normalize_benchmark_document(payload["target"], document_kind="target")
    comparators = [
        normalize_benchmark_document(item, document_kind="comparator")
        for item in payload["comparators"]
    ]
    return target, comparators


class RoleIntelligenceTests(unittest.TestCase):
    def test_alias_canonicalization_keeps_original_evidence(self) -> None:
        observation = canonicalize_capability(
            {
                "capability": "Agent Harness",
                "category": "technical_product",
                "importance": "must_have",
                "evidence_text": "负责 Agent Harness 运行机制设计",
                "source_section": "Responsibilities",
                "confidence": 0.94,
            }
        )

        self.assertEqual(observation["capability_id"], "agent_runtime")
        self.assertEqual(observation["canonicalization_status"], "canonicalized")
        self.assertEqual(observation["capability"], "Agent Harness")
        self.assertEqual(observation["evidence_text"], "负责 Agent Harness 运行机制设计")
        self.assertEqual(observation["source_section"], "responsibilities")

    def test_dedupe_and_cohort_select_the_expected_comparators(self) -> None:
        target, comparators = _fixture()
        duplicate = copy.deepcopy(comparators[0])
        duplicate["source_ref"] = "cmp-repost"
        duplicate["url"] = "https://mirror.example.org/repost/cmp-01"
        duplicate["canonical_url"] = "https://mirror.example.org/repost/cmp-01"
        comparators_with_duplicate = [*comparators, duplicate]

        wrong_cohort = copy.deepcopy(comparators[0])
        wrong_cohort["source_ref"] = "cmp-wrong-cohort"
        wrong_cohort["company"] = "Wrong Cohort Co"
        wrong_cohort["title"] = "Growth Product Manager"
        wrong_cohort["url"] = "https://jobs.example.org/cmp-wrong-cohort"
        wrong_cohort["raw_description"] = "Wrong cohort role with a different specialization."
        wrong_cohort["canonical_url"] = wrong_cohort["url"]
        wrong_cohort["_content_key"] = "wrong-cohort-unique-content"
        wrong_cohort["role_profile"]["specialization"] = "growth"
        comparators_with_duplicate.append(wrong_cohort)

        unique = dedupe_benchmark_documents(comparators_with_duplicate)
        selected = filter_comparator_cohort(target, unique)

        self.assertEqual(len(unique), 21)
        self.assertEqual(len(selected), 20)
        self.assertEqual(
            {item["source_ref"] for item in selected},
            {item["source_ref"] for item in comparators},
        )

    def test_delta_is_deterministic_and_uses_counts_from_runtime(self) -> None:
        target, comparators = _fixture()
        selected = filter_comparator_cohort(target, dedupe_benchmark_documents(comparators))

        first = analyze_delta(target, selected)
        second = analyze_delta(target, selected)

        self.assertEqual(first, second)
        self.assertEqual(first["sample"], {
            "valid_comparator_count": 20,
            "minimum_required": MIN_SAMPLE_COUNT,
            "sufficient": True,
        })
        signals = {item["capability_id"]: item for item in first["signals"]}
        self.assertEqual(signals["agent_runtime"]["comparator_count"], 2)
        self.assertEqual(signals["agent_runtime"]["market_frequency"], 0.1)
        self.assertEqual(signals["agent_runtime"]["direction"], "highly_distinctive")
        self.assertEqual(signals["model_evaluation"]["market_frequency"], 0.1)
        self.assertEqual(signals["model_evaluation"]["direction"], "highly_distinctive")
        self.assertEqual(signals["developer_workflow"]["market_frequency"], 0.2)
        self.assertEqual(signals["developer_workflow"]["direction"], "distinctive")
        self.assertEqual(signals["product_strategy"]["market_frequency"], 1.0)
        self.assertEqual(signals["product_strategy"]["direction"], "common")
        self.assertEqual(signals["growth_experiment"]["market_frequency"], 0.6)
        self.assertEqual(signals["growth_experiment"]["direction"], "missing_common")
        self.assertIn("job:fixture-target", signals["agent_runtime"]["evidence_refs"])
        self.assertIn("cmp-01", signals["agent_runtime"]["evidence_refs"])

    def test_insufficient_sample_is_explicit(self) -> None:
        target, comparators = _fixture()
        result = analyze_delta(target, comparators[: MIN_SAMPLE_COUNT - 1])

        self.assertFalse(result["sample"]["sufficient"])
        self.assertEqual(result["sample"]["valid_comparator_count"], MIN_SAMPLE_COUNT - 1)
        self.assertEqual(result["sample"]["minimum_required"], MIN_SAMPLE_COUNT)
        self.assertEqual(result["signals"], [])

    def test_evidence_gap_is_deterministic_and_ignores_unverified_sections(self) -> None:
        signal = {
            "capability_id": "model_evaluation",
            "market_frequency": 0.08,
            "direction": "highly_distinctive",
        }
        profile_sections = [
            {
                "id": 2,
                "section_type": "experience",
                "title": "大模型评测项目",
                "tier": "verified_fact",
                "confidence": 0.42,
                "content_json": {"description": "负责评测体系与上线质量复盘"},
            },
            {
                "id": 1,
                "section_type": "hypothesis",
                "title": "模型评测推断",
                "tier": "career_hypothesis",
                "confidence": 0.99,
                "content_json": {"description": "可能做过模型评测"},
            },
        ]

        first = calculate_evidence_gap(signal, profile_sections)
        second = calculate_evidence_gap(signal, profile_sections)

        self.assertEqual(first, second)
        self.assertEqual(first["role_distinctiveness"], 92.0)
        self.assertEqual(first["evidence_strength"], 42.0)
        self.assertEqual(first["evidence_gap"], 58.0)
        self.assertEqual(first["training_priority"], 53.36)
        self.assertEqual(first["status"], "partial")
        self.assertEqual(
            [item["profile_section_id"] for item in first["matched_evidence"]],
            [2],
        )

    def test_collection_provider_seam_keeps_fixture_and_deep_executor_separate(self) -> None:
        self.assertIsInstance(
            role_intelligence._collection_provider("fixture"),
            ReplayRoleCollectionProvider,
        )
        self.assertIsInstance(
            role_intelligence._collection_provider("codex"),
            DeepExecutorRoleCollectionProvider,
        )

    def test_persistence_round_trip_keeps_snapshot_evidence_and_delta(self) -> None:
        target, comparators = _fixture()
        analysis = analyze_delta(target, comparators)
        unique, candidate_records = role_intelligence._dedupe_documents_with_status(comparators)

        async def run_round_trip(database_path: Path) -> dict:
            engine = create_async_engine(
                f"sqlite+aiosqlite:///{database_path.as_posix()}"
            )
            session = async_sessionmaker(engine, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                async with session() as db:
                    job = Job(
                        title=target["title"],
                        company=target["company"],
                        location=target["location"],
                        url=target["canonical_url"],
                        source="fixture",
                        raw_description=target["raw_description"],
                        hash_key="fixture-role-intelligence-target",
                    )
                    db.add(job)
                    await db.flush()
                    db.add(
                        RoleBenchmarkRun(
                            run_id="role_benchmark_fixture_round_trip",
                            target_job_id=job.id,
                            cohort_json={},
                            requested_sample_count=30,
                            min_sample_count=MIN_SAMPLE_COUNT,
                            max_sample_count=50,
                            schema_version="offeru.role_benchmark_candidate.v1",
                            algorithm_version="role_benchmark.v1",
                            runtime_id="fixture",
                            status="running",
                        )
                    )
                    await db.commit()
                    target["job_id"] = job.id
                    target["source_ref"] = f"job:{job.id}"

                with patch.object(role_intelligence, "async_session", session):
                    await role_intelligence._persist_benchmark(
                        run_id="role_benchmark_fixture_round_trip",
                        target=target,
                        candidate_records=candidate_records,
                        selected_comparators=unique,
                        analysis=analysis,
                        trace={"fixture": True},
                        runtime_version="fixture-runtime",
                        rejected_count=0,
                        gaps=[],
                    )
                    loaded = await role_intelligence.get_role_benchmark(
                        run_id="role_benchmark_fixture_round_trip"
                    )
                    async with session() as db:
                        job_count = await db.scalar(select(func.count(Job.id)))
                    return loaded, int(job_count or 0)
            finally:
                await engine.dispose()

        with self.subTest("isolated sqlite"):
            with tempfile.TemporaryDirectory() as directory:
                    loaded, job_count = asyncio.run(
                        run_round_trip(Path(directory) / "role.db")
                    )

        self.assertEqual(loaded["valid_sample_count"], 20)
        self.assertEqual(job_count, 1)
        self.assertEqual(len(loaded["documents"]), 21)
        self.assertEqual(len(loaded["signals"]), 5)
        target_document = next(
            item for item in loaded["documents"] if item["document_kind"] == "target"
        )
        self.assertEqual(target_document["job_id"], target["job_id"])
        self.assertEqual(target_document["role_profile"]["schema"], "offeru.role_jd.v1")
        self.assertTrue(
            all(
                item["job_id"] is None
                for item in loaded["documents"]
                if item["document_kind"] == "comparator"
            )
        )
        self.assertEqual(
            target_document["capability_observations"][0]["evidence_text"],
            "负责 Agent Harness 运行机制设计",
        )
        signals = {item["capability_id"]: item for item in loaded["signals"]}
        self.assertEqual(signals["agent_runtime"]["market_frequency"], 0.1)
        self.assertEqual(signals["growth_experiment"]["direction"], "missing_common")

    def test_database_init_creates_role_tables_in_isolated_sqlite(self) -> None:
        probe = """
import asyncio
import json
from sqlalchemy import inspect
import app.main
from app.database import engine, init_db

REQUIRED = {
    "jobs",
    "role_benchmark_runs",
    "role_benchmark_documents",
    "role_capability_observations",
    "role_delta_signals",
}

async def main():
    await init_db()
    async with engine.connect() as connection:
        tables = await connection.run_sync(lambda sync: set(inspect(sync).get_table_names()))
    print(json.dumps({
        "required_tables_present": REQUIRED.issubset(tables),
        "table_count": len(tables),
    }))
    await engine.dispose()

asyncio.run(main())
"""
        with tempfile.TemporaryDirectory() as directory:
            database_path = Path(directory) / "role-init.db"
            env = os.environ.copy()
            env["DATABASE_URL"] = f"sqlite+aiosqlite:///{database_path.as_posix()}"
            result = subprocess.run(
                [sys.executable, "-c", probe],
                cwd=BACKEND_DIR,
                env=env,
                capture_output=True,
                text=True,
                timeout=45,
                check=False,
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertTrue(payload["required_tables_present"])
        self.assertGreaterEqual(payload["table_count"], 5)

    def test_job_read_keeps_last_completed_snapshot_when_latest_attempt_is_blocked(self) -> None:
        async def read_snapshot(database_path: Path) -> dict:
            engine = create_async_engine(
                f"sqlite+aiosqlite:///{database_path.as_posix()}"
            )
            session = async_sessionmaker(engine, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                now = datetime.now(timezone.utc).replace(tzinfo=None)
                async with session() as db:
                    job = Job(
                        title="AIGC Product Manager",
                        company="Fixture Co",
                        source="fixture",
                        raw_description="Build evaluation and agent workflows.",
                        hash_key="fixture-role-read-fallback",
                    )
                    db.add(job)
                    await db.flush()
                    db.add_all(
                        [
                            RoleBenchmarkRun(
                                run_id="role_benchmark_completed_snapshot",
                                target_job_id=job.id,
                                runtime_id="fixture",
                                status="completed",
                                valid_sample_count=20,
                                company_count=14,
                                min_sample_count=MIN_SAMPLE_COUNT,
                                created_at=now - timedelta(minutes=5),
                            ),
                            RoleBenchmarkRun(
                                run_id="role_benchmark_blocked_refresh",
                                target_job_id=job.id,
                                runtime_id="codex",
                                status="blocked",
                                error="401 Missing bearer authentication token",
                                created_at=now,
                            ),
                        ]
                    )
                    await db.commit()

                with (
                    patch.object(role_intelligence, "async_session", session),
                    patch.object(operation_registry, "async_session", session),
                ):
                    result = await execute_operation(
                        "get_role_benchmark",
                        {"job_id": job.id},
                        surface="research_api",
                    )
                return result
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            result = asyncio.run(
                read_snapshot(Path(directory) / "role-read-fallback.db")
            )

        self.assertTrue(result["ok"], result)
        outputs = result["outputs"]
        self.assertEqual(outputs["run_id"], "role_benchmark_completed_snapshot")
        self.assertEqual(outputs["status"], "completed")
        self.assertEqual(outputs["benchmark_status"], "READY")
        self.assertEqual(outputs["valid_sample_count"], 20)
        self.assertNotIn("error", outputs)
        self.assertEqual(
            outputs["latest_attempt"]["run_id"],
            "role_benchmark_blocked_refresh",
        )
        self.assertTrue(outputs["latest_attempt"]["provider_blocked"])
        self.assertEqual(outputs["latest_attempt"]["benchmark_status"], "BLOCKED_EXTERNAL")
        self.assertEqual(
            outputs["latest_attempt"]["last_error"],
            "provider authentication failed",
        )

    def test_operation_registry_golden_path_persists_and_reads_fixture_benchmark(self) -> None:
        fixture_payload = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        worker_payload = {
            "schema": role_intelligence.ROLE_BENCHMARK_OUTPUT_SCHEMA_ID,
            "target": {
                key: copy.deepcopy(fixture_payload["target"][key])
                for key in (
                    "raw_description",
                    "role_profile",
                    "capability_observations",
                )
            },
            "comparators": copy.deepcopy(fixture_payload["comparators"]),
            "gaps": [],
        }

        async def run_golden_path(database_path: Path) -> tuple[dict, dict, dict]:
            engine = create_async_engine(
                f"sqlite+aiosqlite:///{database_path.as_posix()}"
            )
            session = async_sessionmaker(engine, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                target = normalize_benchmark_document(
                    fixture_payload["target"], document_kind="target"
                )
                async with session() as db:
                    job = Job(
                        title=target["title"],
                        company=target["company"],
                        location=target["location"],
                        url=target["url"],
                        source="fixture",
                        raw_description=target["raw_description"],
                        hash_key="fixture-role-intelligence-operation-target",
                    )
                    db.add(job)
                    await db.commit()
                    await db.refresh(job)

                async def fake_runtime(runtime_id: str | None = None) -> dict:
                    return {
                        "runtime_id": "codex",
                        "version": "fixture-runtime",
                    }

                async def fake_deep_task(spec) -> dict:
                    return {
                        "structured": copy.deepcopy(worker_payload),
                        "runtime_version": "fixture-runtime",
                        "trace": {"fixture": True, "task_type": spec.task_type},
                    }

                with (
                    patch.object(role_intelligence, "async_session", session),
                    patch.object(operation_registry, "async_session", session),
                    patch.object(
                        role_intelligence,
                        "_compatible_runtime",
                        side_effect=fake_runtime,
                    ),
                    patch.object(
                        role_intelligence,
                        "execute_deep_task",
                        side_effect=fake_deep_task,
                    ),
                ):
                    build = await execute_operation(
                        "build_role_benchmark",
                        {"job_id": job.id, "runtime_id": "codex"},
                        surface="research_api",
                    )
                    self.assertTrue(build["ok"], build)
                    run_id = build["outputs"]["run_id"]
                    task = role_intelligence._LIVE_TASKS.get(run_id)
                    self.assertIsNotNone(task)
                    assert task is not None
                    await task

                    loaded = await execute_operation(
                        "get_role_benchmark",
                        {"run_id": run_id},
                        surface="research_api",
                    )
                    listed = await execute_operation(
                        "list_role_delta_signals",
                        {"run_id": run_id, "limit": 10},
                        surface="research_api",
                    )
                    return loaded, listed, build
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            loaded, listed, build = asyncio.run(
                run_golden_path(Path(directory) / "role-operation.db")
            )

        self.assertEqual(build["operation"], "build_role_benchmark")
        self.assertEqual(build["outputs"]["scheduled"], True)
        self.assertTrue(loaded["ok"], loaded)
        self.assertEqual(loaded["outputs"]["status"], "completed")
        self.assertEqual(loaded["outputs"]["valid_sample_count"], 20)
        self.assertEqual(len(loaded["outputs"]["signals"]), 5)
        self.assertEqual(
            [item["document_kind"] for item in loaded["outputs"]["documents"]].count(
                "target"
            ),
            1,
        )
        self.assertTrue(
            all(
                item["job_id"] is None
                for item in loaded["outputs"]["documents"]
                if item["document_kind"] == "comparator"
            )
        )
        self.assertTrue(listed["ok"], listed)
        self.assertEqual(listed["outputs"]["total"], 5)

    def test_operations_and_skill_share_the_role_intelligence_boundary(self) -> None:
        operation_names = {
            "get_job",
            "build_role_benchmark",
            "refresh_role_benchmark",
            "get_role_benchmark",
            "list_role_delta_signals",
        }
        skill = resolve_skill("role_intelligence")

        self.assertTrue(operation_names.issubset(OPERATIONS))
        self.assertEqual(OPERATIONS["build_role_benchmark"].group, "research")
        self.assertEqual(
            OPERATIONS["build_role_benchmark"].side_effects,
            ("external", "llm", "write"),
        )
        self.assertEqual(OPERATIONS["get_role_benchmark"].side_effects, ("read",))
        self.assertIsNotNone(skill)
        assert skill is not None
        self.assertEqual(skill.status, "native")
        self.assertTrue(
            (operation_names | {"get_profile", "list_profile_evidence"}).issubset(
                skill.allowed_tools
            )
        )


if __name__ == "__main__":
    unittest.main()
