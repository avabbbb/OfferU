from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.services.main_agent_guardian import (  # noqa: E402
    classify_user_stage,
    detect_guardian_anomalies,
    evaluate_main_agent_guardian,
)
from app.services.harness_memory import (  # noqa: E402
    export_agent_memory_markdown,
    import_agent_memory_payload,
    normalize_agent_memory,
)


def test_classify_user_stage_detects_campus_and_experienced_signals() -> None:
    campus = classify_user_stage(
        profile={"school": "Example University", "major": "Marketing"},
        messages=[{"role": "user", "content": "我是 2026 应届生，想找校招和暑期实习"}],
        memory={},
    )
    experienced = classify_user_stage(
        profile={"headline": "3 years product manager"},
        messages=[{"role": "user", "content": "我想看社招岗位，已经工作三年"}],
        memory={},
    )

    assert campus["stage"] == "campus"
    assert campus["confidence"] >= 0.7
    assert "应届" in campus["signals"] or "校招" in campus["signals"]
    assert experienced["stage"] == "experienced"
    assert experienced["confidence"] >= 0.7


def test_memory_import_export_keeps_local_facts_and_stage() -> None:
    imported = import_agent_memory_payload(
        {
            "user_stage": "campus",
            "facts": ["2026 届本科生"],
            "preferences": ["优先北京"],
            "goals": ["找 AI 产品实习"],
            "risks": ["档案缺少手机号"],
        }
    )

    normalized = normalize_agent_memory(imported)
    markdown = export_agent_memory_markdown(normalized)

    assert normalized["schema_version"] == "offeru.agent_memory.v1"
    assert normalized["user_stage"] == "campus"
    assert "2026 届本科生" in normalized["facts"]
    assert "优先北京" in markdown
    assert "找 AI 产品实习" in markdown


def test_guardian_anomalies_flag_campus_profile_gaps() -> None:
    alerts = detect_guardian_anomalies(
        profile={"name": "", "base_info_json": {}, "target_roles": [], "sections": []},
        jobs=[],
        applications=[],
        memory={"user_stage": "campus"},
        stage="campus",
    )

    alert_codes = {alert["code"] for alert in alerts}
    assert "missing_contact" in alert_codes
    assert "missing_target_role" in alert_codes
    assert "campus_profile_too_thin" in alert_codes


def test_guardian_advises_stage_discovery_without_executing_tools() -> None:
    response = evaluate_main_agent_guardian(
        profile={"name": "", "headline": "", "target_roles": [], "sections": []},
        messages=[{"role": "user", "content": "帮我规划一下下一步"}],
        memory={"user_stage": "unknown"},
    )

    assert response["user_stage"] == "unknown"
    assert response["proactive_suggestions"]
    assert "tool_calls" not in response
    assert "proposed_actions" not in response


def test_guardian_returns_campus_proactive_context() -> None:
    response = evaluate_main_agent_guardian(
        profile={
            "name": "Alex",
            "school": "Example University",
            "major": "Marketing",
            "headline": "",
            "target_roles": [],
            "sections": [],
            "base_info_json": {"email": "alex@example.com"},
        },
        messages=[{"role": "user", "content": "我是应届生，帮我找 AI 产品实习岗位"}],
        memory={"user_stage": "campus"},
    )

    assert response["user_stage"] == "campus"
    assert response["alerts"]
    assert response["proactive_suggestions"]
    assert any("校招" in item["title"] or "实习" in item["title"] for item in response["proactive_suggestions"])


if __name__ == "__main__":
    test_classify_user_stage_detects_campus_and_experienced_signals()
    test_memory_import_export_keeps_local_facts_and_stage()
    test_guardian_anomalies_flag_campus_profile_gaps()
    test_guardian_advises_stage_discovery_without_executing_tools()
    test_guardian_returns_campus_proactive_context()
    print("main Agent Guardian memory contract tests passed")
