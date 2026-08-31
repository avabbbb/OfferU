from __future__ import annotations

import unittest
from unittest.mock import patch

from app.routes import config as config_route
from app.services.security_redaction import (
    redact_sensitive_text,
    redact_sensitive_value,
    safe_error_message,
)
from app.services.agent_run_state import _clean_action, _clean_run


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
