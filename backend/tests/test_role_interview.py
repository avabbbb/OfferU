from __future__ import annotations

import os
import asyncio
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


BACKEND_DIR = Path(__file__).resolve().parents[1]
os.chdir(BACKEND_DIR)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.models.models import Interview, InterviewMessage
from app.ops import OPERATIONS
from app.services.ai_interviews import (
    _decorate_focus_questions,
    _evaluate_answer,
    _follow_up_decision,
    _generate_follow_up_question,
    _generate_questions,
    _role_intelligence_debrief,
)
from app.services.agent_skill_registry import resolve_skill


def _plan() -> dict:
    return {
        "schema": "offeru.interview_focus_plan.v1",
        "benchmark_run_id": "role_benchmark_fixture",
        "target_job_id": 50,
        "profile_id": 7,
        "source": {
            "data_mode": "fixture",
            "runtime_id": "fixture",
            "valid_sample_count": 20,
            "company_count": 20,
            "sample_sufficient": True,
        },
        "focuses": [
            {
                "capability": "model_evaluation",
                "category": "technical_product",
                "role_importance": "must_have",
                "market_frequency": 0.1,
                "role_distinctiveness": 90.0,
                "evidence_strength": 42.0,
                "evidence_gap": 58.0,
                "training_priority": 52.2,
                "signal_confidence": 0.94,
                "direction": "highly_distinctive",
                "priority_score": 49.1,
                "priority_percent": 60.0,
                "rationale": "目标 JD 特别强调模型评测。",
                "target_jd_evidence_refs": [
                    {"source_ref": "job:50", "evidence_text": "负责模型评测体系建设"}
                ],
                "comparator_evidence_refs": [
                    {"source_ref": "cmp-1", "company": "Example", "evidence_text": "评测"}
                ],
                "candidate_evidence_refs": [
                    {"profile_section_id": 7, "title": "项目证据", "excerpt": "参与模型评测"}
                ],
            }
        ],
        "question_blueprint": [
            {"question_index": 0, "capability": "model_evaluation", "mode": "proof"}
        ],
        "question_count": 1,
    }


class RoleInterviewTests(unittest.TestCase):
    def test_question_metadata_is_runtime_owned_by_focus_plan(self) -> None:
        question = {
            "question": "请说明你如何设计评测维度。",
            "type": "technical",
            "focus": "model evaluation chosen by model",
            "tips": "",
        }

        decorated = _decorate_focus_questions([question], _plan())[0]

        self.assertEqual(decorated["focus"], "model_evaluation")
        self.assertEqual(decorated["mode"], "proof")
        self.assertEqual(decorated["delta_refs"], ["role_benchmark_fixture:model_evaluation"])
        self.assertEqual(decorated["target_jd_evidence_refs"][0]["source_ref"], "job:50")
        self.assertEqual(decorated["candidate_evidence_refs"][0]["profile_section_id"], 7)
        self.assertFalse(decorated["is_follow_up"])

    def test_short_answer_gets_adaptive_follow_up_without_coaching(self) -> None:
        question = _decorate_focus_questions(
            [
                {
                    "question": "请说明你如何设计评测维度。",
                    "type": "technical",
                    "focus": "model_evaluation",
                    "tips": "",
                }
            ],
            _plan(),
        )[0]
        evaluation = {
            "dimensions": {
                "relevance": {"missing_evidence": True},
            }
        }

        decision = _follow_up_decision(
            question=question,
            answer="主要看业务效果。",
            evaluation=evaluation,
            model_signal={"required": False, "reason": "none", "evidence_refs": []},
        )

        self.assertEqual(decision, {"required": True, "reason": "vague", "evidence_refs": []})

    def test_debrief_quotes_answer_and_keeps_profile_write_boundary(self) -> None:
        plan = _plan()
        questions = _decorate_focus_questions(
            [
                {
                    "question": "你如何设计评测维度？",
                    "type": "technical",
                    "focus": "model_evaluation",
                    "tips": "",
                }
            ],
            plan,
        )
        interview = Interview(
            target_job_id=50,
            target_position="AIGC 产品经理",
            questions_json=questions,
            focus_plan_json=plan,
        )
        message = InterviewMessage(
            role="candidate",
            question_index=0,
            content="我负责模型评测，使用两周数据验证结果。",
            evaluation_json={
                "content_score": 62,
                "dimensions": {
                    "relevance": {"evidence": ["我负责模型评测"]},
                },
                "improvements": ["补充评测指标"],
            },
        )

        debrief = _role_intelligence_debrief(
            interview=interview,
            messages=[message],
        )

        focus = debrief["focuses"][0]
        self.assertEqual(focus["responses"][0]["answer_excerpt"], "我负责模型评测，使用两周数据验证结果。")
        self.assertEqual(focus["responses"][0]["answer_evidence"], ["我负责模型评测"])
        self.assertEqual(focus["target_jd_evidence_refs"][0]["source_ref"], "job:50")
        self.assertIn("不会把训练观察自动写入正式 Profile", debrief["boundary"])

    def test_focus_operation_is_registered_and_whitelisted(self) -> None:
        self.assertIn("prepare_role_interview_focus", OPERATIONS)
        self.assertFalse(OPERATIONS["prepare_role_interview_focus"].is_mutation)
        practice = resolve_skill("模拟面试")
        self.assertIsNotNone(practice)
        assert practice is not None
        self.assertIn("prepare_role_interview_focus", practice.allowed_tools)

    def test_replay_provider_uses_focus_blueprint_and_validated_evaluation(self) -> None:
        definition = {
            "skill_id": "replay-score",
            "version": 1,
            "dimensions": [
                {
                    "key": "evidence_specificity",
                    "weight": 1.0,
                    "allow_not_applicable": False,
                }
            ],
            "score_bands": [
                {"label": "pass", "min": 50},
                {"label": "needs work", "min": 0},
            ],
            "prompt_instructions": [],
            "prohibited_outputs": [],
        }

        async def run_replay() -> tuple[list[dict], dict, dict]:
            with patch.dict(os.environ, {"OFFERU_INTERVIEW_RUNTIME": "replay"}):
                questions = await _generate_questions(
                    interview_type="mixed",
                    difficulty="medium",
                    question_count=1,
                    target_company="Fixture Co",
                    target_position="AIGC 产品经理",
                    context={},
                    focus_plan=_plan(),
                )
                follow_up = await _generate_follow_up_question(
                    question=_decorate_focus_questions(
                        [
                            {
                                "question": "请说明你如何设计评测维度。",
                                "type": "technical",
                                "focus": "model_evaluation",
                                "tips": "",
                            }
                        ],
                        _plan(),
                    )[0],
                    answer="主要看业务效果。",
                    decision={"required": True, "reason": "vague", "evidence_refs": []},
                )
                evaluation, runtime, _ = await _evaluate_answer(
                    question=questions[0]["question"],
                    answer="主要看业务效果。",
                    definition=definition,
                    focus_context=_plan()["focuses"][0],
                )
                return questions, follow_up, {"evaluation": evaluation, "runtime": runtime}

        questions, follow_up, evaluated = asyncio.run(run_replay())
        self.assertEqual(questions[0]["focus"], "model_evaluation")
        self.assertIn("model_evaluation", questions[0]["question"])
        self.assertTrue(follow_up["is_follow_up"])
        self.assertEqual(follow_up["mode"], "follow_up")
        self.assertEqual(evaluated["runtime"]["provider"], "replay")
        self.assertTrue(evaluated["evaluation"]["dimensions"]["evidence_specificity"]["missing_evidence"])


if __name__ == "__main__":
    unittest.main()
