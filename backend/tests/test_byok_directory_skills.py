from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import secrets
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.chdir(BACKEND_DIR)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.agents.llm import resolve_llm_client_config
from app.llm_config_store import (
    _sanitize_api_key,
    import_provider,
    resolve_api_key,
)
from app.services.agent_skill_registry import (
    catalog,
    registry_snapshot,
    resolve_skill,
)
from app.services.directory_skills import (
    DEFAULT_READONLY_TOOLS,
    SKILLS_ROOT,
    reload_directory_skills,
    scan_directory_skills,
)
from app.ops import list_operations


_RUN_SALT = secrets.token_hex(8)


def _uniq(label: str) -> str:
    return f"{label}-{_RUN_SALT}"


class EnvKeyReferenceTests(unittest.TestCase):
    def test_sanitize_keeps_env_reference(self) -> None:
        self.assertEqual(_sanitize_api_key("env:MY_LLM_KEY"), "env:MY_LLM_KEY")
        self.assertEqual(_sanitize_api_key("ENV:MY_LLM_KEY"), "ENV:MY_LLM_KEY")

    def test_resolve_api_key_reads_environment(self) -> None:
        with patch.dict(os.environ, {"OFFERU_TEST_LLM_KEY": "sk-test-123"}, clear=False):
            self.assertEqual(resolve_api_key("env:OFFERU_TEST_LLM_KEY"), "sk-test-123")
        self.assertEqual(resolve_api_key("env:MISSING_VAR_XYZ"), "")
        self.assertEqual(resolve_api_key("sk-literal-abc"), "sk-literal-abc")

    def test_resolve_api_key_falls_back_to_env_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env_file = Path(tmp) / ".env"
            env_file.write_text(
                "OFFERU_FILE_KEY=sk-from-file\n# 注释行\nEMPTY_VALUE=\n",
                encoding="utf-8",
            )
            with patch(
                "app.llm_config_store._ENV_FILE", env_file
            ), patch(
                "app.llm_config_store._ENV_FILE_VALUES", None
            ):
                self.assertEqual(resolve_api_key("env:OFFERU_FILE_KEY"), "sk-from-file")
                self.assertEqual(resolve_api_key("env:EMPTY_VALUE"), "")
                self.assertEqual(resolve_api_key("env:NOT_THERE"), "")

    def test_resolve_client_config_resolves_env_reference(self) -> None:
        settings = SimpleNamespace(
            llm_api_configs=[
                {
                    "id": "cfg-1",
                    "provider_id": "openai",
                    "service_name": "OpenAI",
                    "model": "gpt-4o-mini",
                    "base_url": "https://api.openai.com/v1",
                    "api_key": "env:OFFERU_TEST_LLM_KEY",
                    "api_format": "openai",
                    "supports_json_mode": True,
                    "default_headers": {},
                    "models": {},
                    "extra_params": {},
                }
            ],
            active_llm_config_id="cfg-1",
            active_llm_base_url="",
            active_llm_api_key="",
            llm_model="gpt-4o-mini",
            llm_provider="openai",
            disabled_llm_providers=[],
            tier_model_map={},
            ssl_verify=True,
            llm_timeout=60,
            ollama_base_url="http://localhost:11434",
        )
        with patch.dict(os.environ, {"OFFERU_TEST_LLM_KEY": "sk-from-env"}, clear=False):
            resolved = resolve_llm_client_config(settings)
        self.assertEqual(resolved["api_key"], "sk-from-env")
        self.assertEqual(resolved["source"], "active_config")


class DisabledProviderTests(unittest.TestCase):
    def test_disabled_active_provider_is_rejected(self) -> None:
        settings = SimpleNamespace(
            llm_api_configs=[
                {
                    "id": "cfg-1",
                    "provider_id": "deepseek",
                    "service_name": "DeepSeek",
                    "model": "deepseek-v4-flash",
                    "base_url": "https://api.deepseek.com",
                    "api_key": "sk-abc",
                    "api_format": "openai",
                    "supports_json_mode": True,
                    "default_headers": {},
                    "models": {},
                    "extra_params": {},
                }
            ],
            active_llm_config_id="cfg-1",
            active_llm_base_url="",
            active_llm_api_key="",
            llm_model="deepseek-v4-flash",
            llm_provider="deepseek",
            disabled_llm_providers=["deepseek"],
            tier_model_map={},
            ssl_verify=True,
            llm_timeout=60,
            ollama_base_url="http://localhost:11434",
        )
        with self.assertRaises(ValueError) as ctx:
            resolve_llm_client_config(settings)
        self.assertIn("已被禁用", str(ctx.exception))

    def test_import_provider_rejects_disabled_provider(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_file = Path(tmp) / "config.json"
            config_file.write_text(json.dumps({}), encoding="utf-8")
            with patch("app.llm_config_store._CONFIG_FILE", config_file), patch(
                "app.llm_config_store.get_settings",
                return_value=SimpleNamespace(disabled_llm_providers=["openai"]),
            ):
                result = import_provider(
                    provider_id="openai",
                    api_key="sk-test-123",
                    activate=True,
                )
        self.assertFalse(result["ok"])
        self.assertTrue(any("已被禁用" in item for item in result["errors"]))

    def test_import_provider_writes_env_reference(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_file = Path(tmp) / "config.json"
            config_file.write_text(json.dumps({}), encoding="utf-8")
            with patch("app.llm_config_store._CONFIG_FILE", config_file), patch(
                "app.llm_config_store.get_settings",
                return_value=SimpleNamespace(disabled_llm_providers=[]),
            ):
                result = import_provider(
                    provider_id="deepseek",
                    api_key="env:MY_DEEPSEEK_KEY",
                    activate=True,
                )
            stored = json.loads(config_file.read_text(encoding="utf-8"))
            configs = stored["llm_api_configs"]
        self.assertTrue(result["ok"])
        self.assertEqual(len(configs), 1)
        self.assertEqual(configs[0]["api_key"], "env:MY_DEEPSEEK_KEY")
        self.assertTrue(configs[0]["is_active"])


class DirectorySkillTests(unittest.TestCase):
    def _write_skill(self, root: Path, name: str, frontmatter: str) -> None:
        skill_dir = root / name
        skill_dir.mkdir(parents=True, exist_ok=True)
        (skill_dir / "SKILL.md").write_text(
            f"---\n{frontmatter}\n---\n\n技能正文。\n",
            encoding="utf-8",
        )

    def test_scan_registers_directory_skill_with_default_readonly_tools(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._write_skill(
                root,
                "jd-summary",
                "name: jd_summary\ndescription: 汇总 JD 要点并列出证据缺口\n",
            )
            with patch("app.services.directory_skills.SKILLS_ROOT", root):
                reload_directory_skills()
                skills = scan_directory_skills()
        self.assertEqual(len(skills), 1)
        skill = skills[0]
        self.assertEqual(skill.id, "jd_summary")
        self.assertEqual(skill.description, "汇总 JD 要点并列出证据缺口")
        self.assertEqual(set(skill.allowed_tools), set(DEFAULT_READONLY_TOOLS))

    def test_scan_honors_tools_and_aliases(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._write_skill(
                root,
                "pro-panel",
                "name: pro_panel\ndescription: 专业面板分析\ntools:\n  - get_profile\n  - list_jobs\naliases:\n  - /pro\nfeatured: true\n",
            )
            with patch("app.services.directory_skills.SKILLS_ROOT", root):
                reload_directory_skills()
                skills = scan_directory_skills()
        skill = skills[0]
        self.assertEqual(set(skill.allowed_tools), {"get_profile", "list_jobs"})
        self.assertIn("pro", skill.aliases)
        self.assertTrue(skill.featured)

    def test_scan_skips_skill_without_description(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._write_skill(root, "no-desc", "name: no_desc\n")
            with patch("app.services.directory_skills.SKILLS_ROOT", root):
                reload_directory_skills()
                skills = scan_directory_skills()
        self.assertEqual(skills, [])

    def test_resolve_skill_finds_directory_skill_after_builtin(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._write_skill(
                root,
                "custom_audit",
                "name: custom_audit\ndescription: 自定义审计流程\n",
            )
            with patch("app.services.directory_skills.SKILLS_ROOT", root):
                reload_directory_skills()
                skill = resolve_skill("custom_audit")
                builtin = resolve_skill("tracker")
        self.assertIsNotNone(skill)
        self.assertEqual(skill.id, "custom_audit")
        self.assertIsNotNone(builtin)

    def test_registry_snapshot_filters_unknown_tools_for_directory_skills(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._write_skill(
                root,
                "draft_skill",
                "name: draft_skill\ndescription: 草稿技能\ntools:\n  - get_profile\n  - not_a_real_operation\n",
            )
            with patch("app.services.directory_skills.SKILLS_ROOT", root):
                reload_directory_skills()
                snapshot = registry_snapshot(list_operations())
        draft = next(item for item in snapshot["skills"] if item["id"] == "draft_skill")
        self.assertEqual(draft["allowed_tools"], ["get_profile"])
        self.assertNotIn("not_a_real_operation", draft["allowed_tools"])

    def test_catalog_includes_directory_skills(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._write_skill(
                root,
                "extra_skill",
                "name: extra_skill\ndescription: 额外技能\n",
            )
            with patch("app.services.directory_skills.SKILLS_ROOT", root):
                reload_directory_skills()
                names = {item["id"] for item in catalog()}
        self.assertIn("extra_skill", names)
        self.assertIn("tracker", names)


if __name__ == "__main__":
    unittest.main()
