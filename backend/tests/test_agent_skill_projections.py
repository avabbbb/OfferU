from __future__ import annotations

import asyncio
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import AsyncMock, patch


BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = BACKEND_DIR.parent
os.chdir(BACKEND_DIR)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.cli import _manifest
from app.services.agent_skill_projections import projection_drift, render_skill_projections
from app.services.agent_skill_registry import resolve_run_skill, resolve_skill, resolve_slash_skill, select_skill


class AgentSkillProjectionTests(unittest.TestCase):
    def test_manifest_projects_the_versioned_skill_registry(self) -> None:
        manifest = _manifest()
        registry = manifest["skill_registry"]

        self.assertGreaterEqual(len(registry["skills"]), 33)
        self.assertEqual(len(registry["sha256"]), 64)
        self.assertEqual(manifest["operations"], [])
        scan = next(skill for skill in registry["skills"] if skill["id"] == "scan_jobs")
        self.assertIn("scan", scan["aliases"])
        self.assertNotIn("allowed_tools", scan)
        self.assertNotIn("confirmation_required_operations", scan)

        selected = _manifest(skill="scan")
        selected_skill = selected["skill_registry"]["skills"][0]
        self.assertEqual(selected_skill["id"], "scan_jobs")
        self.assertIn("batch_triage", selected_skill["confirmation_required_operations"])
        self.assertEqual(
            {operation["name"] for operation in selected["operations"]},
            set(selected_skill["allowed_tools"]),
        )

        bootstrap = _manifest(skill="connection_bootstrap")
        self.assertEqual(
            {operation["name"] for operation in bootstrap["operations"]},
            {"get_current_view"},
        )

    def test_cli_and_mcp_advertise_one_tool_contract(self) -> None:
        from app.mcp_server import operation_catalog

        cli_contract = _manifest()["tool_contract"]
        mcp_contract = asyncio.run(operation_catalog())["tool_contract"]
        self.assertEqual(cli_contract, mcp_contract)
        self.assertEqual(cli_contract["approval_authority"], "independent_user")
        self.assertEqual(cli_contract["bootstrap_operations"], ["get_current_view"])

    def test_slash_commands_resolve_through_the_registry(self) -> None:
        self.assertEqual(resolve_skill("/offeru").id, "discovery")
        self.assertEqual(resolve_skill("/scan").id, "scan_jobs")
        self.assertEqual(resolve_slash_skill("/scan 今天的岗位").id, "scan_jobs")
        self.assertIsNone(resolve_slash_skill("请扫描今天的岗位"))
        self.assertEqual(resolve_run_skill("/scan 今天的岗位", "discovery").id, "scan_jobs")
        with self.assertRaisesRegex(ValueError, "未知技能"):
            resolve_run_skill("/does-not-exist", "discovery")
        with patch("app.agents.llm.chat_completion", new=AsyncMock()) as router:
            selected, reason = asyncio.run(
                select_skill(user_message="/scan 今天的岗位", explicit_skill_id=None, fallback_mode="general")
            )
        self.assertEqual(selected.id, "scan_jobs")
        self.assertEqual(reason, "explicit_slash_command")
        router.assert_not_awaited()

    def test_external_agent_files_are_generated_and_safe(self) -> None:
        rendered = render_skill_projections()

        self.assertEqual(set(rendered), {
            Path(".agents/skills/offeru/SKILL.md"),
            Path(".claude/skills/offeru/SKILL.md"),
            Path(".claude/agents/offeru-operator.md"),
            Path(".codex/agents/offeru-operator.toml"),
            Path(".copilot/SKILL.md"),
        })
        for content in rendered.values():
            self.assertIn("<offeru-cli> manifest --pretty", content)
            self.assertIn("<offeru-cli> manifest --skill <skill-id> --pretty", content)
            self.assertIn("career Skills", content)
            self.assertNotIn("python -m app.cli", content)
            self.assertNotIn("Work from `backend/`", content)
            self.assertNotIn("~/.claude/skills", content)
            self.assertNotIn("/api/agent/runtime/skill", content)
            self.assertNotIn("python -m app.cli confirm", content)
            self.assertNotIn("agent_playbook --arg detail=full", content)
            self.assertNotIn("python -m app.cli api ", content)
            self.assertNotIn("python -m app.cli routes", content)
            self.assertNotIn("http://localhost:8000/api", content)
        for path, content in rendered.items():
            if path in {Path(".agents/skills/offeru/SKILL.md"), Path(".claude/skills/offeru/SKILL.md"), Path(".copilot/SKILL.md")}:
                self.assertIn("installed-product Agent router", content)
                self.assertIn("https://raw.githubusercontent.com/avabbbb/OfferU/main/.agents/skills/offeru/SKILL.md", content)
                self.assertIn("<!-- offeru-runtime-binding -->", content)
                self.assertIn("连接 Agent / 更新接入", content)
                self.assertIn("Source development is allowed only", content)
                self.assertIn("get_agent_connection_nonce", content)
                self.assertIn("get_current_view", content)

    def test_checked_in_projections_have_no_drift(self) -> None:
        self.assertEqual(projection_drift(PROJECT_ROOT), [])

    def test_product_authorities_do_not_restore_copy_prompt_onboarding(self) -> None:
        for name in ("GOAL.md", "AGENTS.md", "docs/product/current-product.md", "docs/product/entry-onboarding-and-dogfood.md"):
            with self.subTest(authority=name):
                source = (PROJECT_ROOT / name).read_text(encoding="utf-8")
                for old_step in ("→ copy one", "→ paste it into the local Agent", "→ 复制一条通用接入提示词"):
                    self.assertNotIn(old_step, source)
        source = (PROJECT_ROOT / "docs/product/current-product.md").read_text(encoding="utf-8")
        self.assertIn("built-in Agent remains capable", source)
        self.assertIn("exactly one", source.lower())

    def test_mcp_default_catalog_is_compact_and_internal_operations_fail_closed(self) -> None:
        from app.mcp_server import operation_catalog, operation_schema, offeru_operation
        from app.services.agent_skill_registry import agent_operation_names
        from app.ops import list_operations

        default = asyncio.run(operation_catalog())
        self.assertEqual(default["operations"], [])
        self.assertEqual(default["skill_registry"], _manifest()["skill_registry"])
        selected = asyncio.run(operation_catalog(skill="connection_bootstrap"))
        self.assertEqual([item["name"] for item in selected["operations"]], ["get_current_view"])
        internal = next(item["name"] for item in list_operations() if item["name"] not in agent_operation_names())
        self.assertFalse(asyncio.run(operation_schema(internal))["ok"])
        self.assertFalse(asyncio.run(offeru_operation(internal))["ok"])
        self.assertFalse(asyncio.run(operation_catalog(skill="missing_skill"))["ok"])


if __name__ == "__main__":
    unittest.main()
