from __future__ import annotations

import unittest

from app.ops import get_operation_schema
from app.services.application_actions import (
    ApplicationActionConnector,
    ApplicationActionRequest,
    application_action_idempotency_key,
    build_application_action_preview,
)
from app.services.job_sources.adapters.boss import BossJobSource


class ApplicationActionPlanningTests(unittest.TestCase):
    def test_idempotency_key_is_stable_and_message_sensitive(self) -> None:
        base = ApplicationActionRequest(
            source="boss",
            job_id=42,
            external_job_ref="sec_123",
            action="send_message",
            message="您好，我对这个岗位很感兴趣。",
        )
        same = ApplicationActionRequest(
            source="boss",
            job_id=42,
            external_job_ref="sec_123",
            action="send_message",
            message="您好，我对这个岗位很感兴趣。",
        )
        changed = ApplicationActionRequest(
            source="boss",
            job_id=42,
            external_job_ref="sec_123",
            action="send_message",
            message="您好，想进一步了解这个岗位。",
        )

        self.assertEqual(
            application_action_idempotency_key(base),
            application_action_idempotency_key(same),
        )
        self.assertNotEqual(
            application_action_idempotency_key(base),
            application_action_idempotency_key(changed),
        )

    def test_greet_preview_is_ready_only_after_pre_application_review(self) -> None:
        request = ApplicationActionRequest(
            source="boss",
            job_id=42,
            external_job_ref="sec_123",
            action="greet",
        )

        blocked = build_application_action_preview(
            request=request,
            pre_application_stage="needs_decision",
        )
        ready = build_application_action_preview(
            request=request,
            pre_application_stage="ready_for_resume_proposal",
        )

        self.assertEqual(blocked.state, "blocked")
        self.assertIn("投前决策", " ".join(blocked.blocking_reasons))
        self.assertEqual(ready.state, "ready_for_proposal")
        self.assertTrue(ready.requires_confirmation)
        self.assertFalse(ready.execution_available)

    def test_send_resume_requires_ready_packet_for_same_job_and_resume(self) -> None:
        request = ApplicationActionRequest(
            source="boss",
            job_id=42,
            external_job_ref="sec_123",
            action="send_resume",
            resume_id=7,
        )

        blocked = build_application_action_preview(
            request=request,
            pre_application_stage="resume_proposal_ready",
            resume_packet={
                "job_id": 99,
                "resume_id": 7,
                "status": "draft",
            },
        )
        ready = build_application_action_preview(
            request=request,
            pre_application_stage="resume_proposal_ready",
            resume_packet={
                "job_id": 42,
                "resume_id": 7,
                "status": "ready",
            },
        )

        self.assertEqual(blocked.state, "blocked")
        self.assertGreaterEqual(len(blocked.blocking_reasons), 2)
        self.assertEqual(ready.state, "ready_for_proposal")
        self.assertEqual(ready.materials["resume_packet_status"], "ready")

    def test_exchange_contact_requires_existing_application_attempt(self) -> None:
        request = ApplicationActionRequest(
            source="boss",
            job_id=42,
            external_job_ref="sec_123",
            action="exchange_contact",
        )

        blocked = build_application_action_preview(
            request=request,
            pre_application_stage="ready_for_resume_proposal",
            has_application_attempt=False,
        )
        ready = build_application_action_preview(
            request=request,
            pre_application_stage="ready_for_resume_proposal",
            has_application_attempt=True,
        )

        self.assertEqual(blocked.state, "blocked")
        self.assertEqual(ready.state, "ready_for_proposal")


class ApplicationActionBoundaryTests(unittest.TestCase):
    def test_boss_job_source_does_not_implement_write_connector(self) -> None:
        self.assertNotIsInstance(BossJobSource(), ApplicationActionConnector)

    def test_preview_operation_is_read_only_and_never_requires_confirmation(self) -> None:
        schema = get_operation_schema("preview_application_action")
        self.assertIsNotNone(schema)
        assert schema is not None
        self.assertEqual(schema["side_effects"], ["read"])
        self.assertFalse(schema["requires_confirmation"])

    def test_preview_operation_is_exposed_to_application_assistant(self) -> None:
        from app.services.agent_skill_registry import resolve_skill

        skill = resolve_skill("application_assistant")
        self.assertIsNotNone(skill)
        assert skill is not None
        self.assertIn("preview_application_action", skill.allowed_tools)


if __name__ == "__main__":
    unittest.main()
