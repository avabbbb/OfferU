from __future__ import annotations

import asyncio
from datetime import datetime
import hashlib
import inspect
import os
from pathlib import Path
import secrets
import sys
import unittest
from unittest.mock import AsyncMock, patch
from fastapi import HTTPException

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.chdir(BACKEND_DIR)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import select, update

from app.database import async_session, init_db
from app.agents import optimize_agent
from app import mcp_server
from app.models.models import (
    Job,
    JobResearchRun,
    LearningObservation,
    Profile,
    ProfileSection,
    ResearchDossier,
    ResearchEvidenceSnapshot,
    ResearchFinding,
    Resume,
    ResumeOptimizationProposal,
    ResumeVersion,
)
from app.ops import OPERATIONS
from app.routes.agent import SYSTEM_PROMPT as WEB_AGENT_SYSTEM_PROMPT
from app.routes import optimize as optimize_route
from app.services import coding_agent_runtime, resume_optimization
from app.services.agent_skill_registry import resolve_skill
from app.services.resume_fact_gates import validate_resume_fact_gates

READ_OPERATIONS = frozenset(
    name for name, operation in OPERATIONS.items()
    if not operation.is_mutation
)
MUTATION_OPERATIONS = frozenset(
    name for name, operation in OPERATIONS.items()
    if operation.is_mutation
)


_RUN_SALT = secrets.token_hex(8)
_RESUME_OPERATIONS = {
    "prepare_resume_optimization",
    "list_resume_optimizations",
    "get_resume_optimization",
    "review_resume_optimization",
}


def _uniq(label: str) -> str:
    return f"{label}-{_RUN_SALT}-{secrets.token_hex(4)}"


class ResumeOptimizationContractTests(unittest.TestCase):
    def test_resume_operations_share_one_registry_boundary(self) -> None:
        skill = resolve_skill("tailor_resume")

        self.assertTrue(_RESUME_OPERATIONS.issubset(OPERATIONS))
        self.assertTrue(_RESUME_OPERATIONS.issubset(OPERATIONS))
        self.assertNotIn("generate_resume", OPERATIONS)
        self.assertEqual(
            {"list_resume_optimizations", "get_resume_optimization"}
            & _RESUME_OPERATIONS,
            READ_OPERATIONS & _RESUME_OPERATIONS,
        )
        self.assertEqual(
            {"prepare_resume_optimization", "review_resume_optimization"},
            MUTATION_OPERATIONS & _RESUME_OPERATIONS,
        )
        self.assertIsNotNone(skill)
        assert skill is not None
        self.assertEqual(skill.status, "native")
        self.assertTrue(_RESUME_OPERATIONS.issubset(skill.allowed_tools))
        self.assertTrue(skill.allowed_tools.issubset(OPERATIONS))
        self.assertNotIn("generate_resume", optimize_agent.TOOL_REGISTRY)
        self.assertNotIn("generate_resume", WEB_AGENT_SYSTEM_PROMPT)
        self.assertFalse(hasattr(mcp_server, "generate_resume"))
        self.assertFalse(hasattr(optimize_route, "_create_generated_resume"))
        self.assertFalse(hasattr(optimize_route, "_generate_for_job"))
        self.assertIn("execute_operation", inspect.getsource(optimize_route.optimize_generate))
        self.assertNotIn(
            "bypassPermissions",
            inspect.getsource(coding_agent_runtime._runtime_args),
        )
        self.assertTrue(
            {"start_job_research", "get_job_research"}.issubset(
                optimize_agent.TOOL_REGISTRY
            )
        )
        self.assertIn(
            'event_type == "resume_proposal_prepared"',
            inspect.getsource(optimize_agent.chat_turn),
        )

    def test_combined_generation_is_explicitly_retired(self) -> None:
        request = optimize_route.OptimizeGenerateRequest(
            job_ids=[1, 2],
            mode="combined",
        )

        with self.assertRaises(HTTPException) as raised:
            asyncio.run(optimize_route.optimize_generate(request))

        self.assertEqual(getattr(raised.exception, "status_code", None), 409)

    def test_fixture_candidate_keeps_relevance_reorder_reviewable(self) -> None:
        async def run() -> dict:
            profile = Profile(id=7, name="Fixture candidate")
            sections = [
                ProfileSection(
                    id=1,
                    profile_id=7,
                    section_type="experience",
                    title="Delivery Operations",
                    sort_order=0,
                    tier="verified_fact",
                    status="active",
                    confidence=1.0,
                    content_json={
                        "normalized": {
                            "company": "Alpha",
                            "position": "Product Manager",
                            "description": "Managed team delivery and launch coordination.",
                        }
                    },
                ),
                ProfileSection(
                    id=2,
                    profile_id=7,
                    section_type="experience",
                    title="Model Evaluation",
                    sort_order=1,
                    tier="verified_fact",
                    status="active",
                    confidence=1.0,
                    content_json={
                        "normalized": {
                            "company": "Beta",
                            "position": "AI Product Manager",
                            "description": "Built a model evaluation workflow for an AI product.",
                        }
                    },
                ),
            ]
            return await resume_optimization._generate_candidate(
                profile=profile,
                sections=sections,
                jd_text="Build a model evaluation workflow for an AI product.",
                research_context={"data_mode": "fixture"},
            )

        candidate = asyncio.run(run())
        before = candidate["original_rows"][0]["content_json"]
        after = candidate["proposed_rows"][0]["content_json"]
        self.assertEqual([item["company"] for item in before], ["Alpha", "Beta"])
        self.assertEqual([item["company"] for item in after], ["Beta", "Alpha"])
        self.assertFalse(candidate["rewrite_applied"])

    def test_optimize_agent_reuses_latest_completed_research(self) -> None:
        async def run() -> tuple[dict, optimize_agent.OptimizeSession, AsyncMock]:
            session = optimize_agent.OptimizeSession(
                session_id="opt_research_reuse_contract",
                job_ids=[7],
            )
            registry = AsyncMock(
                side_effect=[
                    {
                        "total": 1,
                        "items": [
                            {"run_id": "research_reused", "status": "completed"}
                        ],
                    },
                    {"run_id": "research_reused", "status": "completed"},
                ]
            )
            with patch.object(optimize_agent, "_registry_outputs", registry):
                result = await optimize_agent._tool_get_job_research(
                    session,
                    {},
                    None,
                )
            return result, session, registry

        result, session, registry = asyncio.run(run())

        self.assertEqual(result["status"], "completed")
        self.assertEqual(session.research_run_id, "research_reused")
        self.assertEqual(registry.await_args_list[0].args[0], "list_job_research_runs")
        self.assertEqual(registry.await_args_list[1].args[0], "get_job_research")

    def test_fact_gate_requires_provenance_and_rejects_new_claims(self) -> None:
        source = {
            "id": 7,
            "title": "Example Company",
            "content_json": {
                "normalized": {
                    "company": "Example Company",
                    "position": "Backend Engineer",
                    "description": "Built a Python service for internal workflows.",
                }
            },
        }
        rows = [
            {
                "section_type": "experience",
                "title": "工作经历",
                "content_json": [
                    {
                        "company": "Invented Company",
                        "position": "Backend Engineer",
                        "description": "Improved throughput by 80% [待量化].",
                    }
                ],
                "source_section_ids": [],
            }
        ]

        result = validate_resume_fact_gates(
            rows,
            [source],
            strict_structured_facts=True,
        )
        issues = {item["issue"] for item in result["warnings"]}

        self.assertEqual(result["status"], "blocked")
        self.assertTrue(result["requires_user_confirmation"])
        self.assertTrue(
            {
                "missing_provenance",
                "unverified_metric",
                "unverified_fact",
                "unverified_org",
                "unverified_placeholder",
            }.issubset(issues)
        )


class ResumeOptimizationLifecycleTests(unittest.TestCase):
    def test_reviewed_session_candidate_stays_a_proposal(self) -> None:
        async def run() -> tuple[dict, int, int]:
            await init_db()
            fixture = await _create_fixture()
            candidate = _candidate_for(fixture["section"])
            before = candidate["original_rows"]
            after = candidate["proposed_rows"]
            async with async_session() as db:
                resumes_before = len((await db.execute(select(Resume.id))).scalars().all())

            with patch.object(
                resume_optimization,
                "_generate_candidate",
                AsyncMock(side_effect=AssertionError("session candidate must not rerun LLM")),
            ):
                prepared = await resume_optimization.prepare_resume_optimization(
                    job_id=fixture["job_id"],
                    research_run_id=fixture["run_id"],
                    candidate_rows=after,
                    candidate_original_rows=before,
                    source_session_id="opt_contract_session",
                )

            async with async_session() as db:
                resumes_after = len((await db.execute(select(Resume.id))).scalars().all())
            return prepared, resumes_before, resumes_after

        prepared, resumes_before, resumes_after = asyncio.run(run())

        self.assertEqual(prepared["trace"]["source_mode"], "reviewed_optimize_session")
        self.assertEqual(prepared["trace"]["source_session_id"], "opt_contract_session")
        self.assertIsNone(prepared["accepted_resume_id"])
        self.assertEqual(resumes_before, resumes_after)

    def test_optimize_agent_maps_acceptance_to_session_resume(self) -> None:
        async def run() -> tuple[dict, dict, optimize_agent.OptimizeSession, dict]:
            session = optimize_agent.OptimizeSession(
                session_id="opt_registry_contract",
                job_ids=[7],
                profile_id=3,
                reference_resume_id=5,
            )
            session.research_run_id = "job_research_contract"
            row = {
                "section_type": "experience",
                "title": "工作经历",
                "sort_order": 0,
                "visible": True,
                "content_json": [{"company": "Example", "description": "Built service."}],
                "source_section_ids": [11],
            }
            session.rows = [row]
            session.confirmed_sections = {
                "0": {
                    "section_title": "工作经历",
                    "section_type": "experience",
                    "content_json": row["content_json"],
                }
            }
            prepared_result = {
                "proposal_id": "resume_opt_contract",
                "status": "ready",
            }
            accepted_result = {
                "proposal_id": "resume_opt_contract",
                "status": "accepted",
                "accepted_resume_id": 99,
            }
            registry = AsyncMock(side_effect=[prepared_result, accepted_result])
            with patch.object(optimize_agent, "_registry_outputs", registry):
                prepared = await optimize_agent._tool_prepare_resume_optimization(
                    session,
                    {},
                    None,
                )
                accepted = await optimize_agent._tool_review_resume_optimization(
                    session,
                    {"action": "accept"},
                    None,
                )
            prepare_args = registry.await_args_list[0].args[1]
            return prepared, accepted, session, prepare_args

        prepared, accepted, session, prepare_args = asyncio.run(run())

        self.assertEqual(prepared["proposal_id"], "resume_opt_contract")
        self.assertEqual(accepted["accepted_resume_id"], 99)
        self.assertEqual(session.resume_optimization_proposal_id, "resume_opt_contract")
        self.assertEqual(session.resume_id, 99)
        self.assertEqual(prepare_args["profile_id"], 3)
        self.assertEqual(prepare_args["reference_resume_id"], 5)
        self.assertEqual(prepare_args["research_run_id"], "job_research_contract")

    def test_prepare_accept_and_reject_are_review_gated(self) -> None:
        async def run() -> tuple[dict, dict, dict, dict, dict]:
            await init_db()
            fixture = await _create_fixture()
            candidate = _candidate_for(fixture["section"])
            generator = AsyncMock(return_value=candidate)

            async with async_session() as db:
                resumes_before = len((await db.execute(select(Resume.id))).scalars().all())

            with patch.object(resume_optimization, "_generate_candidate", generator):
                prepared = await resume_optimization.prepare_resume_optimization(
                    job_id=fixture["job_id"],
                    research_run_id=fixture["run_id"],
                )

            async with async_session() as db:
                resumes_after_prepare = len(
                    (await db.execute(select(Resume.id))).scalars().all()
                )

            accepted = await resume_optimization.review_resume_optimization(
                proposal_id=prepared["proposal_id"],
                action="accept",
                note="逐项核对后接受。",
            )
            duplicate_accept = await resume_optimization.review_resume_optimization(
                proposal_id=prepared["proposal_id"],
                action="accept",
            )

            with patch.object(
                resume_optimization,
                "_generate_candidate",
                AsyncMock(return_value=candidate),
            ):
                second = await resume_optimization.prepare_resume_optimization(
                    job_id=fixture["job_id"],
                    research_run_id=fixture["run_id"],
                )
            rejected = await resume_optimization.review_resume_optimization(
                proposal_id=second["proposal_id"],
                action="reject",
                note="保留现有表述。",
            )

            async with async_session() as db:
                accepted_proposal = (
                    await db.execute(
                        select(ResumeOptimizationProposal).where(
                            ResumeOptimizationProposal.proposal_id
                            == prepared["proposal_id"]
                        )
                    )
                ).scalar_one()
                rejected_proposal = (
                    await db.execute(
                        select(ResumeOptimizationProposal).where(
                            ResumeOptimizationProposal.proposal_id
                            == second["proposal_id"]
                        )
                    )
                ).scalar_one()
                version = (
                    await db.execute(
                        select(ResumeVersion).where(
                            ResumeVersion.id
                            == accepted_proposal.accepted_resume_version_id
                        )
                    )
                ).scalar_one()
                observations = list(
                    (
                        await db.execute(
                            select(LearningObservation).where(
                                LearningObservation.observation_type.in_(
                                    {
                                        "resume_optimization_accepted",
                                        "resume_optimization_rejected",
                                    }
                                )
                            )
                        )
                    ).scalars().all()
                )

            return (
                {
                    "prepared": prepared,
                    "resumes_before": resumes_before,
                    "resumes_after_prepare": resumes_after_prepare,
                },
                accepted,
                duplicate_accept,
                rejected,
                {
                    "accepted_status": accepted_proposal.status,
                    "rejected_status": rejected_proposal.status,
                    "version": version.content_snapshot,
                    "observations": observations,
                },
            )

        prepared_state, accepted, duplicate, rejected, stored = asyncio.run(run())

        self.assertEqual(prepared_state["prepared"]["status"], "ready")
        self.assertIsNone(prepared_state["prepared"]["accepted_resume_id"])
        self.assertEqual(
            prepared_state["resumes_before"],
            prepared_state["resumes_after_prepare"],
        )
        self.assertEqual(accepted["status"], "accepted")
        self.assertIsInstance(accepted["accepted_resume_id"], int)
        self.assertIsInstance(accepted["accepted_resume_version_id"], int)
        self.assertFalse(accepted["duplicate"])
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual(rejected["status"], "rejected")
        self.assertIsNone(rejected["accepted_resume_id"])
        self.assertEqual(stored["accepted_status"], "accepted")
        self.assertEqual(stored["rejected_status"], "rejected")
        self.assertEqual(
            stored["version"]["provenance"]["proposal_id"],
            accepted["proposal_id"],
        )
        matching_observations = [
            item
            for item in stored["observations"]
            if (item.content_json or {}).get("proposal_id")
            in {accepted["proposal_id"], rejected["proposal_id"]}
        ]
        self.assertEqual(len(matching_observations), 2)
        self.assertTrue(
            all(
                (item.content_json or {}).get("career_fact") is False
                for item in matching_observations
            )
        )


async def _create_fixture() -> dict:
    token = _uniq("resume-opt")
    async with async_session() as db:
        # 先复位既有默认标记：测试候选档案不应该是全局默认档案，
        # 否则多默认档案会让 get_profile / list_profile_evidence 报
        # MultipleResultsFound，污染后续测试与应用运行。
        await db.execute(update(Profile).values(is_default=False))
        profile = Profile(
            name=f"候选人-{token}",
            is_default=True,
            base_info_json={"email": f"{token}@example.com"},
        )
        db.add(profile)
        await db.flush()
        section = ProfileSection(
            profile_id=profile.id,
            section_type="experience",
            title=f"Example Company {token}",
            sort_order=0,
            tier="verified_fact",
            source="manual",
            confidence=1.0,
            content_json={
                "normalized": {
                    "company": f"Example Company {token}",
                    "position": "Backend Engineer",
                    "description": "Built a Python service for internal workflows.",
                }
            },
        )
        job = Job(
            title="Senior Backend Engineer",
            company=f"Target Company {token}",
            raw_description="Build reliable Python services and data workflows.",
            source="test",
            hash_key=hashlib.sha256(token.encode("utf-8")).hexdigest(),
        )
        db.add_all([section, job])
        await db.flush()

        company_dossier = ResearchDossier(
            dossier_key=_uniq("company-dossier"),
            dossier_type="company",
            company_name=job.company,
        )
        role_dossier = ResearchDossier(
            dossier_key=_uniq("role-dossier"),
            dossier_type="role",
            company_name=job.company,
            job_id=job.id,
        )
        db.add_all([company_dossier, role_dossier])
        await db.flush()

        run_id = _uniq("research-run")
        run = JobResearchRun(
            run_id=run_id,
            job_id=job.id,
            company_dossier_id=company_dossier.id,
            role_dossier_id=role_dossier.id,
            status="completed",
            review_status="accepted",
            result_json={"gaps": []},
            completed_at=datetime.utcnow(),
        )
        db.add(run)
        await db.flush()
        db.add_all(
            [
                ResearchEvidenceSnapshot(
                    run_id=run_id,
                    dossier_id=role_dossier.id,
                    source_ref="S1",
                    url="https://careers.example/backend",
                    title="Backend role",
                    publisher="Target Company",
                    source_class="official_job",
                    excerpt="The role builds reliable Python services.",
                    content_hash=hashlib.sha256(
                        f"evidence-{token}".encode("utf-8")
                    ).hexdigest(),
                ),
                ResearchFinding(
                    run_id=run_id,
                    dossier_id=role_dossier.id,
                    finding_type="role_requirement",
                    statement="The role requires reliable Python services.",
                    details_json={},
                    source_refs_json=["S1"],
                    evidence_level="cited",
                ),
            ]
        )
        await db.commit()
        await db.refresh(section)
        return {
            "job_id": job.id,
            "run_id": run_id,
            "section": section,
        }


def _candidate_for(section: ProfileSection) -> dict:
    row = {
        "section_type": "experience",
        "title": "工作经历",
        "sort_order": 0,
        "visible": True,
        "content_json": [
            {
                "company": section.title,
                "position": "Backend Engineer",
                "description": "Built a reliable Python service for internal workflows.",
            }
        ],
        "source_section_ids": [section.id],
    }
    return {
        "selected": [section],
        "original_rows": [row],
        "proposed_rows": [row],
        "rewrite_applied": True,
        "pipeline": {"content_rewrite": {"suggestions": []}},
        "missing_capabilities": [],
    }


if __name__ == "__main__":
    unittest.main()
