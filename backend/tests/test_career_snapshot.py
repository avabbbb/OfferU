from __future__ import annotations

import asyncio
import json

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.database import Base
from app.models.models import (
    AutomationEvent,
    AutomationInboxItem,
    OperationAuditLog,
    Profile,
    ProfileSection,
    ProfileTargetRole,
)
from app.services import automation, career_director, career_tasks
from app.services.career_director import (
    CareerBriefing,
    CareerStageAssessment,
    parse_career_briefing_response,
)


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
    assert snapshot["schema"] == "offeru.career_snapshot.v1"
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
        with pytest.raises(ValueError, match="真实 Codex Runtime"):
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


def test_profile_discovery_runs_one_codex_task_reads_registry_snapshot_and_projects_result(
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
            import app.ops as ops

            monkeypatch.setattr(ops, "async_session", session)

            class SyntheticCodex:
                def __init__(self, on_operation):
                    self.on_operation = on_operation
                    self.read_snapshot = None

                async def start(self):
                    return None

                async def create_thread(self, **_kwargs):
                    return {"threadId": "synthetic-thread"}

                async def start_turn(self, **_kwargs):
                    self.read_snapshot = await self.on_operation("get_career_snapshot", {})
                    message = json.dumps(_briefing(), ensure_ascii=False)
                    self.runtime_events = [
                        {
                            "method": "item/completed",
                            "params": {"item": {"type": "agentMessage", "text": message}},
                        },
                        {
                            "method": "turn/completed",
                            "params": {
                                "turn": {
                                    "id": "synthetic-turn",
                                    "items": [{"type": "agentMessage", "text": message}],
                                }
                            },
                        },
                    ]
                    return {
                        "threadId": "synthetic-thread",
                        "turnId": "synthetic-turn",
                        "completed": {
                            "turn": {
                                "id": "synthetic-turn",
                                "items": [{"type": "agentMessage", "text": message}],
                            }
                        },
                    }

                async def events(self):
                    return {
                        "events": [
                            {"method": "item/tool/call", "params": {"tool": "get_career_snapshot"}},
                            *getattr(self, "runtime_events", []),
                        ]
                    }

                async def shutdown(self):
                    return None

            provider_instances = []

            def make_provider(_provider_id, **kwargs):
                provider = SyntheticCodex(kwargs["on_operation"])
                provider_instances.append(provider)
                return provider

            import app.services.agent_runtime as agent_runtime

            monkeypatch.setattr(agent_runtime, "get_agent_runtime_provider", make_provider)
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
                audit = (
                    await db.execute(
                        select(OperationAuditLog).where(
                            OperationAuditLog.operation == "get_career_snapshot"
                        )
                    )
                ).scalar_one()
                state = {
                    "event_status": event.status,
                    "inbox_category": item.category,
                    "inbox_payload": item.payload_json,
                    "profile_state": profile.base_info_json,
                    "audit_surface": audit.surface,
                    "audit_ok": audit.ok,
                }
            return task, state, provider_instances[0].read_snapshot
        finally:
            await engine.dispose()

    task, state, snapshot = asyncio.run(flow())
    assert task["status"] == "completed"
    assert task["result"]["runtime"]["provider"] == "codex"
    assert task["result"]["runtime"]["tool_calls"] == ["get_career_snapshot"]
    assert snapshot["schema"] == "offeru.career_snapshot.v1"
    assert snapshot["goals"]["primary_roles"] == ["数据分析师"]
    assert state["event_status"] == "completed"
    assert state["inbox_category"] == "needs_review"
    assert state["inbox_payload"]["briefing"]["schema"] == "offeru.career_briefing.v1"
    assert state["profile_state"] == {"employment_state": "准备毕业"}
    assert state["audit_surface"] == "career_director"
    assert state["audit_ok"] is True
