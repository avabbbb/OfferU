"""Host registry + Host×Skill capability matrix contract tests (Phase B).

Verifies the Agent Host Integration / Hosted Runtime separation stays coherent:
every hosted-runtime reference resolves, skill-host capabilities are declared
not branched, and unsupported skills never project as full support.
"""

from __future__ import annotations

import unittest

from app.services.agent_host_registry import (
    SUPPORT_FULL,
    SUPPORT_LIMITED,
    SUPPORT_UNSUPPORTED,
    beginner_host_ids,
    get_host,
    host_capability_matrix,
    hosted_runtime_ids,
    list_hosts,
    recommended_host_id,
    skill_host_ids,
)
from app.services.coding_agent_runtime import RUNTIME_DEFINITIONS


class AgentHostRegistryTests(unittest.TestCase):
    def test_host_ids_are_unique(self) -> None:
        ids = [host.id for host in list_hosts()]
        self.assertEqual(len(ids), len(set(ids)), f"duplicate host ids: {ids}")

    def test_every_runtime_reference_resolves(self) -> None:
        for host in list_hosts():
            if host.runtime_id is None:
                continue
            self.assertIn(
                host.runtime_id,
                RUNTIME_DEFINITIONS,
                f"host {host.id} references unknown runtime {host.runtime_id}",
            )

    def test_runtime_backed_hosts_cover_runtime_definitions(self) -> None:
        # Every RUNTIME_DEFINITIONS executor should be reachable through a host
        # declaration so the UI/agent layer has one seam, not two parallel
        # provider tables.
        mapped = set(hosted_runtime_ids())
        for runtime_id in RUNTIME_DEFINITIONS:
            self.assertIn(
                runtime_id,
                mapped,
                f"runtime {runtime_id} has no host declaration",
            )

    def test_skill_host_and_runtime_kinds_are_disjoint_concepts(self) -> None:
        # A host that only runs hosted (pi/omp/gemini/codebuddy) must not claim
        # a skill-install surface — that is the conflation this registry fixes.
        for host in list_hosts():
            if host.can_install_skill:
                self.assertIn(
                    host.kind,
                    ("skill_host", "both"),
                    f"{host.id} installs skill but kind={host.kind}",
                )

    def test_beginner_and_recommended_are_consistent(self) -> None:
        rec = recommended_host_id()
        self.assertIsNotNone(rec)
        self.assertIn(rec, beginner_host_ids())
        self.assertTrue(get_host(rec).recommended)
        # Exactly one recommended host for the zero-friction path.
        self.assertEqual(
            sum(1 for h in list_hosts() if h.recommended), 1
        )

    def test_unsupported_skill_never_projects_as_full(self) -> None:
        matrix = host_capability_matrix(
            ["application_assistant", "role_intelligence", "company_research"]
        )
        for host_id, support in matrix.items():
            self.assertIn(host_id, {h.id for h in list_hosts()})
            for tier in support.values():
                self.assertIn(tier, (SUPPORT_FULL, SUPPORT_LIMITED, SUPPORT_UNSUPPORTED))
        # WorkBuddy / hosted-only executors cannot browser-autofill.
        self.assertEqual(
            matrix["codebuddy"]["application_assistant"], SUPPORT_UNSUPPORTED
        )
        # OpenCode has no controlled public-web adapter → research is limited.
        self.assertEqual(
            matrix["opencode"]["role_intelligence"], SUPPORT_LIMITED
        )

    def test_skill_host_ids_are_install_capable(self) -> None:
        for host_id in skill_host_ids():
            host = get_host(host_id)
            self.assertTrue(host.can_install_skill or host.kind == "both")


if __name__ == "__main__":
    unittest.main()
