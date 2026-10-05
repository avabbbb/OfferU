from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.models import Base
from app.services import agent_connection as connection, agent_integration as integration
from app.services.operation_projection import execute_or_propose_operation


class UniversalAgentConnectionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        root = Path("H:/tmp/offeru")
        root.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=root)
        self.root = Path(self.temp.name)
        self.engine = create_async_engine(f"sqlite+aiosqlite:///{self.root / 'connection.db'}")
        async with self.engine.begin() as db:
            await db.run_sync(Base.metadata.create_all)
        factory = async_sessionmaker(self.engine, expire_on_commit=False)
        self.patches = [
            patch.object(Path, "home", return_value=self.root),
            patch.dict("os.environ", {"CODEX_HOME": str(self.root / "codex"), "XDG_CONFIG_HOME": str(self.root / "config"),
                                      "CLAUDE_CONFIG_DIR": str(self.root / "claude"), "OMP_AGENT_DIR": str(self.root / "omp"),
                                      "PI_CODING_AGENT_DIR": str(self.root / "pi")}),
            patch.object(integration, "runtime_data_path", side_effect=lambda name: self.root / name),
            patch("app.services.agent_provider_health.async_session", factory),
            patch("app.ops.async_session", factory),
            patch.object(connection.runtime, "_resolve_executable", return_value="/agent/installed"),
            patch.object(connection.runtime, "_probe", AsyncMock(side_effect=AssertionError("must not probe hosted runtime"))),
            patch.object(connection.runtime, "list_local_executors", AsyncMock(side_effect=AssertionError("must not launch discovery"))),
        ]
        for item in self.patches:
            item.start()
        connection._CHECKS.clear()
        connection._CHECK_LOCK = asyncio.Lock()

    async def asyncTearDown(self):
        for item in reversed(self.patches):
            item.stop()
        connection._CHECKS.clear()
        await self.engine.dispose()
        self.temp.cleanup()

    async def test_any_compatible_host_can_complete_the_same_registry_readback(self):
        snapshot = await connection.connect_agent_integration("external")
        item = next(row for row in snapshot["items"] if row["id"] == "external")
        self.assertFalse(item["connection_verified"])
        self.assertEqual(item["skill_status"], "INSTALLED")
        challenge = item["verification_challenge"]
        result = await execute_or_propose_operation("get_agent_connection_nonce", challenge, surface="cli")
        self.assertTrue(result["ok"], result)
        # Desktop can retain its pre-readback memory cache while a different
        # process completes the CLI call. Persisted evidence must take precedence.
        connection._CHECKS["external"] = {"status": "check_required", "challenge_id": challenge["challenge_id"]}
        snapshot = await connection.get_agent_connections()
        item = next(row for row in snapshot["items"] if row["id"] == "external")
        self.assertEqual(item["status"], "ready")
        self.assertTrue(item["connection_verified"])
        self.assertFalse(item["live_model_verified"])
        self.assertIsNone(item["authenticated"])
        self.assertEqual(item["capabilities"]["interactive_input"], "HOST_OWNED")
        self.assertIsNone(item["verification_challenge"])
        duplicate = await execute_or_propose_operation("get_agent_connection_nonce", challenge, surface="mcp")
        self.assertTrue(duplicate["ok"], duplicate)

    async def test_installation_and_host_discovery_do_not_claim_a_connection(self):
        snapshot = await connection.get_agent_connections()
        self.assertEqual(snapshot["recommended_provider_id"], "external")
        self.assertTrue(all(not row["connection_verified"] for row in snapshot["items"]))
        for provider_id in ("omp", "pi", "gemini", "codebuddy"):
            snapshot = await connection.connect_agent_integration(provider_id)
            item = next(row for row in snapshot["items"] if row["id"] == provider_id)
            self.assertTrue(item["can_install_skill"])
            self.assertEqual(item["skill_status"], "INSTALLED")
            self.assertFalse(item["connection_verified"])

    async def test_new_challenge_and_skill_drift_invalidate_old_readback(self):
        first = await connection.connect_agent_integration("external")
        old = next(row for row in first["items"] if row["id"] == "external")["verification_challenge"]
        await connection.probe_agent_connection("external")
        result = await execute_or_propose_operation("get_agent_connection_nonce", old, surface="cli")
        self.assertFalse(result["ok"])
        adapter = integration.integration_manager.adapter("external")
        adapter.skill_path().write_text(adapter.skill_path().read_text(encoding="utf-8") + "\nold", encoding="utf-8")
        with self.assertRaises(ValueError):
            await connection.probe_agent_connection("external")

    async def test_unknown_adapter_fails_without_starting_a_process(self):
        with self.assertRaises(ValueError):
            await connection.connect_agent_integration("future; shell")

    async def test_hosted_model_failure_does_not_block_an_external_tool_connection(self):
        from app.services.agent_provider_health import get_provider_health, record_provider_health
        await record_provider_health("omp", available=True, blocked=True, error="old hosted launch failure", authenticated=False)
        snapshot = await connection.connect_agent_integration("omp")
        item = next(row for row in snapshot["items"] if row["id"] == "omp")
        result = await execute_or_propose_operation("get_agent_connection_nonce", item["verification_challenge"], surface="mcp")
        self.assertTrue(result["ok"], result)
        item = next(row for row in (await connection.get_agent_connections())["items"] if row["id"] == "omp")
        self.assertEqual(item["status"], "ready")
        self.assertEqual(item["last_error"], "")
        self.assertTrue(item["connection_verified"])
        self.assertFalse(item["live_model_verified"])
        self.assertEqual((await get_provider_health("omp"))["status"], "blocked")

    async def test_failed_persistence_is_retryable_and_old_readback_cannot_replace_reconnect(self):
        snapshot = await connection.connect_agent_integration("external")
        challenge = next(row for row in snapshot["items"] if row["id"] == "external")["verification_challenge"]
        with patch.object(connection, "record_external_readback", AsyncMock(side_effect=RuntimeError("persistence unavailable"))):
            failed = await execute_or_propose_operation("get_agent_connection_nonce", challenge, surface="cli")
        self.assertFalse(failed["ok"])
        retried = await execute_or_propose_operation("get_agent_connection_nonce", challenge, surface="cli")
        self.assertTrue(retried["ok"], retried)
        fresh = await connection.probe_agent_connection("external")
        fresh_challenge = next(row for row in fresh["items"] if row["id"] == "external")["verification_challenge"]
        with self.assertRaises(ValueError):
            await connection.record_external_readback(**challenge)
        fresh = await connection.get_agent_connections()
        item = next(row for row in fresh["items"] if row["id"] == "external")
        self.assertFalse(item["connection_verified"])
        self.assertEqual(item["verification_challenge"], fresh_challenge)
