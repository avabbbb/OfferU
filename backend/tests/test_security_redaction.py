from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.routes import config as config_route
from app.ops import OPERATIONS, _audit_inputs, _audit_outputs
from app.services.security_redaction import (
    redact_secret_value,
    redact_sensitive_text,
    redact_sensitive_value,
    safe_error_message,
)
from app.services.agent_run_state import _clean_action, _clean_run
from app.services.automation import _bounded as _bounded_automation
from app.services.automation import _event_view
from app.services.career_tasks import _bounded_json
from app.services.career_tasks import _task_view
from app.services.coding_agent_runtime import _bounded_payload
from app.services.coding_agent_runtime import _append_hosted_event_row
from app.services.coding_agent_runtime import _session_view


class SecurityRedactionTests(unittest.TestCase):
    def test_text_redacts_credentials_urls_and_direct_identifiers(self) -> None:
        source = (
            "Authorization: Bearer canary-token "
            "api_key=canary-key "
            "https://example.test/callback?code=canary-code&state=canary-state "
            "owner@example.com +86 13812345678"
        )
        redacted = redact_sensitive_text(source)
        self.assertNotIn("canary-token", redacted)
        self.assertNotIn("canary-key", redacted)
        self.assertNotIn("canary-code", redacted)
        self.assertNotIn("canary-state", redacted)
        self.assertNotIn("owner@example.com", redacted)
        self.assertNotIn("13812345678", redacted)

    def test_text_redacts_standalone_provider_credentials(self) -> None:
        source = (
            "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890 "
            "ghp_abcdefghijklmnopqrstuvwxyz1234567890 "
            "AIzaSyabcdefghijklmnopqrstuvwxyz1234567890"
        )
        redacted = redact_sensitive_text(source)
        self.assertNotIn("sk-proj-abcdefghijklmnopqrstuvwxyz1234567890", redacted)
        self.assertNotIn("ghp_abcdefghijklmnopqrstuvwxyz1234567890", redacted)
        self.assertNotIn("AIzaSyabcdefghijklmnopqrstuvwxyz1234567890", redacted)

    def test_nested_values_redact_by_key_and_bound_length(self) -> None:
        payload = {
            "api_key": "canary-key",
            "metadata": {"refresh_token": "canary-refresh", "note": "owner@example.com"},
            "items": [{"password": "canary-password"}],
        }
        redacted = redact_sensitive_value(payload)
        self.assertEqual(redacted["api_key"], "[redacted]")
        self.assertEqual(redacted["metadata"]["refresh_token"], "[redacted]")
        self.assertEqual(redacted["items"][0]["password"], "[redacted]")
        self.assertNotIn("owner@example.com", str(redacted))
        self.assertEqual(len(redact_sensitive_text("x" * 20, max_length=10)), 10)

    def test_secret_only_redaction_preserves_user_content(self) -> None:
        payload = {
            "email": "owner@example.com",
            "note": "Contact owner@example.com",
            "authorization": "Bearer canary-token",
        }
        redacted = redact_secret_value(payload)
        self.assertEqual(redacted["email"], "owner@example.com")
        self.assertEqual(redacted["note"], "Contact owner@example.com")
        self.assertEqual(redacted["authorization"], "[redacted]")

    def test_safe_error_message_never_returns_empty_or_raw_secret(self) -> None:
        error = RuntimeError("request failed api_token=canary-token")
        result = safe_error_message(error)
        self.assertEqual(result, "request failed api_token=[redacted]")
        self.assertEqual(safe_error_message(RuntimeError("")), "操作失败")

    def test_agent_run_storage_redacts_sensitive_execution_metadata(self) -> None:
        canary = "offeru-security-canary-run-secret"
        action = _clean_action(
            {
                "id": "resume:1",
                "tool": "resume.update",
                "args": {
                    "content": "candidate text",
                    "api_token": canary,
                    "nested": {"Authorization": f"Bearer {canary}"},
                },
                "summary": f"prepare api_key={canary}",
            },
            1,
        )
        cleaned = _clean_run(
            {
                "id": "run_0123456789abcdef",
                "task_id": "task_security",
                "goal": f"prepare resume for owner@example.com api_key={canary}",
                "steps": [action],
                "skill_snapshot": {"secret": canary},
                "llm_runtime": {"session_token": canary},
                "recovery_cursor": {"note": f"token={canary}"},
                "final_result": {"message": f"Bearer {canary}"},
                "failure_reason": f"failed password={canary}",
            }
        )

        self.assertIsNotNone(cleaned)
        serialized = str(cleaned)
        self.assertNotIn(canary, serialized)
        assert cleaned is not None
        self.assertEqual(cleaned["steps"][0]["args"]["api_token"], "[redacted]")
        self.assertEqual(cleaned["skill_snapshot"]["secret"], "[redacted]")
        self.assertEqual(cleaned["llm_runtime"]["session_token"], "[redacted]")

    def test_operation_audit_boundary_redacts_generic_secret_keys(self) -> None:
        canary = "offeru-security-canary-audit-secret"
        operation = OPERATIONS["get_job"]

        inputs = _audit_inputs(
            operation,
            {"token": canary, "nested": {"client_secret": canary}},
        )
        outputs = _audit_outputs(
            operation,
            {"authorization": f"Bearer {canary}", "result": "ok"},
        )

        self.assertNotIn(canary, str(inputs))
        self.assertNotIn(canary, str(outputs))
        self.assertEqual(inputs["token"], "[redacted]")
        self.assertEqual(inputs["nested"]["client_secret"], "[redacted]")
        self.assertEqual(outputs["authorization"], "[redacted]")

    def test_durable_task_and_event_payload_bounds_redact_secrets_only(self) -> None:
        canary = "offeru-security-canary-durable-secret"
        payload = {
            "email": "owner@example.com",
            "note": "Keep owner@example.com in the career payload",
            "api_key": canary,
        }

        for bounded in (_bounded_automation, _bounded_json, _bounded_payload):
            stored = bounded(payload)
            self.assertNotIn(canary, str(stored))
            self.assertEqual(stored["email"], "owner@example.com")
            self.assertEqual(stored["note"], "Keep owner@example.com in the career payload")

    def test_durable_error_views_redact_pii_without_redacting_normal_payloads(self) -> None:
        error = "provider failed for owner@example.com at +86 13812345678"
        event = _event_view(
            type(
                "Event",
                (),
                {
                    "event_id": "event-security",
                    "event_type": "JOB_SAVED",
                    "source": "test",
                    "target_type": "job",
                    "target_id": "1",
                    "payload_json": {"note": "owner@example.com"},
                    "dedupe_key": "dedupe",
                    "status": "failed",
                    "result_json": {},
                    "error": error,
                    "created_at": None,
                    "processed_at": None,
                },
            )()
        )
        task = _task_view(
            type(
                "Task",
                (),
                {
                    "task_id": "task-security",
                    "task_type": "agent_turn",
                    "source": "test",
                    "target_type": "job",
                    "target_id": "1",
                    "runtime_provider": "replay",
                    "input_json": {"note": "owner@example.com"},
                    "output_contract_json": {},
                    "status": "failed",
                    "progress_json": {},
                    "agent_thread_id": "",
                    "agent_turn_id": "",
                    "run_id": "",
                    "result_ref": "",
                    "result_json": {},
                    "checkpoint_json": {},
                    "error": error,
                    "retryable": True,
                    "attempt_count": 1,
                    "max_attempts": 3,
                    "next_retry_at": None,
                    "created_at": None,
                    "started_at": None,
                    "finished_at": None,
                },
            )()
        )
        session = _session_view(
            type(
                "Session",
                (),
                {
                    "session_id": "session-security",
                    "task_type": "run_artifact",
                    "task_id": "task-security",
                    "executor_id": "replay",
                    "protocol": "test",
                    "external_session_id": "",
                    "external_turn_id": "",
                    "status": "failed",
                    "cwd": "",
                    "capability_grant_json": {},
                    "recovery_cursor_json": {},
                    "error": error,
                    "event_sequence": 0,
                    "created_at": None,
                    "updated_at": None,
                    "started_at": None,
                    "completed_at": None,
                },
            )()
        )

        for view in (event, task, session):
            self.assertNotIn("owner@example.com", view["error"])
            self.assertNotIn("13812345678", view["error"])
            self.assertIn("[redacted email]", view["error"])
            self.assertIn("[redacted phone]", view["error"])

        self.assertEqual(event["payload"]["note"], "owner@example.com")
        self.assertEqual(task["input"]["note"], "owner@example.com")

    def test_hosted_provider_event_payload_redacts_pii_at_persistence_boundary(self) -> None:
        row = SimpleNamespace(session_id="session-security", event_sequence=0)
        event = _append_hosted_event_row(
            row,
            event_type="provider.event",
            provider_event="message.delta",
            payload={
                "text": "Contact owner@example.com at +86 13812345678",
                "note": "normal provider metadata",
                "api_token": "canary-token",
            },
        )

        self.assertEqual(row.event_sequence, 1)
        self.assertNotIn("owner@example.com", str(event.payload_json))
        self.assertNotIn("13812345678", str(event.payload_json))
        self.assertNotIn("canary-token", str(event.payload_json))
        self.assertEqual(event.payload_json["note"], "normal provider metadata")

    def test_config_projection_does_not_expose_nested_provider_credentials(self) -> None:
        config = config_route.ConfigUpdate(
            llm_provider="custom",
            llm_api_configs=[
                config_route.LlmApiConfig(
                    provider_id="custom",
                    service_name="Test Provider",
                    model="test-model",
                    base_url="https://example.test/v1",
                    api_key="canary-api-key",
                    extra_params={"api_token": "canary-extra-token"},
                    default_headers={"Authorization": "Bearer canary-header-token"},
                    is_active=True,
                )
            ],
        )
        with patch.object(config_route, "_current_config", config):
            payload = config_route._response_payload()

        serialized = str(payload)
        self.assertNotIn("canary-api-key", serialized)
        self.assertNotIn("canary-extra-token", serialized)
        self.assertNotIn("canary-header-token", serialized)
        provider = payload["llm_api_configs"][0]
        self.assertEqual(provider["api_key"], "cana******-key")
        self.assertEqual(provider["extra_params"]["api_token"], "[redacted]")
        self.assertEqual(provider["default_headers"]["Authorization"], "[redacted]")


if __name__ == "__main__":
    unittest.main()
