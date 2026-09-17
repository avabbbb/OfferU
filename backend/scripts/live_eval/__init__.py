"""OfferU Live Agent Eval（Ava 版）。

被测对象是外部 Coding Agent（WorkBuddy / Codex / ...），它通过 OfferU
Operation Registry 完成真实求职任务；判分只看数据库最终状态与工具轨迹。
"""

from __future__ import annotations

__all__ = [
    "cases",
    "grader",
    "human_grading",
    "isolation",
    "metrics",
    "private_dataset",
    "private_seed",
    "private_suite",
    "runner",
    "skill_route",
]
