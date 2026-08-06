from __future__ import annotations

import os
from pathlib import Path
import sys
import unittest
from pydantic import ValidationError

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.chdir(BACKEND_DIR)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.ops import CreateMemoryProposalInput, SaveCareerArtifactInput
from app.services.resume_fact_gates import validate_generated_content


class EchoSourceGateTests(unittest.TestCase):
    def test_echo_source_is_blocked(self) -> None:
        result = validate_generated_content(
            "我在字节跳动做过 3 年算法工程师，负责抖音推荐系统。",
            {"bullet": "在字节跳动做过 3 年算法工程师，负责抖音推荐系统。"},
        )
        self.assertEqual(result["status"], "blocked")
        self.assertTrue(any(w["issue"] == "echo_source" for w in result["warnings"]))

    def test_real_source_with_context_passes(self) -> None:
        result = validate_generated_content(
            "2022-2025 字节跳动推荐算法组：负责抖音推荐系统 CTR 预估模型，"
            "主导多模态特征融合项目，CTR 提升 5%。",
            {"bullet": "在字节跳动负责推荐系统 CTR 预估模型，主导多模态特征融合项目"},
        )
        self.assertEqual(result["status"], "passed")

    def test_claim_outside_source_still_blocked(self) -> None:
        result = validate_generated_content(
            "在某公司负责后端服务开发。",
            {"bullet": "在字节跳动负责抖音推荐系统，CTR 提升 5%"},
        )
        self.assertEqual(result["status"], "blocked")
        issues = {w["issue"] for w in result["warnings"]}
        self.assertTrue(issues.intersection({"unverified_fact", "unverified_metric"}))


class DryRunInputModelTests(unittest.TestCase):
    def test_invalid_custom_section_type_blocked_at_input_model(self) -> None:
        with self.assertRaises(ValidationError):
            CreateMemoryProposalInput(
                observation_id=1,
                target_tier="preference",
                section_type="c_preference",
                title="x",
                after={"bullet": "x"},
                reason="r",
            )

    def test_valid_custom_section_type_accepted(self) -> None:
        model = CreateMemoryProposalInput(
            observation_id=1,
            target_tier="preference",
            section_type="custom:c_preference",
            title="x",
            after={"bullet": "x"},
            reason="r",
        )
        self.assertEqual(model.section_type, "custom:c_preference")

    def test_invalid_artifact_type_blocked_at_input_model(self) -> None:
        with self.assertRaises(ValidationError):
            SaveCareerArtifactInput(
                artifact_type="project_experience",
                title="x",
                content_markdown="m",
            )

    def test_valid_artifact_type_accepted(self) -> None:
        model = SaveCareerArtifactInput(
            artifact_type="job_evaluation",
            title="x",
            content_markdown="m",
        )
        self.assertEqual(model.artifact_type, "job_evaluation")


if __name__ == "__main__":
    unittest.main()
