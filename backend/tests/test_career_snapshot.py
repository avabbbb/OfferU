from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.database import Base
from app.models.models import (
    AutomationEvent,
    AutomationInboxItem,
    CalendarEvent,
    CareerSource,
    EvidenceLink,
    LearningObservation,
    MemoryProposal,
    Job,
    OperationAuditLog,
    Profile,
    ProfileSection,
    ProfileTargetRole,
    Resume,
)
from app.services import automation, career_delivery, career_director, career_tasks
from app.services import agent_operations, career_daily
from app.routes import main_agent
from app.services.career_director import (
    CareerBriefing,
    CareerStageAssessment,
    parse_career_briefing_response,
)


class FixtureDirectorRunProvider:
    """Recorded reasoning fixture; never represents a live Agent E2E."""

    def __init__(self, message, operations):
        self.message, self.operations = message, operations

    async def start_run(self, **kwargs):
        import app.ops as ops
        from app.services import agent_run_state
        self.launch = kwargs
        run = await agent_run_state.create_agent_run(
            conversation_id=kwargs["conversation_id"], goal=kwargs["message"],
            task_id=kwargs["task_id"], mode="career_director", skill_id=kwargs["skill_id"], actions=[],
        )
        for operation in self.operations:
            result = await ops.execute_operation(operation, {}, surface="career_director", audit=True)
            assert result["ok"], result
            if operation == "get_career_snapshot": self.read_snapshot = result["outputs"]
            await agent_run_state.append_agent_run_event(run["id"], event_type="operation.completed", payload={"operation": operation})
        run["status"] = "completed"
        await agent_run_state.save_agent_run(run)
        return {"ok": True, "run": run, "assistant_message": self.message}


def _briefing(
    *,
    track: str = "campus",
    substage: str = "fresh_graduate",
    strategy_pack: str = "campus_search.v1",
    questions: list[dict] | None = None,
    **updates,
) -> dict:
    payload = {
        "schema": "offeru.career_briefing.v1",
        "career_stage": {
            "track": track,
            "substage": substage,
            "confidence": "medium",
            "basis": ["profile-section:1"],
        },
        "strategy_pack": strategy_pack,
        "situation_summary": "正在验证适合的入门岗位方向。",
        "profile_coverage": {
            "strong_evidence": ["profile-section:1 有课程项目证据"],
            "weak_evidence": [],
            "missing_evidence": ["目标岗位方向"],
            "unknowns": ["是否有近期毕业计划"],
            "underexpressed_strengths": ["跨学科项目经验尚未突出"],
        },
        "priorities": [],
        "actions": [],
        "questions": questions or [],
        "risks": [],
        "opportunities": [],
    }
    payload.update(updates)
    return payload


def test_career_snapshot_is_read_only_and_keeps_unknown_distinct_from_weak(tmp_path, monkeypatch) -> None:
    async def flow() -> tuple[dict, int]:
        engine = create_async_engine(f"sqlite+aiosqlite:///{(tmp_path / 'career-snapshot.db').as_posix()}")
        session = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            async with session() as db:
                profile = Profile(
                    name="Synthetic Profile",
                    is_default=True,
                    base_info_json={
                        "birth_date": "1997-04-02",
                        "employment_state": "考虑新的全职机会",
                        "personal_archive": {
                            "applicationArchive": {
                                "jobPreference": {
                                    "expectedCities": ["上海"],
                                    "expectedSalary": "面议",
                                    "availableStartDate": "三个月内",
                                    "currentJobSearchStatus": "考虑新的全职机会",
                                },
                                "campusFields": {"graduationDate": "2026-06"},
                            }
                        },
                    },
                )
                db.add(profile)
                await db.flush()
                db.add_all(
                    [
                        ProfileTargetRole(
                            profile_id=profile.id,
                            role_name="产品分析师",
                            fit="primary",
                        ),
                        ProfileSection(
                            profile_id=profile.id,
                            section_type="project",
                            title="Synthetic course project",
                            content_json={
                                "bullet": "Designed a survey and analyzed 120 synthetic responses."
                            },
                            source="manual",
                            confidence=0.94,
                            tier="verified_fact",
                            status="active",
                        ),
                        ProfileSection(
                            profile_id=profile.id,
                            section_type="experience",
                            title="Synthetic internship",
                            content_json={"bullet": "Helped with user research."},
                            source="resume_import",
                            confidence=0.52,
                            tier="career_hypothesis",
                            status="active",
                        ),
                    ]
                )
                await db.commit()
            monkeypatch.setattr(career_director, "async_session", session)
            snapshot = await career_director.build_career_snapshot()
            async with session() as db:
                count = len((await db.execute(select(Profile))).scalars().all())
            return snapshot, count
        finally:
            await engine.dispose()

    snapshot, profile_count = asyncio.run(flow())
    assert profile_count == 1
    assert snapshot["schema"] == "offeru.career_snapshot.v2"
    assert snapshot["identity"]["career_stage"] is None
    assert snapshot["identity"]["employment_state"] == "考虑新的全职机会"
    assert snapshot["goals"]["primary_roles"] == ["产品分析师"]
    assert snapshot["goals"]["locations"] == ["上海"]
    assert snapshot["goals"]["compensation"] == "面议"
    coverage = snapshot["profile_coverage"]
    assert coverage["strong_evidence"] == [
        "profile-section:1 Synthetic course project — Designed a survey and analyzed 120 synthetic responses."
    ]
    assert coverage["weak_evidence"] == [
        "profile-section:2 Synthetic internship — Helped with user research."
    ]
    assert coverage["unknowns"]
    assert coverage["underexpressed_strengths"] == []
    assert "1997-04-02" not in json.dumps(snapshot)


def test_snapshot_without_profile_does_not_create_default_profile(tmp_path, monkeypatch) -> None:
    async def flow() -> tuple[dict, int]:
        engine = create_async_engine(f"sqlite+aiosqlite:///{(tmp_path / 'empty-career-snapshot.db').as_posix()}")
        session = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            monkeypatch.setattr(career_director, "async_session", session)
            snapshot = await career_director.build_career_snapshot()
            async with session() as db:
                count = len((await db.execute(select(Profile))).scalars().all())
            return snapshot, count
        finally:
            await engine.dispose()

    snapshot, profile_count = asyncio.run(flow())
    assert profile_count == 0
    assert snapshot["profile_id"] is None
    assert snapshot["profile_coverage"]["missing_evidence"]
    assert "当前职业阶段尚未确认" in snapshot["profile_coverage"]["unknowns"]


def test_explicit_stage_correction_preserves_unrelated_profile_data_atomically(tmp_path, monkeypatch) -> None:
    async def flow() -> tuple[dict, dict]:
        engine = create_async_engine(f"sqlite+aiosqlite:///{(tmp_path / 'career-stage-correction.db').as_posix()}")
        session = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            async with session() as db:
                db.add(
                    Profile(
                        name="Synthetic correction fixture",
                        is_default=True,
                        base_info_json={"keep_this": "unchanged", "employment_state": "在职"},
                    )
                )
                await db.commit()
            monkeypatch.setattr(career_director, "async_session", session)
            result = await career_director.correct_career_stage(
                track="experienced",
                substage="career_switch",
            )
            async with session() as db:
                profile = (await db.execute(select(Profile))).scalar_one()
            return result, profile.base_info_json
        finally:
            await engine.dispose()

    result, base_info = asyncio.run(flow())
    assert result["changed"] is True
    assert result["snapshot"]["identity"]["career_stage"] == {
        "track": "experienced",
        "substage": "career_switch",
        "confidence": "high",
        "basis": ["user-confirmed"],
    }
    assert result["snapshot"]["identity"]["career_stage_source"] == "user_confirmed"
    assert base_info["keep_this"] == "unchanged"
    assert base_info["career_stage_correction"]["schema"] == "offeru.career_stage_correction.v1"


def test_career_stage_and_strategy_contracts_distinguish_campus_and_experienced() -> None:
    campus = CareerBriefing.model_validate(_briefing())
    experienced = CareerBriefing.model_validate(
        _briefing(
            track="experienced",
            substage="early_career",
            strategy_pack="experienced_search.v1",
            situation_summary="已有全职经验，需突出业务影响。",
        )
    )
    assert campus.strategy_pack == "campus_search.v1"
    assert experienced.strategy_pack == "experienced_search.v1"
    with pytest.raises(ValueError, match="strategy_pack"):
        CareerBriefing.model_validate(
            _briefing(
                track="experienced",
                substage="early_career",
                strategy_pack="campus_search.v1",
            )
        )
    with pytest.raises(ValueError, match="must use campus"):
        CareerStageAssessment(
            track="experienced",
            substage="fresh_graduate",
            confidence="medium",
            basis=["profile-section:1"],
        )


def test_career_briefing_enforces_small_question_count_and_human_gates() -> None:
    question = {
        "question": "你更偏好哪类岗位？",
        "why_needed": "不同方向需要强调不同经历。",
        "unlocks": "确定 Profile 和 Job Assessment 的重点。",
        "optional": True,
    }
    assert len(CareerBriefing.model_validate(_briefing(questions=[question] * 3)).questions) == 3
    with pytest.raises(ValueError, match="at most 3"):
        CareerBriefing.model_validate(_briefing(questions=[question] * 4))

    invalid = _briefing(
        actions=[
            {
                "objective": "更新 Profile 阶段",
                "why_now": "新证据表明目标方向已改变。",
                "skill": "",
                "suggested_operations": ["correct_career_stage"],
                "autonomy_level": "L2",
                "expected_outcome": "更新职业阶段",
                "requires_user": False,
                "dedupe_key": "profile-stage-correction",
            }
        ]
    )
    with pytest.raises(ValueError, match="L2/L3"):
        CareerBriefing.model_validate(invalid)


def test_daily_context_collects_synthetic_urgency_proposals_learning_and_ignored_actions(
    tmp_path, monkeypatch
) -> None:
    async def flow() -> dict:
        engine = create_async_engine(
            f"sqlite+aiosqlite:///{(tmp_path / 'daily-career-context.db').as_posix()}"
        )
        session = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            now = datetime.now().astimezone().replace(tzinfo=None)
            cutoff = now - timedelta(days=30)
            async with session() as db:
                profile = Profile(
                    name="Synthetic daily profile",
                    is_default=True,
                    base_info_json={"employment_state": "synthetic search"},
                    updated_at=now,
                )
                job = Job(title="Synthetic Research Associate", company="Fixture Labs", hash_key="daily-context-job")
                db.add_all([profile, job])
                await db.flush()
                db.add(
                    ProfileSection(
                        profile_id=profile.id,
                        section_type="project",
                        title="Synthetic portfolio update",
                        content_json={"bullet": "Updated synthetic analytics project evidence."},
                        source="manual",
                        confidence=0.9,
                        tier="verified_fact",
                        status="active",
                        updated_at=now,
                    )
                )
                db.add(
                    Resume(
                        user_name="Synthetic Candidate",
                        title="Synthetic revised resume",
                        source_profile_id=profile.id,
                        workspace_revision=3,
                        updated_at=now,
                    )
                )
                db.add(
                    CalendarEvent(
                        title="Synthetic panel interview",
                        event_type="interview",
                        start_time=now + timedelta(days=1),
                        related_job_id=job.id,
                    )
                )
                proposal = MemoryProposal(
                    proposal_key="synthetic-daily-proposal",
                    target_tier="career_hypothesis",
                    section_type="skill",
                    title="Synthetic impact evidence needs review",
                    reason="Synthetic interview feedback needs owner review.",
                    status="pending",
                    created_at=now,
                )
                db.add(proposal)
                source = CareerSource(
                    source_type="synthetic_test",
                    external_id="daily-interview-learning",
                    title="Synthetic interview debrief",
                )
                db.add(source)
                await db.flush()
                observation = LearningObservation(
                    source_id=source.id,
                    observation_type="interview_completed",
                    content_json={
                        "summary": "Synthetic answers need clearer outcome evidence.",
                        "focuses": [{"capability": "Impact storytelling", "training_priority": "high"}],
                    },
                    content_hash="a" * 64,
                    idempotency_key="synthetic-daily-interview-learning",
                    status="active",
                    observed_at=now,
                )
                db.add(observation)
                await db.flush()
                db.add(EvidenceLink(
                    observation_id=observation.id,
                    target_type="memory_proposal",
                    target_id=proposal.id,
                    relation="supports",
                    is_active=True,
                ))
                ignored_briefing = _briefing(
                    actions=[
                        {
                            "objective": "完善研究助理岗位证据",
                            "why_now": "该岗位的申请窗口仍然开放。",
                            "skill": "evidence_review",
                            "suggested_operations": ["get_career_snapshot"],
                            "autonomy_level": "L1",
                            "expected_outcome": "准备岗位证据清单。",
                            "requires_user": False,
                            "dedupe_key": "synthetic-stable-suggestion",
                            "target_ref": {"kind": "job", "id": str(job.id)},
                        }
                    ]
                )
                for index in range(2):
                    db.add(
                        AutomationInboxItem(
                            item_id=f"synthetic-dismissed-daily-{index}",
                            category="needs_review",
                            status="dismissed",
                            target_type="career_brief",
                            target_id=f"2026-09-{20 + index}",
                            title="Synthetic dismissed daily brief",
                            body="Synthetic dismissed action.",
                            payload_json={"briefing": ignored_briefing},
                            created_at=now - timedelta(days=index + 1),
                            updated_at=now - timedelta(days=index + 1),
                        )
                    )
                await db.commit()
                profile_id = profile.id
                job_id = job.id

            monkeypatch.setattr(career_daily, "async_session", session)

            async def fake_board(**_kwargs):
                return {
                    "companies": [
                        {
                            "company": "Fixture Labs",
                            "records": [
                                {
                                    "job_id": job_id,
                                    "job_title": "Synthetic Research Associate",
                                    "current_stage": "interview_1",
                                    "next_action": "Prepare tomorrow's synthetic interview",
                                    "last_event_at": now.isoformat(),
                                    "pending_candidates": 0,
                                }
                            ],
                        }
                    ]
                }

            async def fake_followups():
                return {
                    "entries": [
                        {
                            "application_type": "application_record",
                            "application_id": 17,
                            "job_id": job_id,
                            "company": "Fixture Labs",
                            "role": "Synthetic Research Associate",
                            "next_follow_up_date": now.date().isoformat(),
                            "days_until_follow_up": 0,
                            "urgency": "overdue",
                            "notes": "must not be projected",
                        }
                    ]
                }

            monkeypatch.setattr(agent_operations, "get_application_progress_board", fake_board)
            monkeypatch.setattr(agent_operations, "list_follow_up_cadence", fake_followups)
            return await career_daily.build_daily_career_context(profile_id=profile_id)
        finally:
            await engine.dispose()

    context = asyncio.run(flow())
    assert context["schema"] == "offeru.daily_career_context.v2"
    assert context["pipeline"][0]["job_id"] > 0
    assert context["upcoming_interviews"][0]["title"] == "Synthetic panel interview"
    assert context["follow_ups_due"][0]["urgency"] == "overdue"
    assert context["pending_proposals"][0]["title"] == "Synthetic impact evidence needs review"
    assert {change["kind"] for change in context["recent_changes"]} == {"profile", "resume"}
    assert context["interview_learning"][0]["review_status"] == "pending"
    assert context["interview_learning"][0]["weak_areas"] == []
    assert context["ignored_suggestions"][0]["dedupe_key"] == "synthetic-stable-suggestion"
    assert context["ignored_suggestions"][0]["dismissals"] == 2
    assert "must not be projected" not in json.dumps(context)


def test_daily_review_suppresses_only_exact_repeatedly_dismissed_suggestions() -> None:
    briefing = _briefing(
        actions=[
            {
                "objective": "重复提醒",
                "why_now": "依据没有变化。",
                "skill": "evidence_review",
                "suggested_operations": [],
                "autonomy_level": "L1",
                "expected_outcome": "查看证据。",
                "requires_user": False,
                "dedupe_key": "ignored-twice",
            },
            {
                "objective": "明日面试准备",
                "why_now": "明日新增了面试安排。",
                "skill": "interview_prep",
                "suggested_operations": [],
                "autonomy_level": "L1",
                "expected_outcome": "准备练习重点。",
                "requires_user": False,
                "dedupe_key": "new-interview-evidence",
            },
        ]
    )
    context = {
        "ignored_suggestions": [
            {"dedupe_key": "ignored-twice", "dismissals": 2},
            {"dedupe_key": "ignored-once", "dismissals": 1},
        ]
    }
    filtered = career_daily.suppress_repeatedly_ignored_actions(briefing, context)
    assert [action["dedupe_key"] for action in filtered["actions"]] == ["new-interview-evidence"]


def test_daily_review_event_is_idempotent_and_uses_career_task_dispatch(tmp_path, monkeypatch) -> None:
    async def flow() -> tuple[dict, dict, int, int]:
        engine = create_async_engine(
            f"sqlite+aiosqlite:///{(tmp_path / 'daily-review-dispatch.db').as_posix()}"
        )
        session = async_sessionmaker(engine, expire_on_commit=False)
        started: list[dict] = []
        try:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            monkeypatch.setattr(automation, "async_session", session)

            async def fake_start_career_task(**kwargs):
                started.append(kwargs)
                return {
                    "task_id": "career_task_synthetic_daily_dispatch",
                    "task_type": kwargs["task_type"],
                    "runtime_provider": kwargs["runtime_provider"],
                    "status": "queued",
                    "progress": {"stage": "queued"},
                }

            monkeypatch.setattr(career_tasks, "start_career_task", fake_start_career_task)
            first = await automation.record_automation_event(
                event_type="DAILY_REVIEW",
                source="today_open",
                target_type="profile",
                target_id="1",
                payload={"review_date": "2026-09-26"},
                dedupe_key="synthetic-daily-review:1:2026-09-26",
            )
            second = await automation.record_automation_event(
                event_type="DAILY_REVIEW",
                source="today_open",
                target_type="profile",
                target_id="1",
                payload={"review_date": "2026-09-26"},
                dedupe_key="synthetic-daily-review:1:2026-09-26",
            )
            async with session() as db:
                event_count = len((await db.execute(select(AutomationEvent))).scalars().all())
                inbox_count = len((await db.execute(select(AutomationInboxItem))).scalars().all())
            return first, second, event_count, inbox_count
        finally:
            await engine.dispose()

    first, second, event_count, inbox_count = asyncio.run(flow())
    assert first["status"] == "dispatched"
    assert first["result"]["task"]["task_type"] == "career_director"
    assert second["reused"] is True
    assert second["event_id"] == first["event_id"]
    assert event_count == 1
    assert inbox_count == 1


def test_today_daily_review_route_uses_registry_and_dedupes_by_profile_and_local_date(monkeypatch) -> None:
    async def flow() -> tuple[dict, list[tuple[str, dict]]]:
        calls: list[tuple[str, dict]] = []

        async def fake_registry_operation(name: str, arguments: dict) -> dict:
            calls.append((name, arguments))
            if name == "get_career_snapshot":
                return {"profile_id": 73}
            return {"event_id": "synthetic-daily-event", "status": "dispatched"}

        monkeypatch.setattr(main_agent, "_ui_operation_outputs", fake_registry_operation)
        return await main_agent.trigger_daily_career_review(), calls

    response, calls = asyncio.run(flow())
    assert [name for name, _ in calls] == ["get_career_snapshot", "record_automation_event"]
    event_args = calls[1][1]
    assert event_args["event_type"] == "DAILY_REVIEW"
    assert event_args["source"] == "today_open"
    assert event_args["target_type"] == "profile"
    assert event_args["target_id"] == "73"
    assert event_args["payload"]["review_date"] == datetime.now().astimezone().date().isoformat()
    assert event_args["dedupe_key"] == f"daily-review:73:{event_args['payload']['review_date']}"
    assert response["status"] == "dispatched"


def test_daily_career_director_must_read_daily_context_and_keeps_new_urgent_action(
    tmp_path, monkeypatch
) -> None:
    async def flow() -> dict:
        engine = create_async_engine(
            f"sqlite+aiosqlite:///{(tmp_path / 'daily-career-runtime.db').as_posix()}"
        )
        session = async_sessionmaker(engine, expire_on_commit=False)
        monkeypatch.setattr(career_delivery, "async_session", session)
        try:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            task_id = "career_task_synthetic_daily"
            event_id = "automation_evt_synthetic_daily"
            async with session() as db:
                db.add(
                    AutomationEvent(
                        event_id=event_id,
                        event_type="DAILY_REVIEW",
                        source="today_open",
                        target_type="profile",
                        target_id="1",
                        payload_json={"review_date": "2026-09-26"},
                        dedupe_key="synthetic-daily-runtime-event",
                        status="processing",
                    )
                )
                db.add(
                    career_tasks.CareerTask(
                        task_id=task_id,
                        task_type="career_director",
                        source="automation",
                        target_type="profile",
                        target_id="1",
                        runtime_provider="codex",
                        input_json={
                            "automation_event_id": event_id,
                            "event_type": "DAILY_REVIEW",
                            "profile_id": 1,
                            "review_date": "2026-09-26",
                        },
                        output_contract_json={"schema": "offeru.career_briefing.v1"},
                        status="running",
                        progress_json={"stage": "running"},
                        idempotency_key="synthetic-daily-career-task",
                    )
                )
                await db.commit()
            monkeypatch.setattr(career_tasks, "async_session", session)
            import app.ops as ops

            snapshot = {
                "schema": "offeru.career_snapshot.v2",
                "profile_id": 1,
                "identity": {"career_stage": None},
                "goals": {"primary_roles": ["Synthetic analyst"]},
                "profile_coverage": {},
            }
            daily_context = {
                "schema": "offeru.daily_career_context.v2",
                "review_date": "2026-09-26",
                "pipeline": [],
                "follow_ups_due": [],
                "upcoming_interviews": [{"event_id": 8, "title": "Tomorrow interview", "hours_until": 24}],
                "pending_proposals": [],
                "recent_changes": [],
                "interview_learning": [],
                "ignored_suggestions": [
                    {"dedupe_key": "ignore-twice", "dismissals": 2}
                ],
            }
            calls: list[tuple[str, dict, str, bool]] = []

            async def fake_execute(operation, arguments, *, surface, audit):
                calls.append((operation, arguments, surface, audit))
                outputs = snapshot if operation == "get_career_snapshot" else daily_context
                return {"ok": True, "outputs": outputs}

            monkeypatch.setattr(ops, "execute_operation", fake_execute)

            briefing_payload = _briefing(
                actions=[
                    {
                        "objective": "之前忽略的建议",
                        "why_now": "依据没有变化。",
                        "action_key": "explore.direction",
                        "skill": "title_discovery",
                        "suggested_operations": [],
                        "autonomy_level": "L1",
                        "expected_outcome": "查看证据。",
                        "requires_user": False,
                        "dedupe_key": "ignore-twice",
                        "target_ref": {"kind": "profile", "id": "1"},
                    },
                    {
                        "objective": "准备明日面试",
                        "why_now": "明天将进行 Synthetic Analyst 面试。",
                        "action_key": "interview.prepare",
                        "skill": "interview_prep",
                        "suggested_operations": [],
                        "autonomy_level": "L1",
                        "expected_outcome": "准备岗位重点和练习问题。",
                        "requires_user": True,
                        "dedupe_key": "tomorrow-interview-8",
                        "target_ref": {"kind": "interview", "id": "8"},
                    },
                ]
            )
            message = json.dumps(briefing_payload, ensure_ascii=False)

            provider = FixtureDirectorRunProvider(message, ["get_career_snapshot", "get_daily_career_context"])
            from app.services import agent_runtime, agent_run_state
            monkeypatch.setattr(agent_run_state, "async_session", session)
            monkeypatch.setattr(agent_runtime, "get_agent_run_provider", lambda _provider_id: provider)
            monkeypatch.setattr(career_tasks, "_career_director_workspace", lambda: str(tmp_path))
            result = await career_tasks._run_career_director(
                {
                    "task_id": task_id,
                    "runtime_provider": "codex",
                    "run_id": "",
                    "input": {
                        "automation_event_id": event_id,
                        "event_type": "DAILY_REVIEW",
                        "profile_id": 1,
                        "review_date": "2026-09-26",
                    },
                }
            )
            return {"result": result, "calls": calls, "provider": provider}
        finally:
            await engine.dispose()

    observed = asyncio.run(flow())
    assert [call[0] for call in observed["calls"]] == [
        "get_career_snapshot",
        "get_daily_career_context",
        "get_career_snapshot",
        "get_daily_career_context",
    ]
    assert all(call[2:] == ("career_director", True) for call in observed["calls"])
    assert observed["result"]["runtime"]["tool_calls"] == ["get_career_snapshot", "get_daily_career_context"]
    assert [action["dedupe_key"] for action in observed["result"]["briefing"]["actions"]] == ["tomorrow-interview-8"]
    assert observed["provider"].launch["skill_id"] == "career_director"


def test_model_briefing_is_strict_and_cannot_override_user_correction() -> None:
    corrected = CareerStageAssessment(
        track="experienced",
        substage="career_switch",
        confidence="high",
        basis=["user-confirmed"],
    )
    result = parse_career_briefing_response(
        json.dumps(_briefing(), ensure_ascii=False),
        confirmed_stage=corrected,
    )
    assert result["career_stage"]["substage"] == "career_switch"
    assert result["strategy_pack"] == "experienced_search.v1"

    payload = _briefing()
    payload["unreviewed_truth_write"] = True
    with pytest.raises(ValueError):
        parse_career_briefing_response(json.dumps(payload, ensure_ascii=False))

    with pytest.raises(ValueError):
        parse_career_briefing_response("```json\n{}\n```")


def test_career_director_refuses_replay_and_non_automation_task_sources() -> None:
    async def flow() -> None:
        with pytest.raises(ValueError, match="embedded.*Runtime"):
            await career_tasks.start_career_task(
                task_type="career_director",
                source="automation",
                target_type="profile",
                target_id="1",
                runtime_provider="replay",
                input={"automation_event_id": "synthetic-event", "event_type": "PROFILE_BASELINE_REQUIRED"},
                output_contract={"schema": "offeru.career_briefing.v1"},
            )
        with pytest.raises(ValueError, match="显式 AutomationEvent"):
            await career_tasks.start_career_task(
                task_type="career_director",
                source="ui",
                target_type="profile",
                target_id="1",
                runtime_provider="codex",
                input={"automation_event_id": "synthetic-event", "event_type": "PROFILE_BASELINE_REQUIRED"},
                output_contract={"schema": "offeru.career_briefing.v1"},
            )

    asyncio.run(flow())


def test_profile_discovery_runs_one_embedded_task_reads_registry_snapshot_and_projects_result(
    tmp_path, monkeypatch
) -> None:
    async def flow() -> tuple[dict, dict, dict, dict, int]:
        engine = create_async_engine(
            f"sqlite+aiosqlite:///{(tmp_path / 'career-director-flow.db').as_posix()}"
        )
        session = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            async with session() as db:
                profile = Profile(
                    name="Synthetic campus profile",
                    is_default=True,
                    base_info_json={"employment_state": "准备毕业"},
                )
                db.add(profile)
                await db.flush()
                profile_id = profile.id
                db.add(
                    ProfileTargetRole(
                        profile_id=profile_id,
                        role_name="数据分析师",
                        fit="primary",
                    )
                )
                db.add(
                    ProfileSection(
                        profile_id=profile_id,
                        section_type="project",
                        title="Synthetic capstone",
                        content_json={"bullet": "Analyzed synthetic survey data."},
                        source="manual",
                        confidence=0.9,
                        tier="verified_fact",
                        status="active",
                    )
                )
                await db.commit()

            monkeypatch.setattr(career_director, "async_session", session)
            monkeypatch.setattr(career_tasks, "async_session", session)
            monkeypatch.setattr(automation, "async_session", session)
            monkeypatch.setattr(career_delivery, "async_session", session)
            import app.ops as ops

            monkeypatch.setattr(ops, "async_session", session)

            provider_instances = []

            def make_provider(_provider_id):
                provider = FixtureDirectorRunProvider(json.dumps(_briefing(), ensure_ascii=False), ["get_career_snapshot"])
                provider_instances.append(provider)
                return provider

            from app.services import agent_runtime, agent_run_state
            monkeypatch.setattr(agent_run_state, "async_session", session)
            monkeypatch.setattr(agent_runtime, "get_agent_run_provider", make_provider)
            monkeypatch.setattr(career_tasks, "_career_director_workspace", lambda: str(tmp_path))

            event_result = await automation.record_automation_event(
                event_type="PROFILE_BASELINE_REQUIRED",
                source="profile_ui",
                target_type="profile",
                target_id=str(profile_id),
                payload={"runtime_provider": "codex"},
                dedupe_key="synthetic-profile-discovery-once",
            )
            task_id = event_result["result"]["task"]["task_id"]
            for _ in range(200):
                task = await career_tasks.get_career_task(task_id)
                if task["status"] in {"completed", "failed", "blocked", "cancelled"}:
                    break
                await asyncio.sleep(0.01)
            for _ in range(200):
                async with session() as db:
                    event = await db.get(AutomationEvent, event_result["event_id"])
                    if event is not None and event.status == "completed":
                        break
                await asyncio.sleep(0.01)
            async with session() as db:
                event = await db.get(AutomationEvent, event_result["event_id"])
                item = await db.get(AutomationInboxItem, f"automation_task_{task_id}")
                profile = await db.get(Profile, profile_id)
                audits = (
                    await db.execute(
                        select(OperationAuditLog).where(
                            OperationAuditLog.operation == "get_career_snapshot"
                        )
                    )
                ).scalars().all()
                state = {
                    "event_status": event.status,
                    "inbox_category": item.category,
                    "inbox_payload": item.payload_json,
                    "profile_state": profile.base_info_json,
                    "audit_surface": [audit.surface for audit in audits],
                    "audit_ok": all(audit.ok for audit in audits),
                }
            return task, state, provider_instances[0].read_snapshot
        finally:
            await engine.dispose()

    task, state, snapshot = asyncio.run(flow())
    assert task["status"] == "completed", (task.get("error"), task.get("result"))
    assert task["result"]["runtime"]["provider"] == "embedded"
    assert task["result"]["runtime"]["tool_calls"] == ["get_career_snapshot"]
    assert snapshot["schema"] == "offeru.career_snapshot.v2"
    assert snapshot["goals"]["primary_roles"] == ["数据分析师"]
    assert state["event_status"] == "completed"
    assert state["inbox_category"] == "needs_review"
    assert state["inbox_payload"]["briefing"]["schema"] == "offeru.career_briefing.v1"
    assert state["profile_state"] == {"employment_state": "准备毕业"}
    assert state["audit_surface"] == ["career_director", "career_director"]
    assert state["audit_ok"] is True
