from __future__ import annotations

import pathlib
import sys
import os

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
# Pure-function tests; import still builds the module engine.  Use an isolated
# temp DB path instead of the real ./djm.db so a bare run cannot touch user data.
os.environ.setdefault(
    "DATABASE_URL",
    "sqlite+aiosqlite:///"
    + (pathlib.Path(os.environ.get("OFFERU_TEST_TEMP_ROOT", os.path.join(os.path.expanduser("~"), ".offeru-test"))) / "scripts-isolated.db").as_posix(),
)

from app.routes import profile as profile_route  # noqa: E402


def _project_candidate(description: str) -> dict:
    return profile_route._normalize_candidate(
        "project",
        {
            "section_type": "project",
            "title": "\u5e74\u4f1aAI\u89c6\u9891\u5ba3\u4f20\u7247\u9879\u76ee",
            "content_json": {
                "name": "\u5e74\u4f1aAI\u89c6\u9891\u5ba3\u4f20\u7247\u9879\u76ee",
                "role": "\u6280\u672f\u8d1f\u8d23\u4eba",
                "description": description,
                "bullet": description,
            },
            "confidence": 0.82,
        },
    )


def test_import_candidates_merge_same_project_description_lines() -> None:
    candidates = [
        _project_candidate("\u8d1f\u8d23\u516c\u53f8\u5e74\u4f1a\u9886\u5bfcAI\u89c6\u9891\u5ba3\u4f20\u7247\u9879\u76ee"),
        _project_candidate("\u603b\u7ed3AI\u89c6\u9891\u6280\u672f\u89c4\u8303\u6d41\u7a0b"),
        _project_candidate("\u8d1f\u8d23\u516c\u53f8\u7535\u8bdd\u5f69\u94c3AI\u89c6\u9891\u9879\u76ee"),
    ]

    merged = profile_route._coalesce_resume_entry_candidates(candidates)

    assert len(merged) == 1
    normalized = merged[0]["content_json"]["normalized"]
    assert normalized["name"] == "\u5e74\u4f1aAI\u89c6\u9891\u5ba3\u4f20\u7247\u9879\u76ee"
    assert "\u8d1f\u8d23\u516c\u53f8\u5e74\u4f1a\u9886\u5bfcAI\u89c6\u9891\u5ba3\u4f20\u7247\u9879\u76ee" in normalized["description"]
    assert "\u603b\u7ed3AI\u89c6\u9891\u6280\u672f\u89c4\u8303\u6d41\u7a0b" in normalized["description"]
    assert "\u8d1f\u8d23\u516c\u53f8\u7535\u8bdd\u5f69\u94c3AI\u89c6\u9891\u9879\u76ee" in normalized["description"]


def test_structured_resume_entries_map_to_profile_fields() -> None:
    payload = {
        "base_info": {
            "name": "\u674e\u51ef\u98ce",
            "phone": "18826555466",
            "email": "921693422@qq.com",
            "current_city": "\u4f5b\u5c71",
            "summary": "\u5177\u5907AIGC\u5de5\u4f5c\u6d41\u642d\u5efa\u4e0e\u89c6\u9891\u5236\u4f5c\u7ecf\u9a8c",
        },
        "entries": [
            {
                "entry_type": "work",
                "title": "\u4e2d\u56fd\u7535\u4fe1\u80a1\u4efd\u6709\u9650\u516c\u53f8\u4f5b\u5c71\u5206\u516c\u53f8",
                "organization": "\u4e2d\u56fd\u7535\u4fe1\u80a1\u4efd\u6709\u9650\u516c\u53f8\u4f5b\u5c71\u5206\u516c\u53f8",
                "department": "\u4e91\u4e2d\u53f0\u8f6f\u7814\u4e2d\u5fc3",
                "role": "\u7814\u53d1\u5de5\u7a0b\u5e08",
                "start_date": "2025\u5e7407\u6708",
                "end_date": "\u81f3\u4eca",
                "description": "\u901a\u8fc7\u6821\u62db\u8fdb\u5165\u4e2d\u56fd\u7535\u4fe1\uff0c\u4efb\u804c\u7814\u53d1\u5de5\u7a0b\u5e08\u3002\u4e3b\u8981\u8d1f\u8d23\u4f01\u4e1a\u7ea7AIGC\u5de5\u4f5c\u6d41\u4ece0\u52301\u642d\u5efa\u3002",
                "confidence": 0.92,
            },
            {
                "entry_type": "project",
                "title": "\u516c\u53f8\u5e74\u4f1a\u9886\u5bfc\u5ba3\u4f20\u7247AI\u89c6\u9891\u9879\u76ee",
                "organization": "\u4e2d\u56fd\u7535\u4fe1\u80a1\u4efd\u6709\u9650\u516c\u53f8\u4f5b\u5c71\u5206\u516c\u53f8",
                "role": "\u6280\u672f\u8d1f\u8d23\u4eba",
                "start_date": "2025\u5e7412\u6708",
                "end_date": "2025\u5e7412\u6708",
                "description": "\u5386\u65f6\u4e00\u4e2a\u6708\u5236\u4f5c3\u5206\u949f\u300111\u4f4d\u9886\u5bfc\u53e4\u88c5AI\u89c6\u9891\u77ed\u7247\uff0c\u5e74\u4f1a\u64ad\u653e\u540e\u5f15\u8d77\u53cd\u54cd\u5e76\u6c89\u6dc0\u6280\u672f\u89c4\u8303\u6d41\u7a0b\u3002",
                "confidence": 0.95,
            },
        ]
    }

    candidates = profile_route._candidates_from_structured_resume_payload(payload)

    assert len(candidates) == 2
    work = candidates[0]["content_json"]["normalized"]
    project = candidates[1]["content_json"]["normalized"]
    assert candidates[0]["section_type"] == "experience"
    assert work["company"] == "\u4e2d\u56fd\u7535\u4fe1\u80a1\u4efd\u6709\u9650\u516c\u53f8\u4f5b\u5c71\u5206\u516c\u53f8"
    assert work["position"] == "\u7814\u53d1\u5de5\u7a0b\u5e08"
    assert "\u4f01\u4e1a\u7ea7AIGC" in work["description"]
    assert candidates[1]["section_type"] == "project"
    assert project["name"] == "\u516c\u53f8\u5e74\u4f1a\u9886\u5bfc\u5ba3\u4f20\u7247AI\u89c6\u9891\u9879\u76ee"
    assert "\u6280\u672f\u89c4\u8303\u6d41\u7a0b" in project["description"]

    base_info = profile_route._base_info_from_structured_resume_payload(payload)
    assert base_info["name"] == "\u674e\u51ef\u98ce"
    assert base_info["phone"] == "18826555466"
    assert base_info["current_city"] == "\u4f5b\u5c71"


def test_structured_skill_entry_preserves_original_paragraph() -> None:
    skill_text = (
        "\u719f\u7ec3\u4f7f\u7528Comfyui\u5de5\u4f5c\u6d41\uff0c\u8fd0\u884c\u524d\u6cbf\u5f00\u6e90\u6a21\u578b\uff08WAN\u7b49\uff09\u8fdb\u884c\u89c6\u9891\u5236\u4f5c\uff1b"
        "\u7cfb\u7edf\u5b66\u4e60\u8f6f\u4ef6\u5de5\u7a0b\uff0c\u80fd\u8f83\u597d\u5730\u7f16\u5199\u4ea7\u54c1\u9700\u6c42\u6587\u6863\uff0c\u80fd\u8bbe\u8eab\u5904\u5730\u4e0e\u5f00\u53d1\u4eba\u5458\u6c9f\u901a\u3002"
    )
    payload = {
        "entries": [
            {
                "entry_type": "skill",
                "title": "\u4e13\u4e1a\u6280\u80fd",
                "description": skill_text,
                "items": ["Comfyui", "WAN", "\u8f6f\u4ef6\u5de5\u7a0b"],
                "confidence": 0.9,
            }
        ]
    }

    candidates = profile_route._candidates_from_structured_resume_payload(payload)

    assert len(candidates) == 1
    normalized = candidates[0]["content_json"]["normalized"]
    assert candidates[0]["section_type"] == "skill"
    assert normalized["items"] == [skill_text]
    assert candidates[0]["content_json"]["bullet"] == skill_text


def test_resume_import_mode_aliases_and_memory_messages() -> None:
    candidates = [
        profile_route._normalize_candidate(
            "project",
            {
                "section_type": "project",
                "title": "\u6821\u56ed\u62db\u8058\u6295\u9012\u7cfb\u7edf",
                "content_json": {
                    "name": "\u6821\u56ed\u62db\u8058\u6295\u9012\u7cfb\u7edf",
                    "description": "\u5b8c\u6210\u7b80\u5386\u89e3\u6790\u4e0e\u6295\u9012\u6d41\u7a0b",
                    "bullet": "\u5b8c\u6210\u7b80\u5386\u89e3\u6790\u4e0e\u6295\u9012\u6d41\u7a0b",
                },
                "confidence": 0.8,
            },
        )
    ]

    assert profile_route._normalize_resume_import_mode("llm") == "ai"
    assert profile_route._normalize_resume_import_mode("regex") == "mechanical"

    messages, patch = profile_route._build_resume_import_agent_messages(
        filename="resume.pdf",
        parse_mode="mechanical",
        parsed_text="\u674e\u51ef\u98ce\n\u9879\u76ee\u7ecf\u5386",
        base_info={"name": "\u674e\u51ef\u98ce", "job_intention": "AI\u4ea7\u54c1"},
        candidates=candidates,
    )

    memory = next(item for item in messages if item.get("kind") == "resume_parse_memory")
    assert memory["parse_mode"] == "mechanical"
    assert memory["candidate_count"] == 1
    assert patch["target_roles"] == ["AI\u4ea7\u54c1"]
    assert any(item.get("kind") == "profile_agent_patch" for item in messages)


if __name__ == "__main__":
    test_import_candidates_merge_same_project_description_lines()
    test_structured_resume_entries_map_to_profile_fields()
    test_structured_skill_entry_preserves_original_paragraph()
    test_resume_import_mode_aliases_and_memory_messages()
    print("profile resume import candidate tests passed")
