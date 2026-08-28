from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = BACKEND_DIR.parent
PLUGIN_DIR = PROJECT_ROOT / "plugins" / "job-search"
CLI_PATH = PLUGIN_DIR / "bin" / "job-search-cli.py"


def _load_cli():
    spec = importlib.util.spec_from_file_location("offeru_job_search_cli_test", CLI_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load job-search CLI")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _row(slug: str, title: str, company: str, description: str) -> dict:
    return {
        "slug": slug,
        "title": title,
        "company_name": company,
        "description": description,
        "url": f"https://example.test/jobs/{slug}",
        "location": "Remote",
        "tags": ["Software", "AI"],
        "job_types": ["full-time"],
        "remote": True,
        "created_at": "2026-08-28T00:00:00+00:00",
    }


class JobSearchPluginTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.cli = _load_cli()

    def test_search_returns_runtime_candidate_contract_and_deduplicates(self) -> None:
        rows = [
            _row(
                "ai-pm-one",
                "Senior AI Product Manager",
                "Alpha AI",
                "Required: own AI agent workflow and model evaluation. Define developer workflow outcomes.",
            ),
            _row(
                "ai-pm-two",
                "AI Platform Product Manager",
                "Beta Labs",
                "Must build agent runtime products, model evaluation and product strategy for developers.",
            ),
            _row(
                "ai-pm-two",
                "AI Platform Product Manager",
                "Beta Labs",
                "Must build agent runtime products, model evaluation and product strategy for developers.",
            ),
        ]
        payload = {
            "target": {
                "title": "AI Product Manager",
                "company": "Target Co",
                "raw_description": "Required: build AI agent workflows and model evaluation for developers.",
            },
            "role_family": "product_manager",
            "specialization": "ai_agent",
            "seniority": "senior",
            "limit": 10,
            "page_limit": 1,
        }
        with patch.object(self.cli, "_request_page", return_value=rows):
            result = self.cli._search(payload)

        self.assertEqual(result["schema"], "offeru.role_benchmark_candidate.v1")
        self.assertEqual(result["source"], "arbeitnow")
        self.assertEqual(len(result["comparators"]), 2)
        self.assertEqual(result["sample"]["returned"], 2)
        self.assertFalse(result["sample"]["sufficient_for_role_benchmark"])
        self.assertEqual(
            set(result["target"]["role_profile"]),
            {
                "schema",
                "role_family",
                "specialization",
                "seniority",
                "domain",
                "responsibilities",
                "hard_skills",
                "business_capabilities",
                "behavioral_requirements",
                "domain_knowledge",
                "outcome_expectations",
                "constraints",
            },
        )
        self.assertTrue(result["comparators"][0]["source_ref"].startswith("arbeitnow:"))
        self.assertTrue(result["comparators"][0]["capability_observations"])

    def test_manifest_declares_real_read_only_capabilities(self) -> None:
        manifest = json.loads((PLUGIN_DIR / "offeru-plugin.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["schema"], "offeru.capability_plugin.v1")
        self.assertEqual(manifest["name"], "job-search")
        self.assertEqual(
            {item["name"] for item in manifest["capabilities"]},
            {"jobs.search", "jobs.get", "jobs.snapshot"},
        )
        for capability in manifest["capabilities"]:
            self.assertNotIn("external_write", capability["side_effects"])
            self.assertNotIn("irreversible", capability["side_effects"])
        self.assertEqual(manifest["permissions"]["externalWrite"], "deny")

    def test_plugin_install_discovery_skill_and_uninstall_lifecycle(self) -> None:
        if str(BACKEND_DIR) not in sys.path:
            sys.path.insert(0, str(BACKEND_DIR))
        from app.services import capability_plugins

        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "installed.json"
            before = capability_plugins.list_plugin_capabilities(
                root=PROJECT_ROOT / "plugins",
                state_path=state_path,
            )
            self.assertEqual(before["capabilities"], [])

            installed = capability_plugins.install_plugin(
                "job-search",
                root=PROJECT_ROOT / "plugins",
                state_path=state_path,
            )
            self.assertTrue(installed["installed"])
            discovered = capability_plugins.discover_plugins(
                root=PROJECT_ROOT / "plugins",
                state_path=state_path,
            )
            row = next(item for item in discovered["plugins"] if item["name"] == "job-search")
            self.assertEqual(row["status"], "installed")
            self.assertEqual(
                {item["name"] for item in capability_plugins.list_plugin_capabilities(
                    root=PROJECT_ROOT / "plugins",
                    state_path=state_path,
                )["capabilities"]},
                {"jobs.search", "jobs.get", "jobs.snapshot"},
            )
            skills = capability_plugins.plugin_skill_catalog(
                root=PROJECT_ROOT / "plugins",
                state_path=state_path,
            )
            self.assertEqual([skill.id for skill in skills], ["plugin_job_search_job_search"])

            removed = capability_plugins.uninstall_plugin("job-search", state_path=state_path)
            self.assertTrue(removed["uninstalled"])
            self.assertEqual(
                capability_plugins.list_plugin_capabilities(
                    root=PROJECT_ROOT / "plugins",
                    state_path=state_path,
                )["capabilities"],
                [],
            )

    def test_cli_contract_smoke_is_json_utf8_and_dry_run_is_non_executing(self) -> None:
        interpreter = sys.executable
        version = subprocess.run(
            [interpreter, str(CLI_PATH), "--version", "--json"],
            cwd=PLUGIN_DIR,
            capture_output=True,
            check=False,
        )
        self.assertEqual(version.returncode, 0, version.stderr.decode("utf-8", errors="replace"))
        version_payload = json.loads(version.stdout.decode("utf-8"))
        self.assertEqual(version_payload["name"], "job-search")

        dry_run = subprocess.run(
            [interpreter, str(CLI_PATH), "jobs.search", "--json", "--dry-run"],
            cwd=PLUGIN_DIR,
            capture_output=True,
            check=False,
        )
        self.assertEqual(dry_run.returncode, 0, dry_run.stderr.decode("utf-8", errors="replace"))
        dry_payload = json.loads(dry_run.stdout.decode("utf-8"))
        self.assertEqual(dry_payload["capability"], "jobs.search")
        self.assertFalse(dry_payload["executed"])


if __name__ == "__main__":
    unittest.main()
