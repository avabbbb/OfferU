from __future__ import annotations

import asyncio
import os
from pathlib import Path
import sys
import unittest
from typing import Any
from unittest.mock import AsyncMock, patch


BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = BACKEND_DIR.parent
os.chdir(BACKEND_DIR)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.cli import _manifest
from app.services.agent_skill_projections import projection_drift, render_skill_projections
from app.services.agent_skill_registry import (
    SkillRoutingError,
    resolve_run_skill,
    resolve_skill,
    resolve_slash_skill,
)


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
        self.assertEqual(cli_contract["bootstrap_operations"], ["get_current_view"])

    def test_slash_commands_resolve_through_the_registry(self) -> None:
        self.assertEqual(resolve_skill("/offeru").id, "discovery")
        self.assertEqual(resolve_skill("/scan").id, "scan_jobs")
        self.assertIsNone(resolve_skill("auto"))
        self.assertEqual(resolve_slash_skill("/scan 今天的岗位").id, "scan_jobs")
        self.assertIsNone(resolve_slash_skill("请扫描今天的岗位"))

        async def run() -> None:
            selected, routing = await resolve_run_skill("/scan 今天的岗位", "auto")
            self.assertEqual(selected.id, "scan_jobs")
            self.assertEqual(routing.via, "slash")
            self.assertEqual(routing.provenance()["requested"], "/scan")
            with self.assertRaisesRegex(ValueError, "未知技能"):
                await resolve_run_skill("/does-not-exist", "auto")
            with self.assertRaisesRegex(ValueError, "未知技能"):
                await resolve_run_skill("随便说说", "missing_skill")

        with patch("app.agents.llm.chat_completion", new=AsyncMock()) as router:
            asyncio.run(run())
        # Declared Skills never reach the model router.
        router.assert_not_awaited()

    def test_auto_skill_id_routes_through_one_bounded_model_call(self) -> None:
        async def run() -> None:
            selected, routing = await resolve_run_skill("读取我的岗位列表", "auto")
            self.assertEqual(selected.id, "evaluate_job")
            self.assertEqual(routing.via, "auto")
            self.assertEqual(routing.provenance()["requested"], "auto")
            self.assertTrue(routing.provenance()["reason"])

        with patch(
            "app.agents.llm.chat_completion",
            new=AsyncMock(return_value='{"skill_id":"evaluate_job","reason":"jobs"}'),
        ) as router:
            asyncio.run(run())
        router.assert_awaited_once()
        kwargs = router.await_args.kwargs
        # The router reuses the canonical configured provider/model; no tier
        # override may silently switch to a different model.
        self.assertNotIn("tier", kwargs)
        self.assertTrue(kwargs.get("json_mode"))
        catalog_text = kwargs["messages"][0]["content"]
        self.assertIn('"evaluate_job"', catalog_text)
        self.assertNotIn('"connection_bootstrap"', catalog_text)
        self.assertNotIn('"connection_probe"', catalog_text)
        self.assertNotIn('"career_director"', catalog_text)

    def test_auto_router_masks_pii_and_bounds_context(self) -> None:
        context = [
            {"role": "user", "content": "我的电话是 13800138000，邮箱 a@b.com"},
            {"role": "assistant", "content": "收到"},
        ] * 10

        async def run() -> None:
            await resolve_run_skill(
                "读取我的岗位列表",
                "auto",
                context_messages=context,
            )

        with patch(
            "app.agents.llm.chat_completion",
            new=AsyncMock(return_value='{"skill_id":"evaluate_job","reason":"ok"}'),
        ) as router:
            asyncio.run(run())
        payload = router.await_args.kwargs["messages"][1]["content"]
        self.assertNotIn("13800138000", payload)
        self.assertNotIn("a@b.com", payload)
        self.assertLessEqual(len(payload), 8000)

    def test_auto_router_failures_are_visible_and_fail_closed(self) -> None:
        async def expect_routing_error(**router_state: Any) -> str:
            router = AsyncMock(**router_state)
            with patch("app.agents.llm.chat_completion", new=router):
                try:
                    await resolve_run_skill("读取我的岗位列表", "auto")
                except SkillRoutingError as exc:
                    return str(exc)
            raise AssertionError("auto routing must fail visibly")

        self.assertIn("无响应", asyncio.run(expect_routing_error(return_value=None)))
        self.assertIn("无效技能", asyncio.run(expect_routing_error(return_value='{"skill_id":"career_director"}')))
        self.assertIn("无效技能", asyncio.run(expect_routing_error(return_value='{"skill_id":"connection_bootstrap"}')))
        self.assertIn("无效技能", asyncio.run(expect_routing_error(return_value='{"skill_id":"not_a_skill"}')))
        self.assertIn("无效技能", asyncio.run(expect_routing_error(return_value="not json at all")))
        self.assertIn("失败", asyncio.run(expect_routing_error(side_effect=ValueError("LLM API Key 未配置"))))

    def test_evaluate_job_can_propose_single_jd_import(self) -> None:
        from app.ops import OPERATIONS

        skill = resolve_skill("evaluate_job")
        assert skill is not None
        self.assertIn("import_jd", skill.allowed_tools)
        # JD import stays a proposal: the Operation remains a mutation that the
        # confirmation boundary (not routing) authorizes.
        self.assertTrue(OPERATIONS["import_jd"].is_mutation)
        self.assertTrue(OPERATIONS["import_jd"].requires_confirmation)

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
        for name in ("AGENTS.md", "docs/README.md", "docs/01-overall-design.md", "docs/08-module-agent-runtime.md"):
            with self.subTest(authority=name):
                source = (PROJECT_ROOT / name).read_text(encoding="utf-8")
                for old_step in ("→ copy one", "→ paste it into the local Agent", "→ 复制一条通用接入提示词"):
                    self.assertNotIn(old_step, source)
        source = (PROJECT_ROOT / "docs/01-overall-design.md").read_text(encoding="utf-8")
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
