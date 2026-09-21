from __future__ import annotations

import asyncio
import unittest

from app.ops import get_operation_schema
from app.services.application_action_registry import (
    ApplicationActionConnectorRegistry,
    application_action_connector_registry,
)
from app.services.application_actions import (
    ApplicationActionCapabilities,
    ApplicationActionPreview,
    ApplicationActionRequest,
)


class _StubConnector:
    """Minimal write-plane connector used only to exercise the registry."""

    source_id = "stub_platform"

    async def status(self):
        return "EXPERIMENTAL"

    async def capabilities(self):
        return ApplicationActionCapabilities(greet=True, send_message=True)

    async def preview(self, request: ApplicationActionRequest) -> ApplicationActionPreview:  # pragma: no cover
        raise NotImplementedError

    async def execute(self, request: ApplicationActionRequest, *, idempotency_key: str):  # pragma: no cover
        raise NotImplementedError


class _BrokenConnector:
    source_id = "broken_platform"

    async def status(self):
        raise RuntimeError("driver exploded")

    async def capabilities(self):  # pragma: no cover
        raise RuntimeError("driver exploded")

    async def preview(self, request):  # pragma: no cover
        raise NotImplementedError

    async def execute(self, request, *, idempotency_key):  # pragma: no cover
        raise NotImplementedError


class ApplicationActionConnectorRegistryTests(unittest.TestCase):
    def test_register_unregister_and_lookup(self) -> None:
        reg = ApplicationActionConnectorRegistry()
        conn = _StubConnector()
        reg.register(conn)
        self.assertIs(reg.get("stub_platform"), conn)
        self.assertIn(conn, reg.connectors())
        reg.unregister("stub_platform")
        self.assertIsNone(reg.get("stub_platform"))

    def test_capability_matrix_marks_connector_not_executable(self) -> None:
        reg = ApplicationActionConnectorRegistry()
        reg.register(_StubConnector())
        matrix = asyncio.run(reg.capability_matrix())

        self.assertEqual(matrix["schema"], "offeru.application_action_capability_matrix.v1")
        self.assertFalse(matrix["execution_available"])
        row = matrix["connectors"][0]
        self.assertEqual(row["source_id"], "stub_platform")
        self.assertEqual(row["status"], "EXPERIMENTAL")
        self.assertTrue(row["capabilities"]["greet"])
        self.assertTrue(row["capabilities"]["send_message"])
        self.assertFalse(row["capabilities"]["send_resume"])
        # Phase 1: a connector may declare a capability but never be executable.
        self.assertFalse(row["execution_available"])

    def test_capability_matrix_surfaces_connector_error_not_silent(self) -> None:
        reg = ApplicationActionConnectorRegistry()
        reg.register(_BrokenConnector())
        matrix = asyncio.run(reg.capability_matrix())
        row = matrix["connectors"][0]
        self.assertEqual(row["status"], "UNAVAILABLE")
        self.assertIn("driver exploded", row["error"])
        self.assertFalse(row["execution_available"])

    def test_empty_registry_reports_no_write_path(self) -> None:
        reg = ApplicationActionConnectorRegistry()
        matrix = asyncio.run(reg.capability_matrix())
        self.assertEqual(matrix["connectors"], [])
        self.assertFalse(matrix["execution_available"])

    def tearDown(self) -> None:  # ensure singleton not polluted between tests
        for c in list(application_action_connector_registry.connectors()):
            application_action_connector_registry.unregister(c.source_id)


class ListConnectorsOperationTests(unittest.TestCase):
    def test_operation_is_read_only_and_registered(self) -> None:
        schema = get_operation_schema("list_application_action_connectors")
        self.assertIsNotNone(schema)
        assert schema is not None
        self.assertEqual(schema["side_effects"], ["read"])
        self.assertFalse(schema["requires_confirmation"])

    def test_operation_exposed_to_application_assistant(self) -> None:
        from app.services.agent_skill_registry import resolve_skill

        skill = resolve_skill("application_assistant")
        self.assertIsNotNone(skill)
        assert skill is not None
        self.assertIn("list_application_action_connectors", skill.allowed_tools)


if __name__ == "__main__":
    unittest.main()
