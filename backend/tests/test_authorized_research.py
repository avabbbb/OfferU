from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace
import sys
import unittest


BACKEND_DIR = Path(__file__).resolve().parents[1]
os.chdir(BACKEND_DIR)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.ops import OPERATIONS
from app.services.agent_skill_registry import resolve_skill
from app.services.authorized_research import (
    _PLATFORMS,
    _combined_payload,
    _platform_url,
    _redact_personal_identifiers,
)
from app.services.job_research import _validated_research_result

READ_OPERATIONS = frozenset(
    name for name, operation in OPERATIONS.items()
    if not operation.is_mutation
)
MUTATION_OPERATIONS = frozenset(
    name for name, operation in OPERATIONS.items()
    if operation.is_mutation
)


def _base_result() -> dict:
    return {
        "sources": [
            {
                "source_ref": "S1",
                "dossier_scope": "company",
                "url": "https://company.example/about",
                "title": "About",
                "publisher": "Example Company",
                "source_class": "official_company",
                "published_at": "2026-07-01",
                "excerpt": "The official page describes the business.",
            },
            {
                "source_ref": "S2",
                "dossier_scope": "role",
                "url": "https://interview.example/role",
                "title": "Interview account",
                "publisher": "Interview Example",
                "source_class": "public_interview",
                "published_at": "2026-07-02",
                "excerpt": "One public account mentions a case round.",
            },
        ],
        "findings": [
            {
                "dossier_scope": "company",
                "finding_type": "company_business",
                "statement": "The company identifies this as a business line.",
                "details": {
                    "pattern": "",
                    "applicable_when": "",
                    "constraints": [],
                },
                "source_refs": ["S1"],
                "evidence_level": "cited",
            },
            {
                "dossier_scope": "role",
                "finding_type": "interview_process",
                "statement": "One source mentions a case round.",
                "details": {
                    "pattern": "",
                    "applicable_when": "",
                    "constraints": [],
                },
                "source_refs": ["S2"],
                "evidence_level": "single_signal",
            },
        ],
        "gaps": [],
    }


def _capture(
    capture_id: str,
    *,
    url: str,
    source_class: str = "public_interview",
) -> SimpleNamespace:
    return SimpleNamespace(
        capture_id=capture_id,
        dossier_scope="role",
        url=url,
        title="Selected evidence",
        publisher="User-authorized platform",
        source_class=source_class,
        published_at="2026-07-20",
        excerpt="The selected excerpt independently mentions a case round.",
    )


class AuthorizedResearchBoundaryTests(unittest.TestCase):
    def test_only_named_https_platform_domains_are_allowed(self) -> None:
        platform, safe_url = _platform_url(
            "niuke",
            "https://www.nowcoder.com/discuss/123?token=secret#reply",
        )

        self.assertEqual(platform, "niuke")
        self.assertEqual(safe_url, "https://www.nowcoder.com/discuss/123")
        with self.assertRaises(ValueError):
            _platform_url("niuke", "http://www.nowcoder.com/discuss/123")
        with self.assertRaises(ValueError):
            _platform_url("niuke", "https://example.com/discuss/123")

    def test_logged_in_platforms_cannot_claim_official_source_classes(self) -> None:
        for metadata in _PLATFORMS.values():
            self.assertFalse(
                any(
                    source_class.startswith("official_")
                    for source_class in metadata["source_classes"]
                )
            )

    def test_selected_excerpt_redacts_common_direct_identifiers(self) -> None:
        redacted = _redact_personal_identifiers(
            "Contact candidate@example.com or +86 13812345678"
        )

        self.assertNotIn("candidate@example.com", redacted)
        self.assertNotIn("13812345678", redacted)

    def test_combined_finding_can_corroborate_base_and_authorized_sources(self) -> None:
        payload = _combined_payload(
            base=_base_result(),
            captures=[
                _capture(
                    "capture_xhs",
                    url="https://www.xiaohongshu.com/explore/abc",
                )
            ],
            findings=[
                {
                    "dossier_scope": "role",
                    "finding_type": "interview_process",
                    "statement": "Independent sources mention a case round.",
                    "details": {
                        "pattern": "",
                        "applicable_when": "",
                        "constraints": [],
                    },
                    "capture_ids": ["capture_xhs"],
                    "base_source_refs": ["S2"],
                }
            ],
            gaps=[],
        )

        result = _validated_research_result(payload)
        self.assertEqual(
            result["findings"][-1]["evidence_level"],
            "corroborated",
        )

    def test_community_capture_cannot_become_a_verified_hard_fact(self) -> None:
        # 社区来源（脉脉）可以支撑一条结论，但不能被当作官方验证的硬事实：
        # 无官方来源时降级为 single_signal，研究仍可完成（证据不足是可解释退出状态）。
        payload = _combined_payload(
            base={"sources": [], "findings": [], "gaps": []},
            captures=[
                _capture(
                    "capture_maimai",
                    url="https://maimai.cn/article/abc",
                    source_class="public_community",
                )
            ],
            findings=[
                {
                    "dossier_scope": "role",
                    "finding_type": "role_requirement",
                    "statement": "The role requires an unverified skill.",
                    "details": {
                        "pattern": "",
                        "applicable_when": "",
                        "constraints": [],
                    },
                    "capture_ids": ["capture_maimai"],
                    "base_source_refs": [],
                }
            ],
            gaps=[],
        )

        result = _validated_research_result(payload)
        hard = [
            item
            for item in result["findings"]
            if item["finding_type"] == "role_requirement"
        ]
        self.assertTrue(hard)
        self.assertEqual(hard[0]["evidence_level"], "single_signal",
                         "社区来源的硬事实应降级为 single_signal，而非官方验证结论")

    def test_resume_capture_stores_expression_pattern_not_candidate_resume(self) -> None:
        payload = _combined_payload(
            base={"sources": [], "findings": [], "gaps": []},
            captures=[
                _capture(
                    "capture_resume",
                    url="https://www.nowcoder.com/discuss/resume",
                    source_class="public_resume_guidance",
                )
            ],
            findings=[
                {
                    "dossier_scope": "role",
                    "finding_type": "resume_pattern",
                    "statement": "Use a decision-action-outcome pattern.",
                    "details": {
                        "pattern": "Decision + action + verified outcome",
                        "applicable_when": "Every clause maps to the user's evidence.",
                        "constraints": ["Never copy another candidate's metric."],
                    },
                    "capture_ids": ["capture_resume"],
                    "base_source_refs": [],
                }
            ],
            gaps=[],
        )

        result = _validated_research_result(payload)
        self.assertEqual(result["findings"][0]["finding_type"], "resume_pattern")


class AuthorizedResearchContractTests(unittest.TestCase):
    def test_operations_share_registry_and_confirmation_contract(self) -> None:
        reads = {
            "list_authorized_research_sessions",
            "get_authorized_research_session",
        }
        mutations = {
            "start_authorized_research_session",
            "activate_authorized_research_read_only",
            "capture_authorized_research_page",
            "complete_authorized_research_session",
            "cancel_authorized_research_session",
        }

        self.assertTrue(reads.issubset(READ_OPERATIONS))
        self.assertTrue(mutations.issubset(MUTATION_OPERATIONS))
        self.assertTrue((reads | mutations).issubset(OPERATIONS))
        self.assertTrue((reads | mutations).issubset(OPERATIONS))
        self.assertTrue(
            OPERATIONS[
                "capture_authorized_research_page"
            ].audit_redacted_parameters
        )

    def test_company_research_skill_exposes_authorized_flow(self) -> None:
        skill = resolve_skill("company_research")

        self.assertIsNotNone(skill)
        self.assertIn(
            "complete_authorized_research_session",
            skill.allowed_tools,
        )
        self.assertIn("get_job_research", skill.allowed_tools)


if __name__ == "__main__":
    unittest.main()
