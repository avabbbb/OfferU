from __future__ import annotations

import inspect
import unittest

from app.cli import _manifest, _select_operations
from app.ops import OPERATIONS
from app.routes.applications import generate
from app.services.agent_skill_registry import agent_operation_names


class AgentToolSurfaceTests(unittest.TestCase):
    def test_operation_registry_is_not_the_agent_tool_catalog(self) -> None:
        agent_tools = agent_operation_names()
        featured_tools = agent_operation_names(featured_only=True)

        self.assertTrue(agent_tools)
        self.assertTrue(featured_tools)
        self.assertTrue(featured_tools.issubset(agent_tools))
        self.assertTrue(agent_tools.issubset(OPERATIONS))
        self.assertLess(len(agent_tools), len(OPERATIONS))

    def test_group_discovery_hides_internal_and_legacy_operations(self) -> None:
        rows, selector = _select_operations(group="applications")
        names = {str(row.get("name") or "") for row in rows}

        self.assertEqual(selector, "group:applications")
        self.assertIn("list_applications", names)
        self.assertIn("preview_application_action", names)
        self.assertNotIn("create_application_table", names)
        self.assertNotIn("create_legacy_application", names)
        self.assertNotIn("update_legacy_application", names)

    def test_explicit_all_remains_the_registry_audit_escape_hatch(self) -> None:
        rows, selector = _select_operations(all_operations=True)
        names = {str(row.get("name") or "") for row in rows}

        self.assertEqual(selector, "all")
        self.assertIn("create_application_table", names)
        self.assertIn("create_legacy_application", names)
        self.assertEqual(names, set(OPERATIONS))

    def test_manifest_reports_registry_and_agent_counts_separately(self) -> None:
        payload = _manifest()

        self.assertEqual(payload["operation_registry_count"], len(OPERATIONS))
        self.assertEqual(payload["agent_tool_count"], len(agent_operation_names()))
        self.assertEqual(
            payload["featured_tool_count"],
            len(agent_operation_names(featured_only=True)),
        )
        self.assertEqual(
            payload["internal_operation_count"],
            len(OPERATIONS) - len(agent_operation_names()),
        )
        self.assertEqual(payload["returned_count"], 0)

    def test_resume_group_excludes_route_level_crud(self) -> None:
        payload = _manifest(group="resume")
        names = {str(row.get("name") or "") for row in payload["operations"]}

        self.assertIn("prepare_resume_optimization", names)
        self.assertIn("export_resume_pdf", names)
        self.assertNotIn("create_resume_template", names)
        self.assertNotIn("create_resume_section", names)
        self.assertNotIn("save_resume_draft_record", names)

    def test_dead_and_duplicate_registry_entries_are_removed(self) -> None:
        self.assertNotIn("get_agent_provider_health", OPERATIONS)
        self.assertNotIn("get_synthetic_email_test_data_status", OPERATIONS)
        self.assertNotIn("generate_legacy_cover_letter", OPERATIONS)

    def test_legacy_http_cover_letter_route_uses_canonical_operation(self) -> None:
        source = inspect.getsource(generate)
        self.assertIn('"generate_cover_letter"', source)
        self.assertNotIn("generate_legacy_cover_letter", source)


if __name__ == "__main__":
    unittest.main()
