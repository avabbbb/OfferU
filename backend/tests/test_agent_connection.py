from __future__ import annotations

import asyncio
import json
import time
import unittest
from unittest.mock import AsyncMock, patch

from app.services import agent_connection as connection
from app.services.agent_bridge.codex_adapter import CodexMainLoopAdapter


def detected(provider_id: str = "codex", **updates) -> dict:
    return {
        "id": provider_id, "name": provider_id, "version": "1.0.0",
        "available": True, "executable_path": "/agent/codex",
        "contract_compatible": True, "checked_at": "2026-09-08T08:00:00Z",
        **updates,
    }


class AgentConnectionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        connection._CHECKS.clear()
        connection._CHECK_LOCK = asyncio.Lock()

    async def run_probe(self, account=None, *, failure=None, health=None, item=None):
        item = item or detected()
        adapter = AsyncMock()
        adapter.read_account.return_value = account or {}
        adapter.start.side_effect = failure
        with (
            patch.object(connection.runtime, "_probe", AsyncMock(return_value=item)) as probe,
            patch.object(connection.runtime, "list_local_executors", AsyncMock(return_value={"items": [item]})),
            patch.object(connection, "list_provider_health", AsyncMock(return_value={"providers": health or []})),
            patch("app.services.agent_bridge.codex_adapter.CodexMainLoopAdapter", return_value=adapter) as factory,
        ):
            result = await connection.probe_agent_connection(item["id"])
        return result, adapter, probe, factory

    async def test_discovery_is_not_a_successful_connection_or_login(self):
        item = connection._view(detected(), {"available": True, "authenticated": True})
        self.assertEqual(item["status"], "check_required")
        self.assertIsNone(item["authenticated"])
        self.assertFalse(item["connection_verified"])
        self.assertFalse(item["live_model_verified"])
        self.assertEqual(item["resume_state"], "NOT_VERIFIED")
        self.assertEqual(item["cancel_state"], "NOT_VERIFIED")

    async def test_persisted_conformance_states_are_projected_without_exposing_credentials(self):
        item = connection._view(
            detected(),
            {
                "available": True,
                "authenticated": True,
                "capabilities": {
                    "conformance": {
                        "binary_path": "/agent/codex",
                        "version": "1.0.0",
                        "last_probe_at": "2026-09-09T08:00:00Z",
                        "live_model_verified": "VERIFIED",
                        "structured_output_verified": "VERIFIED",
                        "streaming_verified": "VERIFIED",
                        "resume_verified": "VERIFIED",
                        "cancel_verified": "ERROR",
                        "web_search_verified": "SUPPORTED",
                        "api_key": "must-not-leak",
                    }
                },
            },
        )
        self.assertEqual(item["live_model_state"], "VERIFIED")
        self.assertEqual(item["resume_state"], "VERIFIED")
        self.assertEqual(item["cancel_state"], "ERROR")
        self.assertEqual(item["web_search_state"], "SUPPORTED")
        self.assertNotIn("must-not-leak", json.dumps(item))

    async def test_local_handshake_has_no_model_turn_and_does_not_expose_account_details(self):
        result, adapter, probe, _ = await self.run_probe({
            "account": {"type": "chatgpt", "email": "private@example.com", "token": "private-value"},
            "requiresOpenaiAuth": True,
        })
        item = result["items"][0]
        self.assertEqual(item["status"], "ready")
        self.assertTrue(item["authenticated"])
        self.assertTrue(item["connection_verified"])
        self.assertFalse(item["live_model_verified"])
        probe.assert_awaited_once_with("codex", refresh=True)
        adapter.start.assert_awaited_once()
        adapter.read_account.assert_awaited_once()
        adapter.close.assert_awaited_once()
        adapter.start_turn.assert_not_called()
        self.assertNotIn("private@example.com", json.dumps(result))
        self.assertNotIn("private-value", json.dumps(result))
        self.assertNotIn("executable_path", item)

    async def test_signed_out_account_gets_a_login_step(self):
        result, adapter, _, _ = await self.run_probe({"account": None, "requiresOpenaiAuth": True})
        self.assertEqual(result["items"][0]["status"], "auth_required")
        self.assertIs(result["items"][0]["authenticated"], False)
        adapter.close.assert_awaited_once()

    async def test_custom_provider_without_openai_auth_stays_unverified(self):
        result, _, _, _ = await self.run_probe({"account": None, "requiresOpenaiAuth": False})
        self.assertEqual(result["items"][0]["status"], "check_required")
        self.assertIsNone(result["items"][0]["authenticated"])

    async def test_unknown_account_type_cannot_be_marked_signed_in(self):
        result, _, _, _ = await self.run_probe({"account": {"type": "unexpected-secret"}})
        self.assertEqual(result["items"][0]["status"], "check_required")
        self.assertIsNone(result["items"][0]["authenticated"])
        self.assertNotIn("unexpected-secret", json.dumps(result))

    async def test_local_check_does_not_erase_previous_remote_auth_failure(self):
        result, _, _, _ = await self.run_probe(
            {"account": {"type": "chatgpt"}},
            health=[{"provider_id": "codex", "blocked": True, "last_error": "401 unauthorized"}],
        )
        item = result["items"][0]
        self.assertEqual(item["status"], "blocked")
        self.assertTrue(item["connection_verified"])
        self.assertEqual(item["last_error"], "401 unauthorized")

    async def test_local_check_does_not_erase_previous_remote_unavailable_state(self):
        result, _, _, _ = await self.run_probe(
            {"account": {"type": "chatgpt"}},
            health=[{
                "provider_id": "codex", "status": "unavailable", "available": False,
                "checked_at": "2026-09-08T08:00:00Z", "last_error": "服务商暂时不可用",
            }],
        )
        item = result["items"][0]
        self.assertEqual(item["status"], "failed")
        self.assertTrue(item["connection_verified"])

    async def test_timeout_and_failure_close_the_temporary_process(self):
        for failure in (TimeoutError(), RuntimeError("token=private-value")):
            with self.subTest(failure=type(failure).__name__):
                result, adapter, _, _ = await self.run_probe(failure=failure)
                self.assertEqual(result["items"][0]["status"], "failed")
                self.assertFalse(result["items"][0]["connection_verified"])
                self.assertNotIn("private-value", json.dumps(result))
                adapter.close.assert_awaited_once()

    async def test_unknown_or_replay_provider_does_not_launch_a_process(self):
        for provider_id in ("replay", "fixture", "codex; arbitrary"):
            with self.subTest(provider_id=provider_id):
                with patch.object(connection.runtime, "_probe", AsyncMock()) as probe:
                    with self.assertRaises(ValueError):
                        await connection.probe_agent_connection(provider_id)
                    probe.assert_not_called()

    async def test_incompatible_cli_never_starts_a_protocol_session(self):
        result, _, _, factory = await self.run_probe(item=detected(contract_compatible=False))
        self.assertEqual(result["items"][0]["status"], "incompatible")
        factory.assert_not_called()

    async def test_missing_program_and_unverified_other_agent_have_distinct_states(self):
        result, _, _, factory = await self.run_probe(item=detected(executable_path=None, contract_compatible=False))
        self.assertEqual(result["items"][0]["status"], "missing")
        factory.assert_not_called()
        result, _, _, factory = await self.run_probe(item=detected("claude"))
        self.assertEqual(result["items"][0]["status"], "check_required")
        self.assertIsNone(result["items"][0]["authenticated"])
        factory.assert_not_called()

    async def test_expired_or_replaced_executable_invalidates_success(self):
        await self.run_probe({"account": {"type": "chatgpt"}})
        self.assertEqual(connection._view(detected(version="2.0.0"), {})["status"], "check_required")
        self.assertEqual(connection._view(detected(executable_path="/different/codex"), {})["status"], "check_required")
        connection._CHECKS["codex"]["at"] = time.monotonic() - 121
        self.assertEqual(connection._view(detected(), {})["status"], "check_required")

    async def test_account_probe_does_not_refresh_credentials(self):
        adapter = CodexMainLoopAdapter(executable="test-only")
        with patch.object(adapter, "_request", AsyncMock(return_value={})) as request:
            await adapter.read_account()
        request.assert_awaited_once_with("account/read", {"refreshToken": False})


if __name__ == "__main__":
    unittest.main()
