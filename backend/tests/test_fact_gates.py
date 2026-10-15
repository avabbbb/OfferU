"""Core: resume fact gates (no mocks, no DB)."""
from __future__ import annotations

from pathlib import Path
import sys
import unittest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.services.resume_fact_gates import validate_resume_fact_gates


class ResumeFactGateTests(unittest.TestCase):
    def test_fact_gate_requires_provenance_and_rejects_new_claims(self) -> None:
        source = {
            "id": 7,
            "title": "Example Company",
            "content_json": {
                "normalized": {
                    "company": "Example Company",
                    "position": "Backend Engineer",
                    "description": "Built a Python service for internal workflows.",
                }
            },
        }
        rows = [
            {
                "section_type": "experience",
                "title": "工作经历",
                "content_json": [
                    {
                        "company": "Invented Company",
                        "position": "Backend Engineer",
                        "description": "Improved throughput by 80% [待量化].",
                    }
                ],
                "source_section_ids": [],
            }
        ]

        result = validate_resume_fact_gates(
            rows,
            [source],
            strict_structured_facts=True,
        )
        issues = {item["issue"] for item in result["warnings"]}

        self.assertEqual(result["status"], "blocked")
        self.assertTrue(result["requires_user_confirmation"])
        self.assertTrue(
            {
                "missing_provenance",
                "unverified_metric",
                "unverified_fact",
                "unverified_org",
                "unverified_placeholder",
            }.issubset(issues)
        )

    def test_fact_gate_flags_new_claims_in_description(self) -> None:
        source = {
            "id": 9,
            "title": "Example Company",
            "content_json": {
                "normalized": {
                    "company": "Example Company",
                    "position": "Backend Engineer",
                    "description": "Built a Python service for internal workflows.",
                }
            },
        }
        rows = [
            {
                "section_type": "experience",
                "title": "工作经历",
                "content_json": [
                    {
                        "company": "Example Company",
                        "position": "Backend Engineer",
                        "description": (
                            "Scaled Kubernetes platform at Google, "
                            "improved throughput by 80%."
                        ),
                    }
                ],
                "source_section_ids": [9],
            }
        ]

        result = validate_resume_fact_gates(
            rows,
            [source],
            strict_structured_facts=True,
        )
        issues = {item["issue"] for item in result["warnings"]}

        self.assertEqual(result["status"], "blocked")
        self.assertTrue(result["requires_user_confirmation"])
        self.assertIn("unverified_metric", issues)
        self.assertIn("unverified_named_claim", issues)
        self.assertIn("Kubernetes", result["unsupported_named_claims"])
        self.assertIn("Google", result["unsupported_named_claims"])

    def test_fact_gate_named_claim_only_flags_without_blocking(self) -> None:
        source = {
            "id": 9,
            "title": "Example Company",
            "content_json": {
                "normalized": {
                    "company": "Example Company",
                    "position": "Backend Engineer",
                    "description": "Built a Python service for internal workflows.",
                }
            },
        }
        rows = [
            {
                "section_type": "experience",
                "title": "工作经历",
                "content_json": [
                    {
                        "company": "Example Company",
                        "position": "Backend Engineer",
                        "description": "Built a Python service on Kubernetes.",
                    }
                ],
                "source_section_ids": [9],
            }
        ]

        result = validate_resume_fact_gates(
            rows,
            [source],
            strict_structured_facts=True,
        )

        self.assertEqual(result["status"], "passed")
        self.assertTrue(result["requires_user_confirmation"])
        self.assertIn("Kubernetes", result["unsupported_named_claims"])

    def test_fact_gate_grounded_description_passes_clean(self) -> None:
        source = {
            "id": 9,
            "title": "Example Company",
            "content_json": {
                "normalized": {
                    "company": "Example Company",
                    "position": "Backend Engineer",
                    "description": "Built a Python service for internal workflows.",
                }
            },
        }
        rows = [
            {
                "section_type": "experience",
                "title": "工作经历",
                "content_json": [
                    {
                        "company": "Example Company",
                        "position": "Backend Engineer",
                        "description": "Built a reliable Python service.",
                    }
                ],
                "source_section_ids": [9],
            }
        ]

        result = validate_resume_fact_gates(
            rows,
            [source],
            strict_structured_facts=True,
        )

        self.assertEqual(result["status"], "passed")
        self.assertFalse(result["requires_user_confirmation"])
        self.assertEqual(result["warnings"], [])


