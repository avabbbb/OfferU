from __future__ import annotations

import asyncio
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.chdir(BACKEND_DIR)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.services import batch_job_evaluations as evaluations


def _worker_result() -> dict:
    return {
        "score": 84,
        "recommendation": "match",
        "summary": "岗位要求与已确认的 Python 项目经历基本匹配。",
        "strengths": ["具有可核验的 Python 项目经历"],
        "gaps": ["没有可核验的 Kubernetes 经历"],
        "evidence": [
            {
                "source_ref": "profile_section:7",
                "claim": "候选人有 Python 项目经历",
                "kind": "candidate_fact",
            },
            {
                "source_ref": "job:11",
                "claim": "岗位要求 Python 与 Kubernetes",
                "kind": "job_requirement",
            },
        ],
        "next_actions": ["准备 Python 项目深挖问题"],
    }


def _batch_payload() -> dict:
    return {
        "runtime_id": "codex",
        "runtime_version": "codex-cli 0.144.1",
        "max_workers": 1,
        "profile_snapshot": {"name": "测试候选人"},
        "profile_evidence": [
            {
                "source_ref": "profile_section:7",
                "tier": "verified_fact",
                "normalized": {"skills": ["Python"]},
            }
        ],
        "jobs": [
            {
                "job_id": 11,
                "status": "pending",
                "review_status": "pending",
                "attempts": 0,
                "job_snapshot": {
                    "source_ref": "job:11",
                    "title": "后端工程师",
                    "description": "要求 Python 与 Kubernetes",
                },
            }
        ],
    }


class BatchJobEvaluationTests(unittest.TestCase):
    def test_validated_result_requires_known_evidence_sources(self) -> None:
        result = evaluations._validated_result(
            _worker_result(),
            allowed_source_refs={"profile_section:7", "job:11"},
        )

        self.assertEqual(result["schema"], evaluations.RESULT_SCHEMA)
        self.assertEqual(result["score"], 84)
        self.assertEqual(result["recommendation"], "match")

    def test_validated_result_rejects_unknown_source_and_coerced_score(self) -> None:
        unknown_source = _worker_result()
        unknown_source["evidence"][0]["source_ref"] = "profile_section:999"
        with self.assertRaises(ValueError):
            evaluations._validated_result(
                unknown_source,
                allowed_source_refs={"profile_section:7", "job:11"},
            )

        coerced_score = _worker_result()
        coerced_score["score"] = "84"
        with self.assertRaises(ValueError):
            evaluations._validated_result(
                coerced_score,
                allowed_source_refs={"profile_section:7", "job:11"},
            )

        extra_field = _worker_result()
        extra_field["unsupported"] = True
        with self.assertRaises(ValueError):
            evaluations._validated_result(
                extra_field,
                allowed_source_refs={"profile_section:7", "job:11"},
            )

    def test_store_round_trip_persists_batch_state(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = evaluations.BatchEvaluationStore(Path(directory))
            created = store.create(_batch_payload())
            store.update(
                created["id"],
                lambda payload: payload["jobs"][0].update(status="failed", error="worker failed"),
            )
            loaded = store.get(created["id"])
            listing = store.list()

        self.assertIsNotNone(loaded)
        assert loaded is not None
        self.assertEqual(loaded["jobs"][0]["status"], "failed")
        self.assertEqual(listing["total"], 1)
        self.assertEqual(listing["items"][0]["counts"], {"failed": 1})

    def test_execute_job_stores_review_candidate_and_audit_trace_only(self) -> None:
        async def run() -> tuple[dict, AsyncMock, Path]:
            temporary = tempfile.TemporaryDirectory()
            self.addCleanup(temporary.cleanup)
            root = Path(temporary.name)
            store = evaluations.BatchEvaluationStore(root / "batches")
            batch = store.create(_batch_payload())
            worker = {
                "runtime_id": "codex",
                "runtime_version": "codex-cli 0.144.1",
                "structured": _worker_result(),
                "trace": {"elapsed_ms": 42, "schema_enforced": True},
            }
            runner = AsyncMock(return_value=worker)
            with patch.object(evaluations, "batch_evaluation_store", store), patch.object(
                evaluations,
                "_WORKER_DIR",
                root / "workers",
            ), patch.object(evaluations, "execute_deep_task", runner):
                await evaluations._execute_job(batch["id"], 11, asyncio.Semaphore(1))
            loaded = store.get(batch["id"])
            assert loaded is not None
            return loaded, runner, root

        loaded, runner, root = asyncio.run(run())
        task = loaded["jobs"][0]
        input_path = Path(task["input_path"])

        self.assertEqual(task["status"], "completed")
        self.assertEqual(task["review_status"], "candidate")
        self.assertEqual(task["candidate_result"]["schema"], evaluations.RESULT_SCHEMA)
        self.assertNotIn("artifact_id", task)
        self.assertTrue(task["input_sha256"])
        self.assertEqual(task["execution_trace"]["input_sha256"], task["input_sha256"])
        self.assertTrue(input_path.is_file())
        self.assertTrue(input_path.is_relative_to(root))
        self.assertEqual(
            runner.await_args.args[0].output_schema,
            evaluations.JOB_EVALUATION_OUTPUT_SCHEMA,
        )

    def test_resume_replays_failed_jobs_but_keeps_completed_candidates(self) -> None:
        async def run() -> tuple[dict, Mock]:
            temporary = tempfile.TemporaryDirectory()
            self.addCleanup(temporary.cleanup)
            store = evaluations.BatchEvaluationStore(Path(temporary.name))
            payload = _batch_payload()
            payload["jobs"] = [
                {
                    **payload["jobs"][0],
                    "status": "completed",
                    "review_status": "candidate",
                    "candidate_result": {"marker": "keep"},
                },
                {
                    **payload["jobs"][0],
                    "job_id": 12,
                    "status": "failed",
                    "review_status": "not_available",
                    "error": "worker failed",
                    "candidate_result": {"marker": "discard"},
                },
            ]
            batch = store.create(payload)
            schedule = Mock()
            with patch.object(evaluations, "batch_evaluation_store", store), patch.object(
                evaluations,
                "_LIVE_TASKS",
                set(),
            ), patch.object(evaluations, "_schedule", schedule):
                response = await evaluations.resume_batch_job_evaluation(batch["id"])
            loaded = store.get(batch["id"])
            assert loaded is not None
            return {"response": response, "batch": loaded}, schedule

        result, schedule = asyncio.run(run())
        completed, retried = result["batch"]["jobs"]

        self.assertTrue(result["response"]["accepted"])
        self.assertEqual(completed["status"], "completed")
        self.assertEqual(completed["candidate_result"], {"marker": "keep"})
        self.assertEqual(retried["status"], "pending")
        self.assertEqual(retried["review_status"], "pending")
        self.assertNotIn("candidate_result", retried)
        schedule.assert_called_once_with(result["batch"]["id"])


if __name__ == "__main__":
    unittest.main()
