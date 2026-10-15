"""宽松档「推断技能」：可写进草稿，但必须有原文依据、标出来并逐条确认。

硬闸门（数字、公司、项目名、奖项、时间、职级）不因推断而放宽。
"""
from __future__ import annotations

from app.agents.skills.content_rewriter import _apply_quality_guardrail, _clean_inferred_skills
from app.services.resume_fact_gates import validate_resume_fact_gates
from app.services.resume_optimization import _build_diff, _pop_inferred_skills, _strategy_inferred_skills
from app.services.resume_optimize_support import _apply_suggestions_to_rows

ORIGINAL = "用 Vue 3 做了学院管理后台"
SUGGESTED = "<ul><li>基于 Vue 3 组件化开发学院管理后台</li></ul>"


def test_clean_inferred_skills_requires_verbatim_basis_and_presence():
    kept = _clean_inferred_skills(
        [
            {"skill": "组件化开发", "basis": "Vue 3 做了学院管理后台"},
            {"skill": "前端工程化", "basis": "Vue 3 做了学院管理后台"},  # not in suggested
            {"skill": "组件化开发", "basis": "我没写过的话"},  # duplicate / fake basis
        ],
        ORIGINAL,
        SUGGESTED,
    )
    assert kept == [{"skill": "组件化开发", "basis": "Vue 3 做了学院管理后台"}]


def test_clean_inferred_skills_never_infers_numbers_orgs_or_titles():
    suggested = "<ul><li>提升 30% 效率，腾讯公司，前端负责人</li></ul>"
    kept = _clean_inferred_skills(
        [
            {"skill": "提升 30% 效率", "basis": ORIGINAL},
            {"skill": "腾讯公司", "basis": ORIGINAL},
            {"skill": "前端负责人", "basis": ORIGINAL},
        ],
        ORIGINAL,
        suggested,
    )
    assert kept == []


def test_skills_list_inference_may_cite_anywhere_in_resume():
    kept = _clean_inferred_skills(
        [{"skill": "组件化开发", "basis": "做了学院管理后台"}],
        "Vue 3",
        "Vue 3、组件化开发",
        resume_text=f"项目经历：{ORIGINAL}",
    )
    assert kept and kept[0]["skill"] == "组件化开发"


def _suggestion(inferred):
    return {
        "type": "inject",
        "item_label": "",
        "original": ORIGINAL,
        "suggested": SUGGESTED,
        "injected_keywords": ["组件化开发"],
        "inferred_skills": inferred,
    }


def test_guardrail_allows_declared_inference_and_blocks_undeclared():
    declared = _apply_quality_guardrail(
        {"suggestions": [_suggestion([{"skill": "组件化开发", "basis": ORIGINAL}])]},
        ["组件化开发"],
        ORIGINAL,
    )
    assert len(declared["suggestions"]) == 1
    assert declared["suggestions"][0]["inferred_skills"][0]["skill"] == "组件化开发"

    undeclared = _apply_quality_guardrail({"suggestions": [_suggestion([])]}, ["组件化开发"], ORIGINAL)
    assert undeclared["suggestions"] == []
    assert undeclared["_guardrail_blocked"]


def test_guardrail_still_blocks_responsibility_escalation_with_inference():
    suggestion = {
        **_suggestion([{"skill": "组件化开发", "basis": "管理后台"}]),
        "original": "参与管理后台开发",
        "suggested": "负责组件化开发管理后台",
    }
    result = _apply_quality_guardrail({"suggestions": [suggestion]}, ["组件化开发"], "参与管理后台开发")
    assert result["suggestions"] == []


SOURCE = [{"id": 1, "title": "项目经历", "content_json": {"normalized": {"description": ORIGINAL}}}]


def _skill_rows(items, company=None):
    rows = [{
        "section_type": "skill",
        "title": "专业技能",
        "source_section_ids": [1],
        "content_json": [{"category": "前端", "items": items}],
    }]
    if company:
        rows.append({
            "section_type": "experience",
            "title": "实习经历",
            "source_section_ids": [1],
            "content_json": [{"company": company, "description": ORIGINAL}],
        })
    return rows


def test_fact_gate_inferred_skill_in_skills_column_is_soft():
    blocked = validate_resume_fact_gates(_skill_rows(["Vue 3", "组件化开发"]), SOURCE, strict_structured_facts=True)
    assert blocked["status"] == "blocked"

    passed = validate_resume_fact_gates(
        _skill_rows(["Vue 3", "组件化开发"]),
        SOURCE,
        strict_structured_facts=True,
        inferred_claims=[{"skill": "组件化开发", "basis": ORIGINAL}],
    )
    assert passed["status"] == "passed"
    assert passed["requires_user_confirmation"] is True
    assert [w["issue"] for w in passed["warnings"]] == ["inferred_skill"]


def test_fact_gate_inference_never_covers_company_or_numbers():
    result = validate_resume_fact_gates(
        _skill_rows(["Vue 3"], company="腾讯"),
        SOURCE,
        strict_structured_facts=True,
        inferred_claims=[{"skill": "腾讯"}, {"skill": "提升 30%"}],
    )
    assert result["status"] == "blocked"
    assert any(w["issue"] in {"unverified_org", "unverified_fact"} for w in result["warnings"])


def test_inference_markers_travel_to_diff_not_to_rows():
    rows = [{
        "section_type": "project",
        "title": "项目经历",
        "source_section_ids": [1],
        "content_json": [{"name": "学院管理后台", "description": ORIGINAL}],
    }]
    applied = _apply_suggestions_to_rows(rows, [{
        **_suggestion([{"skill": "组件化开发", "basis": ORIGINAL}]),
        "section_title": "项目经历",
        "item_label": "",
    }])
    assert applied[0]["content_json"][0]["_inferred_skills"]
    inferred = _pop_inferred_skills(applied)
    assert "_inferred_skills" not in applied[0]["content_json"][0]
    diff = _build_diff(rows, applied, inferred)
    assert diff[0]["inferred_skills"] == [{"skill": "组件化开发", "basis": ORIGINAL}]
    assert _strategy_inferred_skills({"inferred_skills": [{"skill": "组件化开发"}, {"x": 1}]}) == [{"skill": "组件化开发"}]
