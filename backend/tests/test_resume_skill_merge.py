from __future__ import annotations

import os
from pathlib import Path
import sys
import unittest

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.chdir(BACKEND_DIR)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.routes.profile import _merge_skill_candidates


class ResumeSkillMergeTests(unittest.TestCase):
    def test_merges_multiple_skill_candidates_into_one(self) -> None:
        candidates = [
            {
                "section_type": "skill",
                "title": "技能清单",
                "content_json": {"items": ["Python", "FastAPI"], "bullet": "Python，FastAPI"},
                "confidence": 0.8,
            },
            {
                "section_type": "skill",
                "title": "技能清单",
                "content_json": {"items": ["PostgreSQL", "Docker"], "bullet": "PostgreSQL，Docker"},
                "confidence": 0.7,
            },
            {
                "section_type": "experience",
                "title": "中国电信",
                "content_json": {"company": "中国电信", "bullet": "研发工程师"},
                "confidence": 0.9,
            },
        ]

        merged = _merge_skill_candidates(candidates)

        self.assertEqual(len(merged), 2)
        skill = next(c for c in merged if c["section_type"] == "skill")
        self.assertEqual(skill["content_json"]["items"], ["Python", "FastAPI", "PostgreSQL", "Docker"])
        self.assertEqual(skill["confidence"], 0.8)
        self.assertIn("Python", skill["content_json"]["bullet"])

    def test_single_skill_candidate_untouched(self) -> None:
        candidates = [
            {
                "section_type": "skill",
                "title": "技能清单",
                "content_json": {"items": ["Python"]},
                "confidence": 0.8,
            }
        ]
        self.assertEqual(_merge_skill_candidates(candidates), candidates)

    def test_no_skills_untouched(self) -> None:
        candidates = [{"section_type": "experience", "title": "A", "content_json": {}}]
        self.assertEqual(_merge_skill_candidates(candidates), candidates)


if __name__ == "__main__":
    unittest.main()
