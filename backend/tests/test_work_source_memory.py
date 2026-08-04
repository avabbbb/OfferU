from __future__ import annotations

import asyncio
import os
from pathlib import Path
import secrets
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.chdir(BACKEND_DIR)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import select

from app.database import async_session, init_db
from app.models.models import (
    CareerSource,
    LearningObservation,
    MemoryProposal,
    ProfileSection,
    WorkSource,
)
from app.ops import OPERATIONS
from app.services.agent_skill_registry import resolve_skill
from app.services.career_memory import list_memory_inbox, review_memory_proposal
from app.services.work_sources import (
    _execute_sync,
    _secret_like,
    _validated_result,
    get_work_source_sync_run,
    invalidate_work_source,
    register_work_source,
    start_work_source_sync,
)

READ_OPERATIONS = frozenset(
    name for name, operation in OPERATIONS.items()
    if not operation.is_mutation
)
MUTATION_OPERATIONS = frozenset(
    name for name, operation in OPERATIONS.items()
    if operation.is_mutation
)


_RUN_SALT = secrets.token_hex(8)


def _uniq(label: str) -> str:
    return f"{label}-{_RUN_SALT}-{secrets.token_hex(4)}"


def _worker_result(title: str) -> dict:
    return {
        "runtime_version": "codex-cli test",
        "structured": {
            "summary": "新增了可审计的工作源同步能力。",
            "accomplishments": ["实现工作源增量指纹和显式数据授权。"],
            "current_focus": ["继续补充故障恢复场景。"],
            "risks": ["尚未由使用者确认成为职业事实。"],
            "memory_candidates": [
                {
                    "target_tier": "verified_fact",
                    "section_type": "project",
                    "title": title,
                    "statement": "实现了可审计的工作源增量同步能力。",
                    "reason": "本次变更包含完整实现文件，但仍需使用者确认。",
                    "completion_status": "completed",
                    "supporting_paths": ["feature.py"],
                    "impact": ["可用于后续项目经历整理"],
                }
            ],
        },
        "trace": {
            "schema_enforced": True,
            "model_called": True,
            "sandbox": "read-only",
        },
    }


class WorkSourceMemoryTests(unittest.TestCase):
    def test_sensitive_files_are_excluded_and_deleted_only_evidence_is_not_fact(self) -> None:
        self.assertTrue(_secret_like("config/client_secret.json"))
        self.assertTrue(_secret_like("auth/refresh_token.txt"))
        self.assertFalse(_secret_like("src/tokenizer.py"))
        structured = _worker_result("删除证据")["structured"]
        validated = _validated_result(
            structured,
            [{"path": "feature.py", "change": "deleted"}],
        )
        self.assertEqual(
            validated["memory_candidates"][0]["target_tier"],
            "career_hypothesis",
        )

    def test_registry_and_skill_expose_one_review_gated_work_source_boundary(self) -> None:
        expected = {
            "register_work_source",
            "list_work_sources",
            "get_work_source",
            "start_work_source_sync",
            "list_work_source_sync_runs",
            "get_work_source_sync_run",
            "resume_work_source_sync",
            "consolidate_memory_observations",
            "invalidate_work_source",
        }
        self.assertTrue(expected.issubset(OPERATIONS))
        self.assertTrue(
            OPERATIONS["start_work_source_sync"].schema()["requires_confirmation"]
        )
        self.assertIn(
            "work_source_content:model",
            OPERATIONS["start_work_source_sync"].permissions,
        )
        skill = resolve_skill("工作源")
        self.assertIsNotNone(skill)
        assert skill is not None
        self.assertEqual(skill.id, "work_source_sync")
        self.assertTrue(expected.issubset(skill.allowed_tools))
        self.assertTrue(skill.allowed_tools.issubset(OPERATIONS))
        readable = {
            "list_work_sources",
            "get_work_source",
            "list_work_source_sync_runs",
            "get_work_source_sync_run",
        }
        confirmable = expected - readable
        self.assertTrue(readable.issubset(READ_OPERATIONS))
        self.assertTrue(confirmable.issubset(MUTATION_OPERATIONS))
        self.assertTrue(expected.issubset(OPERATIONS))

    def test_register_is_idempotent_and_requires_an_existing_directory(self) -> None:
        async def run(root: str) -> tuple[dict, dict]:
            await init_db()
            first = await register_work_source(
                name=_uniq("work-source"),
                root_path=root,
                source_type="directory",
            )
            second = await register_work_source(
                name="重复登记",
                root_path=root,
                source_type="directory",
            )
            return first, second

        with tempfile.TemporaryDirectory() as directory:
            first, second = asyncio.run(run(directory))

        self.assertFalse(first["duplicate"])
        self.assertTrue(second["duplicate"])
        self.assertEqual(first["id"], second["id"])

    def test_sync_requires_explicit_model_data_consent(self) -> None:
        async def run(root: str) -> None:
            await init_db()
            source = await register_work_source(
                name=_uniq("consent"),
                root_path=root,
            )
            await start_work_source_sync(
                work_source_id=source["id"],
                data_consent=False,
            )

        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                asyncio.run(run(directory))

    def test_incremental_sync_creates_observation_and_inbox_proposal_only(self) -> None:
        async def run(root: str, title: str) -> tuple[dict, dict, int]:
            await init_db()
            source = await register_work_source(
                name=_uniq("sync"),
                root_path=root,
            )
            with patch(
                "app.services.work_sources._schedule",
                return_value=None,
            ):
                run = await start_work_source_sync(
                    work_source_id=source["id"],
                    data_consent=True,
                )
            with patch(
                "app.services.work_sources.execute_deep_task",
                new=AsyncMock(return_value=_worker_result(title)),
            ):
                await _execute_sync(run["run_id"])
            completed = await get_work_source_sync_run(run["run_id"])
            inbox = await list_memory_inbox(status="pending", limit=500)
            proposal = next(item for item in inbox["items"] if item["title"] == title)
            async with async_session() as db:
                profile_count = len(
                    (
                        await db.execute(
                            select(ProfileSection.id).where(ProfileSection.title == title)
                        )
                    ).scalars().all()
                )
            return completed, proposal, profile_count

        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "feature.py").write_text(
                "def completed_feature():\n    return 'done'\n",
                encoding="utf-8",
            )
            completed, proposal, profile_count = asyncio.run(
                run(directory, _uniq("工作源候选"))
            )

        self.assertEqual(completed["status"], "completed")
        self.assertIsNotNone(completed["observation_id"])
        self.assertEqual(proposal["status"], "pending")
        self.assertEqual(proposal["target_tier"], "verified_fact")
        self.assertEqual(profile_count, 0)
        self.assertFalse(completed["trace"]["raw_source_stored"])

    def test_unchanged_second_sync_skips_model_and_duplicate_observation(self) -> None:
        async def run(root: str) -> tuple[dict, int]:
            await init_db()
            source = await register_work_source(
                name=_uniq("no-change"),
                root_path=root,
            )
            title = _uniq("候选")
            with patch("app.services.work_sources._schedule", return_value=None):
                first = await start_work_source_sync(
                    work_source_id=source["id"],
                    data_consent=True,
                )
            with patch(
                "app.services.work_sources.execute_deep_task",
                new=AsyncMock(return_value=_worker_result(title)),
            ):
                await _execute_sync(first["run_id"])
            with patch("app.services.work_sources._schedule", return_value=None):
                second = await start_work_source_sync(
                    work_source_id=source["id"],
                    data_consent=True,
                )
            model = AsyncMock(side_effect=AssertionError("无变化时不应调用模型"))
            with patch("app.services.work_sources.execute_deep_task", new=model):
                await _execute_sync(second["run_id"])
            completed = await get_work_source_sync_run(second["run_id"])
            async with async_session() as db:
                observation_count = len(
                    (
                        await db.execute(
                            select(LearningObservation.id)
                            .join(
                                CareerSource,
                                CareerSource.id == LearningObservation.source_id,
                            )
                            .where(CareerSource.external_id == f"work-source:{source['id']}")
                        )
                    ).scalars().all()
                )
            return completed, observation_count

        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "feature.py").write_text("VALUE = 1\n", encoding="utf-8")
            completed, observation_count = asyncio.run(run(directory))

        self.assertEqual(completed["status"], "completed")
        self.assertTrue(completed["result"]["no_change"])
        self.assertFalse(completed["trace"]["model_called"])
        self.assertEqual(observation_count, 1)

    def test_source_invalidation_scrubs_run_and_cascades_accepted_memory(self) -> None:
        async def run(root: str, title: str) -> tuple[dict, dict, dict, bool]:
            await init_db()
            source = await register_work_source(
                name=_uniq("invalidate"),
                root_path=root,
            )
            with patch("app.services.work_sources._schedule", return_value=None):
                run = await start_work_source_sync(
                    work_source_id=source["id"],
                    data_consent=True,
                )
            with patch(
                "app.services.work_sources.execute_deep_task",
                new=AsyncMock(return_value=_worker_result(title)),
            ):
                await _execute_sync(run["run_id"])
            inbox = await list_memory_inbox(status="pending", limit=500)
            proposal = next(item for item in inbox["items"] if item["title"] == title)
            accepted = await review_memory_proposal(
                proposal_id=proposal["id"],
                action="accept",
            )
            invalidated = await invalidate_work_source(
                work_source_id=source["id"],
                reason="使用者撤销本地工作源授权。",
            )
            stored_run = await get_work_source_sync_run(run["run_id"])
            async with async_session() as db:
                stored_source = (
                    await db.execute(
                        select(WorkSource).where(WorkSource.id == source["id"])
                    )
                ).scalar_one()
                stored_proposal = (
                    await db.execute(
                        select(MemoryProposal).where(MemoryProposal.id == proposal["id"])
                    )
                ).scalar_one()
                stored_section = (
                    await db.execute(
                        select(ProfileSection).where(
                            ProfileSection.id == accepted["applied_profile_section_id"]
                        )
                    )
                ).scalar_one_or_none()
            return (
                invalidated,
                {
                    "status": stored_source.status,
                    "name": stored_source.name,
                    "root_path": stored_source.root_path,
                    "checkpoint": stored_source.checkpoint_json,
                },
                {
                    "run": stored_run,
                    "proposal_status": stored_proposal.status,
                },
                stored_section is None,
            )

        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "feature.py").write_text("VALUE = 2\n", encoding="utf-8")
            invalidated, source, derived, section_removed = asyncio.run(
                run(directory, _uniq("撤销候选"))
            )

        self.assertTrue(invalidated["invalidated"])
        self.assertEqual(source["status"], "invalidated")
        self.assertEqual(source["name"], "")
        self.assertEqual(source["root_path"], "")
        self.assertEqual(source["checkpoint"], {})
        self.assertEqual(derived["run"]["result"], {})
        self.assertEqual(derived["proposal_status"], "invalidated")
        self.assertTrue(section_removed)


if __name__ == "__main__":
    unittest.main()
