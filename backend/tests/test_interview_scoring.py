from __future__ import annotations

import os
from pathlib import Path
import sys
import unittest


BACKEND_DIR = Path(__file__).resolve().parents[1]
os.chdir(BACKEND_DIR)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.ops import OPERATIONS
from app.services.agent_skill_registry import resolve_skill
from app.services.interview_scoring import (
    _default_definition,
    build_behavior_summary,
    validate_behavior_events,
    validate_content_evaluation,
    validate_scoring_skill_definition,
)

READ_OPERATIONS = frozenset(
    name for name, operation in OPERATIONS.items()
    if not operation.is_mutation
)
MUTATION_OPERATIONS = frozenset(
    name for name, operation in OPERATIONS.items()
    if operation.is_mutation
)


ANSWER = "我先梳理约束，再选择最小方案，并用两周数据验证结果。"


def _evaluation() -> dict:
    return {
        "dimensions": {
            "relevance": {
                "score": 80,
                "evidence": ["我先梳理约束"],
                "missing_evidence": False,
                "not_applicable": False,
                "strength": "直接回应解决路径。",
                "improvement": "",
            },
            "evidence_specificity": {
                "score": 60,
                "evidence": ["用两周数据验证结果"],
                "missing_evidence": False,
                "not_applicable": False,
                "strength": "提供了验证窗口。",
                "improvement": "补充数据指标。",
            },
            "reasoning_structure": {
                "score": 70,
                "evidence": ["先梳理约束，再选择最小方案"],
                "missing_evidence": False,
                "not_applicable": False,
                "strength": "顺序清楚。",
                "improvement": "",
            },
            "reflection_tradeoffs": {
                "score": 0,
                "evidence": [],
                "missing_evidence": False,
                "not_applicable": True,
                "strength": "",
                "improvement": "",
            },
        },
        "strengths": ["有明确的行动顺序。"],
        "improvements": ["补充验证指标和实际结果。"],
        "suggestion": "下次把约束、指标和结果说得更具体。",
    }


def _behavior_event() -> dict:
    return {
        "event_id": "event-1",
        "event_type": "forward_lean",
        "started_ms": 1000,
        "ended_ms": 2600,
        "occurrence_count": 1,
        "confidence": 0.82,
        "detector_id": "mediapipe-tasks-vision",
        "detector_version": "0.10.35",
        "metadata": {"question_index": 0},
    }


class InterviewScoringBoundaryTests(unittest.TestCase):
    def test_default_skill_is_content_only_and_weights_sum_to_one(self) -> None:
        definition = _default_definition()

        self.assertEqual(definition["scope"], "content_only")
        self.assertAlmostEqual(
            sum(item["weight"] for item in definition["dimensions"]),
            1.0,
        )
        self.assertIn("combined_score", definition["prohibited_outputs"])
        self.assertTrue(
            all(item["evidence_required"] for item in definition["dimensions"])
        )

    def test_delivery_dimension_and_removed_system_prohibition_are_rejected(self) -> None:
        delivery = _default_definition()
        delivery["dimensions"][0]["key"] = "eye_contact"
        with self.assertRaises(ValueError):
            validate_scoring_skill_definition(delivery)

        weakened = _default_definition()
        weakened["prohibited_outputs"].remove("hiring_probability")
        with self.assertRaises(ValueError):
            validate_scoring_skill_definition(weakened)

    def test_server_aggregates_score_and_ignores_not_applicable_weight(self) -> None:
        result = validate_content_evaluation(
            _evaluation(),
            answer=ANSWER,
            definition=_default_definition(),
        )

        self.assertEqual(result["content_score"], 70.6)
        self.assertEqual(result["score_band"], "基本有效")
        self.assertNotIn("combined_score", result)
        self.assertNotIn("delivery_score", result)

    def test_evidence_must_be_verbatim_and_missing_evidence_caps_score(self) -> None:
        invented = _evaluation()
        invented["dimensions"]["relevance"]["evidence"] = ["回答里没有这句话"]
        with self.assertRaises(ValueError):
            validate_content_evaluation(
                invented,
                answer=ANSWER,
                definition=_default_definition(),
            )

        unsupported = _evaluation()
        unsupported["dimensions"]["relevance"].update(
            {
                "score": 80,
                "evidence": [],
                "missing_evidence": True,
            }
        )
        with self.assertRaises(ValueError):
            validate_content_evaluation(
                unsupported,
                answer=ANSWER,
                definition=_default_definition(),
            )

    def test_behavior_schema_rejects_raw_payload_and_has_no_score(self) -> None:
        raw = _behavior_event()
        raw["frame_data"] = "data:image/jpeg;base64,..."
        with self.assertRaises(ValueError):
            validate_behavior_events([raw])

        validated = validate_behavior_events([_behavior_event()])
        summary = build_behavior_summary(validated)
        self.assertEqual(summary["event_counts"]["forward_lean"], 1)
        self.assertEqual(summary["duration_ms_by_type"]["forward_lean"], 1600)
        self.assertNotIn("score", summary)
        self.assertNotIn("personality", summary)
        self.assertFalse(summary["privacy"]["raw_video_stored"])


class InterviewOperationContractTests(unittest.TestCase):
    def test_ai_interview_uses_one_registry_and_confirmation_boundary(self) -> None:
        reads = {
            "get_ai_interview_runtime",
            "list_interview_scoring_skills",
            "get_interview_scoring_skill",
            "list_ai_interviews",
            "get_ai_interview",
        }
        mutations = {
            "create_interview_scoring_skill",
            "create_ai_interview",
            "submit_ai_interview_answer",
            "ingest_interview_behavior_events",
            "restart_ai_interview",
            "delete_ai_interview",
        }

        self.assertTrue(reads.issubset(READ_OPERATIONS))
        self.assertTrue(mutations.issubset(MUTATION_OPERATIONS))
        self.assertTrue((reads | mutations).issubset(OPERATIONS))
        self.assertTrue((reads | mutations).issubset(OPERATIONS))
        self.assertIn(
            "model:interview_transcript",
            OPERATIONS["submit_ai_interview_answer"].permissions,
        )
        self.assertIn(
            "camera:derived_events",
            OPERATIONS["ingest_interview_behavior_events"].permissions,
        )
        self.assertIn(
            "content",
            OPERATIONS["submit_ai_interview_answer"].audit_redacted_parameters,
        )
        self.assertIn(
            "events",
            OPERATIONS["ingest_interview_behavior_events"].audit_redacted_parameters,
        )

    def test_interview_skills_expose_only_registered_tools(self) -> None:
        practice = resolve_skill("模拟面试")
        scoring = resolve_skill("面试评分")

        self.assertIsNotNone(practice)
        self.assertIsNotNone(scoring)
        assert practice is not None
        assert scoring is not None
        self.assertIn("submit_ai_interview_answer", practice.allowed_tools)
        self.assertIn("create_interview_scoring_skill", scoring.allowed_tools)
        self.assertTrue(practice.allowed_tools.issubset(OPERATIONS))
        self.assertTrue(scoring.allowed_tools.issubset(OPERATIONS))


if __name__ == "__main__":
    unittest.main()
