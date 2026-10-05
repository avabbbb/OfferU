from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.database import Base
from app.models.models import (
    ApplicationAttempt,
    AutomationEvent,
    AutomationInboxItem,
    CareerTask,
    Job,
    OperationAuditLog,
    Profile,
    Resume,
    ResumeSection,
    ResumeVersion,
)
from app.services import (
    agent_operations,
    agent_run_state,
    automation,
    career_delivery,
    career_director,
    career_resume,
    career_tasks,
)
from app.services import resume_route_operations


def _version_snapshot(description: str) -> dict:
    return {
        "resume": {"summary": "Synthetic analyst focused on product evidence."},
        "sections": [
            {
                "section_type": "experience",
                "title": "Synthetic experience",
                "content_json": [{"position": "Product analyst", "description": description}],
            }
        ],
    }


def _career_briefing(resume_id: int, job_id: int, evidence_refs: list[str]) -> dict:
    return {
        "schema": "offeru.career_briefing.v1",
        "career_stage": {
            "track": "experienced",
            "substage": "early_career",
            "confidence": "medium",
            "basis": ["synthetic experience evidence"],
        },
        "strategy_pack": "experienced_search.v1",
        "situation_summary": "新简历补充了与旧岗位相关的可验证证据。",
        "profile_coverage": {
            "strong_evidence": [],
            "weak_evidence": [],
            "missing_evidence": [],
            "unknowns": [],
            "underexpressed_strengths": [],
        },
        "resume_update": {
            "resume_id": resume_id,
            "summary": "对照新旧简历证据检查仍有效的申请。",
            "added_evidence_summary": "新增了合成用户研究结果。",
            "candidates": [
                {
                    "job_id": job_id,
                    "worth_reengaging": True,
                    "why": "岗位要求用户研究，而新版本增加了对应的可验证项目结果。",
                    "suggested_angle": "准备一份围绕新增研究结果的重联草稿。",
                    "urgency": "soon",
                    "evidence_refs": evidence_refs,
                }
            ],
        },
        "priorities": [],
        "actions": [],
        "questions": [],
        "risks": [],
        "opportunities": [],
    }


def test_resume_context_uses_current_pointer_and_only_latest_attempt(monkeypatch) -> None:
    async def run() -> dict:
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            async with sessions() as db:
                profile = Profile(name="Synthetic Profile", is_default=True, base_info_json={})
                db.add(profile)
                await db.flush()
                resume = Resume(
                    user_name="Synthetic User",
                    title="Synthetic resume",
                    summary="Synthetic analyst",
                    contact_json={},
                    is_primary=True,
                    source_profile_id=profile.id,
                )
                db.add(resume)
                await db.flush()
                version_1 = ResumeVersion(
                    resume_id=resume.id,
                    version_number=1,
                    content_snapshot=_version_snapshot("Built a basic synthetic reporting dashboard."),
                    change_summary="Synthetic original",
                )
                db.add(version_1)
                await db.flush()
                version_2 = ResumeVersion(
                    resume_id=resume.id,
                    version_number=2,
                    content_snapshot=_version_snapshot(
                        "Built a synthetic user research dashboard that improved weekly insight review by 24%."
                    ),
                    change_summary="Synthetic evidence update",
                )
                db.add(version_2)
                await db.flush()
                # A later numbered backup exists, but a restored canonical pointer
                # remains authoritative for the currently selected Resume.
                version_3 = ResumeVersion(
                    resume_id=resume.id,
                    version_number=3,
                    content_snapshot=_version_snapshot("Synthetic pre-restore backup."),
                    change_summary="Synthetic backup",
                )
                db.add(version_3)
                await db.flush()
                resume.current_version_id = version_2.id
                eligible_job = Job(
                    title="Synthetic Product Analyst",
                    company="Synthetic Company",
                    summary="Research and product metrics",
                    raw_description="The role needs user research and product analytics.",
                    keywords=["user research", "product metrics"],
                    hash_key="synthetic-resume-eligible",
                )
                latest_attempt_job = Job(
                    title="Synthetic Operations Analyst",
                    company="Synthetic Company B",
                    raw_description="Synthetic role description",
                    hash_key="synthetic-resume-latest-attempt",
                )
                db.add_all([eligible_job, latest_attempt_job])
                await db.flush()
                ten_days_ago = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=10)
                db.add_all(
                    [
                        ApplicationAttempt(
                            job_id=eligible_job.id,
                            resume_id=resume.id,
                            resume_version_id=version_1.id,
                            status="applied",
                            created_at=ten_days_ago,
                        ),
                        # The latest attempt uses the current version, so the older
                        # still-open attempt for this same Job must not be resurrected.
                        ApplicationAttempt(
                            job_id=latest_attempt_job.id,
                            resume_id=resume.id,
                            resume_version_id=version_1.id,
                            status="applied",
                            created_at=ten_days_ago,
                        ),
                        ApplicationAttempt(
                            job_id=latest_attempt_job.id,
                            resume_id=resume.id,
                            resume_version_id=version_2.id,
                            status="applied",
                            created_at=ten_days_ago + timedelta(days=1),
                        ),
                    ]
                )
                await db.commit()
                resume_id = resume.id
                eligible_job_id = eligible_job.id
                latest_job_id = latest_attempt_job.id
            monkeypatch.setattr(career_resume, "async_session", sessions)
            context = await career_resume.get_resume_reengagement_context(resume_id=resume_id)
            return context, eligible_job_id, latest_job_id
        finally:
            await engine.dispose()

    context, eligible_job_id, latest_job_id = asyncio.run(run())
    assert context["current_version"]["version_number"] == 2
    assert context["previous_version"]["version_number"] == 1
    assert [item["job_id"] for item in context["candidates"]] == [eligible_job_id]
    assert context["candidates"][0]["days_since_application"] >= 4
    assert all(item["job_id"] != latest_job_id for item in context["candidates"])
    assert context["candidates"][0]["evidence_refs"][0] == "resume_added_1"


def test_resume_plan_is_bound_to_registry_candidates_and_evidence() -> None:
    resume_id = 9
    job_id = 41
    context = {
        "candidates": [
            {
                "job_id": job_id,
                "company": "Registry Company",
                "role": "Registry Role",
                "evidence_refs": ["resume_added_1", "job.description", "application.stage"],
            }
        ]
    }
    plan = _career_briefing(resume_id, job_id, ["resume_added_1", "job.description"])
    plan["resume_update"]["candidates"][0]["company"] = "Model invented company"
    checked = career_tasks._validate_resume_reengagement_plan(
        plan,
        expected_resume_id=resume_id,
        context=context,
    )
    assert checked["resume_update"]["candidates"][0]["company"] == "Registry Company"

    unknown_job = _career_briefing(resume_id, job_id + 1, ["resume_added_1", "job.description"])
    with pytest.raises(ValueError, match="未获准或重复的岗位"):
        career_tasks._validate_resume_reengagement_plan(
            unknown_job,
            expected_resume_id=resume_id,
            context=context,
        )

    unsupported_evidence = _career_briefing(resume_id, job_id, ["invented-evidence", "job.description"])
    with pytest.raises(ValueError, match="岗位/简历证据"):
        career_tasks._validate_resume_reengagement_plan(
            unsupported_evidence,
            expected_resume_id=resume_id,
            context=context,
        )


def test_saved_resume_version_uses_synthetic_provider_with_real_registry_path(monkeypatch, tmp_path) -> None:
    async def run() -> dict:
        # This path starts a background CareerTask while the AutomationEvent
        # dispatcher is finishing its own transaction. A file-backed isolated
        # DB models the production multi-connection SQLite behavior faithfully.
        db_path = (tmp_path / "resume-career-director.db").as_posix()
        engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}")
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            async with sessions() as db:
                profile = Profile(
                    name="Synthetic Profile",
                    is_default=True,
                    base_info_json={"employment_state": "Considering another full-time role"},
                )
                db.add(profile)
                await db.flush()
                resume = Resume(
                    user_name="Synthetic User",
                    title="Synthetic primary resume",
                    summary="Synthetic product analyst",
                    contact_json={"email": "demo.user@example.test"},
                    is_primary=True,
                    source_profile_id=profile.id,
                )
                db.add(resume)
                await db.flush()
                section = ResumeSection(
                    resume_id=resume.id,
                    section_type="experience",
                    title="Synthetic experience",
                    content_json=[
                        {
                            "position": "Product analyst",
                            "description": "Built a basic synthetic reporting dashboard.",
                        }
                    ],
                )
                db.add(section)
                await db.flush()
                original = ResumeVersion(
                    resume_id=resume.id,
                    version_number=1,
                    content_snapshot=_version_snapshot("Built a basic synthetic reporting dashboard."),
                    change_summary="Synthetic original",
                )
                db.add(original)
                await db.flush()
                resume.current_version_id = original.id
                section.content_json = [
                    {
                        "position": "Product analyst",
                        "description": "Built a synthetic user research dashboard serving 120 weekly users and improved review speed by 24%.",
                    }
                ]
                job = Job(
                    title="Synthetic Product Analyst",
                    company="Synthetic Company",
                    summary="User research and product metrics",
                    raw_description="We need user research, product metrics, and clear evidence of cross-team ownership.",
                    keywords=["user research", "product metrics"],
                    hash_key="synthetic-resume-agent-job",
                )
                db.add(job)
                await db.flush()
                db.add(
                    ApplicationAttempt(
                        job_id=job.id,
                        resume_id=resume.id,
                        resume_version_id=original.id,
                        status="applied",
                        created_at=datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=12),
                    )
                )
                await db.commit()
                resume_id, job_id, profile_id = resume.id, job.id, profile.id

            for module in (
                automation,
                career_tasks,
                career_director,
                career_resume,
                career_delivery,
                agent_operations,
                agent_run_state,
                resume_route_operations,
            ):
                monkeypatch.setattr(module, "async_session", sessions)
            import app.ops as ops
            import app.services.agent_runtime as agent_runtime
            from app.services import proposal_plan_store

            monkeypatch.setattr(ops, "async_session", sessions)
            monkeypatch.setattr(proposal_plan_store, "async_session", sessions)
            monkeypatch.setattr(career_tasks, "_career_director_workspace", lambda: "H:\\tmp\\offeru")
            observed: dict[str, object] = {"tool_calls": [], "contexts": [], "prompt": ""}

            class SyntheticEmbeddedRunProvider:
                """Deterministic unit fixture at the current AgentRunProvider seam.

                It issues synthetic reasoning output, while reads, audit rows,
                durable Run events, Policy validation and delivery persistence
                all pass through their production services.
                """

                async def start_run(
                    self,
                    *,
                    message,
                    skill_id,
                    conversation_id,
                    task_id,
                    context_messages,
                    requested_run_id,
                    **_kwargs,
                ):
                    del context_messages
                    observed["prompt"] = message
                    run = await agent_run_state.create_agent_run(
                        conversation_id=conversation_id,
                        goal="Synthetic Career Director fixture",
                        mode="career_director",
                        skill_id=skill_id,
                        task_id=task_id,
                        actions=[],
                        llm_runtime={
                            "runtime": "synthetic_test_provider",
                            "provider_id": "synthetic_fixture",
                        },
                        run_id=requested_run_id,
                    )
                    model_context = {}
                    for operation, arguments in (
                        ("get_career_snapshot", {}),
                        ("get_resume_reengagement_context", {"resume_id": resume_id}),
                    ):
                        await agent_run_state.append_agent_run_event(
                            run["id"],
                            event_type="operation.started",
                            payload={"operation": operation, "fixture": "synthetic_unit"},
                        )
                        envelope = await ops.execute_operation(
                            operation,
                            arguments,
                            surface="career_director",
                            audit=True,
                        )
                        if not envelope.get("ok") or not isinstance(envelope.get("outputs"), dict):
                            raise AssertionError(f"synthetic provider Registry read failed: {operation}")
                        outputs = envelope["outputs"]
                        await agent_run_state.append_agent_run_event(
                            run["id"],
                            event_type="operation.completed",
                            payload={"operation": operation, "fixture": "synthetic_unit"},
                        )
                        observed["tool_calls"].append(operation)
                        if operation == "get_resume_reengagement_context":
                            model_context = outputs
                    observed["contexts"].append(model_context)
                    candidate = model_context["candidates"][0]
                    assistant_message = json.dumps(
                        _career_briefing(
                            resume_id,
                            int(candidate["job_id"]),
                            list(candidate["evidence_refs"]),
                        ),
                        ensure_ascii=False,
                    )
                    run["status"] = "completed"
                    run["final_result"] = {
                        "assistant_message": assistant_message,
                        "requires_confirmation": False,
                        "turn_finished": True,
                    }
                    run = await agent_run_state.save_agent_run(run)
                    return {
                        "ok": True,
                        "run": run,
                        "assistant_message": assistant_message,
                        "pending_actions": [],
                        "active_skill": {"id": skill_id},
                        "conversation_id": conversation_id,
                    }

            monkeypatch.setattr(
                agent_runtime,
                "get_agent_run_provider",
                lambda _provider="embedded": SyntheticEmbeddedRunProvider(),
            )

            saved = await resume_route_operations.create_resume_version_record(
                resume_id,
                change_summary="Synthetic user research evidence",
                created_by="user",
            )
            event_id = saved["automation"]["event_id"]
            task_id = saved["automation"]["task_id"]
            assert saved["automation"]["status"] == "dispatched"
            # This is an in-process scheduler. Await its actual worker so the
            # isolated database remains available through completion.
            worker = career_tasks._LIVE_TASKS.get(task_id)
            if worker is not None:
                await asyncio.wait_for(worker, timeout=30)
            task = await career_tasks.get_career_task(task_id)
            async with sessions() as db:
                observed_audits = (
                    await db.execute(
                        select(OperationAuditLog).where(
                            OperationAuditLog.operation.in_(
                                ("get_career_snapshot", "get_resume_reengagement_context")
                            )
                        )
                    )
                ).scalars().all()
            assert task["status"] == "completed", (
                task.get("error"),
                [(row.operation, row.errors_json) for row in observed_audits],
            )
            async with sessions() as db:
                event = await db.get(AutomationEvent, event_id)
                item = await db.get(AutomationInboxItem, f"automation_task_{task_id}")
            repeated_context = await career_resume.get_resume_reengagement_context(
                resume_id=resume_id
            )

            # Re-saving without added evidence must not create another Agent task.
            cosmetic = await resume_route_operations.create_resume_version_record(
                resume_id,
                change_summary="Synthetic formatting only",
                created_by="user",
            )
            async with sessions() as db:
                events = (
                    await db.execute(select(AutomationEvent).where(AutomationEvent.event_type == "RESUME_UPDATED"))
                ).scalars().all()
                tasks = (
                    await db.execute(select(CareerTask).where(CareerTask.task_type == "career_director"))
                ).scalars().all()
                audits = (
                    await db.execute(
                        select(OperationAuditLog).where(
                            OperationAuditLog.operation.in_(("get_career_snapshot", "get_resume_reengagement_context"))
                        )
                    )
                ).scalars().all()
                inbox = await db.get(AutomationInboxItem, f"automation_task_{task_id}")
                stored_profile = await db.get(Profile, profile_id)
            return {
                "task": task,
                "deliveries": task.get("result", {}).get("deliveries", []),
                "event": event,
                "inbox": inbox,
                "events": events,
                "tasks": tasks,
                "audits": audits,
                "context": observed["contexts"][0],
                "repeated_context": repeated_context,
                "tool_calls": task.get("result", {}).get("runtime", {}).get("tool_calls", []),
                "policy_validation": task.get("result", {}).get("policy_validation", {}),
                "prompt": observed["prompt"],
                "profile": stored_profile.base_info_json,
                "cosmetic": cosmetic,
            }
        finally:
            await engine.dispose()

    result = asyncio.run(run())
    assert result["task"]["status"] == "completed", result["task"]
    assert result["tool_calls"] == ["get_career_snapshot", "get_resume_reengagement_context"]
    assert result["policy_validation"]["ok"] is True
    assert "offeru.career_director_policy.v1" in result["prompt"]
    assert '"autonomy_ceiling":"L2"' in result["prompt"]
    assert result["event"].status == "completed"
    assert result["inbox"].category == "needs_review"
    assert result["inbox"].payload_json["resume_update"]["candidates"][0]["job_id"] == result["context"]["candidates"][0]["job_id"]
    assert result["inbox"].payload_json["reengagement_candidates"][0]["company"] == "Synthetic Company"
    reengagement_deliveries = [
        delivery
        for delivery in result["deliveries"]
        if delivery["artifact_type"] == "reengagement_candidate"
    ]
    assert len(reengagement_deliveries) == 1
    assert reengagement_deliveries[0]["state"] == "ready", (
        reengagement_deliveries[0].get("reason_code"),
        reengagement_deliveries[0].get("reason"),
    )
    assert reengagement_deliveries[0]["artifact_id"]
    assert result["repeated_context"]["candidates"] == []
    assert any(
        candidate["reason"] == "candidate_still_pending"
        for candidate in result["repeated_context"]["suppressed"]
    )
    assert result["profile"] == {"employment_state": "Considering another full-time role"}
    assert len(result["events"]) == 1
    assert len(result["tasks"]) == 1
    assert {row.operation for row in result["audits"]} == {
        "get_career_snapshot",
        "get_resume_reengagement_context",
    }
    assert all(row.surface == "career_director" and row.ok for row in result["audits"])
    assert result["cosmetic"]["automation"]["status"] == "not_triggered"
