from __future__ import annotations

import asyncio
import hashlib
import json
import os
from pathlib import Path
import secrets
import sys
import unittest
from unittest.mock import patch

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.chdir(BACKEND_DIR)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import select

from app.database import async_session, init_db
from app.models.models import (
    CareerSource,
    Interview,
    Job,
    LearningObservation,
    MemoryProposal,
    Profile,
    ProfileSection,
)
from app.ops import OPERATIONS
from app.services.agent_operations import add_profile_evidence
from app.services.agent_skill_registry import resolve_skill
from app.services.career_memory import (
    create_memory_proposal,
    derive_career_model,
    invalidate_memory_source,
    list_career_ledger,
    list_memory_inbox,
    record_conversation_observation,
    record_learning_observation,
    review_memory_proposal,
    _observation_source_excerpt,
)
from app.services.job_projection import build_job_projection


_RUN_SALT = secrets.token_hex(8)


def _uniq(label: str) -> str:
    return f"{label}-{_RUN_SALT}-{secrets.token_hex(4)}"


async def _preference_observation() -> dict:
    statement = "我希望优先考虑北京的后端工程师岗位。"
    return await record_learning_observation(
        source_type="manual",
        source_external_id=_uniq("manual"),
        source_title="使用者确认的职业偏好",
        source_locator="manual:test",
        observation_type="preference_signal",
        content={
            "source_excerpt": statement,
            "statement": statement,
        },
    )


async def _preference_proposal(observation_id: int) -> dict:
    statement = "我希望优先考虑北京的后端工程师岗位。"
    return await create_memory_proposal(
        observation_id=observation_id,
        target_tier="preference",
        section_type="custom:c_preference",
        title=_uniq("目标地点偏好"),
        before={},
        after={
            "category_label": "求职偏好",
            "description": statement,
            "bullet": statement,
        },
        reason="使用者在对话中明确表达了当前岗位地点和方向偏好。",
        impact=["后续岗位推荐可优先展示北京后端岗位"],
    )


class CareerMemoryTests(unittest.TestCase):
    def test_operation_registry_exposes_reviewable_memory_contract(self) -> None:
        self.assertIn("list_learning_observations", OPERATIONS)
        self.assertIn("list_memory_inbox", OPERATIONS)
        self.assertIn("create_memory_proposal", OPERATIONS)
        self.assertIn("review_memory_proposal", OPERATIONS)
        self.assertIn("invalidate_memory_source", OPERATIONS)
        self.assertIn("derive_career_model", OPERATIONS)
        self.assertIn("list_career_ledger", OPERATIONS)
        self.assertIn("build_job_projection", OPERATIONS)
        self.assertFalse(
            OPERATIONS["list_memory_inbox"].schema()["requires_confirmation"]
        )
        self.assertTrue(
            OPERATIONS["review_memory_proposal"].schema()["requires_confirmation"]
        )
        self.assertTrue(
            OPERATIONS["invalidate_memory_source"].schema()["requires_confirmation"]
        )

    def test_memory_skill_exposes_only_registry_backed_memory_actions(self) -> None:
        skill = resolve_skill("memory")

        self.assertIsNotNone(skill)
        assert skill is not None
        self.assertEqual(skill.id, "memory_inbox")
        self.assertTrue(
            {
                "list_learning_observations",
                "list_memory_inbox",
                "create_memory_proposal",
                "review_memory_proposal",
                "invalidate_memory_source",
            }.issubset(skill.allowed_tools)
        )
        self.assertTrue(skill.allowed_tools.issubset(OPERATIONS))

    def test_conversation_observation_is_idempotent_and_does_not_copy_raw_turn(self) -> None:
        async def run() -> tuple[dict, dict]:
            await init_db()
            conversation_id = _uniq("conversation")
            message = "我正在探索北京的 Python 后端岗位。"
            first = await record_conversation_observation(
                conversation_id=conversation_id,
                turn_index=3,
                user_message=message,
                user_stage="experienced",
            )
            second = await record_conversation_observation(
                conversation_id=conversation_id,
                turn_index=3,
                user_message=message,
                user_stage="experienced",
            )
            return first, second

        first, second = asyncio.run(run())

        self.assertTrue(first["recorded"])
        self.assertFalse(first["duplicate"])
        self.assertTrue(second["duplicate"])
        self.assertEqual(first["id"], second["id"])
        serialized = json.dumps(first["content"], ensure_ascii=False)
        self.assertNotIn("我正在探索北京的 Python 后端岗位", serialized)
        self.assertEqual(first["content"]["message_length"], 21)
        self.assertEqual(len(first["content"]["message_sha256"]), 64)

    def test_source_metadata_rejects_connection_secrets(self) -> None:
        async def run() -> None:
            await init_db()
            await record_learning_observation(
                source_type="manual",
                source_external_id=_uniq("source"),
                observation_type="manual_signal",
                content={"statement": "安全测试"},
                source_metadata={"access_token": "must-not-be-stored"},
            )

        with self.assertRaises(ValueError):
            asyncio.run(run())

    def test_conversation_evidence_is_reloaded_and_hash_checked(self) -> None:
        message = "我优先考虑北京的后端岗位。"
        source = CareerSource(
            source_type="conversation",
            external_id="conversation-test",
        )
        observation = LearningObservation(
            content_json={
                "turn_index": 1,
                "message_sha256": hashlib.sha256(message.encode("utf-8")).hexdigest(),
            }
        )
        conversation = {
            "messages": [
                {"role": "user", "content": message},
                {"role": "assistant", "content": "收到。"},
            ]
        }

        with patch(
            "app.services.harness_history.get_conversation",
            return_value=conversation,
        ):
            self.assertEqual(
                _observation_source_excerpt(observation, source),
                message,
            )
            observation.content_json["message_sha256"] = "0" * 64
            with self.assertRaises(ValueError):
                _observation_source_excerpt(observation, source)

    def test_accept_and_revoke_memory_proposal_controls_profile_write(self) -> None:
        async def run() -> tuple[dict, dict, bool, bool]:
            await init_db()
            observation = await _preference_observation()
            proposal = await _preference_proposal(observation["id"])
            pending = await list_memory_inbox(status="pending", limit=500)
            accepted = await review_memory_proposal(
                proposal_id=proposal["id"],
                action="accept",
                note="确认这是当前求职偏好。",
            )
            section_id = accepted["applied_profile_section_id"]
            async with async_session() as db:
                section_before_revoke = (
                    await db.execute(
                        select(ProfileSection).where(ProfileSection.id == section_id)
                    )
                ).scalar_one_or_none()
            revoked = await review_memory_proposal(
                proposal_id=proposal["id"],
                action="revoke",
                note="该偏好已经变化。",
            )
            async with async_session() as db:
                section_after_revoke = (
                    await db.execute(
                        select(ProfileSection).where(ProfileSection.id == section_id)
                    )
                ).scalar_one_or_none()
            in_pending = any(item["id"] == proposal["id"] for item in pending["items"])
            return (
                accepted,
                revoked,
                in_pending and section_before_revoke is not None,
                section_after_revoke,
            )

        accepted, revoked, visible_before_accept, section_after_revoke = asyncio.run(run())

        self.assertTrue(visible_before_accept)
        self.assertEqual(accepted["status"], "accepted")
        self.assertEqual(accepted["profile_write"]["tier"], "preference")
        self.assertEqual(revoked["status"], "revoked")
        # ADR-0048：撤销不再物理删除条目，保留审计外壳并标记失效
        self.assertIsNotNone(section_after_revoke)
        self.assertEqual(section_after_revoke.status, "revoked")
        self.assertIsNotNone(section_after_revoke.invalidated_at)

    def test_interview_learning_projection_tracks_memory_review(self) -> None:
        async def run() -> tuple[dict, dict]:
            await init_db()
            async with async_session() as db:
                interview = Interview(
                    title=_uniq("面试"),
                    target_position="AIGC 产品经理",
                    status="completed",
                    report_json={"learning_candidate": {"status": "pending"}},
                )
                db.add(interview)
                await db.commit()
                await db.refresh(interview)
                interview_id = interview.id

            observation = await record_learning_observation(
                source_type="ai_interview",
                source_external_id=str(interview_id),
                source_title="OfferU AI 面试学习观察",
                source_locator=f"ai_interview:{interview_id}",
                observation_type="interview_completed",
                content={
                    "interview_id": interview_id,
                    "summary": "面试观察：补充评测指标。",
                },
                idempotency_key=_uniq("interview-observation"),
            )
            proposal = await create_memory_proposal(
                observation_id=observation["id"],
                target_tier="career_hypothesis",
                section_type="skill",
                title=_uniq("面试学习观察"),
                after={"bullet": "面试观察：补充评测指标。"},
                reason="用于验证 Interview 与 Profile 投影一致。",
                impact=["作为训练参考"],
            )
            accepted = await review_memory_proposal(
                proposal_id=proposal["id"],
                action="accept",
            )
            async with async_session() as db:
                interview = await db.get(Interview, interview_id)
                assert interview is not None
                report = interview.report_json or {}
            return accepted, report["learning_candidate"]

        accepted, learning_candidate = asyncio.run(run())

        self.assertEqual(accepted["status"], "accepted")
        self.assertEqual(learning_candidate["status"], "accepted")
        self.assertEqual(
            learning_candidate["profile_section_id"],
            accepted["applied_profile_section_id"],
        )

    def test_career_hypothesis_stays_separate_from_verified_facts(self) -> None:
        async def run() -> tuple[dict, dict, dict]:
            await init_db()
            observation = await record_learning_observation(
                source_type="interview_debrief",
                source_external_id=_uniq("hypothesis-source"),
                source_title="模拟面试复盘",
                source_locator="interview-debrief:test",
                observation_type="potential_strength",
                content={
                    "source_excerpt": "在评测设计问题中表现出潜在的系统化思考能力。",
                },
            )
            proposal = await create_memory_proposal(
                observation_id=observation["id"],
                target_tier="career_hypothesis",
                section_type="skill",
                title=_uniq("潜在能力假设"),
                after={
                    "bullet": "可能擅长系统化评测设计",
                },
                reason="该结论来自一次面试观察，仍需更多证据验证。",
                impact=["仅用于后续训练优先级，不作为已验证事实"],
            )
            before = await derive_career_model()
            accepted = await review_memory_proposal(
                proposal_id=proposal["id"],
                action="accept",
            )
            after = await derive_career_model()
            return before, accepted, after

        before, accepted, after = asyncio.run(run())

        title = accepted["title"]
        self.assertNotIn(title, {item["title"] for item in before["entries"]})
        self.assertEqual(accepted["profile_write"]["tier"], "career_hypothesis")
        hypothesis_entries = after["by_tier"].get("career_hypothesis", [])
        fact_entries = after["by_tier"].get("verified_fact", [])
        self.assertIn(title, {item["title"] for item in hypothesis_entries})
        self.assertNotIn(title, {item["title"] for item in fact_entries})
        self.assertEqual(
            next(item for item in hypothesis_entries if item["title"] == title)["tier"],
            "career_hypothesis",
        )

    def test_reject_keeps_profile_unchanged(self) -> None:
        async def run() -> tuple[dict, int]:
            await init_db()
            observation = await _preference_observation()
            proposal = await _preference_proposal(observation["id"])
            before_count = (
                await _profile_section_count(proposal["title"])
            )
            rejected = await review_memory_proposal(
                proposal_id=proposal["id"],
                action="reject",
                note="这不是稳定偏好。",
            )
            after_count = await _profile_section_count(proposal["title"])
            return rejected, after_count - before_count

        rejected, profile_delta = asyncio.run(run())

        self.assertEqual(rejected["status"], "rejected")
        self.assertEqual(profile_delta, 0)

    def test_deferred_proposal_stays_in_inbox_and_can_be_rejected_later(self) -> None:
        async def run() -> tuple[dict, bool, dict]:
            await init_db()
            observation = await _preference_observation()
            proposal = await _preference_proposal(observation["id"])
            deferred = await review_memory_proposal(
                proposal_id=proposal["id"],
                action="defer",
                note="稍后再判断是否稳定。",
            )
            inbox = await list_memory_inbox(status="deferred", limit=500)
            rejected = await review_memory_proposal(
                proposal_id=proposal["id"],
                action="reject",
            )
            return (
                deferred,
                any(item["id"] == proposal["id"] for item in inbox["items"]),
                rejected,
            )

        deferred, visible, rejected = asyncio.run(run())

        self.assertEqual(deferred["status"], "deferred")
        self.assertTrue(visible)
        self.assertEqual(rejected["status"], "rejected")

    def test_invalidating_source_scrubs_and_cascades_derived_memory(self) -> None:
        async def run() -> tuple[dict, dict, dict, bool]:
            await init_db()
            observation = await _preference_observation()
            proposal = await _preference_proposal(observation["id"])
            accepted = await review_memory_proposal(
                proposal_id=proposal["id"],
                action="accept",
            )
            result = await invalidate_memory_source(
                source_id=observation["source"]["id"],
                reason="使用者撤销该对话来源。",
            )
            async with async_session() as db:
                stored_source = (
                    await db.execute(
                        select(CareerSource).where(
                            CareerSource.id == observation["source"]["id"]
                        )
                    )
                ).scalar_one()
                stored_observation = (
                    await db.execute(
                        select(LearningObservation).where(
                            LearningObservation.id == observation["id"]
                        )
                    )
                ).scalar_one()
                stored_proposal = (
                    await db.execute(
                        select(MemoryProposal).where(MemoryProposal.id == proposal["id"])
                    )
                ).scalar_one()
                stored_section = (
                    await db.execute(
                        select(ProfileSection).where(
                            ProfileSection.id == accepted["applied_profile_section_id"]
                        )
                    )
                ).scalar_one_or_none()
            return (
                result,
                {
                    "status": stored_source.status,
                    "title": stored_source.title,
                    "locator": stored_source.locator,
                    "external_id": stored_source.external_id,
                },
                {
                    "observation_status": stored_observation.status,
                    "observation_content": stored_observation.content_json,
                    "proposal_status": stored_proposal.status,
                    "proposal_after": stored_proposal.after_json,
                },
                stored_section,
            )

        result, source, derived, stored_section = asyncio.run(run())

        self.assertTrue(result["invalidated"])
        self.assertEqual(source["status"], "invalidated")
        self.assertEqual(source["title"], "")
        self.assertEqual(source["locator"], "")
        self.assertTrue(source["external_id"].startswith("invalidated:"))
        self.assertEqual(derived["observation_status"], "invalidated")
        self.assertEqual(derived["observation_content"], {})
        self.assertEqual(derived["proposal_status"], "invalidated")
        self.assertEqual(derived["proposal_after"], {})
        # ADR-0048：级联失效保留条目审计外壳，条目标记 invalidated 而非删除
        self.assertIsNotNone(stored_section)
        self.assertEqual(stored_section.status, "invalidated")


async def _profile_section_count(title: str) -> int:
    async with async_session() as db:
        rows = (
            await db.execute(select(ProfileSection.id).where(ProfileSection.title == title))
        ).scalars().all()
        return len(rows)


async def _insert_section(
    title: str,
    *,
    tier: str = "verified_fact",
    section_type: str = "experience",
    content: dict | None = None,
) -> int:
    async with async_session() as db:
        profile = (
            await db.execute(select(Profile).where(Profile.is_default == True))
        ).scalar_one_or_none()
        if profile is None:
            profile = Profile(name="默认档案", is_default=True)
            db.add(profile)
            await db.flush()
        section = ProfileSection(
            profile_id=profile.id,
            section_type=section_type,
            title=title,
            sort_order=0,
            content_json=content or {"bullet": title},
            source="test",
            confidence=1.0,
            tier=tier,
        )
        db.add(section)
        await db.commit()
        await db.refresh(section)
        return section.id


async def _insert_job(title: str, description: str) -> int:
    async with async_session() as db:
        job = Job(
            title=title,
            company="测试公司",
            raw_description=description,
            hash_key=_uniq("job"),
        )
        db.add(job)
        await db.commit()
        await db.refresh(job)
        return job.id


class CareerLedgerTests(unittest.TestCase):
    def test_derive_career_model_excludes_revoked_entries(self) -> None:
        async def run() -> tuple[dict, dict, str]:
            await init_db()
            observation = await _preference_observation()
            proposal = await _preference_proposal(observation["id"])
            await review_memory_proposal(
                proposal_id=proposal["id"],
                action="accept",
            )
            model_before = await derive_career_model()
            await review_memory_proposal(
                proposal_id=proposal["id"],
                action="revoke",
            )
            model_after = await derive_career_model()
            return model_before, model_after, proposal["title"]

        before, after, title = asyncio.run(run())

        before_by_title = {item["title"]: item for item in before["entries"]}
        self.assertIn(title, before_by_title)
        self.assertEqual(before_by_title[title]["status"], "active")
        after_by_title = {item["title"]: item for item in after["entries"]}
        self.assertNotIn(title, after_by_title)
        invalid_by_title = {
            item["title"]: item for item in after["invalidated_entries"]
        }
        self.assertIn(title, invalid_by_title)
        self.assertEqual(invalid_by_title[title]["status"], "revoked")

    def test_supersede_proposal_marks_old_entry_superseded(self) -> None:
        async def run() -> tuple[dict, dict, dict]:
            await init_db()
            first = await _preference_observation()
            proposal_a = await _preference_proposal(first["id"])
            accepted_a = await review_memory_proposal(
                proposal_id=proposal_a["id"],
                action="accept",
            )
            second = await _preference_observation()
            proposal_b = await create_memory_proposal(
                observation_id=second["id"],
                target_tier="preference",
                section_type="custom:c_preference",
                title=_uniq("取代后的地点偏好"),
                before={},
                after={
                    "category_label": "求职偏好",
                    "description": "我希望优先考虑上海的后端工程师岗位。",
                    "bullet": "我希望优先考虑上海的后端工程师岗位。",
                },
                reason="使用者更新了当前求职地点偏好。",
                impact=["后续岗位推荐以新地点为准"],
                supersedes_proposal_id=proposal_a["id"],
            )
            accepted_b = await review_memory_proposal(
                proposal_id=proposal_b["id"],
                action="accept",
            )
            model = await derive_career_model()
            ledger = await list_career_ledger(status="all", limit=500)
            return accepted_b, model, ledger, accepted_a["applied_profile_section_id"]

        accepted_b, model, ledger, old_section_id = asyncio.run(run())

        self.assertEqual(accepted_b["status"], "accepted")
        by_id = {int(item["id"]): item for item in model["entries"]}
        self.assertIn(accepted_b["applied_profile_section_id"], by_id)
        self.assertEqual(
            by_id[accepted_b["applied_profile_section_id"]]["status"],
            "active",
        )
        old_by_id = {int(item["id"]): item for item in model["invalidated_entries"]}
        self.assertIn(old_section_id, old_by_id)
        old = old_by_id[old_section_id]
        self.assertEqual(old["status"], "superseded")
        self.assertEqual(old["superseded_by_id"], accepted_b["applied_profile_section_id"])
        by_id = {item["id"]: item for item in ledger["entries"]}
        new_entry = by_id[accepted_b["id"]]
        old_entry = next(item for item in ledger["entries"] if item["id"] != accepted_b["id"])
        self.assertEqual(new_entry["supersedes_proposal_id"], old_entry["id"])
        self.assertEqual(new_entry["applied_section"]["status"], "active")
        self.assertEqual(old_entry["applied_section"]["status"], "superseded")

    def test_supersede_requires_accepted_target(self) -> None:
        async def run() -> None:
            await init_db()
            observation = await _preference_observation()
            proposal = await _preference_proposal(observation["id"])
            second = await _preference_observation()
            await create_memory_proposal(
                observation_id=second["id"],
                target_tier="preference",
                section_type="custom:c_preference",
                title=_uniq("非法取代提案"),
                after={"bullet": "不应创建"},
                reason="测试非法取代",
                supersedes_proposal_id=proposal["id"],
            )

        with self.assertRaises(ValueError):
            asyncio.run(run())

    def test_revoke_superseded_proposal_is_rejected(self) -> None:
        async def run() -> None:
            await init_db()
            first = await _preference_observation()
            proposal_a = await _preference_proposal(first["id"])
            await review_memory_proposal(proposal_id=proposal_a["id"], action="accept")
            second = await _preference_observation()
            proposal_b = await create_memory_proposal(
                observation_id=second["id"],
                target_tier="preference",
                section_type="custom:c_preference",
                title=_uniq("取代后的地点偏好"),
                after={"bullet": "上海后端"},
                reason="更新偏好",
                supersedes_proposal_id=proposal_a["id"],
            )
            await review_memory_proposal(proposal_id=proposal_b["id"], action="accept")
            await review_memory_proposal(
                proposal_id=proposal_a["id"],
                action="revoke",
            )

        with self.assertRaises(ValueError):
            asyncio.run(run())

    def test_job_projection_ranks_relevant_entries_and_excludes_invalid(self) -> None:
        async def run() -> tuple[dict, int, int, int]:
            await init_db()
            relevant_id = await _insert_section(
                "Python 后端开发经验",
                content={"bullet": "使用 FastAPI 开发后端服务"},
            )
            irrelevant_id = await _insert_section(
                "平面设计作品集",
                content={"bullet": "负责海报与品牌视觉设计"},
            )
            revoked_id = await _insert_section(
                "已撤销的经历条目",
                content={"bullet": "不应出现在投影中"},
            )
            async with async_session() as db:
                section = (
                    await db.execute(
                        select(ProfileSection).where(ProfileSection.id == revoked_id)
                    )
                ).scalar_one()
                section.status = "revoked"
                await db.commit()
            job_id = await _insert_job(
                "Python 后端工程师",
                "负责后端服务开发，熟悉 Python、FastAPI、数据库设计。",
            )
            projection = await build_job_projection(job_id=job_id)
            return projection, relevant_id, irrelevant_id, revoked_id

        projection, relevant_id, irrelevant_id, revoked_id = asyncio.run(run())

        by_id = {int(item["id"]): item for item in projection["entries"]}
        self.assertIn(relevant_id, by_id)
        self.assertTrue(by_id[relevant_id]["selected"])
        self.assertGreater(by_id[relevant_id]["relevance"], 0)
        self.assertIn(irrelevant_id, by_id)
        self.assertFalse(by_id[irrelevant_id]["selected"])
        self.assertEqual(by_id[irrelevant_id]["relevance"], 0)
        relevances = [by_id[int(item["id"])]["relevance"] for item in projection["entries"]]
        self.assertEqual(relevances, sorted(relevances, reverse=True))
        invalid_ids = {int(item["id"]) for item in projection["invalidated_entries"]}
        self.assertIn(revoked_id, invalid_ids)
        self.assertNotIn(relevant_id, projection["invalidated_entries"])
        self.assertFalse(any(item["id"] == revoked_id for item in projection["entries"]))


class PreferenceGateTests(unittest.TestCase):
    def test_preference_write_without_confirmation_is_rejected(self) -> None:
        async def run() -> None:
            await init_db()
            await add_profile_evidence(
                section_type="custom:c_preference",
                title=_uniq("推断偏好"),
                content_json={"category_label": "求职偏好", "bullet": "系统推断的偏好"},
                source_text="系统推断的偏好",
                tier="preference",
            )

        with self.assertRaises(ValueError):
            asyncio.run(run())

    def test_preference_direct_statement_and_verified_fact_pass_gate(self) -> None:
        async def run() -> tuple[dict, dict]:
            await init_db()
            statement = "我明确希望在深圳工作。"
            direct = await add_profile_evidence(
                section_type="custom:c_preference",
                title=_uniq("直写偏好"),
                content_json={"category_label": "求职偏好", "bullet": statement},
                source_text=statement,
                tier="preference",
                preference_confirmation="direct",
            )
            verified = await add_profile_evidence(
                section_type="experience",
                title=_uniq("经历条目"),
                content_json={"bullet": "负责后端服务开发"},
                # verified_fact 需要独立可验证出处；来源=声明原文会被
                # 事实门按自回声拦截（resume_fact_gates._is_self_echo_source）。
                source_text="2023-2025 某科技公司后端组：负责订单后端服务开发，QPS 峰值 1.2 万。",
                tier="verified_fact",
            )
            return direct, verified

        direct, verified = asyncio.run(run())

        self.assertFalse(direct.get("duplicate"))
        self.assertEqual(direct["tier"], "preference")
        self.assertEqual(verified["tier"], "verified_fact")

    def test_proposal_accept_passes_preference_gate(self) -> None:
        async def run() -> dict:
            await init_db()
            observation = await _preference_observation()
            proposal = await _preference_proposal(observation["id"])
            accepted = await review_memory_proposal(
                proposal_id=proposal["id"],
                action="accept",
            )
            return accepted

        accepted = asyncio.run(run())

        self.assertEqual(accepted["status"], "accepted")
        self.assertEqual(accepted["profile_write"]["tier"], "preference")


if __name__ == "__main__":
    unittest.main()
