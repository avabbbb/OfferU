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
            self.assertIn("python -m app.cli manifest --pretty", content)
            self.assertIn("python -m app.cli manifest --skill <skill-id> --pretty", content)
            self.assertIn("career Skills", content)
            self.assertNotIn("python -m app.cli confirm", content)
            self.assertNotIn("agent_playbook --arg detail=full", content)
            self.assertNotIn("python -m app.cli api ", content)
            self.assertNotIn("python -m app.cli routes", content)
            self.assertNotIn("http://localhost:8000/api", content)
        for path, content in rendered.items():
            if path.name == "SKILL.md":
                self.assertIn("get_agent_connection_nonce", content)

    def test_checked_in_projections_have_no_drift(self) -> None:
        self.assertEqual(projection_drift(PROJECT_ROOT), [])


if __name__ == "__main__":
    unittest.main()
