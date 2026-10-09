from __future__ import annotations

import asyncio
import os
from pathlib import Path
import secrets
import sys
import unittest
from unittest.mock import AsyncMock, patch

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.chdir(BACKEND_DIR)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import select

from app.database import async_session, init_db
from app.models.models import (
    AutomationEvent,
    CareerSource,
    CareerTask,
    EvidenceLink,
    Job,
    JobResearchRun,
    LearningObservation,
    MemoryProposal,
    Profile,
    ProfileSection,
    ResearchDossier,
    ResumeOptimizationProposal,
)
from app.services.career_memory import review_memory_proposal
from app.services.career_questions import (
    get_career_questions,
    submit_career_answer,
)


_RUN_SALT = secrets.token_hex(8)


def _uniq(label: str) -> str:
    return f"{label}-{_RUN_SALT}-{secrets.token_hex(4)}"


async def _insert_profile() -> int:
    async with async_session() as db:
        profile = (
            await db.execute(select(Profile).where(Profile.is_default == True))  # noqa: E712
        ).scalar_one_or_none()
        if profile is None:
            profile = Profile(name="默认档案", is_default=True)
            db.add(profile)
            await db.commit()
            await db.refresh(profile)
        return int(profile.id)


async def _insert_job() -> int:
    async with async_session() as db:
        job = Job(
            title=_uniq("后端工程师"),
            company="测试公司",
            raw_description="负责后端服务开发与稳定性建设。",
            hash_key=_uniq("job")[:64],
        )
        db.add(job)
        await db.commit()
        await db.refresh(job)
        return int(job.id)


async def _insert_resume_proposal(*, job_id: int, profile_id: int) -> str:
    async with async_session() as db:
        company = ResearchDossier(
            dossier_key=_uniq("company")[:80],
            dossier_type="company",
            company_name="测试公司",
            job_id=job_id,
        )
        role = ResearchDossier(
            dossier_key=_uniq("role")[:80],
            dossier_type="role",
            company_name="测试公司",
            job_id=job_id,
        )
        db.add_all([company, role])
        await db.flush()
        run = JobResearchRun(
            run_id=_uniq("run")[:64],
            job_id=job_id,
            company_dossier_id=company.id,
            role_dossier_id=role.id,
            status="completed",
            review_status="accepted",
        )
        db.add(run)
        await db.flush()
        proposal = ResumeOptimizationProposal(
            proposal_id=_uniq("prop")[:64],
            job_id=job_id,
            profile_id=profile_id,
            research_run_id=run.run_id,
            status="ready",
            source_section_ids_json=[11, 12],
            source_snapshot_hash="a" * 64,
            research_snapshot_hash="b" * 64,
        )
        db.add(proposal)
        await db.commit()
        await db.refresh(proposal)
        return str(proposal.proposal_id)


def _briefing(questions: list[dict]) -> dict:
    return {
        "schema": "offeru.career_briefing.v1",
        "briefing": {
            "schema": "offeru.career_briefing.v1",
            "questions": questions,
        },
    }


async def _insert_task(
    *,
    task_type: str = "career_director",
    target_type: str = "profile",
    target_id: str = "",
    event_type: str = "PROFILE_BASELINE_REQUIRED",
    job_id: int | None = None,
    profile_id: int | None = None,
    result: dict | None = None,
    status: str = "completed",
) -> str:
    async with async_session() as db:
        task = CareerTask(
            task_id=_uniq("task"),
            task_type=task_type,
            source="automation",
            target_type=target_type,
            target_id=target_id,
            runtime_provider="codex",
            input_json={
                "event_type": event_type,
                **({"job_id": job_id} if job_id is not None else {}),
                **({"profile_id": profile_id} if profile_id is not None else {}),
            },
            status=status,
            result_json=result or {},
            idempotency_key=_uniq("idem"),
        )
        db.add(task)
        await db.commit()
        await db.refresh(task)
        return str(task.task_id)


def _stop_dispatch():
    """Keep recorded automation events durable without running a director turn."""

    async def _stub(event_id: str) -> dict:
        async with async_session() as db:
            row = await db.get(AutomationEvent, event_id)
        return {
            "event_id": event_id,
            "event_type": row.event_type if row is not None else "",
            "status": row.status if row is not None else "queued",
        }

    return patch(
        "app.services.automation._process_automation_event",
        new=AsyncMock(side_effect=_stub),
    )


async def _events_for_dedupe(prefix: str) -> list[AutomationEvent]:
    async with async_session() as db:
        rows = (
            await db.execute(
                select(AutomationEvent).where(AutomationEvent.dedupe_key.like(f"{prefix}%"))
            )
        ).scalars().all()
        return list(rows)


class CareerQuestionAnswerTests(unittest.TestCase):
    def test_job_question_answer_becomes_pending_and_accept_emits_bounded_reprepare(self) -> None:
        async def run() -> dict:
            await init_db()
            profile_id = await _insert_profile()
            job_id = await _insert_job()
            proposal_id = await _insert_resume_proposal(
                job_id=job_id, profile_id=profile_id
            )
            task_id = await _insert_task(
                target_type="job",
                target_id=str(job_id),
                event_type="JOB_SAVED",
                job_id=job_id,
                profile_id=profile_id,
                result={
                    "schema": "offeru.career_director_result.v1",
                    "briefing": {"questions": []},
                    "resume_preparation": {
                        "proposal_id": proposal_id,
                        "questions": [
                            {
                                "question": _uniq("JD 要求 Kafka 经验，你实际用过吗？"),
                                "why_needed": "需要真实证据支撑简历行",
                                "requirement": "Kafka 消息队列经验",
                                "source_section_ids": [11, 12],
                            }
                        ],
                    },
                },
            )
            listing = await get_career_questions(task_id)
            submitted = await submit_career_answer(
                task_id,
                question_index=0,
                answer="我在实习项目里用 Kafka 做过订单事件解耦。",
                proposal_id=proposal_id,
            )
            with _stop_dispatch():
                accepted = await review_memory_proposal(
                    proposal_id=int(submitted["proposal_id"]),
                    action="accept",
                )
                accepted_again = await review_memory_proposal(
                    proposal_id=int(submitted["proposal_id"]),
                    action="accept",
                )
            return {
                "task_id": task_id,
                "job_id": job_id,
                "profile_id": profile_id,
                "resume_proposal_id": proposal_id,
                "listing": listing,
                "submitted": submitted,
                "accepted": accepted,
                "accepted_again": accepted_again,
            }

        outcome = asyncio.run(run())
        listing = outcome["listing"]
        self.assertEqual(listing["task_id"], outcome["task_id"])
        self.assertEqual(listing["task_status"], "completed")
        self.assertEqual(len(listing["questions"]), 1)
        question = listing["questions"][0]
        self.assertEqual(question["question_index"], 0)
        self.assertEqual(question["scope"], "resume_preparation")
        self.assertEqual(question["job_id"], outcome["job_id"])
        self.assertEqual(question["resume_proposal_id"], outcome["resume_proposal_id"])
        self.assertEqual(question["requirement"], "Kafka 消息队列经验")
        self.assertEqual(question["source_section_ids"], [11, 12])
        self.assertIsNone(question["answer"])

        submitted = outcome["submitted"]
        self.assertEqual(submitted["status"], "pending")
        self.assertFalse(submitted["duplicate"])
        self.assertEqual(submitted["resume_proposal_id"], outcome["resume_proposal_id"])
        self.assertEqual(submitted["job_id"], outcome["job_id"])
        self.assertGreater(submitted["observation_id"], 0)
        self.assertGreater(submitted["proposal_id"], 0)

        accepted = outcome["accepted"]
        self.assertEqual(accepted["status"], "accepted")
        self.assertTrue(accepted["applied_profile_section_id"])
        reprepare = accepted.get("reprepare")
        self.assertIsNotNone(reprepare)
        self.assertTrue(reprepare["emitted"])
        self.assertFalse(reprepare["reused"])

        async def inspect() -> tuple[
            AutomationEvent | None, ProfileSection | None, CareerSource | None
        ]:
            async with async_session() as db:
                events = (
                    await db.execute(
                        select(AutomationEvent).where(
                            AutomationEvent.dedupe_key.like("career-answer-reprepare:%"),
                            # The suite shares one database; pin to this test's job.
                            AutomationEvent.target_id == str(outcome["job_id"]),
                        )
                    )
                ).scalars().all()
                section = await db.get(
                    ProfileSection, int(accepted["applied_profile_section_id"])
                )
                observation = await db.get(
                    LearningObservation, int(submitted["observation_id"])
                )
                source = await db.get(CareerSource, observation.source_id)
            return events[0] if events else None, section, source

        event, section, source = asyncio.run(inspect())
        self.assertIsNotNone(event)
        self.assertEqual(event.event_type, "JOB_SAVED")
        self.assertEqual(event.target_type, "job")
        self.assertEqual(event.target_id, str(outcome["job_id"]))
        payload = event.payload_json
        self.assertEqual(payload["job_id"], outcome["job_id"])
        self.assertEqual(payload["profile_id"], outcome["profile_id"])
        self.assertEqual(payload["replaces_proposal_id"], outcome["resume_proposal_id"])
        self.assertEqual(payload["affected_source_section_ids"], [11, 12])
        self.assertEqual(
            payload["accepted_observation_id"], submitted["observation_id"]
        )
        meta = source.metadata_json
        self.assertEqual(meta["task_id"], outcome["task_id"])
        self.assertEqual(meta["question_index"], 0)
        self.assertEqual(meta["job_id"], outcome["job_id"])
        self.assertEqual(meta["resume_proposal_id"], outcome["resume_proposal_id"])
        self.assertEqual(meta["affected_source_section_ids"], [11, 12])
        self.assertIsNotNone(section)
        self.assertEqual(section.tier, "verified_fact")
        self.assertEqual(section.source, "agent_confirmed")

        # Re-accept replays idempotently and must not emit a second event.
        self.assertTrue(outcome["accepted_again"].get("duplicate"))

        async def recount() -> int:
            async with async_session() as db:
                rows = (
                    await db.execute(
                        select(AutomationEvent).where(
                            AutomationEvent.dedupe_key.like("career-answer-reprepare:%")
                        )
                    )
                ).scalars().all()
                return len([row for row in rows if row.target_id == str(outcome["job_id"])])

        self.assertEqual(asyncio.run(recount()), 1)

    def test_repeat_submission_is_idempotent_and_revision_creates_new_proposal(self) -> None:
        async def run() -> dict:
            await init_db()
            profile_id = await _insert_profile()
            task_id = await _insert_task(
                target_type="profile",
                profile_id=profile_id,
                result=_briefing(
                    [
                        {
                            "question": _uniq("你更倾向实习还是全职节奏？"),
                            "why_needed": "影响岗位优先级判断",
                            "unlocks": "更精准的投递策略",
                        }
                    ]
                ),
            )
            first = await submit_career_answer(
                task_id, question_index=0, answer="我优先全职岗位。"
            )
            repeat = await submit_career_answer(
                task_id, question_index=0, answer="我优先全职岗位。"
            )
            revision = await submit_career_answer(
                task_id, question_index=0, answer="改成实习优先，先积累经验。"
            )
            listing = await get_career_questions(task_id)
            return {
                "first": first,
                "repeat": repeat,
                "revision": revision,
                "listing": listing,
            }

        outcome = asyncio.run(run())
        self.assertEqual(
            outcome["first"]["observation_id"], outcome["repeat"]["observation_id"]
        )
        self.assertEqual(
            outcome["first"]["proposal_id"], outcome["repeat"]["proposal_id"]
        )
        self.assertTrue(outcome["repeat"]["duplicate"])
        self.assertNotEqual(
            outcome["revision"]["observation_id"], outcome["first"]["observation_id"]
        )
        self.assertNotEqual(
            outcome["revision"]["proposal_id"], outcome["first"]["proposal_id"]
        )
        answer = outcome["listing"]["questions"][0]["answer"]
        self.assertIsNotNone(answer)
        self.assertEqual(answer["answer"], "改成实习优先，先积累经验。")
        self.assertEqual(answer["status"], "pending")

    def test_discovery_answer_accept_emits_bounded_rediscovery_event(self) -> None:
        async def run() -> dict:
            await init_db()
            profile_id = await _insert_profile()
            task_id = await _insert_task(
                target_type="profile",
                target_id=str(profile_id),
                profile_id=profile_id,
                result=_briefing(
                    [
                        {
                            "question": _uniq("你的目标行业是什么？"),
                            "why_needed": "决定职业方向建议",
                        }
                    ]
                ),
            )
            submitted = await submit_career_answer(
                task_id, question_index=0, answer="目标行业是企业服务 SaaS。"
            )
            with _stop_dispatch():
                accepted = await review_memory_proposal(
                    proposal_id=int(submitted["proposal_id"]), action="accept"
                )
            return {"submitted": submitted, "accepted": accepted, "profile_id": profile_id}

        outcome = asyncio.run(run())
        reprepare = outcome["accepted"].get("reprepare")
        self.assertIsNotNone(reprepare)
        self.assertTrue(reprepare["emitted"])

        async def inspect() -> AutomationEvent | None:
            async with async_session() as db:
                rows = (
                    await db.execute(
                        select(AutomationEvent).where(
                            AutomationEvent.dedupe_key.like("career-answer-rediscovery:%"),
                            # The suite shares one database; pin to this test's profile.
                            AutomationEvent.target_id == str(outcome["profile_id"]),
                        )
                    )
                ).scalars().all()
                return rows[0] if rows else None

        event = asyncio.run(inspect())
        self.assertIsNotNone(event)
        self.assertEqual(event.event_type, "PROFILE_BASELINE_REQUIRED")
        self.assertEqual(event.target_type, "profile")
        self.assertEqual(event.target_id, str(outcome["profile_id"]))
        self.assertEqual(
            event.payload_json["accepted_observation_id"],
            outcome["submitted"]["observation_id"],
        )

    def test_rejected_and_deferred_answers_emit_no_reprepare(self) -> None:
        async def run() -> dict:
            await init_db()
            profile_id = await _insert_profile()
            job_id = await _insert_job()
            proposal_id = await _insert_resume_proposal(
                job_id=job_id, profile_id=profile_id
            )
            task_id = await _insert_task(
                target_type="job",
                target_id=str(job_id),
                event_type="JOB_SAVED",
                job_id=job_id,
                profile_id=profile_id,
                result={
                    "briefing": {"questions": []},
                    "resume_preparation": {
                        "proposal_id": proposal_id,
                        "questions": [
                            {
                                "question": _uniq("是否有分布式缓存经验？"),
                                "why_needed": "JD 明确要求",
                                "requirement": "Redis 缓存经验",
                                "source_section_ids": [21],
                            },
                            {
                                "question": _uniq("是否接受异地实习？"),
                                "why_needed": "影响岗位可行性",
                                "requirement": "工作地点：杭州",
                                "source_section_ids": [22],
                            },
                        ],
                    },
                },
            )
            first = await submit_career_answer(
                task_id, question_index=0, answer="用过 Redis 做排行榜缓存。",
                proposal_id=proposal_id,
            )
            second = await submit_career_answer(
                task_id, question_index=1, answer="可以接受杭州实习。",
                proposal_id=proposal_id,
            )
            with _stop_dispatch():
                rejected = await review_memory_proposal(
                    proposal_id=int(first["proposal_id"]), action="reject"
                )
                deferred = await review_memory_proposal(
                    proposal_id=int(second["proposal_id"]), action="defer"
                )
            return {"rejected": rejected, "deferred": deferred, "task_id": task_id}

        outcome = asyncio.run(run())
        self.assertEqual(outcome["rejected"]["status"], "rejected")
        self.assertNotIn("reprepare", outcome["rejected"])
        self.assertEqual(outcome["deferred"]["status"], "deferred")
        self.assertNotIn("reprepare", outcome["deferred"])

        task_id = outcome["task_id"]

        async def count_events() -> int:
            async with async_session() as db:
                rows = (
                    await db.execute(
                        select(AutomationEvent).where(
                            AutomationEvent.dedupe_key.like(f"career-answer-%:{task_id}:%")
                        )
                    )
                ).scalars().all()
                return len(rows)

        self.assertEqual(asyncio.run(count_events()), 0)

    def test_proposal_target_mismatch_and_scope_errors(self) -> None:
        async def run() -> dict:
            await init_db()
            profile_id = await _insert_profile()
            job_id = await _insert_job()
            other_job_id = await _insert_job()
            proposal_id = await _insert_resume_proposal(
                job_id=job_id, profile_id=profile_id
            )
            foreign_proposal_id = await _insert_resume_proposal(
                job_id=other_job_id, profile_id=profile_id
            )
            task_id = await _insert_task(
                target_type="job",
                target_id=str(job_id),
                event_type="JOB_SAVED",
                job_id=job_id,
                profile_id=profile_id,
                result={
                    "briefing": {"questions": []},
                    "resume_preparation": {
                        "proposal_id": proposal_id,
                        "questions": [
                            {
                                "question": "熟悉哪些后端框架？",
                                "why_needed": "JD 要求 Web 框架经验",
                                "requirement": "后端框架经验",
                                "source_section_ids": [31],
                            }
                        ],
                    },
                },
            )
            running_task_id = await _insert_task(
                target_type="job",
                target_id=str(job_id),
                event_type="JOB_SAVED",
                job_id=job_id,
                result={"briefing": {"questions": []}},
                status="running",
            )
            errors: dict[str, str] = {}

            async def capture(name, coro) -> None:
                try:
                    await coro
                except Exception as exc:  # noqa: BLE001
                    errors[name] = str(exc)

            await capture(
                "foreign_proposal",
                submit_career_answer(
                    task_id,
                    question_index=0,
                    answer="熟悉 FastAPI。",
                    proposal_id=foreign_proposal_id,
                ),
            )
            await capture(
                "unknown_proposal",
                submit_career_answer(
                    task_id,
                    question_index=0,
                    answer="熟悉 FastAPI。",
                    proposal_id="prop-does-not-exist",
                ),
            )
            await capture(
                "out_of_range",
                submit_career_answer(
                    task_id, question_index=2, answer="没有这个题目"
                ),
            )
            await capture(
                "not_completed",
                submit_career_answer(
                    running_task_id, question_index=0, answer="任务未完成"
                ),
            )
            await capture(
                "empty_answer",
                submit_career_answer(task_id, question_index=0, answer="   "),
            )
            await capture(
                "missing_task",
                get_career_questions("task-does-not-exist"),
            )
            return {"errors": errors}

        outcome = asyncio.run(run())
        errors = outcome["errors"]
        for key in (
            "foreign_proposal",
            "unknown_proposal",
            "out_of_range",
            "not_completed",
            "empty_answer",
            "missing_task",
        ):
            self.assertIn(key, errors)

    def test_questions_listing_is_bounded_and_empty_for_plain_tasks(self) -> None:
        async def run() -> dict:
            await init_db()
            profile_id = await _insert_profile()
            overfilled = await _insert_task(
                target_type="profile",
                target_id=str(profile_id),
                profile_id=profile_id,
                result=_briefing(
                    [
                        {"question": f"问题{i}", "why_needed": "why"}
                        for i in range(5)
                    ]
                ),
            )
            plain = await _insert_task(
                target_type="profile",
                target_id=str(profile_id),
                profile_id=profile_id,
                result={"briefing": {}},
            )
            return {
                "overfilled": await get_career_questions(overfilled),
                "plain": await get_career_questions(plain),
            }

        outcome = asyncio.run(run())
        self.assertEqual(len(outcome["overfilled"]["questions"]), 3)
        self.assertEqual(
            [q["question_index"] for q in outcome["overfilled"]["questions"]],
            [0, 1, 2],
        )
        self.assertEqual(outcome["plain"]["questions"], [])


if __name__ == "__main__":
    unittest.main()
