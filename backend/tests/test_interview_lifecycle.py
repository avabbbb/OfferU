from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from career_director_test_support import install_synthetic_pi_run_provider
from app.database import Base
from app.models.models import (
    AutomationEvent,
    AutomationInboxItem,
    CalendarEvent,
    CareerTask,
    Job,
    LearningObservation,
    MemoryProposal,
    OperationAuditLog,
    Profile,
    ProfileSection,
)
from app.services import (
    agent_runtime,
    automation,
    career_delivery,
    career_director,
    career_interviews,
    career_job_assessment,
    career_memory,
    career_tasks,
    legacy_operations,
)


def _briefing(*, event_id: int, event_type: str) -> dict:
    questions = []
    lifecycle = {
        "mode": "prepare",
        "calendar_event_id": event_id,
        "summary": "明天下午有面试，先聚焦岗位要求与现有证据之间的差距。",
        "focus_areas": ["用项目证据解释业务影响"],
        "practice_questions": ["讲一个你用证据影响决策的例子。"],
        "learning_candidates": [],
    }
    if event_type == "INTERVIEW_COMPLETED":
        questions = [
            {
                "question": "实际问了哪些问题？",
                "why_needed": "帮助识别这场岗位真正关注的能力。",
                "unlocks": "后续面试准备方向",
                "optional": False,
            },
            {
                "question": "哪个回答最弱，为什么？",
                "why_needed": "只记录你的自我观察，不自动当作事实。",
                "unlocks": "后续练习重点",
                "optional": False,
            },
        ]
        lifecycle = {
            "mode": "debrief",
            "calendar_event_id": event_id,
            "summary": "先记下刚结束的面试内容，OfferU 会把观察留作待复核学习。",
            "focus_areas": [],
            "practice_questions": [],
            "learning_candidates": [],
        }
    elif event_type == "INTERVIEW_DEBRIEF_CREATED":
        lifecycle = {
            "mode": "learning_review",
            "calendar_event_id": event_id,
            "summary": "这次复盘显示你能组织跨职能证据，但仍需后续面试验证。",
            "focus_areas": [],
            "practice_questions": [],
            "learning_candidates": [
                {
                    "candidate_type": "potential_strength",
                    "title": "跨职能协作中的证据组织",
                    "summary": "可能擅长在跨职能协作中组织证据并推动复核。",
                    "answer_index": 0,
                    "source_excerpt": "I coordinated the synthetic metric review with two teammates.",
                    "review_reason": "这是基于一次复盘回答的职业假设，需要你确认是否值得保留。",
                }
            ],
        }
    return {
        "schema": "offeru.career_briefing.v1",
        "career_stage": {
            "track": "campus",
            "substage": "fresh_graduate",
            "confidence": "medium",
            "basis": ["synthetic profile fixture"],
        },
        "strategy_pack": "campus_search.v1",
        "situation_summary": lifecycle["summary"],
        "profile_coverage": {},
        "interview_lifecycle": lifecycle,
        "priorities": [],
        "actions": [
            {
                "objective": "准备这场面试",
                "why_now": "明天下午将和目标团队面试。",
                "action_key": (
                    "interview.debrief"
                    if event_type == "INTERVIEW_COMPLETED"
                    else "interview.prepare"
                ),
                "skill": (
                    "interview_debrief"
                    if event_type == "INTERVIEW_COMPLETED"
                    else "interview_prep"
                ),
                "suggested_operations": [],
                "target_ref": {"kind": "interview", "id": str(event_id)},
                "autonomy_level": "L1",
                "expected_outcome": "整理有依据的练习重点。",
                "requires_user": True,
                "dedupe_key": f"interview-{event_id}-{event_type.lower()}",
            }
        ] if event_type != "INTERVIEW_DEBRIEF_CREATED" else [],
        "questions": questions,
        "risks": [],
        "opportunities": [],
    }


def test_interview_invitation_uses_live_registry_reads_and_projects_one_task(
    tmp_path, monkeypatch
) -> None:
    async def flow() -> tuple[dict, dict, list[OperationAuditLog], int]:
        engine = create_async_engine(
            f"sqlite+aiosqlite:///{(tmp_path / 'interview-invitation.db').as_posix()}"
        )
        session = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            async with session() as db:
                profile = Profile(
                    name="Synthetic graduate",
                    is_default=True,
                    base_info_json={"employment_state": "在校生，准备毕业"},
                )
                job = Job(
                    title="Synthetic data analyst",
                    company="Fixture Labs",
                    hash_key="a" * 64,
                    raw_description="Use evidence to improve product decisions.",
                )
                db.add_all([profile, job])
                await db.flush()
                await db.commit()
                profile_id, job_id = profile.id, job.id

            for module in (
                automation,
                career_tasks,
                career_director,
                career_interviews,
                career_job_assessment,
                career_memory,
                legacy_operations,
                career_delivery,
            ):
                monkeypatch.setattr(module, "async_session", session)
            import app.ops as ops

            monkeypatch.setattr(ops, "async_session", session)
            calls: list[str] = []

            class SyntheticCodex:
                def __init__(self, on_operation):
                    self.on_operation = on_operation

                async def start(self):
                    return None

                async def create_thread(self, **_kwargs):
                    return {"threadId": "synthetic-interview-thread"}

                async def start_turn(self, prompt: str, **_kwargs):
                    assert "INTERVIEW_INVITATION_DETECTED" in prompt
                    calendar_event_id = int(prompt.split("calendar_event_id=", 1)[1].split(",", 1)[0])
                    await self.on_operation("get_career_snapshot", {})
                    context = await self.on_operation(
                        "get_interview_career_context",
                        {"calendar_event_id": calendar_event_id},
                    )
                    assert context["interview"]["job_id"] == job_id
                    assert context["job_assessment"]["job"]["company"] == "Fixture Labs"
                    calls.extend(["get_career_snapshot", "get_interview_career_context"])
                    message = json.dumps(
                        _briefing(event_id=calendar_event_id, event_type="INTERVIEW_INVITATION_DETECTED"),
                        ensure_ascii=False,
                    )
                    return {
                        "threadId": "synthetic-interview-thread",
                        "turnId": "synthetic-interview-turn",
                        "completed": {"turn": {"items": [{"type": "agentMessage", "text": message}]}},
                    }

                async def events(self):
                    return {
                        "events": [
                            {"method": "item/tool/call", "params": {"tool": name}}
                            for name in calls
                        ]
                    }

                async def shutdown(self):
                    return None

            install_synthetic_pi_run_provider(
                monkeypatch,
                lambda _provider, **kwargs: SyntheticCodex(kwargs["on_operation"]),
            )
            monkeypatch.setattr(career_tasks, "_career_director_workspace", lambda: str(tmp_path))

            starts_at = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(days=1)
            created = await ops.execute_operation(
                "create_calendar_event",
                {
                    "title": "Fixture Labs interview",
                    "description": "Synthetic calendar details",
                    "event_type": "interview",
                    "start_time": starts_at,
                    "end_time": starts_at + timedelta(hours=1),
                    "related_job_id": job_id,
                },
                surface="synthetic_calendar",
            )
            assert created["ok"] is True, f"errors={created.get('errors')} outputs={created.get('outputs')}"
            interview_id = int(created["outputs"]["id"])
            event_result = created["outputs"]["automation"]
            assert event_result.get("status") == "dispatched", (
                f"status={event_result.get('status')} error={event_result.get('error')} "
                f"result={event_result.get('result')}"
            )
            task_id = event_result["result"]["task"]["task_id"]
            inbox = None
            for _ in range(300):
                task = await career_tasks.get_career_task(task_id)
                async with session() as db:
                    inbox = await db.get(AutomationInboxItem, f"automation_task_{task_id}")
                if (
                    task["status"] in {"completed", "failed", "blocked", "cancelled"}
                    and inbox is not None
                    and isinstance(inbox.payload_json, dict)
                    and isinstance(inbox.payload_json.get("interview_lifecycle"), dict)
                ):
                    break
                await asyncio.sleep(0.01)
            async with session() as db:
                audit_rows = (
                    await db.execute(
                        select(OperationAuditLog)
                        .where(OperationAuditLog.operation.in_(calls))
                        .order_by(OperationAuditLog.id)
                    )
                ).scalars().all()
                profile_row = await db.get(Profile, profile_id)
                profile_sections = (
                    await db.execute(select(ProfileSection).where(ProfileSection.profile_id == profile_id))
                ).scalars().all()
                state = {
                    "status": task["status"],
                    "inbox_category": inbox.category,
                    "lifecycle": inbox.payload_json["interview_lifecycle"],
                    "profile": profile_row.base_info_json,
                    "profile_sections": len(profile_sections),
                }
            duplicate = await automation.record_automation_event(
                event_type="INTERVIEW_INVITATION_DETECTED",
                source="synthetic_calendar",
                target_type="interview",
                target_id=str(interview_id),
                payload={"calendar_event_id": interview_id, "job_id": job_id, "profile_id": profile_id},
                dedupe_key=f"calendar-interview-invitation:{interview_id}",
            )
            return {"duplicate": duplicate, "task": task}, state, audit_rows, len(calls)
        finally:
            await engine.dispose()

    observed, state, audit_rows, call_count = asyncio.run(flow())
    assert observed["task"]["status"] == "completed", observed["task"]
    assert observed["duplicate"]["reused"] is True
    assert state["inbox_category"] == "needs_review"
    assert state["lifecycle"]["mode"] == "prepare"
    assert state["lifecycle"]["practice_questions"]
    assert state["profile"] == {"employment_state": "在校生，准备毕业"}
    assert state["profile_sections"] == 0
    assert call_count == 2
    assert [row.operation for row in audit_rows] == [
        "get_career_snapshot",
        "get_interview_career_context",
        "get_career_snapshot",
        "get_interview_career_context",
    ]
    assert all(row.surface == "career_director" and row.ok for row in audit_rows)


def test_completed_interview_debrief_becomes_reviewable_learning_candidate(
    tmp_path, monkeypatch
) -> None:
    async def flow() -> tuple[dict, dict, dict, list[MemoryProposal], list[LearningObservation]]:
        engine = create_async_engine(
            f"sqlite+aiosqlite:///{(tmp_path / 'interview-debrief.db').as_posix()}"
        )
        session = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            async with session() as db:
                profile = Profile(
                    name="Synthetic experienced candidate",
                    is_default=True,
                    base_info_json={"employment_state": "在寻找新的全职机会"},
                )
                job = Job(
                    title="Synthetic product analyst",
                    company="Fixture Works",
                    hash_key="b" * 64,
                    raw_description="Synthetic role requirements.",
                )
                db.add_all([profile, job])
                await db.flush()
                now = datetime.now(timezone.utc).replace(tzinfo=None)
                interview = CalendarEvent(
                    title="Fixture Works interview",
                    description="Synthetic event",
                    event_type="interview",
                    start_time=now - timedelta(hours=2),
                    end_time=now - timedelta(hours=1),
                    related_job_id=job.id,
                )
                db.add(interview)
                await db.commit()
                profile_id, job_id, interview_id = profile.id, job.id, interview.id

            for module in (
                automation,
                career_tasks,
                career_director,
                career_interviews,
                career_job_assessment,
                career_memory,
                career_delivery,
            ):
                monkeypatch.setattr(module, "async_session", session)
            import app.ops as ops

            monkeypatch.setattr(ops, "async_session", session)
            observed_tool_calls: list[tuple[str, str]] = []

            class SyntheticCodex:
                def __init__(self, on_operation):
                    self.on_operation = on_operation
                    self.calls: list[str] = []

                async def start(self):
                    return None

                async def create_thread(self, **_kwargs):
                    return {"threadId": "synthetic-debrief-thread"}

                async def start_turn(self, prompt: str, **_kwargs):
                    event_type = next(
                        name for name in ("INTERVIEW_COMPLETED", "INTERVIEW_DEBRIEF_CREATED")
                        if name in prompt
                    )
                    await self.on_operation("get_career_snapshot", {})
                    self.calls.append("get_career_snapshot")
                    await self.on_operation(
                        "get_interview_career_context",
                        {"calendar_event_id": interview_id},
                    )
                    self.calls.append("get_interview_career_context")
                    observed_tool_calls.extend((event_type, name) for name in self.calls)
                    message = json.dumps(_briefing(event_id=interview_id, event_type=event_type), ensure_ascii=False)
                    return {
                        "threadId": "synthetic-debrief-thread",
                        "turnId": f"synthetic-{event_type.lower()}-turn",
                        "completed": {"turn": {"items": [{"type": "agentMessage", "text": message}]}},
                    }

                async def events(self):
                    return {
                        "events": [
                            {"method": "item/tool/call", "params": {"tool": name}}
                            for _, name in observed_tool_calls[-2:]
                        ]
                    }

                async def shutdown(self):
                    return None

            install_synthetic_pi_run_provider(
                monkeypatch,
                lambda _provider, **kwargs: SyntheticCodex(kwargs["on_operation"]),
            )
            monkeypatch.setattr(career_tasks, "_career_director_workspace", lambda: str(tmp_path))

            completed = await automation.record_automation_event(
                event_type="INTERVIEW_COMPLETED",
                source="synthetic_calendar_elapsed",
                target_type="interview",
                target_id=str(interview_id),
                payload={"calendar_event_id": interview_id, "job_id": job_id, "profile_id": profile_id},
                dedupe_key=f"calendar-interview-completed:{interview_id}",
            )
            assert completed.get("status") == "dispatched", (
                f"status={completed.get('status')} error={completed.get('error')} "
                f"result={completed.get('result')}"
            )
            completed_task_id = completed["result"]["task"]["task_id"]
            worker = career_tasks._LIVE_TASKS.get(completed_task_id)
            if worker is not None:
                await asyncio.wait_for(worker, timeout=30)
            completed_event = None
            for _ in range(300):
                completed_task = await career_tasks.get_career_task(completed_task_id)
                async with session() as db:
                    completed_event = await db.get(AutomationEvent, completed["event_id"])
                if (
                    completed_task["status"] in {"completed", "failed", "blocked", "cancelled"}
                    and completed_event is not None
                    and completed_event.status == "completed"
                ):
                    break
                await asyncio.sleep(0.01)
            assert completed_task["status"] == "completed", (
                completed_task.get("error"),
                completed_task.get("result"),
            )
            prompt_questions = completed_task["result"]["briefing"]["questions"]
            answers = [
                "I coordinated the synthetic metric review with two teammates.",
                "I could have explained how the decision changed the launch plan.",
            ]
            submitted = await ops.execute_operation(
                "submit_interview_debrief",
                {"calendar_event_id": interview_id, "answers": answers},
                surface="synthetic_interview_ui",
            )
            assert submitted["ok"] is True, (
                f"errors={submitted.get('errors')} outputs={submitted.get('outputs')}"
            )
            debrief_task_id = submitted["outputs"]["result"]["task"]["task_id"]
            result_item = None
            for _ in range(300):
                debrief_task = await career_tasks.get_career_task(debrief_task_id)
                async with session() as db:
                    result_item = await db.get(
                        AutomationInboxItem,
                        f"automation_task_{debrief_task_id}",
                    )
                if (
                    debrief_task["status"] in {"completed", "failed", "blocked", "cancelled"}
                    and result_item is not None
                    and isinstance(result_item.payload_json, dict)
                    and isinstance(result_item.payload_json.get("learning_proposals"), list)
                ):
                    break
                await asyncio.sleep(0.01)
            async with session() as db:
                proposals = (
                    await db.execute(select(MemoryProposal).order_by(MemoryProposal.id))
                ).scalars().all()
                observations = (
                    await db.execute(select(LearningObservation).order_by(LearningObservation.id))
                ).scalars().all()
                profile_row = await db.get(Profile, profile_id)
                original_item = await db.get(
                    AutomationInboxItem,
                    f"automation_task_{completed_task_id}",
                )
                state = {
                    "profile": profile_row.base_info_json,
                    "original_debrief_status": original_item.status,
                    "result_payload": result_item.payload_json,
                }
            state["future_learning_context"] = await career_interviews.get_interview_career_context(
                calendar_event_id=interview_id
            )
            return debrief_task, state, {"questions": prompt_questions, "tool_calls": observed_tool_calls}, proposals, observations
        finally:
            await engine.dispose()

    task, state, evidence, proposals, observations = asyncio.run(flow())
    assert task["status"] == "completed", task
    assert len(evidence["questions"]) == 2
    assert state["original_debrief_status"] == "resolved"
    assert state["profile"] == {"employment_state": "在寻找新的全职机会"}
    assert len(observations) == 1
    assert observations[0].observation_type == "interview_debrief_candidate"
    assert len(proposals) == 1
    assert proposals[0].target_tier == "career_hypothesis"
    assert proposals[0].status == "pending"
    assert state["future_learning_context"]["previous_learning"][0]["learning_type"] == "potential_strength"
    assert state["future_learning_context"]["previous_learning"][0]["review_status"] == "pending"
    assert state["future_learning_context"]["repeated_weak_areas"] == []
    assert state["result_payload"]["learning_proposals"][0]["proposal_id"] == proposals[0].id
    assert evidence["tool_calls"] == [
        ("INTERVIEW_COMPLETED", "get_career_snapshot"),
        ("INTERVIEW_COMPLETED", "get_interview_career_context"),
        ("INTERVIEW_DEBRIEF_CREATED", "get_career_snapshot"),
        ("INTERVIEW_DEBRIEF_CREATED", "get_interview_career_context"),
    ]


def test_daily_review_only_dispatches_recent_elapsed_interviews(tmp_path, monkeypatch) -> None:
    async def flow() -> list[dict]:
        engine = create_async_engine(
            f"sqlite+aiosqlite:///{(tmp_path / 'elapsed-interviews.db').as_posix()}"
        )
        session = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            now = datetime.now(timezone.utc).replace(tzinfo=None)
            async with session() as db:
                db.add_all(
                    [
                        CalendarEvent(title="recent", event_type="interview", start_time=now - timedelta(hours=2), end_time=now - timedelta(hours=1)),
                        CalendarEvent(title="future", event_type="interview", start_time=now + timedelta(hours=1)),
                        CalendarEvent(title="old", event_type="interview", start_time=now - timedelta(days=10)),
                    ]
                )
                await db.commit()
            monkeypatch.setattr(automation, "async_session", session)
            calls: list[dict] = []

            async def fake_record(**kwargs):
                calls.append(kwargs)
                return {"reused": False, "status": "dispatched"}

            monkeypatch.setattr(automation, "record_automation_event", fake_record)
            await automation._dispatch_elapsed_interviews()
            return calls
        finally:
            await engine.dispose()

    calls = asyncio.run(flow())
    assert len(calls) == 1
    assert calls[0]["event_type"] == "INTERVIEW_COMPLETED"
    assert calls[0]["dedupe_key"].startswith("calendar-interview-completed:")
