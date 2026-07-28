from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from app.services.resume_fact_gates import validate_resume_fact_gates  # noqa: E402


def test_fact_gate_blocks_unverified_metrics_and_names() -> None:
    source_sections = [
        {
            "title": "星河科技 增长平台",
            "content_json": {
                "bullet": "负责增长实验平台，推动注册转化率提升 18%。",
                "normalized": {
                    "company": "星河科技",
                    "description": "负责增长实验平台，推动注册转化率提升 18%。",
                },
            },
        }
    ]
    rows = [
        {
            "section_type": "experience",
            "title": "实践经历",
            "content_json": [
                {
                    "company": "不存在科技",
                    "position": "产品经理",
                    "description": "负责增长实验平台，推动注册转化率提升 35%。",
                }
            ],
        }
    ]

    result = validate_resume_fact_gates(rows, source_sections)

    assert result["status"] == "blocked"
    assert result["requires_user_confirmation"] is True
    assert result["warnings_count"] == 2
    issues = {warning["issue"] for warning in result["warnings"]}
    assert issues == {"unverified_metric", "unverified_org"}
    assert rows[0]["content_json"][0]["_gate_warnings"]


def test_fact_gate_passes_source_supported_resume() -> None:
    source_sections = [
        {
            "title": "星河科技 增长平台",
            "content_json": {
                "bullet": "负责增长实验平台，推动注册转化率提升 18%。",
                "normalized": {
                    "company": "星河科技",
                    "description": "负责增长实验平台，推动注册转化率提升 18%。",
                },
            },
        }
    ]
    rows = [
        {
            "section_type": "experience",
            "title": "实践经历",
            "content_json": [
                {
                    "company": "星河科技",
                    "position": "产品经理",
                    "description": "负责增长实验平台，推动注册转化率提升 18%。",
                }
            ],
        }
    ]

    result = validate_resume_fact_gates(rows, source_sections)

    assert result["status"] == "passed"
    assert result["requires_user_confirmation"] is False
    assert result["warnings_count"] == 0
    assert "_gate_warnings" not in rows[0]["content_json"][0]


if __name__ == "__main__":
    test_fact_gate_blocks_unverified_metrics_and_names()
    test_fact_gate_passes_source_supported_resume()
    print("resume fact gates tests passed")

