from __future__ import annotations

import asyncio
import json
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.services import agent_integration as integration
from app.services.agent_bridge import codex_adapter


class FakeCodexAdapter:
    final_nonce = ""
    include_operation_event = True

    def __init__(self, **options: object):
        self.closed = False
        self.thread_params = options.get("thread_params") or {}

    async def start(self) -> None:
        return None

    async def list_skills(self, *, cwd: str, force_reload: bool = True) -> list[dict]:
        return [{
            "name": "offeru",
            "path": str(integration.CodexIntegration().skill_path().resolve()),
            "enabled": True,
        }]

    async def create_thread(self, *, cwd: str, tool_descriptions: list[str]) -> dict:
        assert tool_descriptions and tool_descriptions[0].startswith("get_agent_connection_nonce")
        return {"threadId": "test"}

    async def start_turn(self, *, prompt: str, cwd: str, skill: dict | None = None) -> dict:
        assert skill and skill["name"] == "offeru"
        challenge_id = re.search(r"challenge_id=([a-f0-9]{32})", prompt).group(1)  # type: ignore[union-attr]
        nonce = integration.get_connection_nonce("codex", challenge_id)["nonce"]
        returned = self.final_nonce or nonce
        return {"finalMessage": f'{{"nonce":"{returned}"}}'}

    def events(self) -> list[dict]:
        operation = "get_agent_connection_nonce" if self.include_operation_event else "other_operation"
        return [{"method": "item/tool/call", "params": {"tool": operation}}]

    async def close(self) -> None:
        self.closed = True


class AgentIntegrationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.env = patch.dict("os.environ", {"CODEX_HOME": str(self.root / "codex")})
        self.env.start()
        self.data_path = patch.object(
            integration,
            "runtime_data_path",
            side_effect=lambda name: self.root / "data" / name,
        )
        self.data_path.start()

    def tearDown(self) -> None:
        self.data_path.stop()
        self.env.stop()
        self.temp.cleanup()

    async def test_install_update_and_repair_use_a_real_file(self) -> None:
        adapter = integration.CodexIntegration()
        self.assertEqual(adapter.inspect()["skill_status"], "NOT_INSTALLED")
        installed = adapter.install()
        self.assertEqual(installed["skill_status"], "INSTALLED")
        path = adapter.skill_path()
        self.assertFalse(path.is_symlink())
        self.assertIn(str(integration._BACKEND_ROOT.resolve()), path.read_text(encoding="utf-8"))

        path.write_text(path.read_text(encoding="utf-8") + "\noutdated\n", encoding="utf-8")
        self.assertEqual(adapter.inspect()["skill_status"], "OUTDATED")
        self.assertEqual(adapter.update()["skill_status"], "INSTALLED")

        path.write_text("not an OfferU skill", encoding="utf-8")
        self.assertEqual(adapter.inspect()["skill_status"], "ERROR")
        with self.assertRaises(ValueError):
            adapter.install()
        self.assertEqual(adapter.repair()["skill_status"], "INSTALLED")

    async def test_codex_child_uses_system_proxy_without_overriding_process_proxy(self) -> None:
        with patch.dict(codex_adapter.os.environ, {}, clear=True), patch.object(
            codex_adapter.urllib.request,
            "getproxies",
            return_value={"http": "http://system-proxy", "https": "http://system-proxy"},
        ):
            environment = codex_adapter._codex_environment()
        self.assertEqual(environment["HTTP_PROXY"], "http://system-proxy")
        self.assertEqual(environment["HTTPS_PROXY"], "http://system-proxy")

        with patch.dict(codex_adapter.os.environ, {"HTTPS_PROXY": "http://explicit"}, clear=True), patch.object(
            codex_adapter.urllib.request,
            "getproxies",
            return_value={"https": "http://system-proxy"},
        ):
            environment = codex_adapter._codex_environment()
        self.assertEqual(environment["HTTPS_PROXY"], "http://explicit")

    async def test_nonce_is_provider_bound_and_expires(self) -> None:
        challenge = integration.create_connection_challenge("codex")
        with self.assertRaises(ValueError):
            integration.get_connection_nonce("opencode", challenge["challenge_id"])
        self.assertEqual(
            integration.get_connection_nonce("codex", challenge["challenge_id"])["nonce"],
            challenge["nonce"],
        )
        with self.assertRaises(ValueError):
            integration.get_connection_nonce("codex", challenge["challenge_id"])
        expiring = integration.create_connection_challenge("codex")
        with patch.object(integration.time, "time", return_value=integration.time.time() + 301):
            with self.assertRaises(ValueError):
                integration.get_connection_nonce("codex", expiring["challenge_id"])

    async def test_codex_probe_requires_nonce_and_cli_operation_evidence(self) -> None:
        manager = integration.AgentIntegrationManager()
        manager.install("codex")
        with patch("app.services.agent_bridge.codex_adapter.CodexMainLoopAdapter", FakeCodexAdapter):
            verified = await manager.probe("codex", "codex.exe")
        self.assertEqual(verified["integration_status"], "VERIFIED")
        self.assertTrue(verified["connection_verified"])

        FakeCodexAdapter.include_operation_event = False
        try:
            with patch("app.services.agent_bridge.codex_adapter.CodexMainLoopAdapter", FakeCodexAdapter):
                rejected = await manager.probe("codex", "codex.exe")
        finally:
            FakeCodexAdapter.include_operation_event = True
        self.assertEqual(rejected["integration_status"], "ERROR")
        self.assertFalse(rejected["connection_verified"])

    async def test_opencode_probe_reports_discovered_without_claiming_verified(self) -> None:
        manager = integration.AgentIntegrationManager()
        manager.install("opencode")
        location = str(integration.OpenCodeIntegration().skill_path().resolve())
        with patch(
            "app.services.coding_agent_runtime._capture",
            return_value=(0, json.dumps([{"name": "offeru", "location": location}]), ""),
        ):
            result = await manager.probe("opencode", "opencode.exe")
        self.assertEqual(result["integration_status"], "DISCOVERED")
        self.assertFalse(result["connection_verified"])


if __name__ == "__main__":
    unittest.main()
