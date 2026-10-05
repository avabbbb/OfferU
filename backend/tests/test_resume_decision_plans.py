"""Focused tests for Proposal v2 resume decision plans.

Covers ``app.services.resume_decision_plans``: semantic grouping produces one
``review_resume_proposal_items`` node per DecisionGroup (never one node per
bullet), proposal/resume binding, change-id partition and freshness rules,
target revision evidence, and fail-closed run-context binding.

Isolation: a temp SQLite database (conftest redirects tempfile to the data
drive) with ``async_session`` patched into the modules under test.  No real
DB, no network, no external effects.
"""

from __future__ import annotations

import asyncio
import hashlib
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from typing import Any
from unittest.mock import patch

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import app.ops as operation_registry  # noqa: E402
import app.services.agent_run_state as run_state  # noqa: E402
import app.services.decision_plans as decision_plans  # noqa: E402
import app.services.proposal_plan_store as plan_store  # noqa: E402
import app.services.proposal_plan_sources as plan_sources  # noqa: E402
import app.services.resume_decision_plans as resume_plans  # noqa: E402
from app.database import Base  # noqa: E402
from app.models.models import (  # noqa: E402
    Job,
    Profile,
    ProfileSection,
    Resume,
    ResumeOptimizationProposal,
    ResumeSection,
)
from app.ops import execute_operation, set_operation_run_context  # noqa: E402
from app.services.agent_run_state import create_agent_run  # noqa: E402


async def _make_run() -> str:
    run = await create_agent_run(
        conversation_id=f"conv_{uuid.uuid4().hex[:8]}",
        goal="resume decision plan test",
        mode="general",
        skill_snapshot={"allowed_tools": ["prepare_proposal_plan", "propose_resume_decision_plan", "review_resume_proposal_items"]},
        actions=[],
    )
    return str(run["id"])


def _change(change_id: str, title: str, index: int) -> dict[str, Any]:
    before = {
        "section_type": "experience",
        "title": title,
        "sort_order": index,
        "visible": True,
        "content_json": [{"company": "Example", "description": f"old {title}"}],
        "source_section_ids": [],
    }
    after = {
        **before,
        "content_json": [{"company": "Example", "description": f"new {title}"}],
    }
    return {
        "change_id": change_id,
        "change_type": "modified",
        "section_key": f"experience:{title}",
        "section_type": "experience",
        "title": title,
        "source_section_ids": [],
        "before": before,
        "after": after,
    }


async def _seed(
    sessions,
    suffix: str,
    *,
    change_count: int = 8,
    proposal_status: str = "ready",
    fact_gate_status: str = "passed",
    bind_workspace: bool = True,
    reviewed: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    async with sessions() as db:
        profile = Profile(name=f"候选人-{suffix}", is_default=True)
        job = Job(
            title="AI Product Manager",
            company=f"OfferU Test {suffix}",
            raw_description="Build product evaluation workflows.",
            hash_key=hashlib.sha256(suffix.encode()).hexdigest(),
        )
        db.add_all([profile, job])
        await db.flush()
        source = ProfileSection(
            profile_id=profile.id,
            section_type="experience",
            title="项目经历",
            tier="verified_fact",
            status="active",
            content_json={"normalized": {"description": "old evidence"}},
        )
        db.add(source)
        await db.flush()
        resume = Resume(
            user_name=profile.name,
            title=f"{job.company} - {job.title} 定制简历",
            source_mode="job_tailored_workspace",
            is_primary=False,
            source_profile_id=profile.id,
            target_job_id=job.id,
        )
        section = ResumeSection(
            section_type="experience",
            title="工作经历",
            sort_order=0,
            visible=True,
            content_json=[{"company": "Example", "description": "old 工作经历"}],
            source_section_ids=[source.id],
        )
        resume.sections.append(section)
        db.add(resume)
        await db.flush()
        change_ids = [f"change-{suffix}-{index}" for index in range(change_count)]
        proposal = ResumeOptimizationProposal(
            proposal_id=f"prop_{suffix}",
            job_id=job.id,
            profile_id=profile.id,
            status=proposal_status,
            source_section_ids_json=[source.id],
            source_snapshot_hash="",
            research_snapshot_hash="",
            original_rows_json=[],
            proposed_rows_json=[],
            diff_json=[
                _change(change_id, f"段落{index}", index)
                for index, change_id in enumerate(change_ids)
            ],
            fact_gates_json={"status": fact_gate_status},
            strategy_json={},
            presentation_json={},
            trace_json={},
            item_reviews_json=reviewed or {},
            workspace_resume_id=resume.id if bind_workspace else None,
            workspace_snapshot_hash="",
        )
        db.add(proposal)
        await db.commit()
        return {
            "job_id": job.id,
            "profile_id": profile.id,
            "resume_id": resume.id,
            "proposal_id": proposal.proposal_id,
            "change_ids": change_ids,
        }


def _groups(change_ids: list[str]) -> list[dict[str, Any]]:
    """Three semantic groups: positioning, core experience, skills/projects."""
    return [
        {
            "title": "定位与摘要",
            "summary": "更新摘要定位以匹配岗位重点",
            "change_ids": change_ids[:1],
            "dependency_indices": [],
            "display": {"reason": "positioning"},
        },
        {
            "title": "核心经历",
            "summary": "重写与 JD 要求直接相关的经历描述",
            "change_ids": change_ids[1:6],
            "dependency_indices": [0],
            "display": {},
        },
        {
            "title": "技能与项目",
            "summary": "补强技能与开源项目证据",
            "change_ids": change_ids[6:],
            "dependency_indices": [],
            "display": {},
        },
    ]


class _IsolatedDb:
    def __init__(self, directory: str) -> None:
        self.path = Path(directory) / f"resume_plan_{uuid.uuid4().hex}.db"
        self.engine = create_async_engine(
            f"sqlite+aiosqlite:///{self.path.as_posix()}"
        )
        self.session = async_sessionmaker(self.engine, expire_on_commit=False)
        self._patches: list[Any] = []

    async def __aenter__(self) -> "_IsolatedDb":
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        for module in (
            resume_plans,
            decision_plans,
            plan_store,
            plan_sources,
            run_state,
            operation_registry,
        ):
            patcher = patch.object(module, "async_session", self.session)
            patcher.start()
            self._patches.append(patcher)
        return self

    async def __aexit__(self, *exc: Any) -> None:
        for patcher in self._patches:
            patcher.stop()
        await self.engine.dispose()


class ResumeDecisionPlanTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)

    def _db(self) -> _IsolatedDb:
        return _IsolatedDb(self._tmp.name)

    async def _propose(
        self,
        fixture: dict[str, Any],
        groups: list[dict[str, Any]],
        *,
        run_id: str | None = None,
    ) -> dict[str, Any]:
        bound_run = run_id if run_id is not None else await _make_run()
        with set_operation_run_context(bound_run):
            return await resume_plans.propose_resume_decision_plan(
                proposal_id=fixture["proposal_id"],
                resume_id=fixture["resume_id"],
                groups=groups,
            )

    async def _expect_error(
        self,
        fixture: dict[str, Any],
        groups: Any,
        *,
        run_id: str | None = None,
        with_context: bool = True,
    ) -> str:
        try:
            if with_context:
                await self._propose(fixture, groups, run_id=run_id)
            else:
                await resume_plans.propose_resume_decision_plan(
                    proposal_id=fixture["proposal_id"],
                    resume_id=fixture["resume_id"],
                    groups=groups,
                )
        except Exception as exc:  # noqa: BLE001 - assert on message text
            return str(exc)
        self.fail("propose_resume_decision_plan unexpectedly succeeded")

    # ------------------------------------------------------------------
    def test_semantic_groups_create_one_node_per_group(self) -> None:
        async def flow() -> dict[str, Any]:
            async with self._db() as db:
                fixture = await _seed(db.session, "grouping")
                run_id = await _make_run()
                plan = await self._propose(fixture, _groups(fixture["change_ids"]), run_id=run_id)
                return {"plan": plan, "fixture": fixture}

        outcome = asyncio.run(flow())
        plan = outcome["plan"]["plan"]
        self.assertEqual(len(plan["groups"]), 3)
        self.assertTrue(plan["digest"])
        for index, group in enumerate(plan["groups"]):
            self.assertEqual(group["ordinal"], index)
            # Never one node per bullet: each semantic group holds exactly one
            # atomic review_resume_proposal_items accept node.
            self.assertEqual(len(group["nodes"]), 1)
            node = group["nodes"][0]
            self.assertEqual(node["operation"], "review_resume_proposal_items")
            self.assertEqual(node["args"]["action"], "accept")
            self.assertEqual(node["args"]["resume_id"], outcome["fixture"]["resume_id"])
            self.assertGreaterEqual(len(node["args"]["change_ids"]), 1)
            self.assertEqual(node["status"], "pending")
        dependents = plan["groups"][1]["dependency_group_ids"]
        self.assertEqual(dependents, [plan["groups"][0]["id"]])
        flattened = [
            change_id
            for group in plan["groups"]
            for change_id in group["display"]["change_ids"]
        ]
        self.assertEqual(sorted(flattened), sorted(outcome["fixture"]["change_ids"]))

    # ------------------------------------------------------------------
    def test_node_target_carries_revision_evidence(self) -> None:
        async def flow() -> dict[str, Any]:
            async with self._db() as db:
                fixture = await _seed(db.session, "evidence")
                return await self._propose(fixture, _groups(fixture["change_ids"]))

        plan = asyncio.run(flow())["plan"]
        node = plan["groups"][0]["nodes"][0]
        sources = node["source_versions"]
        resume_key = f"resume:{node['args']['resume_id']}"
        self.assertIn(resume_key, sources)
        self.assertIn(f"proposal:{node['args']['proposal_id']}", sources)
        self.assertRegex(sources[resume_key], r"^[0-9a-f]{64}$")
        self.assertTrue(node["display"]["changes"])
        self.assertTrue(plan["digest"])

    # ------------------------------------------------------------------
    def test_duplicate_change_id_across_groups_rejected(self) -> None:
        async def flow() -> str:
            async with self._db() as db:
                fixture = await _seed(db.session, "dup")
                groups = _groups(fixture["change_ids"])
                groups[0]["change_ids"].append(fixture["change_ids"][3])
                return await self._expect_error(fixture, groups)

        message = asyncio.run(flow())
        self.assertIn("只能属于一个语义分组", message)

    # ------------------------------------------------------------------
    def test_unknown_change_id_rejected(self) -> None:
        async def flow() -> str:
            async with self._db() as db:
                fixture = await _seed(db.session, "unknown")
                groups = _groups(fixture["change_ids"])
                groups[0]["change_ids"] = ["change-not-real"]
                return await self._expect_error(fixture, groups)

        self.assertIn("不存在于提案差异中", asyncio.run(flow()))

    # ------------------------------------------------------------------
    def test_already_reviewed_change_rejected(self) -> None:
        async def flow() -> str:
            async with self._db() as db:
                fixture = await _seed(
                    db.session,
                    "reviewed",
                    reviewed={
                        "change-reviewed-2": {
                            "action": "accept",
                            "reviewed_at": "2026-10-05T00:00:00",
                        }
                    },
                )
                return await self._expect_error(fixture, _groups(fixture["change_ids"]))

        self.assertIn("已有审核结果", asyncio.run(flow()))

    # ------------------------------------------------------------------
    def test_unbound_proposal_rejected(self) -> None:
        async def flow() -> str:
            async with self._db() as db:
                fixture = await _seed(db.session, "unbound", bind_workspace=False)
                return await self._expect_error(fixture, _groups(fixture["change_ids"]))

        self.assertIn("尚未绑定当前 Resume Workspace", asyncio.run(flow()))

    # ------------------------------------------------------------------
    def test_fact_gate_blocked_rejected(self) -> None:
        async def flow() -> str:
            async with self._db() as db:
                fixture = await _seed(db.session, "blocked", fact_gate_status="blocked")
                return await self._expect_error(fixture, _groups(fixture["change_ids"]))

        self.assertIn("blocked", asyncio.run(flow()))

    # ------------------------------------------------------------------
    def test_terminal_proposal_rejected(self) -> None:
        async def flow() -> str:
            async with self._db() as db:
                fixture = await _seed(db.session, "terminal", proposal_status="stale")
                return await self._expect_error(fixture, _groups(fixture["change_ids"]))

        self.assertIn("终态", asyncio.run(flow()))

    # ------------------------------------------------------------------
    def test_late_dependency_index_rejected(self) -> None:
        async def flow() -> str:
            async with self._db() as db:
                fixture = await _seed(db.session, "dep")
                groups = _groups(fixture["change_ids"])
                groups[0]["dependency_indices"] = [1]
                return await self._expect_error(fixture, groups)

        self.assertIn("更早的分组", asyncio.run(flow()))

    # ------------------------------------------------------------------
    def test_missing_run_context_fails_closed(self) -> None:
        async def flow() -> str:
            async with self._db() as db:
                fixture = await _seed(db.session, "nocontext")
                return await self._expect_error(
                    fixture, _groups(fixture["change_ids"]), with_context=False
                )

        self.assertIn("Agent Run 上下文", asyncio.run(flow()))

    # ------------------------------------------------------------------
    def test_registry_envelope_path(self) -> None:
        """The registered Operation executes and returns decision_plan."""

        async def flow() -> dict[str, Any]:
            async with self._db() as db:
                fixture = await _seed(db.session, "envelope")
                run_id = await _make_run()
                with set_operation_run_context(run_id):
                    ok_result = await execute_operation(
                        "propose_resume_decision_plan",
                        {
                            "proposal_id": fixture["proposal_id"],
                            "resume_id": fixture["resume_id"],
                            "groups": _groups(fixture["change_ids"]),
                        },
                        surface="embedded",
                    )
                # Without the host-bound run context the same call fails closed.
                no_ctx = await execute_operation(
                    "propose_resume_decision_plan",
                    {
                        "proposal_id": fixture["proposal_id"],
                        "resume_id": fixture["resume_id"],
                        "groups": _groups(fixture["change_ids"]),
                    },
                    surface="embedded",
                )
                return {"ok": ok_result, "no_ctx": no_ctx}

        outcome = asyncio.run(flow())
        self.assertTrue(outcome["ok"]["ok"], outcome["ok"])
        plan = outcome["ok"]["outputs"]["plan"]
        self.assertEqual(len(plan["groups"]), 3)
        self.assertFalse(outcome["no_ctx"]["ok"])
        self.assertIn("Agent Run 上下文", ";".join(outcome["no_ctx"]["errors"]))

    # ------------------------------------------------------------------
    def test_identical_plan_for_same_run_returns_existing_v2_plan(self) -> None:
        async def flow() -> dict[str, Any]:
            async with self._db() as db:
                fixture = await _seed(db.session, "conflict")
                run_id = await _make_run()
                first = await self._propose(fixture, _groups(fixture["change_ids"]), run_id=run_id)
                second = await self._propose(fixture, _groups(fixture["change_ids"]), run_id=run_id)
                return {"first": first, "second": second}

        result = asyncio.run(flow())
        self.assertTrue(result["second"]["duplicate"])
        self.assertEqual(result["first"]["plan_id"], result["second"]["plan_id"])


if __name__ == "__main__":
    unittest.main()
