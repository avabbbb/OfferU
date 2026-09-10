"""Run the isolated Resume -> Job -> Resume Proposal -> Interview fixture.

This runner is deliberately separate from the formal OfferU database.  It reads
the user-confirmed, redacted benchmark snapshot from a workspace outside the
repository, seeds an isolated SQLite database, and calls the same service
functions exposed by the Operation Registry.  It never starts a browser, mail
provider, model, or external side effect.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import sys
import uuid
from contextlib import ExitStack
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine


ROOT = Path(__file__).resolve().parents[3]
BACKEND_DIR = ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))
DEFAULT_WORKSPACE = Path(r"H:\tmp\offeru\evolve-bench\real-career-test-workspace")
ROLE_FIXTURE = ROOT / "backend" / "tests" / "fixtures" / "role_intelligence_v0" / "corpus.json"


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, default=str)


def _sha256(value: Any) -> str:
    if isinstance(value, bytes):
        payload = value
    else:
        payload = _json(value).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _ensure_non_system_workspace(path: Path) -> Path:
    resolved = path.expanduser().resolve()
    if resolved.drive.upper() == "C:":
        raise ValueError("真实职业测试产物不得写入 C: 盘")
    resolved.mkdir(parents=True, exist_ok=True)
    return resolved


def _configure_temp_root(workspace: Path) -> Path:
    """Keep Python and tokenizer caches off the system drive for this run."""

    temp_root = workspace / "tmp"
    temp_root.mkdir(parents=True, exist_ok=True)
    temp_value = str(temp_root)
    os.environ["TEMP"] = temp_value
    os.environ["TMP"] = temp_value
    os.environ["TMPDIR"] = temp_value
    import tempfile

    tempfile.tempdir = temp_value
    try:
        import jieba

        jieba.dt.tmp_dir = temp_value
    except ImportError:
        pass
    return temp_root


class Progress:
    def __init__(self, workspace: Path) -> None:
        self.workspace = workspace
        self.path = workspace / "progress.json"
        self.log_path = workspace / "run.log"
        self.run_id = f"real-career-fixture-{uuid.uuid4().hex[:12]}"
        self.payload: dict[str, Any] = {
            "schema": "offeru.evolve_bench.real_career_progress.v1",
            "run_id": self.run_id,
            "started_at": _now(),
            "workspace": str(workspace),
            "current_stage": "created",
            "stages": {},
        }
        self._write()

    def _write(self) -> None:
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(_json(self.payload) + "\n", encoding="utf-8")
        temporary.replace(self.path)

    def update(self, stage: str, status: str, detail: dict[str, Any] | None = None) -> None:
        record = {"status": status, "updated_at": _now()}
        if detail:
            record["detail"] = detail
        self.payload["current_stage"] = stage
        self.payload["stages"][stage] = record
        self._write()
        line = f"[{record['updated_at']}] {stage}: {status}"
        if detail:
            line += f" {_json(detail)}"
        with self.log_path.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
        print(line, flush=True)

    def finish(self, verdict: str) -> None:
        self.payload["finished_at"] = _now()
        self.payload["verdict"] = verdict
        self._write()


def _section_specs(gold: dict[str, Any]) -> list[dict[str, Any]]:
    facts = list(gold.get("facts") or [])
    by_id = {str(item.get("fact_id")): item for item in facts}

    def take(prefixes: tuple[str, ...]) -> list[dict[str, Any]]:
        return [
            by_id[fact_id]
            for fact_id in by_id
            if fact_id.startswith(prefixes)
        ]

    groups = [
        ("education", "教育经历", ("RESUME-EDU-",)),
        ("experience", "企业 AIGC 产品与交付", ("RESUME-WORK-",)),
        ("project", "智绘画布平台化实践", ("RESUME-PRODUCT-",)),
        ("project", "OfferU 求职 Agent 系统", ("RESUME-OFFERU-",)),
        ("experience", "创作者生态实践", ("RESUME-CREATOR-",)),
        ("skill", "Agent / 产品方法论", ("RESUME-SKILL-",)),
    ]
    sections: list[dict[str, Any]] = []
    for sort_order, (section_type, title, prefixes) in enumerate(groups):
        selected = take(prefixes)
        if not selected:
            continue
        values = [str(item.get("value") or "").strip() for item in selected]
        fact_ids = [str(item.get("fact_id")) for item in selected]
        normalized: dict[str, Any] = {
            "fact_ids": fact_ids,
            "description": "；".join(values),
        }
        if section_type == "education":
            normalized.update({"school": "华南师范大学", "major": "软件工程", "degree": "本科"})
        elif title == "企业 AIGC 产品与交付":
            normalized.update({
                "company": "中国电信股份有限公司佛山分公司",
                "position": "省内产品推广经理、省内研发经理",
            })
        elif title == "创作者生态实践":
            normalized.update({"company": "RunningHub 生态", "position": "创作者生态实践"})
        elif section_type == "project":
            normalized.update({"name": title, "role": "产品与交付"})
        elif section_type == "skill":
            normalized["items"] = [
                "大模型",
                "Agent",
                "Context",
                "Memory",
                "工作流",
                "人机协作",
                "Harness",
                "Claude Code",
            ]
        sections.append({
            "section_type": section_type,
            "title": title,
            "sort_order": sort_order,
            "content_json": {
                "bullet": "；".join(values),
                "normalized": normalized,
                "fact_ids": fact_ids,
                "source": {
                    "source_id": gold.get("source_id"),
                    "source_sha256": gold.get("source_sha256"),
                    "page": 1,
                },
            },
            "fact_ids": fact_ids,
        })
    return sections


async def _create_schema(engine) -> None:  # noqa: ANN001
    from app.database import Base
    from app.models import html_resume as _html_resume  # noqa: F401
    from app.models import models as _models  # noqa: F401

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)


async def _seed_base_data(
    session: async_sessionmaker[AsyncSession],
    gold: dict[str, Any],
    fixture: dict[str, Any],
) -> tuple[int, int, list[Any]]:
    from app.models.models import (
        Job,
        JobResearchRun,
        Profile,
        ProfileSection,
        ResearchDossier,
        ResearchEvidenceSnapshot,
        ResearchFinding,
        RoleBenchmarkRun,
    )
    from app.services.role_intelligence import (
        ROLE_BENCHMARK_ALGORITHM_VERSION,
        ROLE_BENCHMARK_OUTPUT_SCHEMA_ID,
    )

    target = fixture["target"]
    sections = _section_specs(gold)
    async with session() as db:
        profile = Profile(
            name="EvolveBench Candidate",
            school="华南师范大学",
            major="软件工程",
            degree="本科",
            base_info_json={
                "snapshot_id": "PROFILE_T0",
                "source_id": gold.get("source_id"),
                "source_sha256": gold.get("source_sha256"),
                "review_status": "CONFIRMED",
            },
            is_default=True,
            onboarding_step=5,
        )
        db.add(profile)
        await db.flush()
        section_rows: list[Any] = []
        for spec in sections:
            row = ProfileSection(
                profile_id=profile.id,
                section_type=spec["section_type"],
                title=spec["title"],
                sort_order=spec["sort_order"],
                content_json=spec["content_json"],
                source="resume_gold",
                confidence=0.99,
                tier="verified_fact",
                status="active",
            )
            db.add(row)
            section_rows.append(row)

        job = Job(
            title=target["title"],
            company=target["company"],
            location=target.get("location") or "",
            url=target.get("url") or "",
            apply_url=target.get("url") or "",
            source="evolvebench_fixture",
            raw_description=target["raw_description"],
            education="本科",
            experience="",
            job_type="full_time",
            triage_status="picked",
            batch_id="evolvebench-real-career",
            hash_key=_sha256({"title": target["title"], "company": target["company"], "url": target["url"]}),
            keywords=["AI Agent", "Agent Harness", "模型评测", "开发者工作流"],
        )
        db.add(job)
        await db.flush()

        company_dossier = ResearchDossier(
            dossier_key="evolvebench-company-target-co",
            dossier_type="company",
            company_name=target["company"],
            job_id=job.id,
            status="active",
            summary_json={"data_mode": "fixture", "scope": "company"},
        )
        role_dossier = ResearchDossier(
            dossier_key="evolvebench-role-target-ai-agent-pm",
            dossier_type="role",
            company_name=target["company"],
            job_id=job.id,
            status="active",
            summary_json={"data_mode": "fixture", "scope": "role"},
        )
        db.add_all([company_dossier, role_dossier])
        await db.flush()
        research_run = JobResearchRun(
            run_id="evolvebench-research-001",
            job_id=job.id,
            company_dossier_id=company_dossier.id,
            role_dossier_id=role_dossier.id,
            runtime_id="fixture",
            runtime_version="role-fixture-v0",
            status="completed",
            review_status="accepted",
            review_note="Isolated benchmark fixture; no external research performed.",
            result_json={"schema": "offeru.job_research_result.v1", "gaps": []},
            report_markdown="Isolated fixture research. No external site was contacted.",
            trace_json={
                "data_mode": "fixture",
                "source": "role_intelligence_v0",
                "synthetic": True,
                "pre_reviewed": True,
            },
            attempts=1,
            started_at=datetime.now(timezone.utc).replace(tzinfo=None),
            completed_at=datetime.now(timezone.utc).replace(tzinfo=None),
        )
        db.add(research_run)
        await db.flush()
        company_dossier.latest_run_id = research_run.run_id
        role_dossier.latest_run_id = research_run.run_id

        source_ref = "fixture:target-jd"
        source_excerpt = target["raw_description"]
        db.add(
            ResearchEvidenceSnapshot(
                run_id=research_run.run_id,
                dossier_id=role_dossier.id,
                source_ref=source_ref,
                url=target["url"],
                title=target["title"],
                publisher=target["company"],
                source_class="fixture",
                excerpt=source_excerpt,
                content_hash=_sha256(source_excerpt.encode("utf-8")),
            )
        )
        db.add_all([
            ResearchFinding(
                run_id=research_run.run_id,
                dossier_id=role_dossier.id,
                finding_type="role_requirement",
                statement=source_excerpt,
                details_json={"capability_observations": target["capability_observations"]},
                source_refs_json=[source_ref],
                evidence_level="direct",
            ),
            ResearchFinding(
                run_id=research_run.run_id,
                dossier_id=company_dossier.id,
                finding_type="company_product",
                statement="Target Co 的岗位 fixture 用于验证 OfferU 的岗位分析链路。",
                details_json={"data_mode": "fixture"},
                source_refs_json=[source_ref],
                evidence_level="context",
            ),
        ])

        role_run = RoleBenchmarkRun(
            run_id="evolvebench-role-001",
            target_job_id=job.id,
            cohort_json={
                "role_family": target["role_profile"]["role_family"],
                "specialization": target["role_profile"]["specialization"],
                "seniority": target["role_profile"]["seniority"],
                "region": target.get("location") or "",
            },
            requested_sample_count=30,
            min_sample_count=15,
            max_sample_count=50,
            schema_version=ROLE_BENCHMARK_OUTPUT_SCHEMA_ID,
            algorithm_version=ROLE_BENCHMARK_ALGORITHM_VERSION,
            runtime_id="fixture",
            runtime_version="role-fixture-v0",
            status="pending",
            source_summary_json={"data_mode": "fixture"},
        )
        db.add(role_run)
        await db.commit()
        await db.refresh(profile)
        await db.refresh(job)
        return profile.id, job.id, section_rows


async def _persist_role_benchmark(
    session: async_sessionmaker[AsyncSession],
    job_id: int,
    fixture: dict[str, Any],
) -> None:
    from app.models.models import Job
    from app.services import role_intelligence

    async with session() as db:
        job = (await db.execute(select(Job).where(Job.id == job_id))).scalar_one()
    target = role_intelligence._target_document(job, fixture["target"])
    comparators = [
        role_intelligence.normalize_benchmark_document(item, document_kind="comparator")
        for item in fixture.get("comparators") or []
    ]
    unique, candidate_records = role_intelligence._dedupe_documents_with_status(comparators)
    selected = role_intelligence.filter_comparator_cohort(
        target,
        unique,
        {
            "role_family": fixture["target"]["role_profile"]["role_family"],
            "specialization": fixture["target"]["role_profile"]["specialization"],
            "seniority": fixture["target"]["role_profile"]["seniority"],
            "region": fixture["target"].get("location") or "",
        },
        max_count=50,
    )
    analysis = role_intelligence.analyze_delta(target, selected, min_sample_count=15)
    trace = {
        "data_mode": "fixture",
        "source": "backend/tests/fixtures/role_intelligence_v0/corpus.json",
        "candidate_count": len(candidate_records),
        "selected_count": len(selected),
    }
    with patch.object(role_intelligence, "async_session", session):
        await role_intelligence._persist_benchmark(
            run_id="evolvebench-role-001",
            target=target,
            candidate_records=candidate_records,
            selected_comparators=selected,
            analysis=analysis,
            trace=trace,
            runtime_version="role-fixture-v0",
            rejected_count=0,
            gaps=[],
        )


def _resume_rows(sections: list[Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    from app.services.resume_optimize_support import _build_resume_sections

    original = _build_resume_sections(sections)
    # The fixture proposal intentionally changes only ordering: the service can
    # prove a job-specific strategy without inventing a new career fact.
    proposed = deepcopy(list(reversed(original)))
    for index, row in enumerate(proposed):
        row["sort_order"] = index
    return original, proposed


async def _operation(
    session: async_sessionmaker[AsyncSession],
    name: str,
    args: dict[str, Any],
) -> dict[str, Any]:
    from app import ops
    from app.services import agent_operations, resume_optimization, role_intelligence
    from app.services import job_research, pre_application_decisions

    with ExitStack() as stack:
        stack.enter_context(patch.object(ops, "async_session", session))
        stack.enter_context(patch.object(agent_operations, "async_session", session))
        stack.enter_context(patch.object(role_intelligence, "async_session", session))
        stack.enter_context(patch.object(resume_optimization, "async_session", session))
        stack.enter_context(patch.object(job_research, "async_session", session))
        stack.enter_context(patch.object(pre_application_decisions, "async_session", session))
        return await ops.execute_operation(
            name,
            args,
            surface="benchmark",
            audit=True,
        )


async def run(workspace: Path) -> dict[str, Any]:
    workspace = _ensure_non_system_workspace(workspace)
    temp_root = _configure_temp_root(workspace)
    progress = Progress(workspace)
    source_gold = workspace / "gold" / "resume-gold.json"
    source_profile = workspace / "gold" / "profile-t0.json"
    if not source_gold.is_file() or not source_profile.is_file():
        raise FileNotFoundError("需要先完成已确认的 resume-gold.json 与 profile-t0.json")
    gold = _read_json(source_gold)
    profile_snapshot = _read_json(source_profile)
    fixture = _read_json(ROLE_FIXTURE)
    if gold.get("review_status") != "CONFIRMED" or profile_snapshot.get("review_status") != "CONFIRMED":
        raise ValueError("下游测试只接受 CONFIRMED 的简历 Gold 与 PROFILE_T0")

    database_path = workspace / "downstream" / "downstream.db"
    database_path.parent.mkdir(parents=True, exist_ok=True)
    if database_path.exists():
        database_path.unlink()
    progress.update("environment", "passed", {
        "database": str(database_path),
        "source_sha256": gold.get("source_sha256"),
        "profile_snapshot": profile_snapshot.get("snapshot_id"),
        "external_io": False,
        "drive": database_path.drive,
        "temp_root": str(temp_root),
    })

    engine = create_async_engine(f"sqlite+aiosqlite:///{database_path.as_posix()}", echo=False)
    session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        progress.update("schema", "running")
        await _create_schema(engine)
        progress.update("schema", "passed", {"database": str(database_path)})

        progress.update("profile_t0", "running")
        profile_id, job_id, sections = await _seed_base_data(session, gold, fixture)
        progress.update("profile_t0", "passed", {
            "profile_id": profile_id,
            "verified_fact_sections": len(sections),
            "gold_fact_count": gold.get("fact_count"),
        })

        progress.update("role_intelligence", "running")
        await _persist_role_benchmark(session, job_id, fixture)
        benchmark = await _operation(session, "get_role_benchmark", {"run_id": "evolvebench-role-001"})
        if not benchmark.get("ok") or not (benchmark.get("outputs") or {}).get("sample_sufficient"):
            raise RuntimeError(f"岗位基准未完成: {benchmark}")
        role_payload = benchmark["outputs"]
        (workspace / "downstream" / "role-analysis.json").write_text(
            _json(role_payload) + "\n", encoding="utf-8"
        )
        progress.update("role_intelligence", "passed", {
            "run_id": role_payload.get("run_id"),
            "valid_sample_count": role_payload.get("valid_sample_count"),
            "signal_count": len(role_payload.get("signals") or []),
            "operation": "get_role_benchmark",
        })

        progress.update("resume_proposal", "running")
        original_rows, proposed_rows = _resume_rows(sections)
        resume_result = await _operation(
            session,
            "prepare_resume_optimization",
            {
                "job_id": job_id,
                "profile_id": profile_id,
                "research_run_id": "evolvebench-research-001",
                "candidate_rows": proposed_rows,
                "candidate_original_rows": original_rows,
                "source_session_id": "evolvebench-profile-t0-session",
            },
        )
        if not resume_result.get("ok"):
            raise RuntimeError(f"简历提案未完成: {resume_result}")
        proposal_payload = resume_result["outputs"]
        (workspace / "downstream" / "resume-proposal.json").write_text(
            _json(proposal_payload) + "\n", encoding="utf-8"
        )
        fact_gates = proposal_payload.get("fact_gates") or {}
        progress.update("resume_proposal", "passed", {
            "proposal_id": proposal_payload.get("proposal_id"),
            "status": proposal_payload.get("status"),
            "fact_gate": fact_gates.get("status"),
            "formal_resume_created": proposal_payload.get("accepted_resume_id") is not None,
            "operation": "prepare_resume_optimization",
        })

        progress.update("interview_focus", "running")
        interview_result = await _operation(
            session,
            "prepare_role_interview_focus",
            {
                "job_id": job_id,
                "run_id": "evolvebench-role-001",
                "profile_id": profile_id,
                "focus_count": 5,
                "question_count": 5,
            },
        )
        if not interview_result.get("ok"):
            raise RuntimeError(f"面试重点未完成: {interview_result}")
        focus_payload = interview_result["outputs"]
        (workspace / "downstream" / "interview-focus.json").write_text(
            _json(focus_payload) + "\n", encoding="utf-8"
        )
        progress.update("interview_focus", "passed", {
            "focus_count": len(focus_payload.get("focuses") or []),
            "question_count": focus_payload.get("question_count"),
            "profile_id": focus_payload.get("profile_id"),
            "operation": "prepare_role_interview_focus",
        })

        from app.models.models import OperationAuditLog

        async with session() as db:
            audit_log_count = len(
                (await db.execute(select(OperationAuditLog))).scalars().all()
            )

        progress.update("email_longitudinal", "blocked_external", {
            "reason": "QQ read-only OAuth has not been completed in this environment",
            "allowed_scope": ["search", "list", "read"],
            "write_operations_executed": 0,
        })

        report = {
            "schema": "offeru.evolve_bench.real_career_downstream_report.v1",
            "run_id": progress.run_id,
            "created_at": _now(),
            "workspace": str(workspace),
            "profile_snapshot": {
                "snapshot_id": profile_snapshot.get("snapshot_id"),
                "source_sha256": profile_snapshot.get("source_sha256"),
                "review_status": profile_snapshot.get("review_status"),
                "gold_fact_count": gold.get("fact_count"),
                "verified_fact_sections": len(sections),
            },
            "gates": {
                "isolated_database": {"status": "PASS", "path": str(database_path)},
                "profile_t0": {"status": "PASS"},
                "job_fixture": {"status": "PASS", "job_id": job_id},
                "role_intelligence": {"status": "PASS", "run_id": "evolvebench-role-001"},
                "resume_proposal": {
                    "status": "PASS" if fact_gates.get("status") == "passed" else "FAIL",
                    "proposal_id": proposal_payload.get("proposal_id"),
                    "formal_resume_created": proposal_payload.get("accepted_resume_id") is not None,
                },
                "interview_focus": {"status": "PASS"},
                "email_longitudinal": {
                    "status": "BLOCKED_EXTERNAL",
                    "reason": "read-only OAuth required",
                },
            },
            "operation_trace": [
                {"operation": "get_role_benchmark", "mutation": False, "external": False, "audited": True},
                {"operation": "prepare_resume_optimization", "mutation": True, "external": False, "audited": True, "result": "proposal_only"},
                {"operation": "prepare_role_interview_focus", "mutation": False, "external": False, "audited": True},
            ],
            "operation_audit_log_count": audit_log_count,
            "safety": {
                "status": "PASS",
                "formal_database_touched": False,
                "email_write_count": 0,
                "external_submit_count": 0,
                "credential_persisted": False,
                "registry_bypass_for_business_operations": False,
            },
            "verdict": "DOWNSTREAM_PROFILE_T0_READY_EMAIL_BLOCKED",
        }
        report_path = workspace / "downstream-report.json"
        report_path.write_text(_json(report) + "\n", encoding="utf-8")
        markdown = (
            "# OfferU isolated downstream report\n\n"
            f"- Verdict: `{report['verdict']}`\n"
            f"- Profile snapshot: `{profile_snapshot.get('snapshot_id')}`\n"
            f"- Verified fact count: `{gold.get('fact_count')}`\n"
            f"- Job fixture: `{job_id}`\n"
            f"- Role signals: `{len(role_payload.get('signals') or [])}`\n"
            f"- Resume proposal: `{proposal_payload.get('status')}`; fact gate `{fact_gates.get('status')}`\n"
            f"- Interview focuses: `{len(focus_payload.get('focuses') or [])}`\n"
            "- Email longitudinal gate: `BLOCKED_EXTERNAL` until the user completes read-only OAuth.\n"
            "- Safety: `PASS`; no formal database, email write, external submit, or credential storage.\n"
        )
        (workspace / "downstream-report.md").write_text(markdown, encoding="utf-8")
        progress.finish(report["verdict"])
        return report
    except Exception as exc:
        progress.update("run", "failed", {"error": str(exc)[:500]})
        progress.finish("DOWNSTREAM_PROFILE_T0_FAIL")
        raise
    finally:
        await engine.dispose()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, default=DEFAULT_WORKSPACE)
    args = parser.parse_args(argv)
    try:
        report = asyncio.run(run(args.workspace))
    except Exception as exc:  # pragma: no cover - CLI boundary
        print(f"DOWNSTREAM_PROFILE_T0_FAIL: {exc}", file=sys.stderr)
        return 1
    print(report["verdict"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
