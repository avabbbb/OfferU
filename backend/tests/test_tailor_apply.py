"""Core: model rewrites actually land on the resume rows (no mocks, no DB)."""
from __future__ import annotations

from app.models.models import ProfileSection
from app.services.resume_optimize_support import _apply_suggestions_to_rows, _build_resume_sections

ORIGINAL = "用 Python Flask 写了商品、订单接口。"


def _rows():
    section = ProfileSection(
        id=1, section_type="project", title="校园二手交易平台",
        content_json={"normalized": {
            "name": "校园二手交易平台", "role": "后端负责人",
            "start_date": "2024-03", "end_date": "2024-07", "description": ORIGINAL,
        }},
    )
    return _build_resume_sections([section])


def test_resume_rows_keep_experience_dates():
    item = _rows()[0]["content_json"][0]
    assert (item["startDate"], item["endDate"]) == ("2024-03", "2024-07")


def test_suggestion_without_section_title_still_applies_by_original_text():
    # 整份改写时模型只在顶层给 section_title，单条建议里没有。
    rows = _apply_suggestions_to_rows(_rows(), [{
        "original": ORIGINAL, "suggested": "使用 Python Flask 开发商品、订单 RESTful 接口。",
    }])
    assert rows[0]["content_json"][0]["description"] == "使用 Python Flask 开发商品、订单 RESTful 接口。"
