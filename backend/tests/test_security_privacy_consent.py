from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
import os
import sys
import unittest


BACKEND_DIR = Path(__file__).resolve().parents[1]
os.chdir(BACKEND_DIR)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.services.ai_interviews import (
    _build_consent,
    _required_categories,
    get_ai_interview_runtime,
)
from app.services.authorized_research import _session_summary
from app.services.email_sync import (
    DEFAULT_GMAIL_CALLBACK_URL,
    GMAIL_SCOPES,
    validate_gmail_redirect_uri,
)


class PrivacyConsentContractTests(unittest.TestCase):
    def test_interview_categories_are_minimal_and_context_driven(self) -> None:
        self.assertEqual(
            _required_categories(profile_id=None, target_job_id=None),
            ["interview_configuration", "interview_transcript"],
        )
        self.assertEqual(
            _required_categories(profile_id=7, target_job_id=11),
            [
                "interview_configuration",
                "interview_transcript",
                "verified_profile_facts",
                "job_description",
                "job_research",
            ],
        )

    def test_cloud_runtime_requires_explicit_consent_and_categories(self) -> None:
        runtime = {
            "provider": "openai",
            "model": "test-model",
            "is_local": False,
        }
        categories = ["interview_configuration", "interview_transcript"]
        with self.assertRaisesRegex(ValueError, "云端模型"):
            _build_consent(
                runtime=runtime,
                model_provider="openai",
                data_consent=False,
                consented_data_categories=categories,
                required_categories=categories,
            )
        with self.assertRaisesRegex(ValueError, "数据类别"):
            _build_consent(
                runtime=runtime,
                model_provider="openai",
                data_consent=True,
                consented_data_categories=["interview_configuration"],
                required_categories=categories,
            )
        granted = _build_consent(
            runtime=runtime,
            model_provider="openai",
            data_consent=True,
            consented_data_categories=categories,
            required_categories=categories,
        )
        self.assertTrue(granted["granted"])
        self.assertFalse(granted["is_local"])
        self.assertEqual(granted["categories"], categories)

    def test_local_runtime_records_notice_without_claiming_cloud_grant(self) -> None:
        categories = ["interview_configuration", "interview_transcript"]
        result = _build_consent(
            runtime={
                "provider": "ollama",
                "model": "local-model",
                "is_local": True,
            },
            model_provider="ollama",
            data_consent=False,
            consented_data_categories=categories,
            required_categories=categories,
        )

        self.assertFalse(result["granted"])
        self.assertTrue(result["is_local"])

    def test_interview_runtime_and_authorized_browser_expose_privacy_contract(self) -> None:
        runtime = get_ai_interview_runtime()
        self.assertFalse(runtime["privacy"]["raw_camera_data_sent_to_backend"])
        self.assertFalse(runtime["privacy"]["raw_audio_stored_by_default"])
        self.assertIn("personality", runtime["evaluation_boundary"]["prohibited_inferences"])

        session = SimpleNamespace(
            session_id="session-1",
            job_id=7,
            base_run_id=None,
            completed_run_id=None,
            platform="niuke",
            initial_url="https://www.nowcoder.com/discuss/1",
            status="interrupted",
            read_only_active=False,
            expires_at="2026-08-31T00:00:00+00:00",
            created_at="2026-08-31T00:00:00+00:00",
            updated_at="2026-08-31T00:00:00+00:00",
            completed_at=None,
            error="",
        )
        summary = _session_summary(session)
        self.assertFalse(summary["privacy"]["credentials_stored"])
        self.assertFalse(summary["privacy"]["cookies_stored"])
        self.assertFalse(summary["privacy"]["storage_state_stored"])
        self.assertEqual(summary["privacy"]["capture_policy"], "user_selected_excerpt_only")

    def test_gmail_scope_is_read_only(self) -> None:
        self.assertEqual(
            GMAIL_SCOPES,
            ("https://www.googleapis.com/auth/gmail.readonly",),
        )

    def test_gmail_callback_rejects_stale_local_ports(self) -> None:
        self.assertEqual(
            validate_gmail_redirect_uri("http://localhost:8765/api/email/callback"),
            DEFAULT_GMAIL_CALLBACK_URL,
        )
        with self.assertRaisesRegex(ValueError, "本地回调必须使用"):
            validate_gmail_redirect_uri("http://127.0.0.1:8080/api/email/callback")
        with self.assertRaisesRegex(ValueError, "配置无效"):
            validate_gmail_redirect_uri("http://user:password@127.0.0.1:8765/api/email/callback")


if __name__ == "__main__":
    unittest.main()
