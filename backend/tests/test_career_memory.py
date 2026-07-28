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
from app.models.models import CareerSource, LearningObservation, MemoryProposal, ProfileSection
from app.ops import OPERATIONS
from app.services.agent_skill_registry import resolve_skill
from app.services.career_memory import (
    create_memory_proposal,
    invalidate_memory_source,
    list_memory_inbox,
    record_conversation_observation,
    record_learning_observation,
    review_memory_proposal,
    _observation_source_excerpt,
)


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
        section_type="preference",
        title=_uniq("目标地点偏好"),
        before={},
        after={
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
                section_after_revoke is None,
            )

        accepted, revoked, visible_before_accept, removed_after_revoke = asyncio.run(run())

        self.assertTrue(visible_before_accept)
        self.assertEqual(accepted["status"], "accepted")
        self.assertEqual(accepted["profile_write"]["tier"], "preference")
        self.assertEqual(revoked["status"], "revoked")
        self.assertTrue(removed_after_revoke)

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
                stored_section is None,
            )

        result, source, derived, section_removed = asyncio.run(run())

        self.assertTrue(result["invalidated"])
        self.assertEqual(source["status"], "invalidated")
        self.assertEqual(source["title"], "")
        self.assertEqual(source["locator"], "")
        self.assertTrue(source["external_id"].startswith("invalidated:"))
        self.assertEqual(derived["observation_status"], "invalidated")
        self.assertEqual(derived["observation_content"], {})
        self.assertEqual(derived["proposal_status"], "invalidated")
        self.assertEqual(derived["proposal_after"], {})
        self.assertTrue(section_removed)


async def _profile_section_count(title: str) -> int:
    async with async_session() as db:
        rows = (
            await db.execute(select(ProfileSection.id).where(ProfileSection.title == title))
        ).scalars().all()
        return len(rows)


if __name__ == "__main__":
    unittest.main()
