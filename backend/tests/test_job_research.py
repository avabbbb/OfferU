from __future__ import annotations

import asyncio
import copy
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.chdir(BACKEND_DIR)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.ops import OPERATIONS
from app.database import Base
from app.models.models import Job, JobResearchRun, ResearchDossier
from app.services.agent_skill_registry import resolve_skill
from app.services import job_research
from app.services.job_research import _build_report, _validated_research_result


def _worker_payload() -> dict:
    return {
        "sources": [
            {
                "source_ref": "S1",
                "dossier_scope": "company",
                "url": "https://company.example/about",
                "title": "About",
                "publisher": "Example Company",
                "source_class": "official_company",
                "published_at": "2026-07-01",
                "excerpt": "The official page describes the product and business.",
            },
            {
                "source_ref": "S2",
                "dossier_scope": "role",
                "url": "https://interview.example/example-role",
                "title": "Interview experience",
                "publisher": "Interview Example",
                "source_class": "public_interview",
                "published_at": None,
                "excerpt": "One public interview report mentions a structured case round.",
            },
            {
                "source_ref": "S3",
                "dossier_scope": "role",
                "url": "https://community.example/example-interview",
                "title": "Candidate discussion",
                "publisher": "Community Example",
                "source_class": "public_community",
                "published_at": "2026-06-20",
                "excerpt": "An independent public discussion also mentions a case round.",
            },
            {
                "source_ref": "S4",
                "dossier_scope": "role",
                "url": "https://careers.example/resume-guidance",
                "title": "Resume guidance",
                "publisher": "Careers Example",
                "source_class": "public_resume_guidance",
                "published_at": None,
                "excerpt": "The guidance recommends showing decisions with verified outcomes.",
            },
        ],
        "findings": [
            {
                "dossier_scope": "company",
                "finding_type": "company_business",
                "statement": "The company describes this product as a core business line.",
                "details": {"pattern": "", "applicable_when": "", "constraints": []},
                "source_refs": ["S1"],
            },
            {
                "dossier_scope": "role",
                "finding_type": "team_culture",
                "statement": "One public account describes frequent cross-functional reviews.",
                "details": {"pattern": "", "applicable_when": "", "constraints": []},
                "source_refs": ["S2"],
            },
            {
                "dossier_scope": "role",
                "finding_type": "interview_process",
                "statement": "Two public sources independently mention a case round.",
                "details": {"pattern": "", "applicable_when": "", "constraints": []},
                "source_refs": ["S2", "S3"],
            },
            {
                "dossier_scope": "role",
                "finding_type": "resume_pattern",
                "statement": "Use a decision-action-outcome structure when the facts support it.",
                "details": {
                    "pattern": "Decision + action + verified outcome",
                    "applicable_when": "The candidate can trace every clause to their own evidence.",
                    "constraints": [
                        "Do not copy another candidate's employer, metric, or credential."
                    ],
                },
                "source_refs": ["S4"],
            },
        ],
        "gaps": [
            "Login-gated platform material requires a separate user-authorized browser flow."
        ],
    }


class JobResearchValidationTests(unittest.TestCase):
    def test_subjective_findings_require_independent_domains_for_corroboration(self) -> None:
        result = _validated_research_result(_worker_payload())
        by_type = {item["finding_type"]: item for item in result["findings"]}

        self.assertEqual(by_type["company_business"]["evidence_level"], "cited")
        self.assertEqual(by_type["team_culture"]["evidence_level"], "single_signal")
        self.assertEqual(by_type["interview_process"]["evidence_level"], "corroborated")
        self.assertEqual(by_type["resume_pattern"]["evidence_level"], "cited")

    def test_hard_fact_without_source_is_rejected(self) -> None:
        payload = copy.deepcopy(_worker_payload())
        payload["findings"][0]["source_refs"] = []

        with self.assertRaises(ValueError):
            _validated_research_result(payload)

    def test_hard_fact_without_official_source_is_downgraded_not_rejected(self) -> None:
        # CONTEXT.md：证据不足是可解释退出状态。硬事实（公司业务/产品/岗位要求）
        # 无官方来源时降级为 single_signal，而不是让整个研究崩溃。
        payload = copy.deepcopy(_worker_payload())
        payload["sources"][0]["source_class"] = "public_community"

        result = _validated_research_result(payload)
        hard = [
            item
            for item in result["findings"]
            if item["finding_type"] in ("company_business", "company_product", "role_requirement")
            and item["evidence_level"] == "single_signal"
        ]
        self.assertTrue(hard, "无官方来源的硬事实应降级为 single_signal")

    def test_full_candidate_resume_fields_are_rejected(self) -> None:
        payload = copy.deepcopy(_worker_payload())
        payload["findings"][3]["details"]["raw_resume"] = "full candidate resume"

        with self.assertRaises(ValueError):
            _validated_research_result(payload)

    def test_report_renders_inline_urls_and_explicit_signal_levels(self) -> None:
        result = _validated_research_result(_worker_payload())

        report = _build_report(
            job={"company": "Example Company", "title": "Researcher"},
            result=result,
        )

        self.assertIn("[S1](https://company.example/about)", report)
        self.assertIn("team_culture", {item["finding_type"] for item in result["findings"]})
        self.assertIn("single_signal", report)
        self.assertIn("corroborated", report)
        self.assertIn("匿名简历表达模式", report)
        self.assertNotIn("full candidate resume", report)

    def test_backend_search_runtime_is_bounded_and_not_a_cli_provider(self) -> None:
        runtime = job_research._backend_search_runtime()

        self.assertEqual(runtime["id"], "backend_search")
        self.assertEqual(runtime["version"], "backend-search-v1")
        self.assertEqual(runtime["protocol"], "offeru-public-web-http-v1")
        self.assertEqual(job_research._backend_search_page_limit(99), 8)
        self.assertEqual(job_research._backend_search_page_limit(0), 1)
        with self.assertRaises(ValueError):
            job_research._backend_search_page_limit("not-a-number")

    def test_failed_research_run_persists_bounded_error_id(self) -> None:
        async def flow(database_path: Path) -> dict:
            engine = create_async_engine(
                f"sqlite+aiosqlite:///{database_path.as_posix()}",
                connect_args={"timeout": 30},
            )
            session = async_sessionmaker(engine, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                async with session() as db:
                    job = Job(
                        title="Research Failure Role",
                        company="Research Failure Co",
                        source="fixture",
                        raw_description="A research failure fixture role.",
                        hash_key="job-research-validation-failure-id",
                    )
                    db.add(job)
                    await db.flush()
                    company_dossier = ResearchDossier(
                        dossier_key="company:research-validation-failure",
                        dossier_type="company",
                        company_name="Research Failure Co",
                    )
                    db.add(company_dossier)
                    await db.flush()
                    role_dossier = ResearchDossier(
                        dossier_key="role:research-validation-failure",
                        dossier_type="role",
                        company_name="Research Failure Co",
                        job_id=job.id,
                        parent_dossier_id=company_dossier.id,
                    )
                    db.add(role_dossier)
                    await db.flush()
                    db.add(
                        JobResearchRun(
                            run_id="job_research_validation_failure",
                            job_id=job.id,
                            company_dossier_id=company_dossier.id,
                            role_dossier_id=role_dossier.id,
                            runtime_id="replay",
                            status="running",
                        )
                    )
                    await db.commit()
                with patch.object(job_research, "async_session", session):
                    await job_research._mark_run_status(
                        "job_research_validation_failure",
                        "failed",
                        "research failed api_token=not-a-real-secret",
                    )
                    async with session() as db:
                        row = await db.get(
                            JobResearchRun,
                            "job_research_validation_failure",
                        )
                assert row is not None
                return job_research._run_summary(row)
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            result = asyncio.run(
                flow(Path(directory) / "job-research-failure-id.db")
            )
        self.assertEqual(result["status"], "failed")
        self.assertRegex(result["error_id"], r"^err_[0-9a-f]{16}$")
        self.assertNotIn("api_token=not-a-real-secret", result["error"] or "")

    def test_operations_and_skill_share_the_same_research_boundary(self) -> None:
        operation_names = {
            "get_job",
            "list_job_research_runs",
            "get_job_research",
            "review_job_research",
            "start_job_research",
            "resume_job_research",
            "cancel_job_research",
            "list_hosted_executor_sessions",
            "get_hosted_executor_session",
            "get_pre_application_state",
        }
        skill = resolve_skill("company_research")

        self.assertTrue(operation_names.issubset(OPERATIONS))
        self.assertTrue(operation_names.issubset(OPERATIONS))
        self.assertEqual(OPERATIONS["start_job_research"].group, "research")
        self.assertEqual(
            OPERATIONS["start_job_research"].side_effects,
            ("write", "external"),
        )
        self.assertEqual(
            OPERATIONS["review_job_research"].side_effects,
            ("write",),
        )
        self.assertIsNotNone(skill)
        assert skill is not None
        self.assertEqual(skill.status, "native")
        self.assertTrue(
            {
                "list_job_research_runs",
                "get_job_research",
                "review_job_research",
                "start_job_research",
                "resume_job_research",
                "cancel_job_research",
                "list_hosted_executor_sessions",
                "get_hosted_executor_session",
            }.issubset(skill.allowed_tools)
        )


if __name__ == "__main__":
    unittest.main()
