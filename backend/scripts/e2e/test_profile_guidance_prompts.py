from __future__ import annotations

import pathlib
import os
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
# These tests only exercise pure prompt-builder functions; the import below
# still creates the module-level engine.  Point DATABASE_URL at an isolated
# temp path (never the real ./djm.db) so a bare run cannot touch user data.
os.environ.setdefault(
    "DATABASE_URL",
    "sqlite+aiosqlite:///"
    + (pathlib.Path(os.environ.get("OFFERU_TEST_TEMP_ROOT", os.path.join(os.path.expanduser("~"), ".offeru-test"))) / "scripts-isolated.db").as_posix(),
)

from app.routes.profile import _build_profile_chat_prompt, _fallback_chat_payload  # noqa: E402
from app.services.profile_builder_agent import (  # noqa: E402
    build_next_question,
    build_profile_agent_system_prompt,
)


def test_next_question_gives_user_answer_scaffold_for_core_experience() -> None:
    question = build_next_question(["core_experience"], "增长运营")

    assert "任选" in question
    assert "背景" in question
    assert "结果" in question
    assert "增长运营" in question


def test_next_question_asks_for_proof_points_when_metrics_missing() -> None:
    question = build_next_question(["impact_metrics"], "AI 产品经理")

    assert "数字" in question
    assert "人数" in question
    assert "金额" in question
    assert "不确定也可以估一个范围" in question


def test_profile_agent_system_prompt_requires_career_ops_style_fact_source() -> None:
    prompt = build_profile_agent_system_prompt(
        {
            "missing_field_labels": ["核心经历", "量化成果"],
            "goal": {"target_role": "AI 产品经理"},
        }
    )

    assert "单一事实源" in prompt
    assert "proof points" in prompt
    assert "STAR" in prompt
    assert "不要急着提取条目" in prompt


def test_profile_chat_prompt_teaches_agent_to_coach_before_extracting() -> None:
    prompt = _build_profile_chat_prompt("project")

    assert "职业教练" in prompt
    assert "如果信息不够" in prompt
    assert "只问一个最关键追问" in prompt
    assert "背景-动作-结果" in prompt


def test_profile_chat_fallback_invites_missing_proof_points() -> None:
    payload = _fallback_chat_payload("project", "我在学生会外联部拉赞助")

    assert "可写进简历" in payload["assistant_message"]
    assert "金额" in payload["assistant_message"]
    assert "规模" in payload["assistant_message"]
    assert payload["bullet_candidates"][0]["confidence"] < 0.7


if __name__ == "__main__":
    test_next_question_gives_user_answer_scaffold_for_core_experience()
    test_next_question_asks_for_proof_points_when_metrics_missing()
    test_profile_agent_system_prompt_requires_career_ops_style_fact_source()
    test_profile_chat_prompt_teaches_agent_to_coach_before_extracting()
    test_profile_chat_fallback_invites_missing_proof_points()
    print("profile guidance prompt tests passed")
