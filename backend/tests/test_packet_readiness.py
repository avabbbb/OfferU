from __future__ import annotations

import asyncio
import hashlib
import tempfile
import unittest
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.database import Base
from app.models.models import (
    ApplicationAttempt,
    CareerTask,
    Interview,
    Job,
    JobResearchRun,
    Profile,
    ProfileSection,
    ResearchDossier,
    ResearchEvidenceSnapshot,
    ResearchFinding,
    Resume,
    ResumeOptimizationProposal,
    ResumeVersion,
    RoleBenchmarkDocument,
    RoleBenchmarkRun,
)
from app.services import (
    job_research,
    packet_readiness,
    resume_optimization,
    resume_workspace,
    role_intelligence,
)
from app.services.resume_versions import snapshot_resume


class ApplicationPacketReadinessTests(unittest.TestCase):
    def test_jd_only_director_proposal_does_not_fake_research_or_focus(self) -> None:
        async def run() -> tuple[dict, dict]:
            engine, sessions = await _database()
            async with sessions() as db:
                profile = Profile(name="Synthetic Candidate", is_default=True)
                job = Job(
                    title="Product Manager",
                    company="Synthetic Co",
                    raw_description="Own product discovery and measurable outcomes.",
                    hash_key=hashlib.sha256(b"packet-jd-only").hexdigest(),
                )
                db.add_all([profile, job])
                await db.flush()
                evidence = ProfileSection(
                    profile_id=profile.id,
                    section_type="experience",
                    title="Product work",
                    tier="verified_fact",
                    status="active",
                    sort_order=0,
                    confidence=1.0,
                    content_json={
                        "bullet": "Owned product discovery and measured outcomes.",
                        "normalized": {
                            "company": "Synthetic Co",
                            "position": "Product lead",
                            "description": "Owned product discovery and measured outcomes.",
                        },
                    },
                )
                task = CareerTask(
                    task_id="career_task_packet_jd_only",
                    task_type="career_director",
                    source="automation",
                    target_type="job",
                    target_id=str(job.id),
                    input_json={"job_id": job.id, "profile_id": profile.id},
                    status="completed",
                    idempotency_key="packet-jd-only-task",
                )
                db.add_all([evidence, task])
                await db.commit()
                job_id = job.id
            with patch.object(resume_optimization, "async_session", sessions), patch.object(
                resume_workspace, "async_session", sessions
            ), patch.object(
                resume_workspace,
                "get_pre_application_state",
                new=AsyncMock(return_value={"stage": "needs_decision"}),
            ):
                preparation = await resume_optimization.get_resume_preparation_context(job_id)
                proposal = await resume_optimization.persist_director_resume_proposal(
                    job_id,
                    "career_task_packet_jd_only",
                    {
                        "job_id": job_id,
                        "source_fingerprint": preparation["source_fingerprint"],
                        "rows": preparation["baseline_rows"],
                    },
                )
                workspace = await resume_workspace.ensure_resume_workspace(
                    job_id, proposal_id=proposal["proposal_id"]
                )
                async with sessions() as db:
                    resume = await db.get(Resume, workspace["resume"]["id"])
                    version = await db.get(ResumeVersion, resume.current_version_id)
                    version.created_by = "user"
                    await db.commit()
                async with sessions() as db:
                    resume = await resume_workspace._load_resume(
                        db, workspace["resume"]["id"]
                    )
                    job = await db.get(Job, job_id)
                    user_saved_packet = (
                        await resume_workspace._workspace_payload(db, resume, job=job)
                    )["application_packet"]
            await engine.dispose()
            return workspace["application_packet"], user_saved_packet

        packet, user_saved_packet = asyncio.run(run())
        self.assertEqual(packet["status"], "draft")
        self.assertFalse(packet["artifacts"]["research"])
        self.assertFalse(packet["artifacts"]["interview_focus"])
        self.assertFalse(packet["artifact_state"]["resume"]["adopted"])
        self.assertTrue(packet["artifact_state"]["resume"]["exists"])
        self.assertFalse(packet["artifact_state"]["research"]["exists"])
        self.assertIsNone(packet["artifact_state"]["research"]["proposal_run_id"])
        self.assertFalse(packet["artifact_state"]["benchmark"]["exists"])
        self.assertFalse(packet["artifact_state"]["interview_focus"]["exists"])
        self.assertEqual(user_saved_packet["status"], "draft")
        self.assertEqual(
            user_saved_packet["artifact_state"]["resume"]["adoption_status"],
            "not_adopted",
        )

    def test_same_job_other_resume_proposal_does_not_link_research(self) -> None:
        async def run() -> dict:
            engine, sessions = await _database()
            async with sessions() as db:
                profile = Profile(name="Synthetic Candidate", is_default=True)
                job = Job(
                    title="Target role",
                    company="Target Co",
                    raw_description="Target job.",
                    hash_key=hashlib.sha256(b"same-job-wrong-resume").hexdigest(),
                )
                db.add_all([profile, job])
                await db.flush()
                current_resume = Resume(
                    user_name=profile.name,
                    title="Current resume",
                    source_mode="job_tailored_workspace",
                    target_job_id=job.id,
                    source_profile_id=profile.id,
                    sections=[],
                )
                other_resume = Resume(
                    user_name=profile.name,
                    title="Other resume for same job",
                    source_mode="job_tailored_workspace",
                    target_job_id=job.id,
                    source_profile_id=profile.id,
                    sections=[],
                )
                db.add_all([current_resume, other_resume])
                await db.flush()
                other_version = ResumeVersion(
                    resume_id=other_resume.id,
                    version_number=1,
                    content_snapshot={"summary": "Other resume snapshot"},
                )
                db.add(other_version)
                await db.flush()
                other_attempt = ApplicationAttempt(
                    job_id=job.id,
                    resume_id=other_resume.id,
                    resume_version_id=other_version.id,
                    status="submitted",
                )
                company_dossier = ResearchDossier(
                    dossier_key="same-job-wrong-resume-company",
                    dossier_type="company",
                    company_name=job.company,
                    job_id=job.id,
                )
                role_dossier = ResearchDossier(
                    dossier_key="same-job-wrong-resume-role",
                    dossier_type="role",
                    company_name=job.company,
                    job_id=job.id,
                )
                db.add_all([company_dossier, role_dossier])
                await db.flush()
                research = JobResearchRun(
                    run_id="research_for_other_resume",
                    job_id=job.id,
                    company_dossier_id=company_dossier.id,
                    role_dossier_id=role_dossier.id,
                    status="completed",
                    review_status="accepted",
                    result_json={},
                )
                db.add(research)
                proposal = ResumeOptimizationProposal(
                    proposal_id="proposal_for_other_resume",
                    job_id=job.id,
                    profile_id=profile.id,
                    research_run_id=research.run_id,
                    status="accepted",
                    source_snapshot_hash="synthetic-source",
                    research_snapshot_hash="synthetic-research",
                    workspace_resume_id=other_resume.id,
                    accepted_resume_id=other_resume.id,
                )
                db.add_all([proposal, other_attempt])
                await db.commit()
                packet = await packet_readiness.project_packet_state(
                    db,
                    job=job,
                    resume=current_resume,
                    proposals=[proposal],
                    versions=[],
                    attempts=[other_attempt],
                    legacy_application_id=None,
                )
            await engine.dispose()
            return packet

        with patch.object(
            packet_readiness.career_artifact_store,
            "list",
            return_value={"items": []},
        ):
            packet = asyncio.run(run())
        research_state = packet["artifact_state"]["research"]
        self.assertTrue(research_state["exists"])
        self.assertFalse(research_state["ready"])
        self.assertFalse(research_state["linked_to_resume"])
        self.assertIsNone(research_state["proposal_run_id"])
        self.assertFalse(packet["external_submission"]["recorded"])
        self.assertIsNone(packet["external_submission"]["status"])

    def test_orphaned_latest_version_is_not_used_without_current_pointer(self) -> None:
        async def run() -> dict:
            engine, sessions = await _database()
            async with sessions() as db:
                profile = Profile(name="Synthetic Candidate", is_default=True)
                job = Job(
                    title="Product Manager",
                    company="Synthetic Co",
                    raw_description="Own product discovery.",
                    hash_key=hashlib.sha256(b"packet-no-current-version").hexdigest(),
                )
                db.add_all([profile, job])
                await db.flush()
                resume = Resume(
                    user_name=profile.name,
                    title="Synthetic Resume",
                    source_mode="job_tailored_workspace",
                    target_job_id=job.id,
                    source_profile_id=profile.id,
                    current_version_id=None,
                )
                db.add(resume)
                await db.flush()
                db.add(
                    ResumeVersion(
                        resume_id=resume.id,
                        version_number=3,
                        content_snapshot={"summary": "Synthetic snapshot"},
                        change_summary="Saved snapshot without adoption pointer",
                        created_by="system",
                    )
                )
                await db.commit()
                resume_id, job_id = resume.id, job.id
            with patch.object(resume_workspace, "async_session", sessions):
                async with sessions() as db:
                    resume = await resume_workspace._load_resume(db, resume_id)
                    job = await db.get(Job, job_id)
                    packet = (
                        await resume_workspace._workspace_payload(db, resume, job=job)
                    )["application_packet"]
            await engine.dispose()
            return packet

        packet = asyncio.run(run())
        self.assertEqual(packet["status"], "draft")
        self.assertIsNone(packet["current_version_id"])
        self.assertIsNone(packet["current_version_number"])
        self.assertFalse(packet["artifact_state"]["resume"]["ready"])
        self.assertEqual(packet["artifact_state"]["resume"]["adoption_status"], "unknown")

    def test_adopted_resume_and_real_job_assets_are_projected_independently(self) -> None:
        from app.services.career_artifacts import CareerArtifactStore

        async def run(sessions, resume_id: int, job_id: int) -> dict:
            with patch.object(resume_workspace, "async_session", sessions):
                async with sessions() as db:
                    resume = await resume_workspace._load_resume(db, resume_id)
                    job = await db.get(Job, job_id)
                    return await resume_workspace._workspace_payload(db, resume, job=job)

        async def run_packet(store) -> tuple[dict, dict, dict, dict]:
            engine, sessions = await _database()
            async with sessions() as db:
                profile = Profile(name="Synthetic Candidate", is_default=True)
                job = Job(
                    title="Product Manager",
                    company="Synthetic Co",
                    raw_description="Own product discovery and outcomes.",
                    hash_key=hashlib.sha256(b"packet-valid-resources").hexdigest(),
                )
                db.add_all([profile, job])
                await db.flush()
                resume = Resume(
                    user_name=profile.name,
                    title="Synthetic tailored resume",
                    summary="Owned product discovery and measurable outcomes.",
                    sections=[],
                    source_mode="job_tailored_workspace",
                    target_job_id=job.id,
                    source_profile_id=profile.id,
                )
                db.add(resume)
                await db.flush()
                version = ResumeVersion(
                    resume_id=resume.id,
                    version_number=2,
                    content_snapshot={"summary": "Adopted synthetic resume"},
                    change_summary="Reviewed and adopted",
                    created_by="resume_optimization",
                )
                db.add(version)
                await db.flush()
                resume.current_version_id = version.id
                version.content_snapshot = snapshot_resume(resume)
                company_dossier = ResearchDossier(
                    dossier_key="packet-company",
                    dossier_type="company",
                    company_name=job.company,
                    job_id=job.id,
                )
                role_dossier = ResearchDossier(
                    dossier_key="packet-role",
                    dossier_type="role",
                    company_name=job.company,
                    job_id=job.id,
                )
                db.add_all([company_dossier, role_dossier])
                await db.flush()
                research = JobResearchRun(
                    run_id="research_packet_valid",
                    job_id=job.id,
                    company_dossier_id=company_dossier.id,
                    role_dossier_id=role_dossier.id,
                    runtime_id="backend_search",
                    status="running",
                    review_status="pending",
                )
                db.add(research)
                await db.flush()
                research_payload = job_research._validated_research_result(
                    {
                        "sources": [
                            {
                                "source_ref": "S1",
                                "dossier_scope": "role",
                                "url": "https://example.test/role",
                                "title": "Synthetic role posting",
                                "publisher": "Synthetic Co",
                                "source_class": "official_job",
                                "published_at": None,
                                "excerpt": "The role owns product discovery.",
                            }
                        ],
                        "findings": [
                            {
                                "dossier_scope": "role",
                                "finding_type": "role_requirement",
                                "statement": "Product discovery is central to this role.",
                                "details": {
                                    "pattern": "",
                                    "applicable_when": "",
                                    "constraints": [],
                                },
                                "source_refs": ["S1"],
                            },
                            {
                                "dossier_scope": "role",
                                "finding_type": "unknown",
                                "statement": "Interview process details are not public.",
                                "details": {
                                    "pattern": "",
                                    "applicable_when": "",
                                    "constraints": [],
                                },
                                # The canonical producer clears refs on unknowns.
                                "source_refs": ["S1"],
                            },
                        ],
                        "gaps": ["Interview process details are not public."],
                    }
                )
                await job_research._persist_completed_run(
                    db=db,
                    run=research,
                    result=research_payload,
                    report_markdown="Synthetic evidence-backed research.",
                    trace={
                        "runtime_id": "backend_search",
                        "runtime_version": "backend-search-v1",
                    },
                    runtime_version="backend-search-v1",
                )
                research.review_status = "accepted"  # Simulate a persisted review state; review_job_research currently rejects unknown-only refs.

                role_profile = role_intelligence.normalize_role_profile(
                    {
                        "schema": role_intelligence.ROLE_JD_SCHEMA,
                        "role_family": "product",
                        "specialization": "product_management",
                        "seniority": "mid",
                        "domain": "software",
                        "responsibilities": [],
                        "hard_skills": [],
                        "business_capabilities": [],
                        "behavioral_requirements": [],
                        "domain_knowledge": [],
                        "outcome_expectations": [],
                        "constraints": [],
                    }
                )
                target = role_intelligence._target_document(
                    job,
                    {
                        "raw_description": job.raw_description,
                        "role_profile": role_profile,
                        "capability_observations": [
                            {
                                "capability": "product discovery",
                                "category": "product",
                                "importance": "must_have",
                                "evidence_text": "Own product discovery and outcomes.",
                                "source_section": "responsibilities",
                                "confidence": 0.9,
                            }
                        ],
                    },
                )
                comparators = [
                    role_intelligence.normalize_benchmark_document(
                        {
                            "source_ref": f"S{index}",
                            "source": "public_web",
                            "title": f"Synthetic product role {index}",
                            "company": f"Synthetic comparator {index}",
                            "location": "",
                            "industry": "software",
                            "url": f"https://jobs.example.test/role/{index}",
                            "raw_description": f"Product role {index} with discovery work.",
                            "role_profile": role_profile,
                            "capability_observations": [],
                        },
                        document_kind="comparator",
                    )
                    | {"_inclusion_status": "candidate"}
                    for index in range(1, 16)
                ]
                analysis = role_intelligence.analyze_delta(
                    target,
                    comparators,
                    min_sample_count=role_intelligence.MIN_SAMPLE_COUNT,
                )
                benchmark = RoleBenchmarkRun(
                    run_id="benchmark_packet_valid",
                    target_job_id=job.id,
                    requested_sample_count=30,
                    min_sample_count=role_intelligence.MIN_SAMPLE_COUNT,
                    max_sample_count=role_intelligence.MAX_SAMPLE_COUNT,
                    status="running",
                    runtime_id="backend_search",
                    schema_version=role_intelligence.ROLE_BENCHMARK_OUTPUT_SCHEMA_ID,
                    algorithm_version=role_intelligence.ROLE_BENCHMARK_ALGORITHM_VERSION,
                )
                db.add(benchmark)
                await db.commit()
                with patch.object(role_intelligence, "async_session", sessions):
                    await role_intelligence._persist_benchmark(
                        run_id=benchmark.run_id,
                        target=target,
                        candidate_records=comparators,
                        selected_comparators=comparators,
                        analysis=analysis,
                        trace={"runtime_id": "backend_search"},
                        runtime_version="role-benchmark-search-v1",
                        rejected_count=0,
                        gaps=[],
                    )
                db.add(
                    RoleBenchmarkRun(
                        run_id="zz_benchmark_failed_attempt",
                        target_job_id=job.id,
                        status="failed",
                        valid_sample_count=0,
                        min_sample_count=15,
                        runtime_id="backend_search",
                        created_at=datetime.now(timezone.utc).replace(tzinfo=None)
                        + timedelta(minutes=1),
                    )
                )
                db.add(
                    Interview(
                        title="Synthetic role interview",
                        target_job_id=job.id,
                        resume_id=resume.id,
                        status="active",
                        focus_plan_json={
                            "schema": "offeru.interview_focus_plan.v1",
                            "target_job_id": job.id,
                            "benchmark_run_id": benchmark.run_id,
                            "focuses": [{"capability": "product_discovery"}],
                        },
                    )
                )
                proposal = ResumeOptimizationProposal(
                    proposal_id="resume_packet_adopted",
                    job_id=job.id,
                    profile_id=profile.id,
                    research_run_id=research.run_id,
                    status="accepted",
                    source_snapshot_hash="profile-snapshot",
                    research_snapshot_hash="research-snapshot",
                    accepted_resume_id=resume.id,
                    accepted_resume_version_id=version.id,
                )
                attempt = ApplicationAttempt(
                    job_id=job.id,
                    resume_id=resume.id,
                    resume_version_id=version.id,
                    status="submitted",
                )
                latest_failed_attempt = ApplicationAttempt(
                    job_id=job.id,
                    resume_id=resume.id,
                    resume_version_id=version.id,
                    status="failed",
                    created_at=datetime.now(timezone.utc).replace(tzinfo=None)
                    + timedelta(minutes=2),
                )
                db.add_all([proposal, attempt, latest_failed_attempt])
                await db.commit()
                resume_id, job_id, version_id = resume.id, job.id, version.id
            store.save(
                artifact_type="cover_letter",
                title="Synthetic cover letter",
                content_markdown="Draft for this job.",
                related_job_id=job_id,
                metadata={"resume_id": resume_id, "resume_version_id": version_id},
            )
            store.save(
                artifact_type="application_email",
                title="Synthetic email from stale version",
                content_markdown="Stale version draft.",
                related_job_id=job_id,
                metadata={"resume_id": resume_id, "resume_version_id": 999999},
            )
            store.save(
                artifact_type="cover_letter",
                title="Synthetic unrelated resume draft",
                content_markdown="This belongs to another resume.",
                related_job_id=job_id,
                metadata={"resume_id": 999999, "resume_version_id": version_id},
            )
            with patch("app.services.packet_readiness.career_artifact_store", store):
                payload = await run(sessions, resume_id, job_id)
                with patch.object(role_intelligence, "async_session", sessions):
                    role_detail = await role_intelligence.get_role_benchmark(
                        run_id="benchmark_packet_valid"
                    )
                self.assertTrue(role_detail["artifact_verification"]["ready"])
                self.assertEqual(
                    role_detail["artifact_verification"]["status"], "verified"
                )
                async with sessions() as db:
                    benchmark = await db.get(RoleBenchmarkRun, "benchmark_packet_valid")
                    job = await db.get(Job, job_id)
                    documents = list(
                        (
                            await db.execute(
                                select(RoleBenchmarkDocument).where(
                                    RoleBenchmarkDocument.run_id == benchmark.run_id
                                )
                            )
                        ).scalars().all()
                    )
                    current_job_description = job.raw_description
                    job.raw_description = f"{current_job_description} changed after collection"
                    stale_jd_verification = role_intelligence.verify_benchmark_artifact(
                        benchmark, job=job, documents=documents
                    )
                    job.raw_description = current_job_description
                    self.assertFalse(stale_jd_verification["ready"])
                    self.assertIn(
                        "target_snapshot_mismatch", stale_jd_verification["reasons"]
                    )
                    research = await db.get(JobResearchRun, "research_packet_valid")
                    research_findings = list(
                        (
                            await db.execute(
                                select(ResearchFinding).where(
                                    ResearchFinding.run_id == research.run_id
                                )
                            )
                        ).scalars().all()
                    )
                    unknown_finding = next(
                        item for item in research_findings if item.finding_type == "unknown"
                    )
                    self.assertEqual(unknown_finding.source_refs_json, [])
                    self.assertEqual(unknown_finding.evidence_level, "unknown")
                    fixture_run = RoleBenchmarkRun(
                        run_id=benchmark.run_id,
                        target_job_id=benchmark.target_job_id,
                        valid_sample_count=benchmark.valid_sample_count,
                        min_sample_count=benchmark.min_sample_count,
                        runtime_id="replay",
                        runtime_version="fixture-replay.v1",
                        schema_version=benchmark.schema_version,
                        algorithm_version=benchmark.algorithm_version,
                        status=benchmark.status,
                        result_json=benchmark.result_json,
                        trace_json=benchmark.trace_json,
                        target_profile_json=benchmark.target_profile_json,
                    )
                    replay_verification = role_intelligence.verify_benchmark_artifact(
                        fixture_run, job=job, documents=documents
                    )
                    no_target_verification = role_intelligence.verify_benchmark_artifact(
                        benchmark,
                        job=job,
                        documents=[
                            item for item in documents if item.document_kind != "target"
                        ],
                    )
                    counter_only_verification = role_intelligence.verify_benchmark_artifact(
                        benchmark,
                        job=job,
                        documents=[
                            item for item in documents if item.document_kind == "target"
                        ],
                    )
                    self.assertFalse(replay_verification["ready"])
                    self.assertIn(
                        "fixture_or_unknown_data_mode", replay_verification["reasons"]
                    )
                    fixture_run.runtime_id = "backend_search"
                    fixture_run.runtime_version = "role-benchmark-search-v1"
                    fixture_run.schema_version = "legacy.schema"
                    schema_verification = role_intelligence.verify_benchmark_artifact(
                        fixture_run, job=job, documents=documents
                    )
                    self.assertFalse(schema_verification["ready"])
                    self.assertIn("schema_mismatch", schema_verification["reasons"])
                    fixture_run.schema_version = benchmark.schema_version
                    fixture_run.algorithm_version = "legacy.algorithm"
                    algorithm_verification = role_intelligence.verify_benchmark_artifact(
                        fixture_run, job=job, documents=documents
                    )
                    self.assertFalse(algorithm_verification["ready"])
                    self.assertIn(
                        "algorithm_mismatch", algorithm_verification["reasons"]
                    )
                    self.assertFalse(no_target_verification["ready"])
                    self.assertIn(
                        "target_snapshot_missing_or_ambiguous",
                        no_target_verification["reasons"],
                    )
                    self.assertFalse(counter_only_verification["ready"])
                    self.assertIn(
                        "comparator_snapshot_count_mismatch",
                        counter_only_verification["reasons"],
                    )
                async with sessions() as db:
                    resume = await resume_workspace._load_resume(db, resume_id)
                    resume.style_config = {"accentColorHex": "#123456"}
                    design_version = ResumeVersion(
                        resume_id=resume.id,
                        version_number=3,
                        content_snapshot={},
                        change_summary="Layout only",
                        created_by="resume_design",
                    )
                    db.add(design_version)
                    await db.flush()
                    design_version.content_snapshot = snapshot_resume(resume)
                    resume.current_version_id = design_version.id
                    await db.commit()
                layout_payload = await run(sessions, resume_id, job_id)
                async with sessions() as db:
                    resume = await db.get(Resume, resume_id)
                    resume.summary = "Unsaved content change"
                    await db.commit()
                stale_payload = await run(sessions, resume_id, job_id)
                async with sessions() as db:
                    research = await db.get(JobResearchRun, "research_packet_valid")
                    research.status = "failed"
                    research.review_status = "pending"
                    benchmark = await db.get(RoleBenchmarkRun, "benchmark_packet_valid")
                    benchmark.status = "failed"
                    interview = (
                        await db.execute(
                            select(Interview).where(
                                Interview.target_job_id == job_id,
                                Interview.resume_id == resume_id,
                            )
                        )
                    ).scalar_one()
                    interview.status = "failed"
                    await db.commit()
                failed_resources_payload = await run(sessions, resume_id, job_id)
            await engine.dispose()
            return payload, layout_payload, stale_payload, failed_resources_payload, version_id

        with tempfile.TemporaryDirectory() as artifact_dir:
            store = CareerArtifactStore(Path(artifact_dir))
            (
                payload,
                layout_payload,
                stale_payload,
                failed_resources_payload,
                version_id,
            ) = asyncio.run(run_packet(store))
            packet = payload["application_packet"]
            self.assertEqual(packet["status"], "ready")
            self.assertTrue(packet["artifact_state"]["resume"]["adopted"])
            self.assertTrue(packet["artifact_state"]["resume"]["ready"])
            self.assertEqual(
                packet["artifact_state"]["research"]["run_id"],
                "research_packet_valid",
            )
            self.assertTrue(packet["artifact_state"]["research"]["linked_to_resume"])
            self.assertTrue(packet["artifact_state"]["research"]["ready"])
            self.assertTrue(packet["artifact_state"]["research"]["adopted"])
            self.assertTrue(packet["artifact_state"]["benchmark"]["ready"])
            self.assertEqual(
                packet["artifact_state"]["benchmark"]["verification_status"],
                "verified",
            )
            self.assertTrue(
                packet["artifact_state"]["benchmark"]["artifact_verification"]["ready"]
            )
            self.assertEqual(
                packet["artifact_state"]["benchmark"]["run_id"],
                "benchmark_packet_valid",
            )
            self.assertEqual(
                packet["artifact_state"]["benchmark"]["latest_attempt_status"],
                "failed",
            )
            self.assertTrue(packet["artifact_state"]["interview_focus"]["ready"])
            self.assertTrue(packet["artifact_state"]["documents"]["exists"])
            self.assertEqual(packet["artifact_state"]["documents"]["count"], 2)
            self.assertEqual(
                sorted(
                    item["version_matches_resume"]
                    for item in packet["artifact_state"]["documents"]["items"]
                ),
                [False, True],
            )
            self.assertTrue(packet["external_submission"]["completed"])
            self.assertEqual(packet["external_submission"]["scope"], "recorded_only")
            self.assertFalse(packet["external_submission"]["receipt_verified"])
            self.assertEqual(packet["external_submission"]["status"], "submitted")
            self.assertEqual(
                packet["external_submission"]["latest_attempt"]["status"], "failed"
            )
            self.assertEqual(
                packet["external_submission"]["resume_version_id"], version_id
            )
            layout_packet = layout_payload["application_packet"]
            self.assertEqual(layout_packet["status"], "ready")
            self.assertTrue(layout_packet["artifact_state"]["resume"]["adopted"])
            self.assertEqual(
                layout_packet["artifact_state"]["resume"]["adoption_source"],
                "inherited_layout",
            )
            self.assertFalse(
                layout_packet["external_submission"]["matches_current_version"]
            )
            stale_packet = stale_payload["application_packet"]
            self.assertEqual(stale_packet["status"], "draft")
            self.assertFalse(
                stale_packet["artifact_state"]["resume"]["current_version_matches_resume"]
            )
            failed_resources = failed_resources_payload["application_packet"]["artifact_state"]
            self.assertTrue(failed_resources["research"]["exists"])
            self.assertFalse(failed_resources["research"]["ready"])
            self.assertFalse(failed_resources["research"]["adopted"])
            self.assertTrue(failed_resources["benchmark"]["exists"])
            self.assertFalse(failed_resources["benchmark"]["ready"])
            self.assertTrue(failed_resources["interview_focus"]["exists"])
            self.assertFalse(failed_resources["interview_focus"]["ready"])

    def test_unknown_research_findings_remain_gaps_not_facts(self) -> None:
        result = job_research._validated_research_result(
            {
                "sources": [
                    {
                        "source_ref": "S1",
                        "dossier_scope": "role",
                        "url": "https://example.test/role",
                        "title": "Synthetic role posting",
                        "publisher": "Synthetic Co",
                        "source_class": "official_job",
                        "published_at": None,
                        "excerpt": "The role owns product discovery.",
                    }
                ],
                "findings": [
                    {
                        "dossier_scope": "role",
                        "finding_type": "role_requirement",
                        "statement": "Product discovery is central to this role.",
                        "details": {
                            "pattern": "",
                            "applicable_when": "",
                            "constraints": [],
                        },
                        "source_refs": ["S1"],
                    },
                    {
                        "dossier_scope": "role",
                        "finding_type": "unknown",
                        "statement": "Interview process details are not public.",
                        "details": {
                            "pattern": "",
                            "applicable_when": "",
                            "constraints": [],
                        },
                        "source_refs": ["S1"],
                    },
                ],
                "gaps": [],
            }
        )
        run = JobResearchRun(
            run_id="research_unknown_guard",
            job_id=1,
            company_dossier_id=1,
            role_dossier_id=1,
            runtime_id="backend_search",
            runtime_version="backend-search-v1",
            status="completed",
            review_status="accepted",
            result_json=result,
            trace_json={
                "result_schema": job_research.RESEARCH_RESULT_SCHEMA,
                "runtime_id": "backend_search",
                "runtime_version": "backend-search-v1",
            },
        )
        source = result["sources"][0]
        evidence = ResearchEvidenceSnapshot(
            run_id=run.run_id,
            dossier_id=1,
            source_ref=source["source_ref"],
            url=source["url"],
            title=source["title"],
            publisher=source["publisher"],
            source_class=source["source_class"],
            excerpt=source["excerpt"],
            content_hash=hashlib.sha256(b"synthetic evidence").hexdigest(),
        )

        def stored_findings(payload: dict) -> list[ResearchFinding]:
            return [
                ResearchFinding(
                    run_id=run.run_id,
                    dossier_id=1,
                    finding_type=item["finding_type"],
                    statement=item["statement"],
                    details_json=item["details"],
                    source_refs_json=item["source_refs"],
                    evidence_level=item["evidence_level"],
                )
                for item in payload["findings"]
            ]

        self.assertTrue(
            packet_readiness._research_ready(run, [evidence], stored_findings(result))
        )

        run.trace_json["runtime_version"] = "stale-runtime-version"
        self.assertFalse(
            packet_readiness._research_ready(run, [evidence], stored_findings(result))
        )
        run.runtime_id = "fixture"
        run.runtime_version = "fixture-replay.v1"
        run.trace_json = {
            "result_schema": job_research.RESEARCH_RESULT_SCHEMA,
            "runtime_id": "fixture",
            "runtime_version": "fixture-replay.v1",
        }
        self.assertFalse(
            packet_readiness._research_ready(run, [evidence], stored_findings(result))
        )
        run.runtime_id = "backend_search"
        run.runtime_version = "backend-search-v1"
        run.trace_json = {
            "result_schema": job_research.RESEARCH_RESULT_SCHEMA,
            "runtime_id": "backend_search",
            "runtime_version": "backend-search-v1",
        }

        forged_unknown = deepcopy(result)
        forged_unknown["findings"][1]["source_refs"] = ["S1"]
        run.result_json = forged_unknown
        self.assertFalse(
            packet_readiness._research_ready(
                run, [evidence], stored_findings(forged_unknown)
            )
        )

        unknown_only = deepcopy(result)
        unknown_only["findings"] = [unknown_only["findings"][1]]
        run.result_json = unknown_only
        self.assertFalse(
            packet_readiness._research_ready(
                run, [evidence], stored_findings(unknown_only)
            )
        )

    def test_failed_or_cross_job_assets_are_not_ready(self) -> None:
        async def run() -> dict:
            engine, sessions = await _database()
            async with sessions() as db:
                profile = Profile(name="Synthetic Candidate", is_default=True)
                job = Job(
                    title="Target role",
                    company="Target Co",
                    raw_description="Target job.",
                    hash_key=hashlib.sha256(b"packet-target").hexdigest(),
                )
                other_job = Job(
                    title="Other role",
                    company="Other Co",
                    raw_description="Other job.",
                    hash_key=hashlib.sha256(b"packet-other").hexdigest(),
                )
                db.add_all([profile, job, other_job])
                await db.flush()
                resume = Resume(
                    user_name=profile.name,
                    title="Target resume",
                    source_mode="job_tailored_workspace",
                    target_job_id=job.id,
                    source_profile_id=profile.id,
                )
                other_resume = Resume(
                    user_name=profile.name,
                    title="Other resume",
                    source_mode="job_tailored_workspace",
                    target_job_id=other_job.id,
                    source_profile_id=profile.id,
                )
                db.add_all([resume, other_resume])
                await db.flush()
                other_version = ResumeVersion(
                    resume_id=other_resume.id,
                    version_number=1,
                    content_snapshot={},
                )
                db.add(other_version)
                await db.flush()
                resume.current_version_id = other_version.id
                company_dossier = ResearchDossier(
                    dossier_key="packet-other-company",
                    dossier_type="company",
                    company_name=other_job.company,
                    job_id=other_job.id,
                )
                role_dossier = ResearchDossier(
                    dossier_key="packet-other-role",
                    dossier_type="role",
                    company_name=other_job.company,
                    job_id=other_job.id,
                )
                db.add_all([company_dossier, role_dossier])
                await db.flush()
                foreign_research = JobResearchRun(
                    run_id="research_packet_other_job",
                    job_id=other_job.id,
                    company_dossier_id=company_dossier.id,
                    role_dossier_id=role_dossier.id,
                    status="completed",
                    review_status="accepted",
                )
                db.add(foreign_research)
                db.add(
                    RoleBenchmarkRun(
                        run_id="benchmark_packet_failed",
                        target_job_id=job.id,
                        status="failed",
                        valid_sample_count=15,
                        min_sample_count=15,
                        runtime_id="backend_search",
                    )
                )
                db.add(
                    Interview(
                        title="Mismatched focus",
                        target_job_id=job.id,
                        resume_id=resume.id,
                        status="failed",
                        focus_plan_json={
                            "schema": "offeru.interview_focus_plan.v1",
                            "target_job_id": other_job.id,
                            "benchmark_run_id": "benchmark_packet_failed",
                            "focuses": [{"capability": "wrong_job"}],
                        },
                    )
                )
                proposal = ResumeOptimizationProposal(
                    proposal_id="resume_packet_wrong_research",
                    job_id=job.id,
                    profile_id=profile.id,
                    research_run_id=foreign_research.run_id,
                    status="ready",
                    source_snapshot_hash="profile-snapshot",
                    research_snapshot_hash="research-snapshot",
                )
                failed_attempt = ApplicationAttempt(
                    job_id=job.id,
                    resume_id=resume.id,
                    status="cancelled",
                )
                db.add_all([proposal, failed_attempt])
                await db.commit()
                resume_id, job_id = resume.id, job.id
            with patch.object(resume_workspace, "async_session", sessions):
                async with sessions() as db:
                    resume = await resume_workspace._load_resume(db, resume_id)
                    job = await db.get(Job, job_id)
                    packet = (
                        await resume_workspace._workspace_payload(db, resume, job=job)
                    )["application_packet"]
            await engine.dispose()
            return packet

        packet = asyncio.run(run())
        self.assertEqual(packet["status"], "draft")
        self.assertEqual(packet["status_scope"], "resume_for_send")
        self.assertFalse(packet["artifact_state"]["resume"]["ready"])
        self.assertFalse(packet["artifact_state"]["research"]["exists"])
        self.assertTrue(packet["artifact_state"]["benchmark"]["exists"])
        self.assertFalse(packet["artifact_state"]["benchmark"]["ready"])
        self.assertEqual(
            packet["artifact_state"]["benchmark"]["verification_status"],
            "unverified",
        )
        self.assertFalse(
            packet["artifact_state"]["benchmark"]["target_snapshot"]["exists"]
        )
        self.assertTrue(packet["artifact_state"]["interview_focus"]["exists"])
        self.assertFalse(packet["artifact_state"]["interview_focus"]["ready"])
        self.assertEqual(packet["external_submission"]["status"], "cancelled")
        self.assertIsNotNone(packet["external_submission"]["attempt_id"])
        self.assertFalse(packet["external_submission"]["completed"])

    def test_user_saved_version_is_ready_without_fabricating_proposal_adoption(self) -> None:
        async def run() -> dict:
            engine, sessions = await _database()
            async with sessions() as db:
                profile = Profile(name="Synthetic Candidate", is_default=True)
                job = Job(
                    title="Product Manager",
                    company="Synthetic Co",
                    raw_description="Own product discovery.",
                    hash_key=hashlib.sha256(b"packet-user-saved").hexdigest(),
                )
                db.add_all([profile, job])
                await db.flush()
                resume = Resume(
                    user_name=profile.name,
                    title="User-authored resume",
                    summary="User-authored product experience.",
                    sections=[],
                    source_mode="manual",
                    target_job_id=job.id,
                    source_profile_id=profile.id,
                )
                db.add(resume)
                await db.flush()
                version = ResumeVersion(
                    resume_id=resume.id,
                    version_number=1,
                    content_snapshot={},
                    created_by="user",
                )
                db.add(version)
                await db.flush()
                version.content_snapshot = snapshot_resume(resume)
                resume.current_version_id = version.id
                await db.commit()
                resume_id, job_id = resume.id, job.id
            with patch.object(resume_workspace, "async_session", sessions):
                async with sessions() as db:
                    resume = await resume_workspace._load_resume(db, resume_id)
                    job = await db.get(Job, job_id)
                    packet = (
                        await resume_workspace._workspace_payload(db, resume, job=job)
                    )["application_packet"]
            await engine.dispose()
            return packet

        packet = asyncio.run(run())
        self.assertEqual(packet["status"], "ready")
        self.assertTrue(packet["artifact_state"]["resume"]["ready"])
        self.assertFalse(packet["artifact_state"]["resume"]["adopted"])
        self.assertEqual(packet["artifact_state"]["resume"]["adoption_status"], "user_saved")


async def _database():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    return engine, sessions
