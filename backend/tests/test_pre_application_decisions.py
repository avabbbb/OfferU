from __future__ import annotations

import asyncio
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.chdir(BACKEND_DIR)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.ops import OPERATIONS
from app.services import pre_application_decisions
from app.services.agent_skill_registry import resolve_skill
from app.services.pre_application_decisions import (
    extract_pre_application_final_decision,
    extract_recent_job_id,
)


_OPERATIONS = {
    "get_pre_application_state",
    "prepare_pre_application_decision",
    "review_pre_application_decision",
}


def _context(*, proposal: dict | None = None) -> dict:
    return {
        "stage": "needs_decision",
        "job": {"id": 7, "source_ref": "job:7"},
        "profile_id": 3,
        "profile_evidence_count": 1,
        "research_run": {
            "run_id": "research_7",
            "status": "completed",
            "finding_count": 1,
            "source_count": 1,
        },
        "decision_input": {},
        "input_hash": "input-hash-7",
        "allowed_source_refs": {
            "job:7",
            "profile_section:11",
            "research-source:1",
        },
        "profile_source_refs": {"profile_section:11"},
        "latest_resume_proposal": proposal,
    }


def _decision_payload() -> dict:
    return {
        "job_id": 7,
        "profile_id": 3,
        "research_run_id": "research_7",
        "input_hash": "input-hash-7",
        "agent_recommendation": "go",
        "decision": {
            "recommendation": "go",
            "rationale": "已确认职业证据覆盖核心要求。",
            "strengths": ["有直接项目证据"],
            "gaps": [],
            "conditions": [],
            "missing_evidence": [],
            "evidence": [
                {
                    "source_refs": ["profile_section:11", "job:7"],
                    "claim": "已确认项目与岗位要求直接相关。",
                    "kind": "inference",
                }
            ],
        },
        "model_runtime": {"provider": "test", "model": "test"},
    }


class PreApplicationDecisionContractTests(unittest.TestCase):
    def test_all_surfaces_share_the_operation_registry_boundary(self) -> None:
        skill = resolve_skill("pre_application_decision")
        read_operations = {
            name for name, operation in OPERATIONS.items()
            if not operation.is_mutation
        }
        mutation_operations = {
            name for name, operation in OPERATIONS.items()
            if operation.is_mutation
        }

        self.assertTrue(_OPERATIONS.issubset(OPERATIONS))
        self.assertEqual(
            {"get_pre_application_state"},
            read_operations & _OPERATIONS,
        )
        self.assertEqual(
            {
                "prepare_pre_application_decision",
                "review_pre_application_decision",
            },
            mutation_operations & _OPERATIONS,
        )
        self.assertIsNotNone(skill)
        assert skill is not None
        self.assertEqual("native", skill.status)
        self.assertEqual("pre_application_workflow", skill.mode)
        self.assertTrue(_OPERATIONS.issubset(skill.allowed_tools))
        self.assertIsNone(resolve_skill("auto_pipeline"))

    def test_decision_contract_has_no_probability_or_unified_score(self) -> None:
        payload = {
            "recommendation": "conditional_go",
            "rationale": "核心要求有来源支持，但地点需要确认。",
            "strengths": ["已有相关项目证据"],
            "gaps": ["地点偏好未确认"],
            "conditions": ["确认可接受岗位地点"],
            "missing_evidence": [],
            "evidence": [
                {
                    "source_refs": ["profile_section:11"],
                    "claim": "候选人有相关项目证据。",
                    "kind": "candidate_fact",
                },
                {
                    "source_refs": ["job:7"],
                    "claim": "岗位要求相关项目经验。",
                    "kind": "job_requirement",
                },
                {
                    "source_refs": ["research-source:1"],
                    "claim": "岗位地点来自已完成调研。",
                    "kind": "research_fact",
                },
            ],
        }

        result = pre_application_decisions._validated_decision(
            payload,
            allowed_source_refs={
                "profile_section:11",
                "job:7",
                "research-source:1",
            },
            profile_source_refs={"profile_section:11"},
            job_source_ref="job:7",
        )

        self.assertEqual("conditional_go", result["recommendation"])
        self.assertNotIn("score", result)
        self.assertNotIn("probability", result)

    def test_unknown_evidence_source_is_rejected(self) -> None:
        payload = {
            "recommendation": "go",
            "rationale": "看起来合适。",
            "strengths": [],
            "gaps": [],
            "conditions": [],
            "missing_evidence": [],
            "evidence": [
                {
                    "source_refs": ["invented:1"],
                    "claim": "不存在的候选人事实。",
                    "kind": "candidate_fact",
                }
            ],
        }

        with self.assertRaisesRegex(ValueError, "未知来源"):
            pre_application_decisions._validated_decision(
                payload,
                allowed_source_refs={"profile_section:11", "job:7"},
                profile_source_refs={"profile_section:11"},
                job_source_ref="job:7",
            )

    def test_reviewed_go_opens_resume_gate_and_no_go_exits(self) -> None:
        async def run(final_decision: str) -> tuple[dict, dict]:
            with tempfile.TemporaryDirectory() as directory:
                store = pre_application_decisions.PreApplicationDecisionStore(
                    Path(directory)
                )
                prepared = store.create(_decision_payload())
                with (
                    patch.object(pre_application_decisions, "decision_store", store),
                    patch.object(
                        pre_application_decisions,
                        "_load_current_context",
                        AsyncMock(return_value=_context()),
                    ),
                ):
                    reviewed = await pre_application_decisions.review_pre_application_decision(
                        prepared["id"],
                        final_decision,
                        note=("当前地点不符合偏好" if final_decision == "no_go" else ""),
                    )
                    state = await pre_application_decisions.get_pre_application_state(7)
                return reviewed, state

        reviewed_go, go_state = asyncio.run(run("go"))
        reviewed_no_go, no_go_state = asyncio.run(run("no_go"))

        self.assertEqual("reviewed", reviewed_go["status"])
        self.assertEqual("ready_for_resume_proposal", go_state["stage"])
        self.assertEqual("no_go", reviewed_no_go["final_decision"])
        self.assertEqual("completed_no_go", no_go_state["stage"])

    def test_user_choice_parser_does_not_treat_pre_application_as_go(self) -> None:
        self.assertIsNone(extract_pre_application_final_decision("投前决策 岗位 #7"))
        self.assertEqual("go", extract_pre_application_final_decision("确认投"))
        self.assertEqual(
            "conditional_go",
            extract_pre_application_final_decision("有条件投，先确认地点"),
        )
        self.assertEqual(
            "no_go",
            extract_pre_application_final_decision("不投，地点不符合偏好"),
        )
        self.assertEqual(
            "insufficient_evidence",
            extract_pre_application_final_decision("证据不足，先补项目数据"),
        )
        self.assertEqual(
            7,
            extract_recent_job_id(
                [
                    {"role": "user", "content": "投前决策 岗位 #7"},
                    {"role": "assistant", "content": "Agent 建议：投。"},
                    {"role": "user", "content": "投"},
                ]
            ),
        )


if __name__ == "__main__":
    unittest.main()
